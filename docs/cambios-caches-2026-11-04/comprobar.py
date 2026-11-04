#!/usr/bin/env python3
"""Canarios del informe: casos leídos a mano en el evento de bb, que el cálculo debe repetir.

Uso: comprobar.py  (sale 1 si alguno falla). Los valores salen de `bb thread log` de cada hilo, no de analizar.py.
"""
import importlib.util
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location("analizar", os.path.join(AQUI, "analizar.py"))
an = importlib.util.module_from_spec(_s)
_s.loader.exec_module(an)
r = an.analizar()
F = r["filas"]
fallos = 0


def caso(nombre, ok):
    global fallos
    print(("ok   " if ok else "FALLA"), nombre)
    fallos += 0 if ok else 1


def filas(hilo):
    return [f for f in F if f["hilo"] == hilo]


# DEBE SALIR: la mudanza al i9 cambió a las 06:05, tras más de 2 h sin peticiones, y no mató nada.
c = filas("thr_4kfyv6knny")
caso("el canario del encargo sale en la tabla, joytorm → team5", any(f["de"] == "joytorm" and f["a"] == "team5" for f in c))
caso("y está fría, no matada: 130,9 min sin peticiones", all(f["clase"] != "mata" for f in c) and any(f["clase"] == "fria" and f["hueco_min"] > 120 for f in c))

# DEBE SER matada: el 11-03 a las 23:04 UTC el evento de bb da «session rebuilt» y una escritura de 170.249.
c = [f for f in filas("thr_pf5wnyyu4p") if f["de"] == "siloeads" and f["a"] == "aitor"]
caso("un cambio con reconstrucción y escritura de 170.249 tokens cuenta como matada", any(f["clase"] == "mata" and f["escribe1"] > 100_000 for f in c))

# NO DEBE SER matada: un `tell` en un turno abierto trae una cuenta nueva, pero el proceso sigue en la suya.
c = filas("thr_n7eshs92vw")
caso("un `tell` con el turno abierto no cuenta como cambio de cuenta", not any(f["a"] == "siloeads" and f["clase"] == "mata" for f in c))

# El método: entre organizaciones la caché se pierde; entre Team, no.
otras = [f for f in F if not f["misma_org"] and f["hueco_min"] < 60 and f["clase"] in ("mata", "sin-explicar")]
team = [f for f in F if f["misma_org"] and f["hueco_min"] < 60 and f["clase"] in ("mata", "misma-org")]
caso("entre organizaciones se pierde en más del 90 %", sum(f["clase"] == "mata" for f in otras) / len(otras) > 0.9)
caso("entre Team se conserva en más del 80 %", sum(f["clase"] == "misma-org" for f in team) / len(team) > 0.8)
caso("ninguna tanda sin su primera petición", r["sin_primera"] == 0)
sys.exit(1 if fallos else 0)
