#!/usr/bin/env python3
"""Del registro del plugin a movimientos.jsonl.gz, sin nombres de proyectos (repo público).

Uso: parsear-registro.py <proyectos.json> <salida.jsonl.gz> <agotadas.jsonl.gz> <plazas.jsonl.gz> <registro>...
`plazas`: {ts, cuenta, ocupadas, tope} cada vez que el registro las cuenta.
`agotadas`: cada vez que el plugin dijo que una cuenta no puede con un modelo hasta una hora,
{ts, cuenta, modelo, hasta} (hora del servidor de bb: CET en noviembre, medido con `date` en el NUC).
Cada fila: {ts, tipo, hilo, proyecto, de, a, motivo, modelo}. `tipo` es la forma de la línea;
`motivo` es el reparto del informe. Una línea que parece un cambio y no se reconoce hace fallar
el script: mejor parar que contar de menos.
"""
import gzip
import json
import re
import sys
from datetime import datetime, timezone

RE_HILO = re.compile(r"^thread (thr_[a-z0-9]+): (?:left in error: )?(.*)$", re.S)
RE_PROY = re.compile(r"^project (.+?): (moved from|picked by hand|Rebalanced)(?=[ ,:])(.*)$", re.S)

# (expresión sobre el texto tras «thread T: », motivo, cómo sacar origen y modelo)
HILO = [
    (re.compile(r"^Moved to account (\S+) before the turn: (\S+) would spend (\w+)'s weekly"), "reserva", "to,from,_"),
    (re.compile(r"^Moved to account (\S+) after a turn in \w+: (\S+) would spend (\w+)'s weekly"), "reserva", "to,from,_"),
    (re.compile(r"^Moved back to account (\S+) before the turn: (\S+) was an excursion for (\w+)"), "reserva-vuelta", "to,from,model"),
    (re.compile(r"^Moved to account (\S+) before the turn: (\S+) cannot run (\w+)"), "cuota", "to,from,model"),
    (re.compile(r"^Moved to account (\S+), which can run the waiting turn now: (\S+) cannot run (\w+)"), "cuota", "to,from,model"),
    (re.compile(r"^Moved to account (\S+) before the turn: (\S+) seats full"), "plazas", "to,from"),
    (re.compile(r"^Moved to account (\S+) before the turn: (\S+) is not logged in"), "sin-login", "to,from"),
    (re.compile(r"^Switched to account (\S+) \((\w+)\)"), "cuota", "to,model"),
    (re.compile(r"^Switched ahead of the limit to (\S+): (\S+) at"), "cuota-previa", "to,from"),
    (re.compile(r"^Retrying on account (\S+) \((\w+)\): it has room now"), "cuota", "to,model"),
    (re.compile(r"^Retrying on account (\S+)"), "cuota", "to"),
]
PARECE = re.compile(r"\b(Moved|Switched|Retrying)\b")


RE_AGOTADA = re.compile(r"\((?:exhausted) for (\w+) until (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\)")
RE_EN = re.compile(r": (?:moved from|left on) (\S+) \(exhausted")
RE_ESPERA = re.compile(r"Waiting for (\w+) on (\S+) until (\d{4}-\d{2}-\d{2}T[\d:.]+Z)")


RE_PLAZAS = re.compile(r"(?:running on|seat on|admitted to a seat on|Waiting for a seat on) (\S+?)[;: ].*?(\d+)/(\d+)")


def plazas(ruta):
    with open(ruta, encoding="utf-8", errors="replace") as f:
        for linea in f:
            if "/" not in linea or ("taken" not in linea and "threads running" not in linea):
                continue
            try:
                d = json.loads(linea)
            except ValueError:
                continue
            g = RE_PLAZAS.search(d.get("message") or "")
            if g:
                yield {"ts": d["ts"], "cuenta": g.group(1), "ocupadas": int(g.group(2)), "tope": int(g.group(3))}


