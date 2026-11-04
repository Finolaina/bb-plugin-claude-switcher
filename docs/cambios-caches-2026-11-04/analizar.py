#!/usr/bin/env python3
"""Cuenta los cambios de cuenta de 7 días y las cachés que mataron. Solo lee ficheros de esta carpeta.

Uso: analizar.py [--json]  (carpeta = la de este script)
Entradas: hilos.jsonl.gz (extraer.py), movimientos.jsonl.gz (parsear-registro.py), tics.jsonl.gz,
cuentas.json (organización de cada cuenta, hash corto), ahora.txt (hora de la extracción, ms).
Sin red ni bb: el resultado se repite byte a byte.

Unidad: la TANDA, cada evento de tokens de bb (un mensaje procesado, con todas sus peticiones al
modelo). Un mismo id de turno puede traer muchas tandas (un turno abierto con subagentes de fondo
recibe tics y avisos), así que el turno no sirve de unidad.
La cuenta de una tanda es la del último `provider.env-resolved` que arrancó un proceso, es decir, el
que llega pegado a un `turn/started` o con el hilo parado. El que llega con un turno abierto (un
`tell` que se mete en un turno en marcha) no cambia nada: el proceso sigue vivo con su cuenta, como
demuestra que la petición siguiente lea la caché. El «running on» del registro del plugin dice dónde
está el proyecto, no dónde corre un proceso ya abierto.
"""
import gzip
import json
import os
import sys
from collections import Counter, defaultdict

AQUI = os.path.dirname(os.path.abspath(__file__))
TTL_MS = 3_600_000  # promptCacheTtlMs de cada evento de tokens (salida: «ttl»)
# $/M de escritura de 1 h; misma tabla que Optimizador/informes/2026-10-14/cache/medir-cache.py:20-26
PRECIO_ESCRITURA = (("fable", 20.0), ("opus-5", 8.0), ("sonnet", 4.0), ("haiku", 0.2))
REHECHA = 0.5  # escribe al menos la mitad del contexto = la caché no estaba
CTX_MIN = 1000  # por debajo no hay caché que perder
PEGADO = 3  # eventos entre turn/started y el provider.env-resolved de su arranque (medido: 1-2)


def precio(modelo):
    m = (modelo or "").lower()
    for clave, valor in PRECIO_ESCRITURA:
        if clave in m:
            return valor
    return PRECIO_ESCRITURA[0][1]  # sin modelo conocido: tarifa Fable, como medir-cache.py


def leer_gz(nombre):
    with gzip.open(os.path.join(AQUI, nombre), "rt", encoding="utf-8") as f:
        return [json.loads(x) for x in f if x.strip()]


def tandas_de(h):
    """Las tandas de un hilo, en orden: arranque, cuenta, sesión, modelo y contexto que llevaban.

    El arranque es el primer mensaje, turno o reconstrucción tras la tanda anterior. Un evento de
    contexto no arranca nada: bb lo emite también justo después de los tokens de la tanda anterior.
    """
    cuenta, conocida, modelo, sesion = None, False, None, None
    ctx_ultimo = None
    abierto, seq_ini = False, -10
    salida = []
    actual = {"ini": None, "ctx": None, "modelo": None}
    for ev in h["ev"]:
        tipo, at = ev[0], ev[2]
        if tipo == "env":
            sesion = ev[3] or sesion
            if not conocida or not abierto or ev[1] - seq_ini <= PEGADO:
                cuenta, conocida = ev[4] or "(por defecto)", True
        elif tipo == "ini":
            sesion = ev[4] or sesion
            abierto, seq_ini = True, ev[1]
        elif tipo == "fin":
            abierto = False
        if tipo in ("env", "ini", "req") and actual["ini"] is None:
            actual["ini"] = at
        if tipo == "ctx":
            if ev[5]:
                modelo = ev[5]
                if actual["ini"] is not None:
                    actual["modelo"] = actual["modelo"] or ev[5]
            if ev[4]:
                if actual["ini"] is not None and actual["ctx"] is None:
                    actual["ctx"] = ev[4]
                ctx_ultimo = ev[4]
        elif tipo == "comp":
            actual["comp_at"] = actual.get("comp_at") or at
        elif tipo == "tok":
            lee, escribe = ev[5] or 0, ev[6] or 0
            if lee + escribe > 0:
                previa = salida[-1] if salida else None
                ini = actual["ini"]
                salida.append({
                    # Sin mensaje ni turno nuevo (aviso de un subagente de fondo): 0 s de hueco medibles.
                    "ini": ini if ini is not None else (previa["fin"] if previa else at), "fin": at,
                    "lee": lee, "escribe": escribe, "ttl": ev[8], "sesion": sesion,
                    "ctx": actual["ctx"] if actual["ctx"] is not None else ctx_ultimo,
                    "modelo": actual["modelo"] or modelo, "comp_at": actual.get("comp_at"),
                    "cuenta": cuenta if conocida else None, "con_mensaje": ini is not None,
                })
                actual = {"ini": None, "ctx": None, "modelo": None}
    return salida


