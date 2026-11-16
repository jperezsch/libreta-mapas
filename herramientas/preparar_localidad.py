#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
preparar_localidad.py  ·  Libreta de Campo, mapas sin conexión
Revisión R1 · 2026-11-14 · automatiza los pasos II-1 a II-14 de la Guía de mapas.

Qué hace (subcomando "preparar"):
  1. Genera el polígono circular (radio pedido + 0,5 km de margen).
  2. Elige el build más reciente de Protomaps que exista.
  3. Corta el mapa base (zoom 15, baja a 14 o 13 si el total supera el tope).
  4. Corta el relieve de Mapterhorn (zoom 12).
  5. Verifica los dos paquetes con "pmtiles verify".
  6. Copia los paquetes a la carpeta del repositorio, agrega o reemplaza la
     entrada en catalogo.json (conserva "capas" e "imagenes") y borra los
     paquetes antiguos de esa localidad.

Subcomando "verificar": comprueba que lo publicado en GitHub Pages responde
(catálogo con la entrada nueva, paquetes por rangos, CORS y firma PMTiles).

Solo usa la biblioteca estándar de Python 3.8 o superior. Necesita el programa
pmtiles (go-pmtiles) en el PATH, o indicado con --pmtiles.

Uso local en Windows (equivale a la tarea T13):
  python herramientas\\preparar_localidad.py preparar --nombre "Parque Rucamanque, Temuco" ^
      --region "Región de La Araucanía" --lat -38.6574947 --lon -72.5928705 --radio-km 4 ^
      --pmtiles C:\\herramientas\\pmtiles\\pmtiles.exe --repo-dir "C:\\ruta\\al\\repositorio"
