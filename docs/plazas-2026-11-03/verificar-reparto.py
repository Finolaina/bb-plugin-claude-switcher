"""Fase 2 del encargo de 2026-11-03: en `list --json`, ninguna Ultra con más
de 10 proyectos por encima de la que menos tiene, y ningún hilo vivo (no
archivado, no parado) en un proyecto movido por «Rebalanced».
Uso: verificar-reparto.py despues-list.json despues-hilos.json"""
import collections, json, sys

ULTRA = ["aitor", "ganaresenas", "joytorm", "siloeads"]
state = json.load(open(sys.argv[1]))
threads = json.load(open(sys.argv[2]))
count = collections.Counter(
    p["account"] or state["defaultAccountName"]
    for p in state["projects"]
    if not p["external"]
)
spread = max(count[a] for a in ULTRA) - min(count[a] for a in ULTRA)
moved = {h["projectId"] for h in state["history"] if h["reason"].startswith("Rebalanced")}
alive = [
    t["id"]
    for t in threads
    if t["providerId"] == "claude-code"
    and t["archivedAt"] is None
    and t["status"] != "idle"
    and t["projectId"] in moved
]
print({a: count[a] for a in ULTRA}, f"spread {spread}", f"moved {len(moved)}", f"alive threads moved {alive}")
sys.exit(0 if spread <= 10 and not alive else 1)
