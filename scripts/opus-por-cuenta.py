#!/usr/bin/env python3
"""opus-por-cuenta.py — turnos y tokens de salida por cuenta y modelo en los transcripts de Claude Code de ESTA máquina.

Uso:  opus-por-cuenta.py [--desde EPOCH] [--hasta EPOCH] > maquina.json
      opus-por-cuenta.py --juntar health.json a.json b.json ... > tabla.md   (une máquinas y pinta la tabla)

Encargo de Aitor del 2026-11-06 («el switcher sigue gastando más Opus que Fable y no tira de las cuentas Team»).

Fuentes (todo local, solo lectura):
- Cuenta de cada momento de una sesión: ~/.claude/state/sesiones-cuenta.jsonl, una línea por arranque del proceso de
  Claude Code (hook SessionStart: sid, ts, config_dir). La cuenta de un mensaje es la del último arranque de su sesión
  anterior al mensaje: un proceso que sigue abierto sigue en su cuenta aunque el proyecto se mueva.
- Modelo y tokens: ~/.claude/projects/**/*.jsonl (también los de subagentes, que heredan la sesión de su padre). Cada
  mensaje cuenta una vez por message.id (gana la última línea); output_tokens; modelos «<…>» fuera.
- Turno: cada mensaje de usuario escrito (no resultado de herramienta, no meta) del transcript principal. Su modelo es
  el que más tokens de salida dio hasta el siguiente turno; su cuenta, la del arranque anterior al turno.
La salida no lleva títulos de hilos; sí la carpeta de trabajo de cada turno de Opus/Sonnet, para explicar por qué fue
adonde fue: esa salida NO se sube al repo (es público).
"""
import argparse, bisect, collections, datetime, glob, json, os, sys, time

FAM = lambda m: next((f for f in ("fable", "opus", "sonnet", "haiku") if f in (m or "").lower()), "otro")


