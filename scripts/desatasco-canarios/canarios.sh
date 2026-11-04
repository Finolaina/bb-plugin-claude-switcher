#!/usr/bin/env bash
# Two canaries for desatasco-noche.py, dry run on fixtures (no bb, no moves).
set -euo pipefail
D="$(cd "$(dirname "$0")" && pwd)"; S="$D/../desatasco-noche.py"; NOW=1793833200000
common=(--dry-run --now-ms "$NOW" --seats-file "$D/seats.txt" --health-file "$D/health.txt" --plugins-file "$D/plugins.txt" --project thr_atascado=proj_A --project thr_fable=proj_F)
out1="$(/usr/bin/python3 "$S" "${common[@]}" --log-file "$D/log-stuck.txt")"; echo "$out1"
grep -q "movido: thr_atascado (proj_A) team2 → team3" <<<"$out1" || { echo "CANARIO 1 ROJO: debía mover proj_A a team3 (2 libres > 1 en team4)"; exit 1; }
grep -q "thr_fable: Fable, no se toca" <<<"$out1" || { echo "CANARIO 1 ROJO: el hilo Fable no debía moverse"; exit 1; }
! grep -q "thr_viejo" <<<"$out1" || { echo "CANARIO 1 ROJO: un STUCK de hace 30 min no cuenta"; exit 1; }
grep -q "1 movimiento(s)" <<<"$out1" || { echo "CANARIO 1 ROJO: un solo movimiento"; exit 1; }
out2="$(/usr/bin/python3 "$S" "${common[@]}" --log-file "$D/log-sin-stuck.txt")"; echo "$out2"
grep -q "sin STUCK" <<<"$out2" && ! grep -q "movido" <<<"$out2" || { echo "CANARIO 2 ROJO: sin STUCK no debía mover nada"; exit 1; }
out3="$(/usr/bin/python3 "$S" "${common[@]}" --log-file "$D/log-stuck.txt" --plugins-file <(echo 'claude-switcher@0.2.41  running'))"; echo "$out3"
grep -q "apagado: el plugin instalado es 0.2.41" <<<"$out3" || { echo "CANARIO 3 ROJO: con la 0.2.41 instalada debía apagarse"; exit 1; }
out4="$(/usr/bin/python3 "$S" "${common[@]}" --log-file "$D/log-stuck.txt" --plugins-file <(echo 'bb: no se pudo conectar'))"; echo "$out4"
grep -q "sin versión del plugin" <<<"$out4" && ! grep -q "movido" <<<"$out4" || { echo "CANARIO 4 ROJO: sin versión leída no debía mover nada (code-reviewer r1 L1)"; exit 1; }
echo "CANARIOS VERDES"
