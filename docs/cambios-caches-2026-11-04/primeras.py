#!/usr/bin/env python3
"""La primera petición al modelo de cada tanda, leída de la transcripción de Claude Code de esta máquina.

Corre en cada máquina con hilos (servidor de bb, Mac, i9). Entrada por stdin: JSON
[{"h": hilo, "s": sesión, "t": ms desde}...]. Salida por stdout: JSONL con
{"h","s","t","at","lee","escribe","entrada","modelo"} de la primera respuesta del agente principal
(no de subagentes) con hora >= t. Ni textos ni rutas: solo tokens y hora.
"""
import glob
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone


def ms(iso):
    return int(datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp() * 1000)


def peticiones(ruta):
    with open(ruta, encoding="utf-8", errors="replace") as f:
        for linea in f:
            if '"usage"' not in linea or '"assistant"' not in linea:
                continue
            try:
                d = json.loads(linea)
            except ValueError:
                continue
            if d.get("type") != "assistant" or d.get("isSidechain"):
                continue
            m = d.get("message") or {}
            u = m.get("usage")
            ts = d.get("timestamp")
            if not u or not ts or m.get("model") == "<synthetic>":
                continue
            lee = u.get("cache_read_input_tokens") or 0
            escribe = u.get("cache_creation_input_tokens") or 0
            yield ms(ts), lee, escribe, u.get("input_tokens") or 0, m.get("model")


def main():
    consultas = json.load(sys.stdin)
    por_sesion = defaultdict(list)
    for c in consultas:
        por_sesion[c["s"]].append(c)
    raices = [os.path.expanduser("~/.claude/projects")] + glob.glob(os.path.expanduser("~/.claude-cuentas/*/projects"))
    indice = defaultdict(list)
    for raiz in raices:
        for carpeta in glob.glob(os.path.join(raiz, "*")):
            try:
                for nombre in os.listdir(carpeta):
                    if nombre.endswith(".jsonl"):
                        s = nombre[:-6]
                        if s in por_sesion:
                            indice[s].append(os.path.join(carpeta, nombre))
            except OSError:
                pass
    for s, cs in por_sesion.items():
        vistas = []
        for ruta in set(os.path.realpath(r) for r in indice.get(s, [])):
            try:
                vistas.extend(peticiones(ruta))
            except OSError:
                continue
        if not vistas:
            continue
        vistas = sorted(set(vistas), key=lambda v: v[0])
        for c in cs:
            # La transcripción tiene segundos enteros; un margen de 1 s no cruza de tanda en la práctica.
            for at, lee, escribe, entrada, modelo in vistas:
                if at >= c["t"] - 1000:
                    print(json.dumps({"h": c["h"], "s": s, "t": c["t"], "at": at, "lee": lee, "escribe": escribe, "entrada": entrada, "modelo": modelo}, separators=(",", ":")))
                    break


if __name__ == "__main__":
    main()
