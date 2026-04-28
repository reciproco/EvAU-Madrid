# Notas EvAU — Comunidad de Madrid

Web pública para consultar y comparar las notas medias de la EvAU (bloque
obligatorio / fase general) de cada centro educativo de la Comunidad de Madrid.

> 🔗 [demo](https://reciproco.github.io/EvAU-Madrid/)

Incluye:

- Un **scraper** en Python que extrae los datos del portal oficial de la
  Consejería de Educación (la misma fuente que usan El Mundo y ABC para sus
  rankings).
- Una **SPA estática** (HTML + JS, sin backend) que sirve un ranking ordenable,
  filtros por área/titularidad/búsqueda, gráficos de evolución por centro y
  modo comparador entre varios centros.

**Fuente original de los datos:** [Servicio Web a Padres de Alumnos](https://gestiona.comunidad.madrid/wpad_pub/run/j/MostrarFichaCentro.icm) de la
Consejería de Educación, Universidades, Ciencia y Portavocía de la Comunidad
de Madrid.

## ¿Por qué un scraper?

La Comunidad de Madrid **no publica los datos en formato descargable** centro
por centro. Solo se pueden consultar uno a uno en el portal, y los resultados
académicos se cargan vía AJAX (no aparecen en el HTML inicial de la página).
Por eso aquí usamos Playwright: pilota un navegador real y extrae los datos
después de la interacción.

## Instalación

```bash
pip install -r requirements.txt
python -m playwright install chromium
```

## Uso

### 1) Comprobar que funciona en un centro

Antes de lanzar el scraping masivo, prueba con un centro conocido:

```bash
python scraper_evau_madrid.py probar --codigo 28030939
```

`28030939` es el IES San Mateo, que suele liderar el ranking de la EvAU en la
red pública. Deberías ver algo así:

```
=== DIAGNÓSTICO de centro 28030939 ===

--- Metadatos ---
  nombre_centro: IES "san mateo"
  tipo_centro: INSTITUTO DE EDUCACIÓN SECUNDARIA
  titularidad: Público
  municipio: Madrid
  area_territorial: Madrid-Capital

--- Resultados EvAU (5 filas) ---
  curso | nota_media_centro | nota_media_cm | n_presentados | ...
  2023/24 | 8.25 | 6.32 | 102 | ...
  2022/23 | 8.35 | 6.30 | 121 | ...
  ...
```

> Si el modo diagnóstico **no devuelve filas** pero sí devuelve metadatos,
> añade el flag `--headful` para ver el navegador en acción y entender qué
> está pasando: `python scraper_evau_madrid.py probar --codigo 28030939 --headful`.
> El script también guarda el HTML capturado en `debug_<codigo>.html` cuando
> no encuentra datos, para que se pueda inspeccionar.

### 2) Conseguir el listado de centros con Bachillerato

Hay dos opciones.

**Opción A — Automática:**

```bash
python scraper_evau_madrid.py listar --output centros.csv
```

Esto navega el buscador, marca todas las áreas, filtra por Bachillerato y
descarga el CSV oficial (lo convierte de Windows-1252 a UTF-8 y elimina la
cabecera de consulta).

**Opción B — Manual (más fiable):**

1. Abre <https://gestiona.comunidad.madrid/wpad_pub/run/j/MostrarConsultaGeneral.icm>
2. Marca *"¿Quieres incluir otros criterios?"* y selecciona las 5 zonas
   en *"¿En qué zona?"*.
3. En *Tipo de enseñanza*, marca *Bachillerato*.
4. Pulsa *FINALIZAR Y VER LISTADO*.
5. Pulsa *DESCARGAR LISTADO*. Te bajará un CSV en codificación
   `windows-1252` separado por `;`. Conviértelo a UTF-8
   (en VSCode: *Reopen with Encoding → Save with Encoding UTF-8*).

El CSV resultante tiene columnas como `AREA TERRITORIAL`, `CODIGO CENTRO`,
`TIPO DE CENTRO`, `CENTRO`, `MUNICIPIO`, `TITULARIDAD`...

### 3) Scraping masivo

```bash
python scraper_evau_madrid.py scrape --input centros.csv --output evau.csv
```

- Es **reanudable**: si se corta (Ctrl+C, fallo de red...), vuelve a
  ejecutarlo y continuará desde el último centro completado. El estado se
  guarda en `checkpoint.json`.
- Hace una pausa aleatoria de 1.5–3 s entre centros para no saturar el portal.
- Tarda aproximadamente **20–40 minutos** para los ~600 centros con
  Bachillerato.

### 4) Visualizar los datos en una web

Una vez tengas `evau.csv`, genera la SPA de consulta:

```bash
python build_web.py
```

Esto crea `web/evau.js` con los datos inlineados. Para verlo:

```bash
cd web && python -m http.server 8000
# abre http://localhost:8000
```

(También puedes abrir `web/index.html` directamente en el navegador con
`file://`; los recursos están todos en relativo.)

La web ofrece:

- **Ranking** ordenable por cualquier columna y filtrable por área, titularidad
  y búsqueda libre (ignora acentos).
- **Detalle del centro** al pulsar una fila: gráfico de evolución del centro
  comparado con la media de la Comunidad de Madrid, y tabla con todos los
  cursos. Tabs para cambiar la métrica (nota media / nota media aptos / %
  aptos / nº presentados).
- **Comparador**: pulsa el `+` de varias filas y aparece una barra abajo con
  un botón *Ver comparativa* que superpone las series en un gráfico.

Si vuelves a scrapear, basta con re-ejecutar `python build_web.py` para
actualizar los datos de la web.

## Formato del CSV de salida

| columna | descripción |
|---------|-------------|
| `codigo_centro` | Código de 8 dígitos |
| `nombre_centro` | Nombre del centro |
| `tipo_centro` | IES, Colegio, etc. |
| `titularidad` | Público / Concertado / Privado |
| `municipio` | Municipio |
| `area_territorial` | Madrid-Capital, Madrid-Norte, ... |
| `curso` | `2023/24`, `2022/23`, ... |
| `modalidad` | Presencial / Nocturno / Distancia |
| `nota_media_centro` | Nota media del centro en el bloque obligatorio |
| `nota_media_cm` | Nota media de la Comunidad de Madrid |
| `n_presentados` | Nº de alumnos del centro presentados |
| `pct_aptos_centro` | % de aptos del centro |
| `pct_aptos_cm` | % de aptos de la Comunidad |
| `nota_media_aptos_centro` | Nota media solo de los aptos del centro |
| `nota_media_aptos_cm` | Nota media solo de los aptos de la CM |

## Notas técnicas

- El portal solo expone **el bloque obligatorio** (fase general) **de la
  convocatoria de junio**. La fase voluntaria y la convocatoria extraordinaria
  no están disponibles centro a centro.
- Los datos suelen llevar 1–2 cursos de retraso. La última publicación al
  preparar este scraper es del curso **2023/24**.
- Solo aparecen datos para centros que ofertan Bachillerato.
- Si el portal cambia su estructura (cambian las pestañas, los nombres del
  desplegable...), el script tiene varios *fallbacks* y modo `--headful` para
  depurar. La interacción se concentra en `obtener_evau_de_centro()`.

## Uso responsable

Estos son datos públicos publicados por la administración. Aun así:

- Identifica tu scraper con un User-Agent honesto si lo usas mucho.
- Respeta las pausas entre peticiones; no bajes el `DELAY_ENTRE_CENTROS` por
  debajo de 1 s.
- Si vas a usar los datos en una publicación, cita la fuente:
  *Consejería de Educación, Universidades, Ciencia y Portavocía
  de la Comunidad de Madrid*.


## Licencia

Código bajo licencia [MIT](LICENSE). Los datos educativos provienen de la
Comunidad de Madrid (información pública); cita la fuente al reutilizarlos.