def hora_utc(texto):
    """«2026-10-30 12:00» del registro a ms. El plugin lo escribe con toISOString: es UTC (server.ts, stranded)."""
    dt = datetime.strptime(texto, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def agotadas(ruta):
    with open(ruta, encoding="utf-8", errors="replace") as f:
        for linea in f:
            if "exhausted for" not in linea and "Waiting for" not in linea:
                continue
            try:
                d = json.loads(linea)
            except ValueError:
                continue
            m = d.get("message") or ""
            a, en = RE_AGOTADA.search(m), RE_EN.search(m)
            if a and en:
                yield {"ts": d["ts"], "cuenta": en.group(1), "modelo": a.group(1), "hasta": hora_utc(a.group(2))}
                continue
            e = RE_ESPERA.search(m)
            if e:
                hasta = datetime.strptime(e.group(3)[:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
                yield {"ts": d["ts"], "cuenta": e.group(2), "modelo": e.group(1), "hasta": int(hasta.timestamp() * 1000)}


def filas(ruta, proyectos, vistos):
    with open(ruta, encoding="utf-8", errors="replace") as f:
        for linea in f:
            try:
                d = json.loads(linea)
            except ValueError:
                continue
            m, ts = d.get("message") or "", d.get("ts")
            if (ts, m) in vistos:
                continue
            vistos.add((ts, m))
            h = RE_HILO.match(m)
            if h:
                hilo, resto = h.groups()
                if not PARECE.match(resto):
                    continue
                for rx, motivo, campos in HILO:
                    g = rx.match(resto)
                    if not g:
                        continue
                    fila = {"ts": ts, "tipo": "hilo", "hilo": hilo, "motivo": motivo}
                    for nombre, valor in zip(campos.split(","), g.groups()):
                        if nombre in ("to", "from", "model"):
                            fila[{"to": "a", "from": "de", "model": "modelo"}[nombre]] = valor
                    yield fila
                    break
                else:
                    raise SystemExit(f"línea de cambio sin reconocer: {resto[:160]}")
                continue
            if ": not moved to " in m or " excursion from " in m:
                continue
            p = RE_PROY.match(m)
            if not p:
                continue
            nombre, forma, resto = p.groups()
            pid = nombre if nombre.startswith("proj_") else proyectos.get(nombre, "?")
            if forma == "moved from":
                g = re.match(r" (\S+) \((not logged in|exhausted for (\w+) until [^)]*)\) to (\S+) \(seats", resto)
                if not g:
                    raise SystemExit(f"rescate sin reconocer: {resto[:160]}")
                motivo = "sin-login" if g.group(2) == "not logged in" else "rescate-cuota"
                fila = {"ts": ts, "tipo": "rescate", "proyecto": pid, "de": g.group(1), "a": g.group(4), "motivo": motivo, "modelo": g.group(3)}
                u = re.search(r"until (\d{4}-\d{2}-\d{2} \d{2}:\d{2})", resto)
                if u:
                    fila["hasta"] = hora_utc(u.group(1))
                yield fila
            elif forma == "picked by hand":
                g = re.match(r", (\S+) → (\S+)", resto)
                if not g:
                    raise SystemExit(f"mano sin reconocer: {resto[:160]}")
                yield {"ts": ts, "tipo": "mano", "proyecto": pid, "de": g.group(1), "a": g.group(2), "motivo": "a-mano"}
            else:
                g = re.match(r": (\S+) had \d+ projects[^,]*, (\S+) \d+", resto)
                if not g:
                    raise SystemExit(f"rebalance sin reconocer: {resto[:160]}")
                yield {"ts": ts, "tipo": "rebalance", "proyecto": pid, "de": g.group(1), "a": g.group(2), "motivo": "rebalance"}


def main():
    proyectos = {p["name"]: p["id"] for p in json.load(open(sys.argv[1], encoding="utf-8"))}
    vistos = set()
    todas = []
    for ruta in sys.argv[5:]:
        todas.extend(filas(ruta, proyectos, vistos))
    with gzip.open(sys.argv[4], "wt", encoding="utf-8") as g:
        for ruta in sys.argv[5:]:
            for f in plazas(ruta):
                g.write(json.dumps(f, separators=(",", ":")) + "\n")
    vistas = set()
    with gzip.open(sys.argv[3], "wt", encoding="utf-8") as g:
        for ruta in sys.argv[5:]:
            for f in agotadas(ruta):
                k = (f["cuenta"], f["modelo"], f["hasta"])
                if k in vistas:  # la primera vez basta: desde ahí hasta `hasta`
                    continue
                vistas.add(k)
                g.write(json.dumps(f, separators=(",", ":")) + "\n")
    todas.sort(key=lambda f: f["ts"])
    with gzip.open(sys.argv[2], "wt", encoding="utf-8") as g:
        for f in todas:
            g.write(json.dumps(f, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(len(todas), "filas;", sum(1 for f in todas if f.get("proyecto") == "?"), "con proyecto sin resolver")


if __name__ == "__main__":
    main()
