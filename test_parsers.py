"""
Tests de las funciones de parseo y normalización numérica.

Compatible con `python test_parsers.py` (ejecuta los asserts y avisa) y con
`pytest test_parsers.py` (cada función `test_*` se descubre y corre como caso).
"""
from __future__ import annotations

from scraper_evau_madrid import num_es, parse_datos_centro, parse_tabla_evau

# HTML representativo de la cabecera de un centro (basado en lo observado).
HTML_HEADER = """
<table>
<tr><td>NOMBRE DEL CENTRO:</td><td><b>IES "calatalifa"</b></td></tr>
<tr><td>Tipo (denominación genérica): <b>INSTITUTO DE EDUCACIÓN SECUNDARIA</b></td></tr>
<tr><td>Titularidad: <b>Público</b> Titular: <b>COMUNIDAD DE MADRID</b></td></tr>
<tr><td>Código del centro: <b>28041512</b> Área territorial: <b>Madrid-Sur</b></td></tr>
<tr><td>Dirección: <b>calle san antonio 2, 28670, Villaviciosa de Odón.</b></td></tr>
</table>
"""

# HTML representativo de la tabla EvAU legacy (formato no-transpuesto).
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


def test_parse_datos_centro() -> None:
    meta = parse_datos_centro(HTML_HEADER)
    assert meta["nombre_centro"] == 'IES "calatalifa"'
    assert meta["tipo_centro"] == "INSTITUTO DE EDUCACIÓN SECUNDARIA"
    assert meta["titularidad"] == "Público"
    assert meta["area_territorial"] == "Madrid-Sur"
    assert meta["municipio"] == "Villaviciosa de Odón"


def test_parse_tabla_evau_legacy() -> None:
    meta = parse_datos_centro(HTML_HEADER)
    filas = parse_tabla_evau(HTML_TABLA, "28041512", meta)
    assert len(filas) == 3

    cursos = [r.curso for r in filas]
    assert cursos == ["2023/24", "2022/23", "2021/22"]

    primero = filas[0]
    assert primero.codigo_centro == "28041512"
    assert primero.nota_media_centro == "6.80"
    assert primero.nota_media_cm == "6.32"
    assert primero.n_presentados == "87"
    assert primero.pct_aptos_centro == "97.70"
    assert primero.pct_aptos_cm == "94.22"
    assert primero.nota_media_aptos_centro == "6.95"
    assert primero.nota_media_aptos_cm == "6.55"
    # La fila debe heredar los metadatos del centro.
    assert primero.nombre_centro == 'IES "calatalifa"'


def test_num_es() -> None:
    assert num_es("7,64") == "7.64"
    assert num_es("8.25") == "8.25"
    assert num_es("97,70%") == "97.70"
    assert num_es("-") == ""
    assert num_es("—") == ""
    assert num_es("n/d") == ""
    assert num_es("92") == "92"
    assert num_es("") == ""
    # Espacios y &nbsp; deben limpiarse.
    assert num_es(" 7,64\xa0") == "7.64"


if __name__ == "__main__":
    test_parse_datos_centro()
    test_parse_tabla_evau_legacy()
    test_num_es()
    print("✓ Todos los tests pasan.")
