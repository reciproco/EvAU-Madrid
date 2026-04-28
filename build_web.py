#!/usr/bin/env python3
"""
Convierte `evau.csv` en `web/evau.js` (datos inlineados para la SPA).

Si pasas también `--centros <listado>.csv` (el CSV oficial del buscador con
columnas DOMICILIO / COD. POSTAL / MUNICIPIO), la dirección completa se mergea
por código de centro y se publica en la SPA junto con un enlace a OSM.

Uso:
    python build_web.py [--input evau.csv] [--centros 28-04-2026-(985).csv]
                        [--output web/evau.js]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
from pathlib import Path


def to_num(s: str | None) -> float | None:
    """Convierte un string del CSV a float; vacíos y no-números → None."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def cargar_direcciones(centros_csv: Path) -> dict[str, str]:
    """
    Lee el CSV oficial de centros (windows-1252, separador `;`, primera línea
    "CONSULTA DE CENTROS...") y devuelve {codigo_centro: direccion_completa}.
    """
    raw = centros_csv.read_bytes()
    for enc in ("utf-8", "windows-1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", errors="replace")

    lineas = text.splitlines()
    while lineas and (not lineas[0].strip()
                      or lineas[0].upper().startswith("CONSULTA DE CENTROS")):
        lineas.pop(0)

    reader = csv.DictReader(io.StringIO("\n".join(lineas)), delimiter=";")
    out: dict[str, str] = {}
    for row in reader:
        codigo = (row.get("CODIGO CENTRO") or "").strip()
        if not codigo.isdigit():
            continue
        domicilio = (row.get("DOMICILIO") or "").strip().rstrip(",").strip()
        cp        = (row.get("COD. POSTAL") or "").strip()
        municipio = (row.get("MUNICIPIO") or "").strip()
        partes = [p for p in (domicilio, cp, municipio) if p and p != "-"]
        if partes:
            out[codigo] = ", ".join(partes)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--input", type=Path, default=Path("evau.csv"))
    ap.add_argument(
        "--centros", type=Path, default=None,
        help="CSV oficial del buscador (con DOMICILIO/COD. POSTAL/MUNICIPIO) "
             "para mergear la dirección por código de centro.",
    )
    ap.add_argument("--output", type=Path, default=Path("web/evau.js"))
    args = ap.parse_args()

    with open(args.input, encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    direcciones = cargar_direcciones(args.centros) if args.centros else {}

    # Quedarnos solo con filas que tienen `curso` (las que carecen del campo
    # son centros que no exponen EvAU — entran al CSV como placeholder pero
    # no son útiles para la SPA).
    filas = [r for r in rows if r.get("curso")]

    slim = [
        {
            "c": r["codigo_centro"],
            "n": r["nombre_centro"],
            "t": r["tipo_centro"],
            "tit": r["titularidad"],
            "mun": r["municipio"],
            "dir": direcciones.get(r["codigo_centro"], ""),
            "a": r["area_territorial"],
            "curso": r["curso"],
            "nm": to_num(r["nota_media_centro"]),
            "ncm": to_num(r["nota_media_cm"]),
            "np": to_num(r["n_presentados"]),
            "pa": to_num(r["pct_aptos_centro"]),
            "pacm": to_num(r["pct_aptos_cm"]),
            "na": to_num(r["nota_media_aptos_centro"]),
            "nacm": to_num(r["nota_media_aptos_cm"]),
        }
        for r in filas
    ]

    # Cuento dos cosas distintas:
    #   `n_centros`            — todos los centros del CSV (con o sin EvAU).
    #   `n_centros_con_datos`  — centros con al menos un curso de nota media.
    centros_unicos = {r["codigo_centro"] for r in rows}
    centros_con_datos = {r["c"] for r in slim if r["nm"] is not None}

    payload = {
        "rows": slim,
        "meta": {
            "n_filas": len(slim),
            "n_centros": len(centros_unicos),
            "n_centros_con_datos": len(centros_con_datos),
            "cursos": sorted({r["curso"] for r in slim}),
        },
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    js = "window.DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n"
    args.output.write_text(js, encoding="utf-8")

    print(f"✓ {args.output} ({len(js) / 1024:.0f} KB)")
    print(f"  Filas: {payload['meta']['n_filas']}")
    print(f"  Centros únicos: {payload['meta']['n_centros']}")
    print(f"  Centros con datos EvAU: {payload['meta']['n_centros_con_datos']}")
    print(f"  Cursos: {', '.join(payload['meta']['cursos'])}")
    if direcciones:
        con_dir = sum(1 for r in slim if r["dir"])
        print(f"  Direcciones mergeadas: {con_dir} / {len(slim)} filas "
              f"(fuente: {args.centros})")


if __name__ == "__main__":
    main()