"""
import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

R_TIERRA_KM = 6371.0
MARGEN_KM = 0.5
VERTICES = 72
LIMITE_ARCHIVO = 95 * 1000 * 1000      # GitHub rechaza archivos de 100 MB o más
ZOOM_MIN_BASE = 13
DIAS_ATRAS_BUILD = 8

BUILD_BASE = os.environ.get("PROTOMAPS_BUILD_BASE", "https://build.protomaps.com")
RELIEVE_URL = os.environ.get("MAPTERHORN_URL", "https://download.mapterhorn.com/planet.pmtiles")


class Falla(Exception):
    """Error esperable, con mensaje pensado para leerse en pantalla."""


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- utilidades
def numero(texto, nombre):
    try:
        return float(str(texto).strip().replace(",", "."))
    except ValueError:
        raise Falla(f"{nombre}: '{texto}' no es un número.")


def hacer_slug(nombre):
    base = nombre.split(",")[0]
    base = unicodedata.normalize("NFKD", base)
    base = "".join(c for c in base if not unicodedata.combining(c)).lower()
    base = re.sub(r"[^a-z0-9]+", "_", base).strip("_")
    return base


def circulo(lat, lon, radio_km, n=VERTICES):
    d = radio_km / R_TIERRA_KM
    phi1, lam1 = math.radians(lat), math.radians(lon)
    puntos = []
    for i in range(n):
        rumbo = 2 * math.pi * i / n
        phi2 = math.asin(math.sin(phi1) * math.cos(d) + math.cos(phi1) * math.sin(d) * math.cos(rumbo))
        lam2 = lam1 + math.atan2(math.sin(rumbo) * math.sin(d) * math.cos(phi1),
                                 math.cos(d) - math.sin(phi1) * math.sin(phi2))
        lo = (math.degrees(lam2) + 540) % 360 - 180
        puntos.append([round(lo, 6), round(math.degrees(phi2), 6)])
    puntos.append(puntos[0])
    return puntos


def caja(anillo):
    lons = [p[0] for p in anillo]
    lats = [p[1] for p in anillo]
    return [min(lons), min(lats), max(lons), max(lats)]


def ahora_utc():
    return datetime.now(timezone.utc)


def http_rango(url, rango="bytes=0-15", timeout=30):
    req = urllib.request.Request(url, headers={"Range": rango, "User-Agent": "libreta-mapas/1"})
    return urllib.request.urlopen(req, timeout=timeout)


def existe_build(fecha):
    url = f"{BUILD_BASE}/{fecha}.pmtiles"
    for intento in range(2):
        try:
            with http_rango(url, "bytes=0-0") as r:
                return r.status in (200, 206)
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                return False
            if intento == 1:
                raise Falla(f"El servidor de builds respondió {e.code} para {url}.")
        except urllib.error.URLError as e:
            if intento == 1:
                raise Falla(f"No se pudo alcanzar {BUILD_BASE} ({e.reason}).")
        time.sleep(3)
    return False


def elegir_build(pedido):
    if pedido and pedido != "auto":
        if not re.fullmatch(r"\d{8}", pedido):
            raise Falla("El build debe tener formato AAAAMMDD, por ejemplo 20261110.")
        if not existe_build(pedido):
            raise Falla(f"El build {pedido} no existe en {BUILD_BASE}. Usa 'auto' o elige otra fecha.")
        return pedido
    hoy = ahora_utc()
    for k in range(DIAS_ATRAS_BUILD):
        fecha = (hoy - timedelta(days=k)).strftime("%Y%m%d")
        if existe_build(fecha):
            return fecha
        log(f"  build {fecha}: no disponible, pruebo el día anterior")
    raise Falla(f"No encontré ningún build de Protomaps en los últimos {DIAS_ATRAS_BUILD} días en {BUILD_BASE}.")


def correr(cmd, intentos=2):
    ultimo = ""
    for i in range(intentos):
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if p.returncode == 0:
            return p
        ultimo = (p.stderr or p.stdout or "").strip()[-600:]
        log(f"  intento {i + 1} de {intentos} falló: {ultimo}")
        time.sleep(5)
    raise Falla(f"Falló el comando {' '.join(map(str, cmd[:3]))} ...\n{ultimo}")


def extraer(pmtiles, origen, destino, poligono, maxzoom=None):
    if destino.exists():
        destino.unlink()
    cmd = [pmtiles, "extract", origen, str(destino), f"--region={poligono}"]
    if maxzoom is not None:
        cmd.append(f"--maxzoom={maxzoom}")
    correr(cmd)
    if not destino.exists() or destino.stat().st_size == 0:
        raise Falla(f"pmtiles terminó sin errores pero no creó {destino.name}.")
    return destino.stat().st_size


def mb(n):
    return f"{n / 1_000_000:.2f} MB"


# ----------------------------------------------------------------- catálogo
def leer_catalogo(ruta):
    if not ruta.exists():
        return {"esquema": 1, "actualizado": "", "mapas": []}
    try:
        datos = json.loads(ruta.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise Falla(f"catalogo.json no es un JSON válido ({e}). No lo modifico.")
    if not isinstance(datos.get("mapas"), list):
        raise Falla("catalogo.json no tiene la lista 'mapas'. No lo modifico.")
    return datos


def base_url(catalogo, arg_base):
    if arg_base:
        return arg_base.rstrip("/")
    if os.environ.get("PAGES_BASE_URL"):
        return os.environ["PAGES_BASE_URL"].rstrip("/")
    for m in catalogo.get("mapas", []):
        for a in m.get("archivos", []):
            u = a.get("url", "")
            if u.startswith("http"):
                limpio = u.split("?")[0]
                return limpio.rsplit("/", 1)[0]
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" in repo:
        dueno, nombre = repo.split("/", 1)
        return f"https://{dueno.lower()}.github.io/{nombre}"
    raise Falla("No pude determinar la dirección base de Pages. Usa --base-url.")


def nombre_de(url):
    return urllib.parse.urlparse(url).path.rsplit("/", 1)[-1]


# ---------------------------------------------------------------- preparar
def preparar(a):
    lat = numero(a.lat, "Latitud")
    lon = numero(a.lon, "Longitud")
    radio = numero(a.radio_km, "Radio (km)")
    max_mb = numero(a.max_mb, "Tope de MB")
    zoom_base = int(numero(a.zoom_base, "Zoom base"))
    if not (-85 <= lat <= 85):
        raise Falla("La latitud debe estar entre -85 y 85.")
    if not (-179 <= lon <= 179):
        raise Falla("La longitud debe estar entre -179 y 179.")
    if not (0.5 <= radio <= 30):
        raise Falla("El radio debe estar entre 0,5 y 30 km.")
    if not (ZOOM_MIN_BASE <= zoom_base <= 15):
        raise Falla(f"El zoom base debe estar entre {ZOOM_MIN_BASE} y 15.")
    if not a.nombre.strip() or not a.region.strip():
        raise Falla("Faltan el nombre o la región.")
    slug = a.id.strip() if a.id else hacer_slug(a.nombre)
    if not re.fullmatch(r"[a-z0-9_]+", slug or ""):
        raise Falla(f"El identificador '{slug}' solo puede tener minúsculas sin tildes, números y guion bajo.")

    repo_dir = Path(a.repo_dir).resolve()
    ruta_cat = repo_dir / "catalogo.json"
    catalogo = leer_catalogo(ruta_cat)
    base = base_url(catalogo, a.base_url)
    pm = a.pmtiles

    trabajo = Path(a.work_dir) if a.work_dir else Path(tempfile.mkdtemp(prefix="mapas_"))
    trabajo.mkdir(parents=True, exist_ok=True)

    log(f"[1/6] Polígono de {radio:g} km + {MARGEN_KM} km de margen para '{slug}'")
    anillo = circulo(lat, lon, radio + MARGEN_KM)
    area = caja(anillo)
    radio_txt = f"{radio:g}".replace(".", "_")
    poligono = trabajo / f"{slug}-{radio_txt}km.geojson"
    poligono.write_text(json.dumps({"type": "FeatureCollection", "features": [{
        "type": "Feature", "properties": {"id": slug},
        "geometry": {"type": "Polygon", "coordinates": [anillo]}}]}), encoding="utf-8")
    log(f"      caja [oeste, sur, este, norte] = {area}")

    log("[2/6] Build de Protomaps")
    build = elegir_build(a.build)
    log(f"      uso {build}")

    zoom = zoom_base
    tope = int(max_mb * 1_000_000)
    base_path = trabajo / "base.pmtiles"
    relieve_path = trabajo / "relieve.pmtiles"
    origen_base = f"{BUILD_BASE}/{build}.pmtiles"
    log("[3/6] Relieve (se corta primero para conocer su tamaño)")
    bytes_relieve = extraer(pm, RELIEVE_URL, relieve_path, poligono)
    log(f"      relieve: {mb(bytes_relieve)}")
    log("[4/6] Mapa base")
    while True:
        bytes_base = extraer(pm, origen_base, base_path, poligono, maxzoom=zoom)
        total = bytes_base + bytes_relieve
        log(f"      base z{zoom}: {mb(bytes_base)} · total {mb(total)} (tope {mb(tope)})")
        if total <= tope:
            break
        if zoom <= ZOOM_MIN_BASE:
            raise Falla(
                f"Con zoom {zoom} el total sigue siendo {mb(total)}, sobre el tope de {mb(tope)}. "
                f"Reduce el radio o sube el tope (max_mb).")
        zoom -= 1
        log(f"      supera el tope: pruebo con zoom {zoom}")

    log("[5/6] Verificación")
    for archivo in (base_path, relieve_path):
        correr([pm, "verify", str(archivo)], intentos=1)
        if archivo.stat().st_size >= LIMITE_ARCHIVO:
            raise Falla(f"{archivo.name} pesa {mb(archivo.stat().st_size)}: GitHub no acepta archivos de 100 MB o más.")
    log("      pmtiles verify sin errores en los dos paquetes")

    nombre_base = f"mapa-{slug}-{build}-z{zoom}.pmtiles"
    nombre_relieve = f"elevacion-{slug}-z12.pmtiles"
    hoy = ahora_utc()
    version = hoy.strftime("%Y-%m")
    sufijo = "?v=" + hoy.strftime("%Y%m")
    nuevos = [
        {"tipo": "base", "url": f"{base}/{nombre_base}{sufijo}", "bytes": bytes_base},
        {"tipo": "relieve", "url": f"{base}/{nombre_relieve}{sufijo}", "bytes": bytes_relieve},
    ]

    resultado = dict(id=slug, nombre=a.nombre.strip(), region=a.region.strip(), build=build, zoom=zoom,
                     bytes_base=bytes_base, bytes_relieve=bytes_relieve, area=area, version=version,
                     lat=lat, lon=lon, radio=radio, urls=[n["url"] for n in nuevos])

    if a.solo_medir:
        log("[6/6] Modo solo medir: no se copia nada ni se toca el catálogo")
        escribir_resumen(resultado, publicado=False, anillo=anillo)
        return 0

    log("[6/6] Copiar al repositorio y actualizar el catálogo")
    repo_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(base_path, repo_dir / nombre_base)
    shutil.copyfile(relieve_path, repo_dir / nombre_relieve)

    existente = next((m for m in catalogo["mapas"] if m.get("id") == slug), None)
    viejos = []
    if existente is not None:
        viejos = [nombre_de(x.get("url", "")) for x in existente.get("archivos", [])]
        entrada = existente
        log(f"      '{slug}' ya existía: reemplazo sus paquetes y conservo capas e imágenes")
    else:
        entrada = {"id": slug, "capas": [], "imagenes": []}
        catalogo["mapas"].append(entrada)
    entrada.update({"nombre": a.nombre.strip(), "region": a.region.strip(), "version": version,
                    "area": area, "archivos": nuevos})
    entrada.setdefault("capas", [])
    entrada.setdefault("imagenes", [])
    catalogo["actualizado"] = hoy.strftime("%Y-%m-%d")
    catalogo.setdefault("esquema", 1)

    for viejo in viejos:
        if viejo and viejo not in (nombre_base, nombre_relieve) and (repo_dir / viejo).is_file():
            (repo_dir / viejo).unlink()
            log(f"      borrado el paquete anterior {viejo}")

    texto = json.dumps(catalogo, ensure_ascii=False, indent=2) + "\n"
    json.loads(texto)
    ruta_cat.write_text(texto, encoding="utf-8")
    log("      catalogo.json actualizado")

    escribir_resumen(resultado, publicado=True, anillo=anillo)
    salida = os.environ.get("GITHUB_OUTPUT")
    if salida:
        with open(salida, "a", encoding="utf-8") as f:
            f.write(f"id={slug}\nnombre_commit={a.nombre.strip()}\n")
    return 0


def escribir_resumen(r, publicado, anillo):
    geo = {"type": "Feature", "properties": {}, "geometry": {"type": "Polygon", "coordinates": [anillo]}}
    enlace = "https://geojson.io/#data=data:application/json," + urllib.parse.quote(json.dumps(geo, separators=(",", ":")))
    total = r["bytes_base"] + r["bytes_relieve"]
    filas = [
        "## Mapa " + ("publicado" if publicado else "medido (no se publicó nada)"),
        "",
        f"**{r['nombre']}** · `{r['id']}` · {r['region']}",
        "",
        "| Dato | Valor |", "|---|---|",
        f"| Centro | {r['lat']}, {r['lon']} |",
        f"| Radio | {r['radio']:g} km (+ {MARGEN_KM} km de margen) |",
        f"| Build de Protomaps | {r['build']} |",
        f"| Mapa base | z{r['zoom']} · {r['bytes_base']:,} bytes ({mb(r['bytes_base'])}) |",
        f"| Relieve | z12 · {r['bytes_relieve']:,} bytes ({mb(r['bytes_relieve'])}) |",
        f"| Total | {mb(total)} |",
        f"| Caja `area` | `{r['area']}` |",
        "",
        f"[Ver el polígono sobre un mapa (geojson.io)]({enlace})",
        "",
        "Fila para el registro de localidades de la Guía (II-14):",
        "",
        "| Id | Nombre | Región | Centro (lat, lon) | Radio (km) | Build Protomaps | Base (bytes) | Relieve (bytes) | Fecha de publicación |",
        "|---|---|---|---|---|---|---|---|---|",
        f"| {r['id']} | {r['nombre']} | {r['region']} | {r['lat']}, {r['lon']} | {r['radio']:g} | {r['build']} | "
        f"{r['bytes_base']} | {r['bytes_relieve']} | {ahora_utc().strftime('%Y-%m-%d')} |",
        "",
    ]
    texto = "\n".join(filas)
    destino = os.environ.get("GITHUB_STEP_SUMMARY")
    if destino:
        with open(destino, "a", encoding="utf-8") as f:
            f.write(texto + "\n")
    log("\n" + texto.replace(enlace, "<enlace geojson.io>"))


# ---------------------------------------------------------------- verificar
def verificar(a):
    repo_dir = Path(a.repo_dir).resolve()
    local = leer_catalogo(repo_dir / "catalogo.json")
    entrada_local = next((m for m in local["mapas"] if m.get("id") == a.id), None)
    if entrada_local is None:
        raise Falla(f"El catálogo local no tiene la localidad '{a.id}'.")
    base = base_url(local, a.base_url)
    limite = time.time() + a.espera
    ultimo = "sin intentos"
    intento = 0
    while True:
        intento += 1
        try:
            problemas = revisar_publicado(base, entrada_local)
        except Exception as e:  # red caída, JSON roto, etc.: se reintenta
            problemas = [f"{type(e).__name__}: {e}"]
        if not problemas:
            log(f"Publicación comprobada (intento {intento}): catálogo, paquetes por rangos, CORS y firma PMTiles correctos.")
            return 0
        ultimo = "; ".join(problemas)
        log(f"intento {intento}: {ultimo}")
        if time.time() + a.pausa > limite:
            break
        time.sleep(a.pausa)
    raise Falla("No pude confirmar la publicación a tiempo. Último problema: " + ultimo +
                ". GitHub Pages a veces demora; revisa la dirección del catálogo en unos minutos.")


def revisar_publicado(base, entrada_local):
    problemas = []
    url_cat = f"{base}/catalogo.json?t={int(time.time())}"
    with urllib.request.urlopen(urllib.request.Request(url_cat, headers={"User-Agent": "libreta-mapas/1"}), timeout=30) as r:
        remoto = json.loads(r.read().decode("utf-8"))
    ent = next((m for m in remoto.get("mapas", []) if m.get("id") == entrada_local["id"]), None)
    if ent is None:
        return ["el catálogo publicado aún no incluye la localidad"]
    if [x.get("url") for x in ent.get("archivos", [])] != [x.get("url") for x in entrada_local["archivos"]]:
        return ["el catálogo publicado aún tiene las direcciones anteriores"]
    for arch in entrada_local["archivos"]:
        try:
            with http_rango(arch["url"]) as r:
                cuerpo = r.read(16)
                cabeceras = {k.lower(): v for k, v in r.headers.items()}
                if r.status != 206:
                    problemas.append(f"{arch['tipo']}: el servidor no entrega por rangos (código {r.status})")
                if not cuerpo.startswith(b"PMTiles"):
                    problemas.append(f"{arch['tipo']}: el archivo no empieza con la firma PMTiles")
                if "access-control-allow-origin" not in cabeceras:
                    problemas.append(f"{arch['tipo']}: falta la cabecera CORS access-control-allow-origin")
                total = cabeceras.get("content-range", "").rsplit("/", 1)[-1]
                if total.isdigit() and int(total) != arch["bytes"]:
                    problemas.append(f"{arch['tipo']}: pesa {total} bytes y el catálogo dice {arch['bytes']}")
        except urllib.error.HTTPError as e:
            problemas.append(f"{arch['tipo']}: HTTP {e.code}")
    return problemas


# --------------------------------------------------------------------- main
def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("preparar", help="corta los paquetes y actualiza el catálogo")
    p.add_argument("--nombre", required=True)
    p.add_argument("--region", required=True)
    p.add_argument("--lat", required=True)
    p.add_argument("--lon", required=True)
    p.add_argument("--radio-km", default="4")
    p.add_argument("--id", default="")
    p.add_argument("--build", default="auto")
    p.add_argument("--zoom-base", default="15")
    p.add_argument("--max-mb", default="30")
    p.add_argument("--pmtiles", default="pmtiles")
    p.add_argument("--repo-dir", default=".")
    p.add_argument("--work-dir", default="")
    p.add_argument("--base-url", default="")
    p.add_argument("--solo-medir", action="store_true")

    v = sub.add_parser("verificar", help="comprueba lo publicado en GitHub Pages")
    v.add_argument("--id", required=True)
    v.add_argument("--repo-dir", default=".")
    v.add_argument("--base-url", default="")
    v.add_argument("--espera", type=int, default=600, help="segundos máximos de espera")
    v.add_argument("--pausa", type=int, default=20, help="segundos entre intentos")

    # argparse toma "-38,65" (coma decimal) por una opción; se pegan como --lat=VALOR.
    crudo = list(sys.argv[1:] if argv is None else argv)
    pegado, i = [], 0
    while i < len(crudo):
        if crudo[i] in ("--lat", "--lon") and i + 1 < len(crudo):
            pegado.append(f"{crudo[i]}={crudo[i + 1]}")
            i += 2
        else:
            pegado.append(crudo[i])
            i += 1
    a = ap.parse_args(pegado)
    try:
        return preparar(a) if a.cmd == "preparar" else verificar(a)
    except Falla as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