def rehecha(p):
    """¿La primera petición de la tanda escribió la caché en vez de leerla? `p` viene de primeras.py."""
    base = p["lee"] + p["escribe"]
    return base >= CTX_MIN and p["escribe"] >= REHECHA * base


def ultimo_movimiento(movs, cuenta, hasta):
    """El último movimiento del proyecto hacia `cuenta` no posterior al arranque de la tanda."""
    mejor = None
    for m in movs:
        if m["ts"] > hasta + 5000:
            break
        if m.get("a") == cuenta:
            mejor = m
    return mejor


def analizar():
    ahora = int(open(os.path.join(AQUI, "ahora.txt"), encoding="utf-8").read().strip())
    desde = ahora - 7 * 86_400_000
    hilos = leer_gz("hilos.jsonl.gz")
    movimientos = leer_gz("movimientos.jsonl.gz")
    org = json.load(open(os.path.join(AQUI, "cuentas.json"), encoding="utf-8"))
    proyecto_de = {h["t"]: h["p"] for h in hilos}

    movs_proy = defaultdict(list)
    for m in movimientos:
        p = m.get("proyecto") or proyecto_de.get(m.get("hilo"))
        if p and p != "?":
            movs_proy[p].append(m)

    primeras = {(p["h"], p["t"]): p for p in leer_gz("primeras.jsonl.gz")}
    filas, sin_cambio = [], []
    n_tandas, ttls, desconocidas, sin_primera = 0, Counter(), 0, 0
    reescrituras = defaultdict(lambda: [0, 0, 0.0])  # causa → tandas, tokens, coste

    def apunta(causa, p):
        fila = reescrituras[causa]
        fila[0] += 1
        fila[1] += p["escribe"]
        fila[2] += p["escribe"] * precio(p["modelo"]) / 1e6

    for h in hilos:
        tandas = tandas_de(h)
        visto_org = {}  # organización → última tanda de este hilo allí
        previa_p = None
        for i, b in enumerate(tandas):
            a = tandas[i - 1] if i else None
            antes = dict(visto_org)
            p = primeras.get((h["t"], b["ini"]))
            modelo_antes = previa_p["modelo"] if previa_p else None
            if p:
                previa_p = p
            if b["cuenta"] is not None:
                visto_org[org.get(b["cuenta"], b["cuenta"])] = b["fin"]
            if a is None or b["ini"] < desde:
                continue
            n_tandas += 1
            ttls[str(b["ttl"])] += 1
            if a["cuenta"] is None or b["cuenta"] is None:
                desconocidas += 1
                continue
            if p is None:
                sin_primera += 1
                continue
            hueco = b["ini"] - a["fin"]
            modelo_cambia = bool(modelo_antes and p["modelo"] != modelo_antes)
            hecha = rehecha(p)
            compacto = b.get("comp_at") is not None and b["comp_at"] <= p["at"]
            if a["cuenta"] == b["cuenta"]:
                if hecha:
                    if hueco >= TTL_MS:
                        apunta("pausa de más de 1 h, misma cuenta", p)
                    else:
                        por = "compactación" if compacto else "cambio de modelo" if modelo_cambia else "otra"
                        apunta(f"{por}, misma cuenta", p)
                        sin_cambio.append({"hilo": h["t"], "at": b["ini"], "tokens": p["escribe"], "por": por, "hueco_min": round(hueco / 60000, 1)})
                continue
            clave_a = org.get(b["cuenta"], b["cuenta"])
            misma_org = org.get(a["cuenta"], a["cuenta"]) == clave_a
            destino_vivo = b["ini"] - antes.get(clave_a, -10**15) < TTL_MS
            mov = ultimo_movimiento(movs_proy.get(h["p"], []), b["cuenta"], b["ini"])
            mov_at = mov["ts"] if mov else None
            viva_al_mover = mov_at is not None and mov_at - a["fin"] < TTL_MS
            if compacto:
                clase = "compacta"
            elif modelo_cambia:
                clase = "cambia-modelo"
            elif hueco < TTL_MS:
                clase = "mata" if hecha else ("misma-org" if misma_org else "destino-vivo" if destino_vivo else "sin-explicar")
            elif viva_al_mover and hecha:
                clase = "caduca-tras-mover"
            else:
                clase = "fria"
            toks = p["escribe"] if hecha else 0
            if hecha:
                apunta({"mata": "cambio de cuenta con la caché viva", "caduca-tras-mover": "pausa de más de 1 h, cuenta cambiada mientras", "fria": "pausa de más de 1 h, cuenta cambiada después",
                        "compacta": "compactación, cuenta cambiada", "cambia-modelo": "cambio de modelo, cuenta cambiada"}.get(clase, "otra"), p)
            filas.append({
                "hilo": h["t"], "proyecto": h["p"], "at": b["ini"], "de": a["cuenta"], "a": b["cuenta"],
                "misma_org": misma_org, "destino_vivo": destino_vivo, "con_mensaje": b["con_mensaje"],
                "hueco_min": round(hueco / 60000, 1), "fin_prev": a["fin"],
                "mov_at": mov_at, "motivo": mov["motivo"] if mov else "sin-registro",
                "clase": clase, "lee1": p["lee"], "escribe1": p["escribe"],
                "tokens": toks, "modelo": p["modelo"], "modelo_antes": modelo_antes,
                "coste": round(toks * precio(p["modelo"]) / 1e6, 3),
            })
    movs_ventana = [m for m in movimientos if m["ts"] >= desde]
    return {
        "ahora": ahora, "desde": desde, "filas": sorted(filas, key=lambda f: f["at"]),
        "sin_cambio": sin_cambio, "tandas": n_tandas, "ttl": dict(ttls), "desconocidas": desconocidas, "sin_primera": sin_primera,
        "movimientos": dict(Counter(m["motivo"] for m in movs_ventana)), "movs_total": len(movs_ventana),
        "reescrituras": {k: [v[0], v[1], round(v[2], 2)] for k, v in sorted(reescrituras.items())},
    }