def epoch(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (AttributeError, ValueError):
        return None


def cuenta_de(config_dir):
    base = os.path.basename(os.path.normpath(config_dir or ""))
    return "base" if base in (".claude", "") else base


def medir(desde, hasta):
    home = os.path.expanduser("~")
    arranques = collections.defaultdict(list)  # sid -> [(ts, cuenta)]
    try:
        with open(os.path.join(home, ".claude/state/sesiones-cuenta.jsonl"), encoding="utf-8") as fh:
            for linea in fh:
                try:
                    d = json.loads(linea)
                    arranques[d["sid"]].append((float(d["ts"]), cuenta_de(d.get("config_dir"))))
                except (ValueError, KeyError, TypeError):
                    continue
    except OSError:
        pass
    for v in arranques.values():
        v.sort()

    def cuenta(sid, t):
        v = arranques.get(sid)
        if not v:
            return "?"
        i = bisect.bisect_right([x[0] for x in v], t + 5) - 1  # 5 s: el hook escribe tras arrancar
        return v[i][1] if i >= 0 else "?"

    tokens = collections.defaultdict(lambda: [0, 0])  # (cuenta, fam, lado) -> [mensajes, tokens]
    turnos = collections.Counter()  # (cuenta, fam) -> n
    lista = []  # turnos de opus/sonnet: ts, sid, cwd, cuenta, tokens
    vistos = 0
    for f in glob.glob(os.path.join(home, ".claude/projects/**/*.jsonl"), recursive=True):
        try:
            if os.path.getmtime(f) < desde:
                continue
        except OSError:
            continue
        vistos += 1
        partes = f.split(os.sep)
        sub = "subagents" in partes
        sid = partes[partes.index("subagents") - 1] if sub else os.path.basename(f)[:-6]
        mensajes = {}  # id -> (t, fam, out)
        humanos = []  # (t, cwd)
        try:
            with open(f, encoding="utf-8", errors="replace") as fh:
                for linea in fh:
                    try:
                        d = json.loads(linea)
                    except ValueError:
                        continue
                    t = epoch(d.get("timestamp"))
                    if t is None or not (desde <= t < hasta):
                        continue
                    if d.get("type") == "assistant":
                        m = d.get("message") or {}
                        modelo = m.get("model") or ""
                        if not modelo or modelo.startswith("<"):
                            continue
                        mensajes[m.get("id") or len(mensajes)] = (t, FAM(modelo), int((m.get("usage") or {}).get("output_tokens") or 0))
                    elif d.get("type") == "user" and not sub and not d.get("isMeta") and not d.get("isSidechain"):
                        c = (d.get("message") or {}).get("content")
                        lst = c if isinstance(c, list) else []
                        escrito = isinstance(c, str) or (
                            any(isinstance(x, dict) and x.get("type") == "text" for x in lst)
                            and not any(isinstance(x, dict) and x.get("type") == "tool_result" for x in lst))
                        if escrito:
                            humanos.append((t, d.get("cwd") or ""))
        except OSError:
            continue
        for t, fam, out in mensajes.values():
            k = (cuenta(sid, t), fam, "subagente" if sub else "principal")
            tokens[k][0] += 1
            tokens[k][1] += out
        if sub or not humanos:
            continue
        humanos.sort()
        orden = sorted(mensajes.values())
        for i, (t, cwd) in enumerate(humanos):
            fin = humanos[i + 1][0] if i + 1 < len(humanos) else hasta
            por = collections.Counter()
            for tm, fam, out in orden:
                if t <= tm < fin:
                    por[fam] += out + 1
            if not por:
                continue
            fam = por.most_common(1)[0][0]
            c = cuenta(sid, t)
            turnos[(c, fam)] += 1
            if fam in ("opus", "sonnet"):
                lista.append({"ts": t, "sid": sid, "cwd": cwd, "cuenta": c, "modelo": fam, "tokens": por[fam] - 1})
    return {
        "maquina": os.uname().nodename, "desde": desde, "hasta": hasta, "ficheros": vistos,
        "tokens": [[*k, *v] for k, v in tokens.items()],
        "turnos": [[*k, v] for k, v in turnos.items()],
        "turnos_opus_sonnet": lista,
    }


def juntar(health, ficheros):
    planes = {c["nombre"]: c["plan"] for c in json.load(open(health))["cuentas"]}
    tipo = lambda c: {"team": "Team", "max": "Max", "ultra": "Ultra"}.get(planes.get(c), "?")
    tok = collections.defaultdict(lambda: [0, 0])
    tur = collections.Counter()
    maquinas = []
    for f in ficheros:
        d = json.load(open(f))
        maquinas.append(f"{d['maquina']} ({d['ficheros']} transcripts)")
        for c, fam, lado, n, out in d["tokens"]:
            tok[(c, fam, lado)][0] += n
            tok[(c, fam, lado)][1] += out
        for c, fam, n in d["turnos"]:
            tur[(c, fam)] += n
    cuentas = sorted({k[0] for k in tok} | {k[0] for k in tur}, key=lambda c: (tipo(c), c))
    fams = ("fable", "opus", "sonnet", "haiku")
    cab = " | ".join(f"turnos {f}" for f in fams) + " | " + " | ".join(f"Mtok {f} (subag.)" for f in fams)
    print("| cuenta | tipo | " + cab + " |")
    print("|---" * (2 + 2 * len(fams)) + "|")
    totales = collections.defaultdict(lambda: [0, 0, 0])
    for c in cuentas:
        fila = [c, tipo(c)]
        for f in fams:
            fila.append(str(tur[(c, f)]))
            totales[(tipo(c), f)][0] += tur[(c, f)]
        for f in fams:
            p, s = tok[(c, f, "principal")][1], tok[(c, f, "subagente")][1]
            fila.append(f"{(p + s) / 1e6:.2f} ({s / 1e6:.2f})")
            totales[(tipo(c), f)][1] += p + s
            totales[(tipo(c), f)][2] += s
        print("| " + " | ".join(fila) + " |")
    print()
    print("| tipo | " + cab + " |")
    print("|---" * (1 + 2 * len(fams)) + "|")
    for t in sorted({tipo(c) for c in cuentas}):
        print("| " + t + " | " + " | ".join(str(totales[(t, f)][0]) for f in fams) + " | "
              + " | ".join(f"{totales[(t, f)][1] / 1e6:.2f} ({totales[(t, f)][2] / 1e6:.2f})" for f in fams) + " |")
    print()
    print("Máquinas: " + ", ".join(maquinas))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--desde", type=float, default=time.time() - 7 * 86400)
    ap.add_argument("--hasta", type=float, default=time.time())
    ap.add_argument("--juntar", nargs="+", metavar="FICHERO", help="health.json y después los JSON de cada máquina")
    a = ap.parse_args()
    if a.juntar:
        juntar(a.juntar[0], a.juntar[1:])
    else:
        json.dump(medir(a.desde, a.hasta), sys.stdout)
