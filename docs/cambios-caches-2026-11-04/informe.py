#!/usr/bin/env python3
"""Escribe docs/cambios-y-caches.md desde los ficheros de esta carpeta. Dos tiradas, mismo fichero.

Uso: informe.py > ../cambios-y-caches.md
"""
import gzip
import importlib.util
import json
import os
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from zoneinfo import ZoneInfo

AQUI = os.path.dirname(os.path.abspath(__file__))
_s = importlib.util.spec_from_file_location("simular", os.path.join(AQUI, "simular.py"))
sim = importlib.util.module_from_spec(_s)
_s.loader.exec_module(sim)
an = sim.an
MADRID = ZoneInfo("Europe/Madrid")
CANARIO = "thr_4kfyv6knny"
MOTIVOS = [
    ("cuota", "cuota agotada (el turno falla o la cuenta ya no puede)"),
    ("cuota-previa", "cuota casi agotada (cambio anticipado)"),
    ("rescate-cuota", "rescate de proyectos parados en una cuenta agotada"),
    ("sin-login", "cuenta sin login"),
    ("reserva", "regla «Esperar siempre» (Opus sale de una Max)"),
    ("reserva-vuelta", "vuelta tras esa excursión"),
    ("plazas", "plazas llenas"),
    ("a-mano", "mover a mano (`use`)"),
    ("rebalance", "`rebalance`"),
    ("sin-registro", "sin línea en el registro"),
]
CLASES = ["mata", "caduca-tras-mover", "fria", "misma-org", "cambia-modelo", "compacta", "sin-explicar"]


def h(ms):
    return datetime.fromtimestamp(ms / 1000, MADRID).strftime("%m-%d %H:%M")


def d(x):
    return f"{x:,.2f}".replace(",", " ").replace(".", ",")


def n(x):
    return f"{x:,}".replace(",", ".")


