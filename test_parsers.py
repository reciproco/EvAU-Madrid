"""Test rápido de las funciones de parseo con HTML representativo."""
import sys
sys.path.insert(0, ".")
from scraper_evau_madrid import parse_datos_centro, parse_tabla_evau, num_es

# HTML representativo de la cabecera de un centro (basado en lo observado)
HTML_HEADER = """
<table>
<tr><td>NOMBRE DEL CENTRO:</td><td><b>IES "calatalifa"</b></td></tr>
<tr><td>Tipo (denominación genérica): <b>INSTITUTO DE EDUCACIÓN SECUNDARIA</b></td></tr>
<tr><td>Titularidad: <b>Público</b> Titular: <b>COMUNIDAD DE MADRID</b></td></tr>
<tr><td>Código del centro: <b>28041512</b> Área territorial: <b>Madrid-Sur</b></td></tr>
<tr><td>Dirección: <b>calle san antonio 2, 28670, Villaviciosa de Odón.</b></td></tr>
</table>
"""

# HTML representativo de la tabla EvAU (la de RESULTADOS ACADÉMICOS → PAU/EVAU)
HTML_TABLA = """
<table>
<caption>Resultados PAU/EvAU - Bloque obligatorio / Fase general</caption>
<thead>
  <tr>
    <th>Curso</th>
    <th>Nota media centro</th>
    <th>Nota media CM</th>
    <th>Nº presentados</th>
    <th>% aptos centro</th>
    <th>% aptos CM</th>
    <th>Nota media aptos centro</th>
    <th>Nota media aptos CM</th>
  </tr>
</thead>
<tbody>
  <tr><td>2023/24</td><td>6,80</td><td>6,32</td><td>87</td><td>97,70%</td><td>94,22%</td><td>6,95</td><td>6,55</td></tr>
  <tr><td>2022/23</td><td>6,55</td><td>6,30</td><td>92</td><td>96,74%</td><td>91,77%</td><td>6,72</td><td>6,55</td></tr>
  <tr><td>2021/22</td><td>6,40</td><td>6,37</td><td>85</td><td>95,29%</td><td>93,85%</td><td>6,60</td><td>6,55</td></tr>
</tbody>
</table>
"""

print("=== Test parse_datos_centro ===")
meta = parse_datos_centro(HTML_HEADER)
for k, v in meta.items():
    print(f"  {k}: {v!r}")

print("\n=== Test parse_tabla_evau ===")
filas = parse_tabla_evau(HTML_TABLA, "28041512", meta)
print(f"  Filas extraídas: {len(filas)}")
for r in filas:
    print(f"  - {r.curso}: nota={r.nota_media_centro}, presentados={r.n_presentados}, "
          f"%aptos={r.pct_aptos_centro}, nota_aptos={r.nota_media_aptos_centro}")

print("\n=== Test num_es ===")
for s in ["7,64", "8.25", "97,70%", "-", "92", ""]:
    print(f"  {s!r} → {num_es(s)!r}")
