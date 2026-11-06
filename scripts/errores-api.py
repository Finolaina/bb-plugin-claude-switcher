#!/usr/bin/env python3
"""errores-api.py — errores de la API de Anthropic por cuenta en los transcripts de Claude Code de ESTA máquina.

Uso:  errores-api.py --desde EPOCH [--hasta EPOCH] > maquina.json

Para la medida de plazas por Team (Aitor, 2026-11-06: «Medir 5 por team necesitamos más flujo»): al subir las plazas,
un 429 que NO sea cuota agotada (rate limit, overloaded) manda volver al valor anterior (CLAUDE.md, «Asientos subidos»).

Fuentes (solo lectura): ~/.claude/projects/**/*.jsonl, líneas con "isApiErrorMessage": true; la cuenta, la del último
arranque de la sesión en ~/.claude/state/sesiones-cuenta.jsonl (como scripts/opus-por-cuenta.py).
Clases: «cuota» = «You've hit your … limit» (sesión de 5 h o semanal agotada); «otro» = cualquier otro error, con su texto.
"""
import argparse, bisect, collections, datetime, glob, json, os, sys, time


def epoch(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--desde", type=float, required=True)
    ap.add_argument("--hasta", type=float, default=time.time())
    a = ap.parse_args()
    home = os.path.expanduser("~")
    arranques = collections.defaultdict(list)
    try:
        with open(os.path.join(home, ".claude/state/sesiones-cuenta.jsonl"), encoding="utf-8") as fh:
            for linea in fh:
                try:
                    d = json.loads(linea)
                    base = os.path.basename(os.path.normpath(d.get("config_dir") or ""))
                    arranques[d["sid"]].append((float(d["ts"]), "base" if base in (".claude", "") else base))
                except (ValueError, KeyError, TypeError):
                    continue
    except OSError:
        pass
    for v in arranques.values():
        v.sort()

    def cuenta(sid, t):
        v = arranques.get(sid) or []
        i = bisect.bisect_right([x[0] for x in v], t + 5) - 1
        return v[i][1] if i >= 0 else "?"

    cuentas = collections.Counter()
    otros = []
    for f in glob.glob(os.path.join(home, ".claude/projects/**/*.jsonl"), recursive=True):
        try:
            if os.path.getmtime(f) < a.desde:
                continue
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        partes = f.split(os.sep)
        sid = partes[partes.index("subagents") - 1] if "subagents" in partes else os.path.basename(f)[:-6]
        with fh:
            for linea in fh:
                if '"isApiErrorMessage":true' not in linea:
                    continue
                try:
                    d = json.loads(linea)
                except ValueError:
                    continue
                t = epoch(d.get("timestamp"))
                if t is None or not (a.desde <= t < a.hasta):
                    continue
                c = (d.get("message") or {}).get("content")
                texto = c[0].get("text", "") if isinstance(c, list) and c and isinstance(c[0], dict) else str(c or "")
                clase = "cuota" if "hit your" in texto and "limit" in texto else "otro"
                k = cuenta(sid, t)
                cuentas[(k, clase)] += 1
                if clase == "otro":
                    otros.append({"ts": t, "cuenta": k, "error": d.get("error"), "texto": texto[:200]})
    json.dump({"maquina": os.uname().nodename, "desde": a.desde, "hasta": a.hasta,
               "errores": [[*k, n] for k, n in cuentas.items()], "otros": otros}, sys.stdout)


if __name__ == "__main__":
    main()