def main():
    s, matadas, r = sim.simular()
    F = r["filas"]
    dias = 7
    total = sum(f["coste"] for f in matadas)
    toks = [f["tokens"] for f in matadas]
    cuentas_mov = r["movimientos"]
    print("# Cachés que mata el cambio de cuenta (7 días)\n")
    print(f"Ventana: {h(r['desde'])} a {h(r['ahora'])} (hora de Madrid), 2026. Encargo: Aitor, 2026-11-04, audio tareas-1, «vamos a valorar las cachés que se están matando por el cambio de cuenta». Todas las cifras son **cuenta nuestra**, recalculables con `python3 docs/cambios-caches-2026-11-04/informe.py` desde los ficheros de esa carpeta (se extraen con `rehacer.sh`). Los dólares son tarifa de API usada como proxy: las cuentas son suscripciones y nadie paga esa cantidad; lo que se gasta es cuota.\n")
    print("## Resultado\n")
    print(f"- **{r['movs_total']} movimientos** en el registro del plugin, pero solo **{len(F)} cambios reales** de cuenta en un hilo (el proceso de Claude arrancó en otra cuenta): la mayoría de los movimientos son de proyectos parados que no se notan hasta el siguiente turno, y muchos se pisan entre sí.")
    print(f"- **{len(matadas)} mataron una caché viva**: {n(sum(toks))} tokens reescritos, ≈ {d(total)} $ en la semana (≈ {d(total / dias)} $/día, proxy). Contexto de cada una: mediana {n(int(statistics.median(toks)))}, máximo {n(max(toks))} tokens.")
    c = Counter(f["clase"] for f in F)
    print(f"- {c['misma-org']} cambios no perdieron nada porque fueron de una Team a otra: **team1 a team5 son la misma organización** (hash en `cuentas.json`, leído de `oauthAccount.organizationUuid` en las dos máquinas) y su caché se comparte. Con hueco de menos de 1 h, sin compactar ni cambiar de modelo: entre Team, {c['misma-org']} aciertos y {sum(1 for f in matadas if f['misma_org'])} fallos; entre organizaciones distintas, {sum(1 for f in matadas if not f['misma_org'])} fallos y {c['sin-explicar']} aciertos. Esto corrige lo que dábamos por hecho («cada cuenta es su organización»): vale para las Max, no para las Team.")
    print(f"- {c['fria']} cambios llegaron con la caché ya caducada (pausa de más de 1 h antes del cambio): no mataron nada. {c['caduca-tras-mover']} más estaban vivas al mover el proyecto, pero el siguiente turno llegó pasada la hora: sin tics habrían caducado igual.")
    rees = r["reescrituras"]
    total_rees = sum(v[2] for v in rees.values())
    print(f"- Proporción: de todo lo reescrito en estos 7 días por los hilos de bb (≈ {d(total_rees)} $, proxy), el cambio de cuenta con caché viva es el {round(100 * total / total_rees)} %.\n")

    print("## Canario: el hilo de la mudanza al i9\n")
    filas = [f for f in F if f["hilo"] == CANARIO]
    print("| Hora | De → a | Hueco antes | Clase | Tokens escritos en la 1.ª petición | Motivo |\n| --- | --- | --- | --- | --- | --- |")
    for f in filas:
        print(f"| {h(f['at'])} | {f['de']} → {f['a']} | {d(f['hueco_min'])} min | {f['clase']} | {n(f['escribe1'])} | {f['motivo']} |")
    print("\nSale en la tabla y cambió a las ~06:05, como decía el encargo, pero **no mató una caché viva**: su última petición fue más de 2 h antes, la caché ya había caducado y esa reescritura se habría pagado sin cambiar de cuenta. Calor lo marca «fría: la cuenta del proyecto cambió»; la causa real es la pausa.\n")

    print("## Reparto por motivo\n")
    print("Cuántos cambios reales, y qué pasó con su caché. «Movimientos» son las líneas del registro, por eso no suman lo mismo.\n")
    print("| Motivo | Movimientos | Cambios reales | Mataron | Tokens | $ (proxy) | Caducó tras mover | Ya fría | Sin pérdida (Team) | Modelo o compactación |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |")
    for clave, nombre in MOTIVOS:
        fs = [f for f in F if f["motivo"] == clave]
        ma = [f for f in fs if f["clase"] == "mata"]
        cc = Counter(f["clase"] for f in fs)
        print(f"| {nombre} | {cuentas_mov.get(clave, 0)} | {len(fs)} | {len(ma)} | {n(sum(f['tokens'] for f in ma))} | {d(sum(f['coste'] for f in ma))} | {cc['caduca-tras-mover']} | {cc['fria']} | {cc['misma-org']} | {cc['cambia-modelo'] + cc['compacta']} |")
    print(f"| **Total** | **{r['movs_total']}** | **{len(F)}** | **{len(matadas)}** | **{n(sum(toks))}** | **{d(total)}** | **{c['caduca-tras-mover']}** | **{c['fria']}** | **{c['misma-org']}** | **{c['cambia-modelo'] + c['compacta']}** |")
    print(f"\n{c['sin-explicar']} cambios entre organizaciones leyeron la caché y no sabemos por qué (fuera de la tabla: es el error del método). `reserva` incluye tiempo anterior a «Esperar siempre» (2026-11-03).\n")

    print("## De dónde sale cada reescritura de la semana\n")
    print("| Causa | Veces | Tokens | $ (proxy) |\n| --- | ---: | ---: | ---: |")
    for k, v in sorted(rees.items(), key=lambda kv: -kv[1][2]):
        print(f"| {k} | {v[0]} | {n(v[1])} | {d(v[2])} |")
    print()

    print("## Calor frente a la medida\n")
    with gzip.open(os.path.join(AQUI, "calor.json.gz"), "rt", encoding="utf-8") as fh:
        calor = json.load(fh)
    with gzip.open(os.path.join(AQUI, "proyectos-cuenta.json.gz"), "rt", encoding="utf-8") as fh:
        cuenta_proyecto = {p["id"]: p["cuenta"] for p in json.load(fh)}
    org = json.load(open(os.path.join(AQUI, "cuentas.json"), encoding="utf-8"))
    hilos = {x["t"]: x for x in an.leer_gz("hilos.jsonl.gz")}
    frios = [x for x in calor if "cuenta" in (x.get("motivo") or "")]
    resumen = Counter()
    for x in frios:
        hh = hilos.get(x["hilo"])
        tandas = an.tandas_de(hh) if hh else []
        if not tandas:
            resumen["sin tandas en la ventana"] += 1
            continue
        ult = tandas[-1]
        destino = cuenta_proyecto.get(hh["p"])
        misma = org.get(ult["cuenta"]) == org.get(destino)
        if r["ahora"] - ult["fin"] >= an.TTL_MS:
            resumen["caducada por tiempo"] += 1
        elif misma:
            resumen["viva, y el proyecto sigue en su organización"] += 1
        else:
            resumen["viva, pero el siguiente turno irá a otra organización"] += 1
    print(f"`bb calor list` da {len(frios)} hilos «fría: la cuenta del proyecto cambió» de {len(calor)}, a la hora de la ventana. Medido con su última petición y la cuenta real de su proceso:\n")
    for k, v in sorted(resumen.items(), key=lambda kv: -kv[1]):
        print(f"- {k}: {v}")
    print("\nCalor juzga por la variable del proyecto: no sabe que entre Team la caché sigue viva, ni que un proceso abierto sigue en su cuenta. Se pide aparte a su buzón; este encargo no lo toca.\n")

    print("## Las cachés matadas, una a una\n")
    print("| Hora | Hilo | De → a | Motivo | Hueco (min) | Contexto (tokens) | $ (proxy) | Modelo |\n| --- | --- | --- | --- | ---: | ---: | ---: | --- |")
    for f in matadas:
        print(f"| {h(f['at'])} | {f['hilo']} | {f['de']} → {f['a']} | {f['motivo']} | {d(f['hueco_min'])} | {n(f['tokens'])} | {d(f['coste'])} | {(f['modelo'] or '').replace('claude-', '')} |")
    print()

    print("## Cómo se mide\n")
    print(f"""- **Unidad**: la tanda, un mensaje procesado, de `thread/tokenUsage/updated` en `bb.db` (leída en solo lectura, `extraer.py`): {r['tandas']} tandas de {len(hilos)} hilos de Claude Code. Cada una lleva {r['ttl']} como `promptCacheTtlMs`, de ahí 1 h.
- **Cuenta real de cada tanda**: el `provider.env-resolved` que arrancó el proceso, el que llega pegado a `turn/started` o con el hilo parado. El que llega con un turno abierto no cambia nada (un `tell` que entra en un turno en marcha), y el «running on» del registro del plugin dice dónde está el proyecto, no dónde corre el proceso. Prueba: con esa regla, {c["sin-explicar"]} sin explicar; sin ella salían 17 en esta misma semana (medido antes de añadirla).
- **¿Se perdió la caché?** Primera petición de la tanda, de la transcripción de Claude Code de su máquina (`primeras.py`, en el NUC, el Mac y el i9; {r['sin_primera']} tandas sin encontrar): perdida si escribe al menos la mitad de lo que lee y escribe, en un contexto de 1.000 tokens o más.
- **Clases**: `mata` hueco < 1 h y perdida; `caduca-tras-mover` hueco ≥ 1 h, viva al escribirse el movimiento; `fria` caducada antes de moverse; `misma-org` hueco < 1 h entre Team, sin pérdida; `cambia-modelo` y `compacta` son reescrituras que habrían ocurrido igual.
- **Coste** (misma fórmula que `Optimizador/informes/2026-11-04/friki/cache-viva.md` §Procedencia): tokens × precio de escritura de 1 h, por modelo (Fable 20, Opus 8, Sonnet 4, Haiku 0,2 $/M, tabla de `Optimizador/informes/2026-10-14/cache/medir-cache.py:20-26`). La doc oficial da 5 $/M de entrada para Opus 5 (Context7, `platform.claude.com/docs/pt-BR/models/opus-5/overview`), que con escritura de 1 h al doble serían 10 en vez de 8: el total subiría {d(sum(f['tokens'] for f in matadas if 'opus' in (f['modelo'] or '')) * 2 / 1e6)} $.
- **Motivo**: la última línea del registro con movimiento del proyecto hacia esa cuenta. Registro: `plugin.log` del NUC desde el 2026-10-29 01:08 UTC y el del Mac hasta entonces, con 50 líneas de proyectos ya borrados sin resolver a un id.
- **Calor**: `bb calor list --json` a la hora de la extracción (motivo y fin del último turno). Sus tics se identifican por `calor/logs/plugin.log`.

## Lo que este informe no ve

- Las sesiones interactivas del Mac y los subagentes: solo hilos de bb. Por eso {d(total / dias)} $/día no es comparable con los ~73 $/día de la remedición del 2026-10-26 (`cache-prompts.md:16`), que medía transcripciones de todas las sesiones y tiempos anteriores a las reglas de hoy.
- Las plazas y la sesión de cada cuenta tienen un agujero de unos 2 días en las muestras del plugin (10-31 a 11-03): el almacén de muestras dejó de caber en el KV el 2026-11-01 y una recarga se lleva lo no guardado. Las plazas se reconstruyen del registro; el porcentaje de Fable de cada cuenta en el pasado no se guarda en ninguna parte.
- Una versión instalada nueva (0.2.39, 2026-11-04 04:58) solo lleva horas: casi todo el registro es de versiones anteriores, con otras reglas.""")


if __name__ == "__main__":
    main()
