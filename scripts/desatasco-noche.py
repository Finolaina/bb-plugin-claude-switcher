#!/usr/bin/env python3
"""Night unsticker for the Claude switcher (temporary, until the plugin moves
stuck projects by itself).

Every run reads the plugin's own STUCK lines of the last minutes (a thread
held 10 min while another account had a free seat), and moves the project of
each stuck non-Fable thread with `bb claude-switcher use` to the Team account
with the most free seats among the ones the line names as free. Never to an
Ultra or Max account: the plugin moves an Opus turn off one that keeps Fable's
weekly within a second (measured 2026-11-04 23:00:59), so such a move only
churns. Each move is one JSON line in the state file.

It turns itself off once the plugin installed is at OFF_VERSION or later (the
version that moves stuck projects itself) or once the night is over.
Canaries: scripts/desatasco-canarios/canarios.sh.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

OFF_VERSION = (0, 2, 41)
WINDOW_MIN = 11  # STUCK lines this recent are acted on (one run every 10 min)
SAME_PROJECT_MIN = 15  # a project moved by this script is left alone this long
STATE = Path.home() / ".claude/state/switcher-desatasco.jsonl"
RUNS = Path.home() / ".claude/state/switcher-desatasco-pasadas.log"
TIMER = "switcher-desatasco.timer"

STUCK_RE = re.compile(
    r"^STUCK: (?P<cuenta>\S+) holds thread (?P<hilo>thr_\w+) \((?P<modelo>[^)]*)\) "
    r"(?P<min>\d+) min, (?P<libres>.+?) (?:is|are) free"
    r"(?P<ocupado>; another thread of its project is at work)?$"
)
SEATS_RE = re.compile(r"^(\S+)\tseats (\d+)/(\d+|∞) .*\t(\d+) waiting$")


def run(cmd: list[str], timeout: int = 60) -> str:
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}: rc {out.returncode}: {out.stderr.strip()[:300]}")
    return out.stdout


def parse_stuck(log_text: str, now_ms: int) -> list[dict]:
    """Latest STUCK line per thread within WINDOW_MIN."""
    found: dict[str, dict] = {}
    for line in log_text.splitlines():
        if not line.startswith("{"):
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if now_ms - int(entry.get("ts", 0)) > WINDOW_MIN * 60_000:
            continue
        m = STUCK_RE.match(entry.get("message", ""))
        if m is None:
            continue
        found[m["hilo"]] = {
            "hilo": m["hilo"],
            "cuenta": m["cuenta"],
            "modelo": m["modelo"],
            "minutos": int(m["min"]),
            "libres": [a.strip() for a in m["libres"].split(",")],
            "ocupado": m["ocupado"] is not None,
        }
    return list(found.values())


def parse_seats(text: str) -> dict[str, int]:
    """Seats free beyond those owed to the queue, per account (head of `seats`)."""
    room: dict[str, int] = {}
    for line in text.splitlines():
        m = SEATS_RE.match(line)
        if m is None:
            if room:
                break
            continue
        taken, cap, waiting = int(m[2]), m[3], int(m[4])
        room[m[1]] = 99 if cap == "∞" else int(cap) - taken - waiting
    return room


def parse_health(text: str) -> dict[str, dict]:
    accounts: dict[str, dict] = {}
    for line in text.splitlines():
        parts = line.split(" · ")
        name_plan = parts[0].split()
        if len(parts) < 3 or len(name_plan) < 2:
            continue
        accounts[name_plan[0]] = {"plan": name_plan[1], "usable": parts[-1].strip() == "usable"}
    return accounts


def plan_moves(stuck, room, health, project_of, recent_projects):
    moves, notes = [], []
    room = dict(room)
    taken_projects: set[str] = set()
    for s in sorted(stuck, key=lambda x: -x["minutos"]):
        if "fable" in s["modelo"].lower():
            notes.append(f"{s['hilo']}: Fable, no se toca")
            continue
        project = project_of(s["hilo"])
        if project is None:
            notes.append(f"{s['hilo']}: sin proyecto leído")
            continue
        if project in taken_projects or project in recent_projects:
            notes.append(f"{s['hilo']}: su proyecto ya se movió hace menos de {SAME_PROJECT_MIN} min")
            continue
        teams = [
            a
            for a in s["libres"]
            if a != s["cuenta"]
            and health.get(a, {}).get("plan") == "Team"
            and health.get(a, {}).get("usable")
            and room.get(a, 0) > 0
        ]
        if not teams:
            notes.append(
                f"{s['hilo']}: ninguna Team con plaza ahora; una Ultra no sirve hasta que "
                "el plugin traiga el cambio (la deshace al instante)"
            )
            continue
        best = max(teams, key=lambda a: (room[a], -s["libres"].index(a)))
        free_there = room[best]
        room[best] -= 1
        taken_projects.add(project)
        moves.append(
            {
                "hilo": s["hilo"],
                "proyecto": project,
                "de": s["cuenta"],
                "a": best,
                "motivo": f"llevaba {s['minutos']} min esperando plaza en {s['cuenta']}"
                + (" con otro hilo de su proyecto trabajando" if s["ocupado"] else "")
                + f"; {best} tenía {free_there} plaza(s) libre(s)",
            }
        )
    return moves, notes


def plugin_version(text: str):
    m = re.search(r"claude-switcher@(\d+)\.(\d+)\.(\d+)", text)
    return tuple(int(x) for x in m.groups()) if m else None


def recent_projects_moved(now_ms: int) -> set[str]:
    out: set[str] = set()
    if STATE.exists():
        for line in STATE.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if now_ms - row.get("ts", 0) < SAME_PROJECT_MIN * 60_000:
                out.add(row.get("proyecto"))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--log-file")
    ap.add_argument("--seats-file")
    ap.add_argument("--health-file")
    ap.add_argument("--plugins-file")
    ap.add_argument("--now-ms", type=int)
    ap.add_argument("--project", action="append", default=[], help="thr_x=proj_y, instead of asking bb")
    ap.add_argument("--until", default="2026-11-05T08:00:00+01:00")
    args = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    now_ms = args.now_ms or int(now.timestamp() * 1000)

    def read(path, cmd):
        return Path(path).read_text() if path else run(cmd)

    def log(msg: str) -> None:
        line = f"{dt.datetime.now().astimezone().isoformat(timespec='seconds')} {'[prueba] ' if args.dry_run else ''}{msg}"
        print(line)
        if not args.dry_run:
            RUNS.parent.mkdir(parents=True, exist_ok=True)
            with RUNS.open("a") as f:
                f.write(line + "\n")

    def off(why: str) -> int:
        log(f"apagado: {why}")
        if not args.dry_run:
            subprocess.run(["systemctl", "--user", "disable", "--now", TIMER], capture_output=True)
        return 0

    if args.now_ms is None and now > dt.datetime.fromisoformat(args.until):
        return off(f"pasada la hora de corte {args.until}")
    version = plugin_version(read(args.plugins_file, ["bb", "plugin", "list"]))
    if version is None:
        # Without the installed version a move could fight a plugin that
        # already moves stuck projects itself (code-reviewer r1 L1).
        log("pasada: sin versión del plugin en `bb plugin list`; no muevo nada")
        return 0
    if version >= OFF_VERSION:
        return off(f"el plugin instalado es {'.'.join(map(str, version))}: ya mueve él los proyectos atascados")

    stuck = parse_stuck(read(args.log_file, ["bb", "plugin", "logs", "claude-switcher", "-n", "3000"]), now_ms)
    if not stuck:
        log(f"pasada: sin STUCK en los últimos {WINDOW_MIN} min; nada que mover")
        return 0
    room = parse_seats(read(args.seats_file, ["bb", "claude-switcher", "seats"]))
    health = parse_health(read(args.health_file, ["bb", "claude-switcher", "health"]))
    given = dict(p.split("=", 1) for p in args.project)

    def project_of(thread: str):
        if thread in given:
            return given[thread]
        if args.log_file:
            return None
        try:
            return json.loads(run(["bb", "thread", "show", thread, "--json"]))["thread"]["projectId"]
        except Exception as e:  # noqa: BLE001 (una pasada fallida se registra y no para las demás)
            log(f"{thread}: no se pudo leer su proyecto: {e}")
            return None

    moves, notes = plan_moves(stuck, room, health, project_of, recent_projects_moved(now_ms))
    for n in notes:
        log(f"sin mover: {n}")
    for mv in moves:
        if not args.dry_run:
            try:
                run(["bb", "claude-switcher", "use", mv["proyecto"], mv["a"]])
            except Exception as e:  # noqa: BLE001 (una pasada fallida se registra y no para las demás)
                log(f"falló mover {mv['proyecto']} a {mv['a']}: {e}")
                continue
            at = dt.datetime.now().astimezone()
            row = {"ts": int(at.timestamp() * 1000), "hora": at.isoformat(timespec="seconds"), **mv}
            STATE.parent.mkdir(parents=True, exist_ok=True)
            with STATE.open("a") as f:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        log(f"movido: {mv['hilo']} ({mv['proyecto']}) {mv['de']} → {mv['a']}: {mv['motivo']}")
    log(f"pasada: {len(stuck)} STUCK, {len(moves)} movimiento(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
