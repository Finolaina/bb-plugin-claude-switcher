"""Gasto por plaza y semana, de las muestras de `bb claude-switcher seats --json`.

Uso: python3 medir-techo.py seats-semana.json.gz
Muestra: [t, running, reserved, session %, weekly %, session resets, weekly resets].
Por cuenta y nº de plazas ocupadas (running+reserved del tramo, la media de
los dos extremos redondeada), cuánto sube la sesión de 5 h y la semanal por
hora, solo entre dos muestras de la misma ventana (mismo reset ±2 min) y de
como mucho 15 min de separación. Cuenta nuestra.
"""
import gzip, json, sys
from collections import defaultdict

d = json.load((gzip.open if sys.argv[1].endswith(".gz") else open)(sys.argv[1], "rt"))
rows = defaultdict(lambda: defaultdict(lambda: {"h": 0.0, "ses": 0.0, "sem": 0.0, "n": 0}))
peak = {}
for name, samples in d["samples"].items():
    samples = sorted(samples)
    peak[name] = max((s[1] + s[2] for s in samples), default=0)
    for a, b in zip(samples, samples[1:]):
        dt = (b[0] - a[0]) / 3_600_000
        if dt <= 0 or dt > 0.25:
            continue
        seats = round(((a[1] + a[2]) + (b[1] + b[2])) / 2)
        r = rows[name][seats]
        same_ses = a[5] is not None and b[5] is not None and abs(a[5] - b[5]) < 120_000
        same_sem = a[6] is not None and b[6] is not None and abs(a[6] - b[6]) < 120_000
        if same_sem and b[4] is not None and a[4] is not None:
            r["h"] += dt
            r["sem"] += b[4] - a[4]
            r["n"] += 1
            if same_ses and a[3] is not None and b[3] is not None:
                r["ses"] += b[3] - a[3]
            else:
                r.setdefault("ses_h_missing", 0)
print("cuenta\tplazas\thoras\tsesión %/h\tsemanal %/h\tmuestras\tpico de plazas")
for name in sorted(rows):
    for seats in sorted(rows[name]):
        r = rows[name][seats]
        if r["h"] < 0.25:
            continue
        print(f"{name}\t{seats}\t{r['h']:.1f}\t{r['ses']/r['h']:.1f}\t{r['sem']/r['h']:.2f}\t{r['n']}\t{peak[name]}")
