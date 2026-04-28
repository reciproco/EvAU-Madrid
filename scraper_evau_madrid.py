#!/usr/bin/env python3
"""
Scraper de notas medias EvAU de la Comunidad de Madrid
=======================================================

Extrae los resultados de la EvAU (bloque obligatorio) de cada centro
educativo de Madrid desde el portal oficial de la Consejería de Educación:

    https://gestiona.comunidad.madrid/wpad_pub/run/j/MostrarFichaCentro.icm

El portal carga los datos académicos vía AJAX, por lo que usamos Playwright
para conducir un navegador real, interceptar las llamadas de red y extraer
los datos.

USO
---
1. Listar todos los centros con Bachillerato (opción A: automático):

    python scraper_evau_madrid.py listar --output centros.csv

   Opción B (manual): descarga el CSV desde el buscador oficial:
   https://gestiona.comunidad.madrid/wpad_pub/run/j/MostrarConsultaGeneral.icm
   filtrando por enseñanza = Bachillerato.

2. Modo diagnóstico (un solo centro, para verificar que funciona):

    python scraper_evau_madrid.py probar --codigo 28030939

   (28030939 = IES San Mateo, suele tener buena nota EvAU)

3. Scraping masivo:

    python scraper_evau_madrid.py scrape --input centros.csv --output evau.csv

   Es reanudable: si se corta, vuelve a ejecutarlo y continúa donde lo dejó.

REQUISITOS
----------
    pip install playwright beautifulsoup4 lxml
    python -m playwright install chromium
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import csv
import io
import json
import logging
import random
import re
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from bs4 import BeautifulSoup
from playwright.async_api import Page, async_playwright
from playwright.async_api import TimeoutError as PWTimeout

# =============================================================================
# CONFIGURACIÓN
# =============================================================================

BASE = "https://gestiona.comunidad.madrid/wpad_pub/run/j"
URL_FICHA = f"{BASE}/MostrarFichaCentro.icm"
URL_BUSCADOR = f"{BASE}/MostrarConsultaGeneral.icm"

# Pausas entre peticiones — sé amable con el servidor de la Comunidad de Madrid
DELAY_ENTRE_CENTROS = (1.5, 3.0)   # segundos (rango aleatorio)
TIMEOUT_PAGINA_MS = 30_000
PAUSA_TRAS_CLICK_RADIO_S = 0.8     # margen extra para AJAX si no detectamos cambio
PAUSA_POST_PESTANA_S = 0.5

USER_AGENT = (
    "EvAU-Madrid-Scraper/1.0 "
    "(+https://github.com/reciproco/EvAU-Madrid; uso académico, datos públicos)"
)

logger = logging.getLogger("evau_scraper")


# =============================================================================
# MODELO DE DATOS
# =============================================================================

@dataclass
class ResultadoEvAU:
    """Una fila de resultados EvAU para un curso académico de un centro."""
    codigo_centro: str
    nombre_centro: str = ""
    tipo_centro: str = ""
    titularidad: str = ""
    municipio: str = ""
    area_territorial: str = ""
    curso: str = ""                          # ej: "2023/24"
    modalidad: str = "Presencial"            # Presencial / Nocturno / Distancia
    nota_media_centro: str = ""
    nota_media_cm: str = ""                  # media de toda la Comunidad
    n_presentados: str = ""
    pct_aptos_centro: str = ""
    pct_aptos_cm: str = ""
    nota_media_aptos_centro: str = ""
    nota_media_aptos_cm: str = ""


# =============================================================================
# UTILIDADES
# =============================================================================

def limpiar(s: str | None) -> str:
    """Limpia y normaliza un string extraído del HTML."""
    if not s:
        return ""
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def num_es(s: str) -> str:
    """Normaliza un número en formato español ('7,64' → '7.64'). Devuelve '' si no es número."""
    s = limpiar(s).replace("%", "").strip()
    if not s or s in {"-", "—", "n/d", "N/D"}:
        return ""
    # Acepta tanto '7,64' como '7.64'
    if re.fullmatch(r"-?\d+([.,]\d+)?", s):
        return s.replace(",", ".")
    return s  # devolver tal cual si no encaja


async def random_delay() -> None:
    a, b = DELAY_ENTRE_CENTROS
    await asyncio.sleep(random.uniform(a, b))


# =============================================================================
# EXTRACCIÓN DE DATOS DEL HTML
# =============================================================================

def parse_datos_centro(html: str) -> dict[str, str]:
    """Extrae los metadatos básicos del centro de la cabecera de la ficha."""
    soup = BeautifulSoup(html, "lxml")
    text = soup.get_text("\n", strip=False)

    out = {
        "nombre_centro": "",
        "tipo_centro": "",
        "titularidad": "",
        "municipio": "",
        "area_territorial": "",
    }

    # Patrones tipo: "NOMBRE DEL CENTRO:" "Titularidad:" "Área territorial:"
    patrones = {
        "nombre_centro":     r"NOMBRE DEL CENTRO\s*:?\s*(.+)",
        "tipo_centro":       r"Tipo\s*\(denominaci[oó]n[^)]*\)\s*:?\s*(.+)",
        "titularidad":       r"Titularidad\s*:?\s*([^\n]+?)(?:Titular|\n)",
        "area_territorial":  r"[ÁA]rea territorial\s*:?\s*([^\n]+)",
    }
    for clave, pat in patrones.items():
        m = re.search(pat, text, flags=re.IGNORECASE)
        if m:
            out[clave] = limpiar(m.group(1))

    # Municipio: la dirección está partida en varios <span> (calle, nº, CP,
    # municipio, distrito). Buscamos el <td> que empieza por "Dirección:" y
    # extraemos el municipio como el primer fragmento alfabético tras el CP de 5
    # dígitos.
    for td in soup.find_all("td"):
        td_text = limpiar(td.get_text(" ", strip=True))
        if td_text.lower().startswith("dirección") or td_text.lower().startswith("direccion"):
            m_cp = re.search(r"\b\d{5}\b\s*,?\s*([^,()]+?)(?:\s*[,(]|\s*\.\s*|\Z)", td_text)
            if m_cp:
                out["municipio"] = limpiar(m_cp.group(1))
            break

    return out


def parse_tabla_indicador_pau(html: str) -> dict[str, tuple[str, str]]:
    """
    Parsea la tabla PAU/EVAU del portal en su formato real (transpuesto):

        | PAU/EVAU            | 2019-2020 | 2020-2021 | ... |
        | Centro              | 8.89      | 8.57      | ... |
        | Comunidad de Madrid | 6.51      | 6.51      | ... |

    El portal solo muestra UN indicador a la vez (Nota media / Nº presentados /
    % aptos / Nota media aptos), seleccionable con radios. Esta función parsea
    la tabla actual sin saber qué indicador es; el caller acumula los 4.

    Devuelve {curso: (valor_centro, valor_cm)}.
    """
    soup = BeautifulSoup(html, "lxml")
    out: dict[str, tuple[str, str]] = {}

    for table in soup.find_all("table"):
        thead = table.find("thead")
        if not thead:
            continue
        cabecera = [limpiar(td.get_text(" ", strip=True)) for td in thead.find_all(["th", "td"])]
        if not cabecera or "PAU" not in cabecera[0].upper():
            continue
        cursos = cabecera[1:]

        valores_centro: list[str] = []
        valores_cm: list[str] = []
        for tr in table.find_all("tr"):
            celdas = [limpiar(td.get_text(" ", strip=True)) for td in tr.find_all(["td", "th"])]
            if not celdas:
                continue
            etiqueta = celdas[0].lower()
            if etiqueta == "centro":
                valores_centro = celdas[1:]
            elif "comunidad" in etiqueta:
                valores_cm = celdas[1:]

        for i, curso in enumerate(cursos):
            c = valores_centro[i] if i < len(valores_centro) else ""
            cm = valores_cm[i] if i < len(valores_cm) else ""
            out[curso] = (c, cm)
        return out

    return out


_CAMPOS_LEGACY = (
    "nota_media_centro",
    "nota_media_cm",
    "n_presentados",
    "pct_aptos_centro",
    "pct_aptos_cm",
    "nota_media_aptos_centro",
    "nota_media_aptos_cm",
)


def parse_tabla_evau(html: str, codigo: str, meta: dict[str, str]) -> list[ResultadoEvAU]:
    """
    Parser de respaldo (formato no-transpuesto, fila por curso). Se mantiene
    para compatibilidad con `test_parsers.py` y como fallback si el portal
    cambiara su estructura.
    """
    soup = BeautifulSoup(html, "lxml")
    resultados: list[ResultadoEvAU] = []

    candidatas = [
        table for table in soup.find_all("table")
        if any(k in table.get_text(" ", strip=True).lower()
               for k in ("bloque obligatorio", "fase general", "evau", "pau"))
    ]

    for table in candidatas:
        for tr in table.find_all("tr"):
            celdas = [limpiar(td.get_text(" ", strip=True)) for td in tr.find_all(["td", "th"])]
            if not celdas or not re.match(r"^\d{4}[/\-]\d{2,4}", celdas[0]):
                continue
            r = ResultadoEvAU(codigo_centro=codigo, **meta)
            r.curso = celdas[0]
            for nombre, valor in zip(_CAMPOS_LEGACY, (num_es(c) for c in celdas[1:]), strict=False):
                setattr(r, nombre, valor)
            resultados.append(r)

    return resultados


# =============================================================================
# INTERACCIÓN CON LA PÁGINA
# =============================================================================

async def _activar_pestana_resultados(page: Page) -> None:
    """Pulsa la pestaña 'RESULTADOS ACADÉMICOS' probando varios selectores."""
    for selector in (
        "text=/RESULTADOS\\s*ACAD/i",
        "td:has-text('RESULTADOS')",
        "a:has-text('RESULTADOS')",
    ):
        try:
            await page.click(selector, timeout=3000)
            await page.wait_for_load_state("networkidle", timeout=10_000)
            return
        except Exception as e:
            logger.debug("Pestaña RESULTADOS — selector %r falló: %s", selector, e)
    logger.warning("No se pudo activar la pestaña 'RESULTADOS ACADÉMICOS'")


async def _seleccionar_indicador_pau(page: Page, valor: str, img_pau_id: str | None) -> None:
    """Pulsa el radio del indicador y espera a que la tabla se refresque."""
    src_previo = None
    if img_pau_id:
        src_previo = await page.evaluate(
            "(id) => { const el = document.getElementById(id); return el ? el.src : null; }",
            img_pau_id,
        )

    await page.click(
        f"input[type='radio'][name^='tipoResPAU.grafica'][value='{valor}']",
        timeout=3000,
    )

    if img_pau_id and src_previo:
        try:
            await page.wait_for_function(
                "([id, prev]) => { const el = document.getElementById(id); return el && el.src !== prev; }",
                arg=[img_pau_id, src_previo],
                timeout=8_000,
            )
            return
        except PWTimeout:
            logger.debug("Cambio de src de la imagen no detectado para indicador %s", valor)

    # Fallback: esperar networkidle + pausa fija si no detectamos cambio de img.
    with contextlib.suppress(PWTimeout):
        await page.wait_for_load_state("networkidle", timeout=8_000)
    await asyncio.sleep(PAUSA_TRAS_CLICK_RADIO_S)


# Map indicador → (valor del radio, par de campos del dataclass).
# El segundo elemento del par es None cuando el indicador no expone valor de CM
# (caso "Nº presentados", que en el portal solo muestra fila Centro).
_INDICADORES_PAU: tuple[tuple[str, str, tuple[str, str | None]], ...] = (
    ("0", "nota_media",        ("nota_media_centro",       "nota_media_cm")),
    ("1", "n_presentados",     ("n_presentados",           None)),
    ("2", "pct_aptos",         ("pct_aptos_centro",        "pct_aptos_cm")),
    ("3", "nota_media_aptos",  ("nota_media_aptos_centro", "nota_media_aptos_cm")),
)


async def obtener_evau_de_centro(
    page: Page, codigo: str,
) -> tuple[dict[str, str], list[ResultadoEvAU], str]:
    """
    Para un código de centro, navega a su ficha, activa la pestaña
    "RESULTADOS ACADÉMICOS" y recorre los 4 radios del bloque PAU/EVAU
    (Nota media, Nº presentados, % aptos, Nota media aptos) parseando la tabla
    tras cada cambio.

    Devuelve (metadatos, lista_de_filas, html_capturado).
    """
    url = f"{URL_FICHA}?cdCentro={codigo}"
    await page.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT_PAGINA_MS)

    html_inicial = await page.content()
    meta = parse_datos_centro(html_inicial)

    await _activar_pestana_resultados(page)
    await asyncio.sleep(PAUSA_POST_PESTANA_S)

    # Localizar la <img> del gráfico PAU/EVAU para usar el cambio de src como
    # señal de que la AJAX de mostrarGrafica() ya ha refrescado la tabla.
    img_pau_id: str | None = await page.evaluate("""
        () => {
            const radio = document.querySelector("input[name^='tipoResPAU.grafica']");
            if (!radio) return null;
            const m = radio.name.match(/grafica(\\d+)/);
            return m ? `imagen.grafica${m[1]}` : null;
        }
    """)

    # Recorrer los 4 indicadores. Para el primero (value=0) la tabla ya está en
    # la página tras activar la pestaña — no hace falta clicar el radio.
    datos: dict[str, dict[str, tuple[str, str]]] = {}
    html_final = await page.content()

    for valor, clave, _ in _INDICADORES_PAU:
        if valor != "0":
            try:
                await _seleccionar_indicador_pau(page, valor, img_pau_id)
            except Exception as e:
                logger.debug("Indicador %s (%s) no clicable: %s", valor, clave, e)
                continue
            html_final = await page.content()
        tabla = parse_tabla_indicador_pau(html_final)
        if tabla:
            datos[clave] = tabla

    # Combinar los 4 indicadores en filas por curso.
    cursos = sorted({c for d in datos.values() for c in d})
    resultados: list[ResultadoEvAU] = []
    for curso in cursos:
        r = ResultadoEvAU(codigo_centro=codigo, curso=curso, **meta)
        for _, clave, (campo_centro, campo_cm) in _INDICADORES_PAU:
            valores = datos.get(clave, {}).get(curso)
            if valores is None:
                continue
            v_centro, v_cm = valores
            setattr(r, campo_centro, num_es(v_centro))
            if campo_cm is not None:
                setattr(r, campo_cm, num_es(v_cm))
        resultados.append(r)

    # Fallback: si el formato transpuesto no devuelve nada (cambio de portal),
    # probar el parser antiguo sobre el HTML final.
    if not resultados:
        resultados = parse_tabla_evau(html_final, codigo, meta)

    return meta, resultados, html_final


# =============================================================================
# CHECKPOINTING (para reanudar)
# =============================================================================

class Checkpoint:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.hechos: set[str] = set()
        self.errores: dict[str, str] = {}
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                self.hechos = set(data.get("hechos", []))
                self.errores = dict(data.get("errores", {}))
            except (json.JSONDecodeError, OSError) as e:
                logger.warning(
                    "Checkpoint %s ilegible (%s); empezando de cero. "
                    "Si tenías progreso, renombra el fichero antes de seguir.",
                    path, e,
                )

    def marcar_hecho(self, codigo: str) -> None:
        self.hechos.add(codigo)
        self.errores.pop(codigo, None)
        self._guardar()

    def marcar_error(self, codigo: str, msg: str) -> None:
        self.errores[codigo] = msg
        self._guardar()

    def _guardar(self) -> None:
        self.path.write_text(
            json.dumps({"hechos": sorted(self.hechos), "errores": self.errores},
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


# =============================================================================
# COMANDOS
# =============================================================================

async def cmd_probar(codigo: str, headful: bool = False) -> None:
    """Modo diagnóstico: scrapea un solo centro y muestra resultados."""
    print(f"\n=== DIAGNÓSTICO de centro {codigo} ===\n")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not headful)
        context = await browser.new_context(user_agent=USER_AGENT)
        page = await context.new_page()
        try:
            meta, resultados, html = await obtener_evau_de_centro(page, codigo)
        finally:
            await browser.close()

    print("--- Metadatos ---")
    for k, v in meta.items():
        print(f"  {k}: {v}")

    print(f"\n--- Resultados EvAU ({len(resultados)} filas) ---")
    if not resultados:
        print("  ⚠️  No se han encontrado datos EvAU en este centro.")
        print("      (puede ser que no oferte Bachillerato o que no haya datos publicados)")
        # Guardar HTML para depuración
        debug_path = Path(f"debug_{codigo}.html")
        debug_path.write_text(html, encoding="utf-8")
        print(f"      HTML guardado en {debug_path} para depuración.")
    else:
        cabecera = ["curso", "nota_media_centro", "nota_media_cm", "n_presentados",
                    "pct_aptos_centro", "pct_aptos_cm",
                    "nota_media_aptos_centro", "nota_media_aptos_cm"]
        print("  " + " | ".join(cabecera))
        for r in resultados:
            d = asdict(r)
            print("  " + " | ".join(str(d.get(c, "")) for c in cabecera))


async def _click_primero_que_funcione(page: Page, selectores: tuple[str, ...], etiqueta: str) -> bool:
    """Intenta varios selectores hasta que uno responde; loggea los fallos."""
    for sel in selectores:
        try:
            await page.click(sel, timeout=3000)
            return True
        except Exception as e:
            logger.debug("%s — selector %r falló: %s", etiqueta, sel, e)
    logger.warning("%s — ningún selector funcionó", etiqueta)
    return False


async def cmd_listar(output: Path, headful: bool = False) -> None:
    """
    Navega el buscador y descarga la lista de centros con Bachillerato.
    Genera un CSV con las columnas mínimas necesarias para el scraper.
    """
    print("\n=== LISTANDO CENTROS CON BACHILLERATO ===\n")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not headful)
        context = await browser.new_context(
            user_agent=USER_AGENT,
            accept_downloads=True,
        )
        page = await context.new_page()
        try:
            await page.goto(URL_BUSCADOR, wait_until="domcontentloaded", timeout=TIMEOUT_PAGINA_MS)
            await asyncio.sleep(1)

            await _click_primero_que_funcione(
                page, ("text=/incluir otros criterios/i",), "incluir otros criterios"
            )

            # Marcar todas las áreas (5 zonas).
            try:
                checkboxes = await page.query_selector_all("input[type='checkbox'][name*='zona' i]")
                for cb in checkboxes:
                    if not await cb.is_checked():
                        await cb.check()
            except Exception as e:
                logger.warning("No se pudieron marcar las zonas: %s", e)

            # Filtrar por enseñanza = Bachillerato.
            try:
                await page.check("input[type='checkbox']:near(:text('Bachillerato'))")
            except Exception as e:
                logger.warning("No se pudo marcar 'Bachillerato': %s", e)

            await _click_primero_que_funcione(
                page,
                (
                    "text=/FINALIZAR Y VER LISTADO/i",
                    "input[value*='Finalizar' i]",
                    "button:has-text('FINALIZAR')",
                ),
                "Finalizar y ver listado",
            )
            try:
                await page.wait_for_load_state("networkidle", timeout=15_000)
            except PWTimeout:
                logger.debug("networkidle no alcanzado tras 'Finalizar'")

            async with page.expect_download(timeout=30_000) as dl_info:
                await _click_primero_que_funcione(
                    page,
                    (
                        "text=/DESCARGAR LISTADO/i",
                        "a:has-text('DESCARGAR')",
                        "button:has-text('DESCARGAR')",
                    ),
                    "Descargar listado",
                )
            download = await dl_info.value
            tmp_path = await download.path()

            # Convertir el CSV de windows-1252 a UTF-8 y eliminar la cabecera
            # de consulta ("CONSULTA DE CENTROS Y SERVICIOS EDUCATIVOS;...").
            raw = Path(tmp_path).read_bytes()
            text = raw.decode("windows-1252", errors="replace")
            lineas = [
                line for line in text.splitlines()
                if not line.startswith("CONSULTA DE CENTROS")
            ]
            output.write_text("\n".join(lineas), encoding="utf-8")
        finally:
            await browser.close()

    print(f"✓ Listado guardado en {output}")


_RE_CODIGO_CENTRO = re.compile(r"^\d{8}$")


def _leer_csv_centros(input_csv: Path) -> list[dict[str, object]]:
    """
    Lee el CSV de centros tolerando los dos formatos comunes:
      1) Bajado del buscador oficial: codificación windows-1252, separador `;`,
         primera línea "CONSULTA DE CENTROS Y SERVICIOS EDUCATIVOS;;...;;",
         cabeceras reales en la segunda línea (`AREA TERRITORIAL;CODIGO CENTRO;...`).
      2) CSV simple en UTF-8 con una columna `codigo`.
    """
    raw = Path(input_csv).read_bytes()
    for enc in ("utf-8", "windows-1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", errors="replace")

    # Saltar cabeceras de consulta y líneas vacías al principio.
    lineas = text.splitlines()
    while lineas and (not lineas[0].strip()
                      or lineas[0].upper().startswith("CONSULTA DE CENTROS")):
        lineas.pop(0)
    text = "\n".join(lineas)

    sample = text[:2048]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=delim)

    centros: list[dict[str, object]] = []
    for row in reader:
        codigo = (row.get("CODIGO CENTRO") or row.get("codigo") or
                  row.get("CODIGO") or row.get("CODIGO_CENTRO") or "").strip()
        if _RE_CODIGO_CENTRO.match(codigo):
            centros.append({"codigo": codigo, "row": row})
    return centros


def _cabeceras_compatibles(output_csv: Path, fieldnames: list[str]) -> bool:
    """Comprueba que el CSV de salida existente tiene las mismas cabeceras."""
    try:
        with open(output_csv, encoding="utf-8", newline="") as f:
            cabecera = next(csv.reader(f), None)
    except OSError:
        return False
    return cabecera == fieldnames


async def cmd_scrape(
    input_csv: Path, output_csv: Path, checkpoint_path: Path, headful: bool = False,
) -> None:
    """Itera sobre los centros del CSV y scrapea EvAU de cada uno."""
    centros = _leer_csv_centros(input_csv)

    print(f"Centros a procesar: {len(centros)}")
    if not centros:
        print("⚠️  No se encontraron códigos de centro válidos en el CSV.")
        return

    cp = Checkpoint(checkpoint_path)
    pendientes = [c for c in centros if c["codigo"] not in cp.hechos]
    print(f"Pendientes (sin completar): {len(pendientes)}")

    fieldnames = list(ResultadoEvAU.__dataclass_fields__.keys())
    nuevo_archivo = not output_csv.exists()
    if not nuevo_archivo and not _cabeceras_compatibles(output_csv, fieldnames):
        raise SystemExit(
            f"\n⚠️  {output_csv} ya existe pero sus cabeceras no coinciden con el "
            f"esquema actual del scraper. Renómbralo o bórralo antes de continuar.\n"
            f"   Esperado: {fieldnames}"
        )

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not headful)
        context = await browser.new_context(user_agent=USER_AGENT)
        page = await context.new_page()

        with open(output_csv, "a", encoding="utf-8", newline="") as fout:
            writer = csv.DictWriter(fout, fieldnames=fieldnames)
            if nuevo_archivo:
                writer.writeheader()
                fout.flush()

            for i, centro in enumerate(pendientes, 1):
                codigo = centro["codigo"]
                t0 = time.time()
                try:
                    meta, resultados, _ = await obtener_evau_de_centro(page, codigo)
                    if not resultados:
                        # Marcamos como hecho con una fila vacía para no reintentar.
                        writer.writerow(asdict(ResultadoEvAU(codigo_centro=codigo, **meta)))
                        cp.marcar_hecho(codigo)
                        estado = "sin datos EvAU"
                    else:
                        for r in resultados:
                            writer.writerow(asdict(r))
                        cp.marcar_hecho(codigo)
                        estado = f"{len(resultados)} cursos"
                    fout.flush()
                    nombre = (meta.get("nombre_centro") or "?")[:35]
                    print(f"[{i}/{len(pendientes)}] {codigo} ({nombre}): "
                          f"{estado} ({time.time() - t0:.1f}s)")
                except Exception as e:
                    cp.marcar_error(codigo, f"{type(e).__name__}: {e}")
                    print(f"[{i}/{len(pendientes)}] {codigo}: "
                          f"ERROR — {type(e).__name__}: {str(e)[:80]}")
                await random_delay()

        await browser.close()

    print(f"\n✓ Completado. Resultados en {output_csv}")
    if cp.errores:
        print(f"⚠️  {len(cp.errores)} centros con error. Revisa {checkpoint_path} "
              f"y vuelve a ejecutar para reintentarlos.")


# =============================================================================
# CLI
# =============================================================================

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-v", "--verbose", action="count", default=0,
        help="Aumenta el nivel de logging (-v = INFO, -vv = DEBUG)",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_probar = sub.add_parser("probar", help="Diagnóstico: scrapea un solo centro")
    p_probar.add_argument("--codigo", required=True, help="Código de centro de 8 dígitos")
    p_probar.add_argument("--headful", action="store_true", help="Mostrar el navegador (debugging)")

    p_listar = sub.add_parser("listar", help="Descarga el listado de centros del buscador")
    p_listar.add_argument("--output", type=Path, default=Path("centros.csv"))
    p_listar.add_argument("--headful", action="store_true")

    p_scrape = sub.add_parser("scrape", help="Scraping masivo a partir de un CSV de centros")
    p_scrape.add_argument("--input", type=Path, required=True, help="CSV con columna CODIGO CENTRO")
    p_scrape.add_argument("--output", type=Path, default=Path("evau_madrid.csv"))
    p_scrape.add_argument("--checkpoint", type=Path, default=Path("checkpoint.json"))
    p_scrape.add_argument("--headful", action="store_true")

    args = parser.parse_args()

    nivel = logging.WARNING if args.verbose == 0 else logging.INFO if args.verbose == 1 else logging.DEBUG
    logging.basicConfig(
        level=nivel,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    if args.cmd == "probar":
        asyncio.run(cmd_probar(args.codigo, headful=args.headful))
    elif args.cmd == "listar":
        asyncio.run(cmd_listar(args.output, headful=args.headful))
    elif args.cmd == "scrape":
        asyncio.run(cmd_scrape(args.input, args.output, args.checkpoint, headful=args.headful))


if __name__ == "__main__":
    main()
