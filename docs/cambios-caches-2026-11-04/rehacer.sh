#!/bin/bash
# Repite la extracción: eventos de bb (NUC), registros del plugin y primera petición de cada tanda
# (NUC, Mac, i9). Se ejecuta en el i9 con acceso por ssh a `nuc` y `mac`. Lo crudo se queda en $T.
set -euo pipefail
E="$(cd "$(dirname "$0")" && pwd)"
T="${T:-/tmp/sw-f1}"
mkdir -p "$T"; cd "$T"
D='~/.bb-machines/macbook-pro-de-aitor.tail81fad6.ts.net/plugins'
scp -q -o BatchMode=yes "nuc:$D/claude-switcher/logs/plugin.log" switcher.log
scp -q -o BatchMode=yes "nuc:$D/calor/logs/plugin.log" calor.log
[ -f switcher-mac.log ] || scp -q -o BatchMode=yes "mac:.bb/plugins/claude-switcher/logs/plugin.log" switcher-mac.log
NOW=$(date +%s%3N); echo "$NOW" > "$E/ahora.txt"
bb project list --json > projects.json
bb claude-switcher seats --json > seats.json
bb calor list --json > calor-ahora.json
bb claude-switcher list --json > list.json
jq -c '.samples' seats.json | gzip -n > "$E/muestras.json.gz"
jq -c '[.[]|{hilo:.threadId,frio,motivo,fin:.ultimoTurnoFin}]' calor-ahora.json | gzip -n > "$E/calor.json.gz"
jq -c '[.projects[]|{id,cuenta:(.account//.accountName)}]' list.json | gzip -n > "$E/proyectos-cuenta.json.gz"
scp -q -o BatchMode=yes "$E/extraer.py" nuc:/tmp/sw-extraer.py
ssh -o BatchMode=yes nuc "nice -n 10 python3 /tmp/sw-extraer.py $((NOW-8*86400000)) $NOW" > hilos.jsonl
gzip -nc hilos.jsonl > "$E/hilos.jsonl.gz"
python3 "$E/parsear-registro.py" projects.json "$E/movimientos.jsonl.gz" "$E/agotadas.jsonl.gz" "$E/plazas.jsonl.gz" switcher-mac.log switcher.log
jq -c 'select(.message|test("tic #.* enviado"))|{ts,hilo:(.message|capture("hilo (?<h>thr_[a-z0-9]+)").h)}' calor.log | gzip -n > "$E/tics.jsonl.gz"
python3 "$E/consultas.py" "$E" > consultas.json
nice -n 10 python3 "$E/primeras.py" < consultas.json > prim-i9.jsonl
for h in nuc mac; do scp -q -o BatchMode=yes "$E/primeras.py" consultas.json "$h:/tmp/"; done
ssh -o BatchMode=yes nuc 'nice -n 10 python3 /tmp/primeras.py < /tmp/consultas.json' > prim-nuc.jsonl
ssh -o BatchMode=yes mac '/opt/homebrew/bin/python3 /tmp/primeras.py < /tmp/consultas.json' > prim-mac.jsonl
cat prim-i9.jsonl prim-nuc.jsonl prim-mac.jsonl | python3 "$E/fusionar.py" | gzip -n > "$E/primeras.jsonl.gz"
wc -l prim-*.jsonl
