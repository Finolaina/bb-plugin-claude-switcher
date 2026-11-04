#!/usr/bin/env python3
"""Extrae de bb.db (solo lectura) los eventos de turno de los hilos de Claude Code.

Corre en el servidor de bb. Salida: JSONL en stdout, una línea por hilo, sin títulos
ni textos: ids, horas, cuenta de cada arranque de proceso, tokens por turno.
Uso: extraer.py <desde_ms> [hasta_ms]
"""
import json
import os
import re
import sqlite3
import sys

DB = os.path.expanduser("~/.bb-machines/macbook-pro-de-aitor.tail81fad6.ts.net/bb.db")
desde = int(sys.argv[1])
hasta = int(sys.argv[2]) if len(sys.argv) > 2 else 10**15
c = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10, isolation_level=None)
CUENTA = re.compile(r'Claude Code account "([^"]+)"')

hilos = c.execute(
    "select id, project_id, parent_thread_id, visibility, origin_plugin_id, created_at, archived_at"
    " from threads where provider_id='claude-code' and updated_at >= ? and deleted_at is null",
    (desde,),
).fetchall()

TIPOS = (
    "turn/started",
    "turn/completed",
    "thread/tokenUsage/updated",
    "provider.env-resolved",
    "thread/compacted",
    "client/turn/requested",
    "provider/warning",
    "thread/contextWindowUsage/updated",
)
for h in hilos:
    tid = h[0]
    salida = {
        "t": tid, "p": h[1], "padre": h[2], "vis": h[3], "plugin": h[4], "creado": h[5], "arch": h[6],
        "ev": [],
    }
    for ty in TIPOS:
        if ty == "thread/contextWindowUsage/updated":
            q = (
                "select sequence, created_at, turn_id,"
                " json_extract(data,'$.contextWindowUsage.snapshot.usedTokens'),"
                " json_extract(data,'$.contextWindowUsage.snapshot.model'),"
                " json_extract(data,'$.contextWindowUsage.snapshot.estimated')"
                " from events where thread_id=? and type=? and created_at between ? and ? order by sequence"
            )
            ult = None
            for s, at, turn, used, model, est in c.execute(q, (tid, ty, desde - 864e5, hasta)):
                # Se guarda solo cuando cambia de turno o de modelo o de tamaño > 1 %: el fichero no necesita más.
                if ult is None or ult[0] != turn or ult[2] != model or abs((used or 0) - (ult[1] or 0)) > 0.01 * max(ult[1] or 1, 1):
                    salida["ev"].append(["ctx", s, at, turn, used, model, est])
                    ult = (turn, used, model)
            continue
        q = "select sequence, created_at, turn_id, data from events where thread_id=? and type=? and created_at between ? and ? order by sequence"
        for s, at, turn, data in c.execute(q, (tid, ty, desde - 864e5, hasta)):
            d = json.loads(data)
            if ty == "turn/started":
                salida["ev"].append(["ini", s, at, turn, d.get("providerThreadId")])
            elif ty == "turn/completed":
                salida["ev"].append(["fin", s, at, turn, d.get("status")])
            elif ty == "thread/tokenUsage/updated":
                u = d.get("tokenUsage") or {}
                l = u.get("last") or {}
                salida["ev"].append(["tok", s, at, turn, l.get("inputTokens"), l.get("cacheReadInputTokens"), l.get("cacheWriteInputTokens"), l.get("outputTokens"), u.get("promptCacheTtlMs")])
            elif ty == "provider.env-resolved":
                cuenta = None
                for e in d.get("entries") or []:
                    if e.get("name") == "CLAUDE_CONFIG_DIR":
                        m = CUENTA.search(e.get("reason") or "")
                        cuenta = m.group(1) if m else "?" + str(e.get("reason"))[:40]
                salida["ev"].append(["env", s, at, d.get("providerThreadId"), cuenta])
            elif ty == "thread/compacted":
                salida["ev"].append(["comp", s, at, turn])
            elif ty == "provider/warning":
                if "rebuilt" in (d.get("summary") or ""):
                    salida["ev"].append(["reb", s, at, turn])
            elif ty == "client/turn/requested":
                salida["ev"].append(["req", s, at, d.get("source"), d.get("initiator"), d.get("senderThreadId")])
    salida["ev"].sort(key=lambda e: e[1])
    print(json.dumps(salida, separators=(",", ":")))
