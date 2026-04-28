#!/usr/bin/env python3
"""
Convierte `evau.csv` en `web/evau.js` (datos inlineados para la SPA).

Uso:
    python build_web.py [--input evau.csv] [--output web/evau.js]
"""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def to_num(s: str) -> float | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, default=Path("evau.csv"))
    ap.add_argument("--output", type=Path, default=Path("web/evau.js"))
    args = ap.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    # Quedarnos con filas que tienen curso (las vacías son centros sin EvAU)
    filas = [r for r in rows if r.get("curso")]

    slim = [
        {
            "c": r["codigo_centro"],
            "n": r["nombre_centro"],
            "t": r["tipo_centro"],
            "tit": r["titularidad"],
            "mun": r["municipio"],
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

    print(f"✓ {args.output} ({len(js)/1024:.0f} KB)")
    print(f"  Filas: {payload['meta']['n_filas']}")
    print(f"  Centros únicos: {payload['meta']['n_centros']}")
    print(f"  Centros con datos EvAU: {payload['meta']['n_centros_con_datos']}")
    print(f"  Cursos: {', '.join(payload['meta']['cursos'])}")


if __name__ == "__main__":
    main()
