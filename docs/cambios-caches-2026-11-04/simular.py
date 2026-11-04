#!/usr/bin/env python3
"""Cuántas de las cachés matadas de analizar.py habría salvado cada opción. Solo lee esta carpeta.

Uso: simular.py [--json]
La disponibilidad de otra cuenta en el pasado se reconstruye de `agotadas` (lo que dijo el plugin) y de
`muestras` (sesión, semanal y plazas al medir). Canario: las cuentas a las que de verdad fue cada cambio
deben salir disponibles casi siempre; sale en la línea «canario de disponibilidad».
"""
import gzip
import importlib.util
import json
import os
import sys
from bisect import bisect_right
from collections import Counter, defaultdict

AQUI = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location("analizar", os.path.join(AQUI, "analizar.py"))
an = importlib.util.module_from_spec(_s)
_s.loader.exec_module(an)

HORA = 3_600_000
TTL = an.TTL_MS
MUESTRA_VALIDA = 30 * 60_000
PLAZAS = {"team": 2, "max": 4}  # seatsTeam y seatsMax por defecto (CLAUDE.md del repo)
TEAMS = {f"team{i}" for i in range(1, 6)}
CUENTAS = sorted(TEAMS | {"aitor", "ganaresenas", "joytorm", "siloeads", "viaulab"})
RESERVA_DESDE = 1793664000000  # 2026-11-03 00:00 CET: «Esperar siempre» (Aitor, 2026-11-03)
TIC_MS = 8000


def familia(modelo):
    m = (modelo or "").lower()
    for f in ("Fable", "Opus", "Sonnet", "Haiku"):
        if f.lower() in m:
            return f
    return None


class Estado:
    """Lo que se sabe de cada cuenta en un instante del pasado."""

    def __init__(self):
        # Dos fotos de las muestras del plugin: la de hoy y la del 2026-11-03 (el almacén de muestras no
        # cabe en el KV desde el 2026-11-01 y una recarga se lleva lo que no se guardó).
        unidas = defaultdict(dict)
        for ruta in ("muestras.json.gz", "../plazas-2026-11-03/seats-semana.json.gz"):
            with gzip.open(os.path.join(AQUI, ruta), "rt", encoding="utf-8") as f:
                d = json.load(f)
            for cuenta, filas in (d.get("samples") or d).items():
                for fila in filas:
                    unidas[cuenta][fila[0]] = fila
        self.muestras = {k: [v[t] for t in sorted(v)] for k, v in unidas.items()}
        self.t = {k: [s[0] for s in v] for k, v in self.muestras.items()}
        self.plazas = defaultdict(list)
        for x in sorted(an.leer_gz("plazas.jsonl.gz"), key=lambda x: x["ts"]):
            self.plazas[x["cuenta"]].append((x["ts"], x["ocupadas"], x["tope"]))
        self.ts_plazas = {k: [x[0] for x in v] for k, v in self.plazas.items()}
        self.agotada = defaultdict(list)
        for x in an.leer_gz("agotadas.jsonl.gz"):
            # Una espera de bb «until» de pocos minutos es un reintento, no el reset de la ventana.
            if x["hasta"] - x["ts"] >= 10 * 60_000:
                self.agotada[(x["cuenta"], x["modelo"])].append((x["ts"], x["hasta"]))

    def muestra(self, cuenta, at):
        ts = self.t.get(cuenta)
        if not ts:
            return None
        i = bisect_right(ts, at) - 1
        if i < 0 or at - ts[i] > MUESTRA_VALIDA:
            return None
        return self.muestras[cuenta][i]

    def fin_agotada(self, cuenta, modelo, at):
        """Hasta cuándo la cuenta no puede con el modelo, o None si no se dijo nada."""
        fin = None
        for ini, hasta in self.agotada.get((cuenta, modelo), []):
            if ini - 5 * 60_000 <= at < hasta:
                fin = max(fin or 0, hasta)
        return fin

    def libre(self, cuenta, modelo, at):
        """¿Podría correr este modelo con plaza libre? Plazas del registro; sesión y semanal de la muestra, si la hay."""
        if self.fin_agotada(cuenta, modelo, at) is not None:
            return False
        s = self.muestra(cuenta, at)
        if s is not None and ((s[3] or 0) >= 100 or (s[4] or 0) >= 100):
            return False
        ts = self.ts_plazas.get(cuenta, [])
        i = bisect_right(ts, at) - 1
        if i < 0:
            return None if s is None else s[1] + s[2] < PLAZAS["team" if cuenta in TEAMS else "max"]
        _, ocupadas, tope = self.plazas[cuenta][i]
        return ocupadas < tope

    def permitida(self, cuenta, modelo, at):
        """«Esperar siempre»: desde su fecha, Opus no va a una Max con Fable."""
        return not (modelo == "Opus" and at >= RESERVA_DESDE and cuenta not in TEAMS)