if __name__ == "__main__":
    r = analizar()
    if "--json" in sys.argv:
        print(json.dumps(r, ensure_ascii=False, sort_keys=True))
        sys.exit(0)
    F = r["filas"]
    print("tandas", r["tandas"], "ttl", r["ttl"], "pares con cuenta desconocida", r["desconocidas"], "sin primera petición", r["sin_primera"])
    print("movimientos del plugin", r["movs_total"], r["movimientos"])
    print("cambios reales en hilos", len(F), Counter(f["clase"] for f in F))
    tabla = defaultdict(lambda: [0, 0, 0.0])
    for f in F:
        k = (f["motivo"], f["clase"])
        tabla[k][0] += 1
        tabla[k][1] += f["tokens"]
        tabla[k][2] += f["coste"]
    for k in sorted(tabla):
        print(k, tabla[k][0], tabla[k][1], round(tabla[k][2], 2))
    print("rehechas sin cambio de cuenta", Counter(x["por"] for x in r["sin_cambio"]), sum(x["tokens"] for x in r["sin_cambio"]))
    print("misma org, hueco < 1 h, sin compactar ni cambiar de modelo:",
          Counter(f["clase"] for f in F if f["misma_org"] and f["hueco_min"] < 60 and f["clase"] not in ("compacta", "cambia-modelo")))
    print("otra org, hueco < 1 h, sin compactar ni cambiar de modelo:",
          Counter(f["clase"] for f in F if not f["misma_org"] and f["hueco_min"] < 60 and f["clase"] not in ("compacta", "cambia-modelo")))
    for f in F:
        if f["hilo"] == "thr_4kfyv6knny":
            print("CANARIO", json.dumps(f, ensure_ascii=False))
    for f in F:
        if f["clase"] == "sin-explicar" or (f["misma_org"] and f["clase"] == "mata"):
            print(f["clase"], f["hilo"], f["de"], "→", f["a"], "hueco", f["hueco_min"], "lee1", f["lee1"], "esc1", f["escribe1"], f["modelo"], f["motivo"])
