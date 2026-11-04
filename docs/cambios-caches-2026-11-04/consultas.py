#!/usr/bin/env python3
"""Lista de tandas de la ventana para primeras.py. Uso: consultas.py <carpeta> > consultas.json"""
import importlib.util
import json
import os
import sys

E = sys.argv[1]
_s = importlib.util.spec_from_file_location("an", os.path.join(E, "analizar.py"))
an = importlib.util.module_from_spec(_s)
_s.loader.exec_module(an)
ahora = int(open(os.path.join(E, "ahora.txt"), encoding="utf-8").read())
salida = []
for h in an.leer_gz("hilos.jsonl.gz"):
    for t in an.tandas_de(h):
        if t["ini"] >= ahora - 7 * 86_400_000 and t["sesion"]:
            salida.append({"h": h["t"], "s": t["sesion"], "t": t["ini"]})
json.dump(salida, sys.stdout)
