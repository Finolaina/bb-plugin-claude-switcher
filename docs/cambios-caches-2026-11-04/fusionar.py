#!/usr/bin/env python3
"""Une la salida de primeras.py de cada máquina: una fila por tanda, la petición más temprana."""
import json
import sys

vistas = {}
for linea in sys.stdin:
    linea = linea.strip()
    if not linea:
        continue
    d = json.loads(linea)
    k = (d["h"], d["t"])
    if k not in vistas or d["at"] < vistas[k][0]:
        vistas[k] = (d["at"], linea)
print("\n".join(vistas[k][1] for k in sorted(vistas)))
