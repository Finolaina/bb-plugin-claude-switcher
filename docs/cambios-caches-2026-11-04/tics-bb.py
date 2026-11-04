#!/usr/bin/env python3
"""Cada tic de Calor que bb dio por turno, del evento `client/turn/requested`: incluye los que Calor registró como encolados.

Corre en el servidor de bb, solo lectura. Uso: tics-bb.py <desde_ms> <hasta_ms> > tics-bb.jsonl
"""
import json
import os
import sqlite3
import sys

DB = os.path.expanduser("~/.bb-machines/macbook-pro-de-aitor.tail81fad6.ts.net/bb.db")
db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
filas = db.execute(
    "select thread_id, created_at from events where type = 'client/turn/requested'"
    " and created_at between ? and ? and data like '%calor: tic de caché #%' order by created_at",
    (int(sys.argv[1]), int(sys.argv[2])),
)
for hilo, at in filas:
    print(json.dumps({"ts": at, "hilo": hilo}))