def simular():
    r = an.analizar()
    F = r["filas"]
    est = Estado()
    hilos = {h["t"]: h for h in an.leer_gz("hilos.jsonl.gz")}
    org = json.load(open(os.path.join(AQUI, "cuentas.json"), encoding="utf-8"))
    primeras = {(p["h"], p["t"]): p for p in an.leer_gz("primeras.jsonl.gz")}
    # Los tics que bb dio por turno, de su evento: el registro de Calor no marca «enviado» los que se encolaron.
    tics = defaultdict(list)
    for x in an.leer_gz("tics-bb.jsonl.gz"):
        tics[x["hilo"]].append(x["ts"])
    # Cuándo los mandó Calor, con el hilo parado («enviado») o retenidos por el plugin o por un turno («encolado»):
    # es el primer intento, el único que el plugin puede rechazar sin dejar una fila fallida.
    intentos = defaultdict(list)
    for x in an.leer_gz("tics.jsonl.gz"):
        intentos[x["hilo"]].append(x["ts"])
    movs = an.leer_gz("movimientos.jsonl.gz")
    tandas = {t: an.tandas_de(h) for t, h in hilos.items()}
    por_proyecto = defaultdict(list)
    for t, h in hilos.items():
        por_proyecto[h["p"]].append(t)

    def es_tic(hilo, at):
        return any(abs(x - at) <= TIC_MS for x in tics.get(hilo, []))

    matadas = [f for f in F if f["clase"] == "mata"]
    for f in matadas:
        f["familia"] = familia(f["modelo"])
        f["tic"] = es_tic(f["hilo"], f["at"])

    # Canario de disponibilidad: el destino real del cambio debía estar libre o, al menos, sin marcar agotado.
    canario = Counter()
    for f in F:
        if f["clase"] in ("mata", "misma-org", "fria"):
            fam = familia(f["modelo"])
            v = est.libre(f["a"], fam, f["at"] - 2000)
            canario["libre" if v else "sin dato" if v is None else "no libre"] += 1

    salida = {"matadas": len(matadas), "tokens": sum(f["tokens"] for f in matadas), "coste": round(sum(f["coste"] for f in matadas), 2)}

    def resumen(filas):
        return {"n": len(filas), "tokens": sum(f["tokens"] for f in filas), "coste": round(sum(f["coste"] for f in filas), 2)}

    # T · un tic de Calor no cambia de cuenta. Solo ahorra si no llegó un turno de verdad a aprovechar esa escritura.
    t_todas = [f for f in matadas if f["tic"]]
    t_derroche, t_diferida = [], []
    for f in t_todas:
        reales = [x for x in tandas[f["hilo"]] if x["ini"] > f["at"] and not es_tic(f["hilo"], x["ini"])]
        siguiente = reales[0] if reales else None
        if siguiente is None or siguiente["ini"] - f["at"] > 6 * HORA or siguiente["cuenta"] != f["a"]:
            t_derroche.append(f)
        else:
            t_diferida.append(f)
    # Solo la que movió el propio tic está en la mano del plugin: si el proyecto ya se había movido antes,
    # el tic solo arrancó el proceso en la cuenta nueva, y eso Calor ya lo frena desde su regla de «cuenta cambiada».
    def movida_por_tic(f):
        return f["mov_at"] is not None and any(abs(f["mov_at"] - x) <= TIC_MS for x in intentos.get(f["hilo"], []))

    salida["T_tic_no_mueve"] = {
        "disparadas_por_tic": resumen(t_todas),
        "movida_por_tic": resumen([f for f in t_todas if movida_por_tic(f)]),
        "ahorro": resumen([f for f in t_derroche if movida_por_tic(f)]),
        "solo_aplaza": resumen([f for f in t_diferida if movida_por_tic(f)]),
        "filas": [(f["hilo"], f["de"], f["a"], f["motivo"], f["coste"], f in t_derroche, movida_por_tic(f)) for f in t_todas],
    }

    # A · saliendo de una Team, otra Team con plaza (la misma organización conserva la caché).
    a_salva, a_sin, a_vigentes = [], [], []
    for f in matadas:
        if f["de"] in TEAMS and f["a"] not in TEAMS:
            otras = [c for c in TEAMS if c != f["de"] and est.libre(c, f["familia"], f["at"] - 2000)]
            (a_salva if otras else a_sin).append(f)
            if otras and f["familia"] != "Opus":
                a_vigentes.append(f)
    salida["A_misma_org"] = {"team_a_max": resumen(a_salva + a_sin), "habia_team_libre": resumen(a_salva), "sin_team_libre": resumen(a_sin), "filas": [(f["hilo"], f["de"], f["a"], f["familia"]) for f in a_salva]}

    # B · la cuenta donde el hilo aún tiene caché viva, si está libre y la regla lo permite.
    b_salva = []
    for f in matadas:
        visto = {}
        for x in tandas[f["hilo"]]:
            if x["ini"] >= f["at"]:
                break
            if x["cuenta"]:
                visto[x["cuenta"]] = x["fin"]
        for c, fin in visto.items():
            if c == f["de"] or f["at"] - fin >= TTL:
                continue
            if est.libre(c, f["familia"], f["at"] - 2000) and est.permitida(c, f["familia"], f["at"]):
                b_salva.append(dict(f, alternativa=c))
                break
    salida["B_cache_viva"] = {"salva": resumen(b_salva), "filas": [(f["hilo"], f["de"], f["a"], f["alternativa"]) for f in b_salva]}

    # C · mover en la pausa fría anterior, si la cuenta ya iba alta y nadie del proyecto tenía caché viva.
    salida["C_cambio_en_pausa"] = {}
    candidatas = [f for f in matadas if f["motivo"] in ("cuota", "cuota-previa", "rescate-cuota")]
    for umbral in (50, 60, 70, 80, 90):
        salva, sin_pausa, sin_umbral, ocupado = [], [], [], []
        for f in candidatas:
            pasadas = [x for x in tandas[f["hilo"]] if x["fin"] <= f["at"]]
            pausa = None
            for u, v in zip(pasadas, pasadas[1:]):
                if v["ini"] - u["fin"] >= TTL and u["cuenta"] == f["de"]:
                    pausa = (u["fin"], v["ini"])
            if pausa is None or f["at"] - pausa[1] > 48 * HORA:
                sin_pausa.append(f)
                continue
            s = est.muestra(f["de"], pausa[1])
            if s is None or max(s[3] or 0, s[4] or 0) < umbral:
                sin_umbral.append(f)
                continue
            hermano_vivo = False
            for otro in por_proyecto[f["proyecto"]]:
                if otro == f["hilo"]:
                    continue
                if any(0 <= pausa[1] - x["fin"] < TTL or x["ini"] <= pausa[1] <= x["fin"] for x in tandas[otro]):
                    hermano_vivo = True
                    break
            if hermano_vivo:
                ocupado.append(f)
            else:
                salva.append(f)
        salida["C_cambio_en_pausa"][str(umbral)] = {"salva": resumen(salva), "sin_pausa_fria_48h": len(sin_pausa), "bajo_umbral": len(sin_umbral), "proyecto_ocupado": len(ocupado)}
        # Falsas alarmas del umbral: pausas frías que habrían movido un proyecto sin que su cuenta se agotase en 48 h.
        movidas, inutiles = 0, 0
        for hilo, lista in tandas.items():
            for u, v in zip(lista, lista[1:]):
                if v["ini"] < r["desde"] or v["ini"] - u["fin"] < TTL or not u["cuenta"]:
                    continue
                s = est.muestra(u["cuenta"], v["ini"])
                if s is None or max(s[3] or 0, s[4] or 0) < umbral:
                    continue
                movidas += 1
                fam = familia((primeras.get((hilo, v["ini"])) or {}).get("modelo")) or "Fable"
                if not any(est.fin_agotada(u["cuenta"], fam, v["ini"] + i * HORA) for i in range(0, 49, 2)):
                    inutiles += 1
        salida["C_cambio_en_pausa"][str(umbral)].update(moveria=movidas, sin_agotarse_en_48h=inutiles)

    # D · retrasar el cambio por plazas unos minutos.
    registros_plazas = [m for m in movs if m["motivo"] == "plazas" and m["ts"] >= r["desde"]]
    salida["D_retrasar_plazas"] = {"movimientos_por_plazas": len(registros_plazas), "matadas": resumen([f for f in matadas if f["motivo"] == "plazas"])}

    # E · rescate perezoso: el proyecto se queda hasta que un turno lo necesite.
    e_salva, e_modelo, e_sigue = [], [], []
    rescates = defaultdict(list)
    for m in movs:
        if m["motivo"] == "rescate-cuota":
            rescates[(m["proyecto"], m["a"])].append(m)
    for f in matadas:
        if f["motivo"] != "rescate-cuota":
            continue
        previos = [m for m in rescates[(f["proyecto"], f["a"])] if m["ts"] <= f["at"] + 5000]
        m = previos[-1] if previos else None
        if m and familia(f["modelo"]) != m.get("modelo"):
            e_modelo.append(f)  # rescató por el modelo de otro: el turno sí podía correr donde estaba
        elif m and m.get("hasta") and m["hasta"] <= f["at"]:
            e_salva.append(f)  # cuando llegó el turno, el reset ya había pasado
        else:
            e_sigue.append(f)
    salida["E_rescate_perezoso"] = {"modelo_ajeno": resumen(e_modelo), "reset_antes_del_turno": resumen(e_salva), "habria_movido_igual": resumen(e_sigue), "filas_modelo_ajeno": [f["hilo"] for f in e_modelo]}

    # F · esperar al reset si falta poco, en vez de cambiar de cuenta.
    salida["F_esperar_reset"] = {}
    cuota = [f for f in matadas if f["motivo"] in ("cuota", "cuota-previa")]
    for minutos in (5, 15, 30, 60, 120):
        salva = []
        for f in cuota:
            fin = est.fin_agotada(f["de"], f["familia"], f["at"])
            if fin is not None and fin - f["at"] <= minutos * 60_000:
                salva.append(f)
        salida["F_esperar_reset"][str(minutos)] = resumen(salva)

    # G · cadenas: dos cambios seguidos en 2 h, el segundo evitable eligiendo mejor el primero.
    cadena = []
    for f in matadas:
        anteriores = [g for g in F if g["hilo"] == f["hilo"] and g["at"] < f["at"] and f["at"] - g["at"] <= 2 * HORA and g["a"] == f["de"]]
        if anteriores:
            cadena.append(f)
    con_alternativa = []
    for f in cadena:
        previo = max((g for g in F if g["hilo"] == f["hilo"] and g["at"] < f["at"] and g["a"] == f["de"]), key=lambda g: g["at"])
        fam = familia(previo["modelo"])
        horas = [previo["at"] + i * 15 * 60_000 for i in range(0, 9)]
        for c in CUENTAS:
            if c in (previo["de"], previo["a"]):
                continue
            if est.libre(c, fam, previo["at"]) and est.permitida(c, fam, previo["at"]) and not any(est.fin_agotada(c, fam, h) for h in horas):
                con_alternativa.append(f)
                break
    salida["G_cadenas"] = {"cadenas": resumen(cadena), "con_destino_mejor": resumen(con_alternativa), "hilos": sorted({f["hilo"] for f in con_alternativa})}

    # Ninguna regla actual podría evitarlas: lo que queda tras la unión de las opciones que se construirían.
    salida["canario_disponibilidad"] = dict(canario)
    salida["por_motivo"] = {k: resumen([f for f in matadas if f["motivo"] == k]) for k in sorted({f["motivo"] for f in matadas})}
    return salida, matadas, r


if __name__ == "__main__":
    s, _, _ = simular()
    print(json.dumps(s, ensure_ascii=False, indent=1, sort_keys=True))
