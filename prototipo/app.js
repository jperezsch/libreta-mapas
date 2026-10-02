/* Libreta de Campo Pro · prototipo de viabilidad del mapa sin conexión (T15)
   Pagina aparte: no toca la app. Pila: MapLibre GL JS 5.24 + PMTiles + maplibre-contour.
   Almacenamiento: OPFS (con respaldo en IndexedDB si el navegador no permite escribir en OPFS). */
(function () {
"use strict";

var VERSION_PROTO = "proto-1 · 2026-10-01";
var CATALOGO_POR_DEFECTO = "https://jperezsch.github.io/libreta-mapas-prueba/catalogo.json";
var PARAMS = new URLSearchParams(location.search);
var CATALOGO_URL = PARAMS.get("catalogo") || CATALOGO_POR_DEFECTO;
var FORZAR_IDB = PARAMS.get("idb") === "1";
var LS_IDX = "lcp_instalados", LS_CAT = "lcp_catalogo", LS_PTS = "lcp_puntos", LS_ACTIVO = "lcp_mapa_activo", LS_CAPAS = "lcp_capas";
var CENTRO_INICIAL = [-72.5929, -38.6575];

function $(id) { return document.getElementById(id); }
function leerJSON(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
function guardarJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
function mb(b) { return (b / 1048576).toFixed(b < 10485760 ? 2 : 1) + " MB"; }
function el(tag, attrs, hijos) {
  var n = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    if (attrs[k] == null) continue;
    if (k === "texto") n.textContent = attrs[k];
    else if (k === "onclick") n.onclick = attrs[k];
    else if (k === "class") n.className = attrs[k];
    else n.setAttribute(k, attrs[k]);
  }
  (hijos || []).forEach(function (h) { if (h) n.appendChild(h); });
  return n;
}
function fechaLocalHM(d) {
  d = d || new Date();
  function p(x) { return (x < 10 ? "0" : "") + x; }
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

/* ---------- registro de errores y métricas para el informe ---------- */
var errores = [];
function anotarError(origen, e) {
  var m = origen + ": " + (e && e.message ? e.message : String(e));
  if (errores.length < 25) errores.push(fechaLocalHM() + " " + m);
  if (window.console) console.warn(m);
}
var metricas = { descargas: [], aperturaMs: null, fluidez: null, gpsUltimo: null };

/* ---------- almacenamiento de archivos (OPFS o IndexedDB) ---------- */
var Alm = (function () {
  var opfs = !FORZAR_IDB && !!(navigator.storage && navigator.storage.getDirectory &&
    typeof FileSystemFileHandle !== "undefined" && FileSystemFileHandle.prototype.createWritable);
  var dbp = null;
  function idb() {
    if (!dbp) dbp = new Promise(function (res, rej) {
      var r = indexedDB.open("lcp_archivos", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("a"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function idbOp(modo, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction("a", modo), st = tx.objectStore("a"), rq = fn(st);
        tx.oncomplete = function () { res(rq && rq.result); };
        tx.onerror = tx.onabort = function () { rej(tx.error); };
      });
    });
  }
  function dir() { return navigator.storage.getDirectory(); }
  return {
    modo: function () { return opfs ? "OPFS" : "IndexedDB (respaldo)"; },
    leer: async function (nombre) {
      if (opfs) {
        try { return await (await (await dir()).getFileHandle(nombre)).getFile(); }
        catch (e) { if (e.name === "NotFoundError") return null; throw e; }
      }
      return (await idbOp("readonly", function (s) { return s.get(nombre); })) || null;
    },
    borrar: async function (nombre) {
      delete pmCache[nombre];
      if (opfs) { try { await (await dir()).removeEntry(nombre); } catch (e) { if (e.name !== "NotFoundError") anotarError("borrar " + nombre, e); } }
      else await idbOp("readwrite", function (s) { return s.delete(nombre); });
    },
    listar: async function () {
      var out = [];
      if (opfs) { var d = await dir(); for await (var par of d.entries()) if (par[1].kind === "file") out.push(par[0]); }
      else out = (await idbOp("readonly", function (s) { return s.getAllKeys(); })) || [];
      return out;
    },
    /* descarga en flujo; llama onBytes(n) por cada trozo. Lanza error si se cancela o falla. */
    descargar: async function (url, nombre, bytesEsperados, onBytes, signal) {
      var resp = await fetch(url, { signal: signal, cache: "no-store" });
      if (!resp.ok) throw new Error("El servidor respondió " + resp.status);
      if (!resp.body) throw new Error("El navegador no entrega la descarga por partes");
      var reader = resp.body.getReader(), recibido = 0;
      if (opfs) {
        var fh = await (await dir()).getFileHandle(nombre, { create: true });
        var w = await fh.createWritable();
        try {
          for (;;) {
            var r = await reader.read();
            if (r.done) break;
            await w.write(r.value); recibido += r.value.length; onBytes(r.value.length);
          }
          await w.close();
        } catch (e) { try { await w.abort(); } catch (_) {} try { reader.cancel(); } catch (_) {} await this.borrar(nombre); throw e; }
      } else {
        var trozos = [];
        try {
          for (;;) {
            var r2 = await reader.read();
            if (r2.done) break;
            trozos.push(r2.value); recibido += r2.value.length; onBytes(r2.value.length);
          }
        } catch (e) { try { reader.cancel(); } catch (_) {} throw e; }
        var blob = new Blob(trozos, { type: "application/octet-stream" });
        await idbOp("readwrite", function (s) { return s.put(blob, nombre); });
      }
      if (bytesEsperados && recibido !== bytesEsperados) {
        await this.borrar(nombre);
        throw new Error("Tamaño recibido " + recibido + " distinto del esperado " + bytesEsperados);
      }
      var f = await this.leer(nombre);
      if (!f) throw new Error("El archivo no quedó guardado");
      var cab = new Uint8Array(await f.slice(0, 7).arrayBuffer());
      if (String.fromCharCode.apply(null, cab) !== "PMTiles") { await this.borrar(nombre); throw new Error("El archivo no es un paquete PMTiles válido"); }
      return recibido;
    }
  };
})();

/* ---------- lectura de paquetes PMTiles desde el almacenamiento ---------- */
var pmCache = {};
function BlobSource(blob, key) { this.blob = blob; this.key = key; }
BlobSource.prototype.getKey = function () { return this.key; };
BlobSource.prototype.getBytes = function (offset, length) {
  return this.blob.slice(offset, offset + length).arrayBuffer().then(function (b) { return { data: b }; });
};
async function abrirPM(nombre) {
  if (!pmCache[nombre]) {
    var b = await Alm.leer(nombre);
    if (!b) throw new Error("Paquete no instalado: " + nombre);
    pmCache[nombre] = new pmtiles.PMTiles(new BlobSource(b, nombre));
  }
  return pmCache[nombre];
}
async function bytesTesela(nombre, z, x, y) {
  var p = await abrirPM(nombre);
  var r = await p.getZxy(z, x, y);
  return r ? r.data : null;
}

maplibregl.addProtocol("lcmap", async function (params) {
  var m = /^lcmap:\/\/([^\/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
  if (!m) throw new Error("URL de mapa inválida");
  var d = await bytesTesela(m[1], +m[2], +m[3], +m[4]);
  return { data: d || new ArrayBuffer(0) };
});

/* relieve: lo lee maplibre-contour con una función propia que va al almacenamiento */
var relieveNombre = null;
var demSource = new mlcontour.DemSource({ url: "lcdem://{z}/{x}/{y}", encoding: "terrarium", maxzoom: 12, worker: false });
function nuevoManagerDem() {
  demSource.manager = new mlcontour.LocalDemManager({
    demUrlPattern: "lcdem://{z}/{x}/{y}", cacheSize: 128, encoding: "terrarium", maxzoom: 12, timeoutMs: 20000,
    getTile: async function (url) {
      var m = /(\d+)\/(\d+)\/(\d+)$/.exec(url);
      if (!m || !relieveNombre) throw new Error("sin relieve");
      var d = await bytesTesela(relieveNombre, +m[1], +m[2], +m[3]);
      if (!d) throw new Error("tesela de relieve fuera del área");
      return { data: new Blob([d], { type: "image/webp" }), expires: undefined, cacheControl: undefined };
    }
  });
}
nuevoManagerDem();
demSource.setupMaplibre(maplibregl);
var tiemposCurvas = [];
demSource.onTiming(function (t) {
  if (!t || t.error || !/contour/.test(t.url || "")) return;
  if (t.process == null) return;                 /* solo teselas calculadas de verdad, no las de caché */
  tiemposCurvas.push({ dur: t.duration, proc: t.process, dec: t.decode || 0 });
  if (tiemposCurvas.length > 200) tiemposCurvas.shift();
});

/* ---------- estado ---------- */
var inst = leerJSON(LS_IDX, {});          /* id -> {id,nombre,version,area,archivos:[{tipo,nombre,bytes}],fecha} */
var cat = null, catInfo = "";
var desc = null;                           /* descarga en curso */
var activoId = localStorage.getItem(LS_ACTIVO) || null;
var capasVis = leerJSON(LS_CAPAS, { sombra: true, curvas: true, anteriores: true });
var puntos = leerJSON(LS_PTS, []);
var ESTILO_BASE = [];
var gps = { watch: null, fix: null, primera: true };
var online = navigator.onLine !== false;
var hojaTipo = null;

function nombreDeUrl(u) { return decodeURIComponent(new URL(u, location.href).pathname.split("/").pop()); }
function archivosDe(entrada) {
  return (entrada.archivos || []).filter(function (a) { return a.tipo === "base" || a.tipo === "relieve"; });
}
function totalBytes(entrada) { return archivosDe(entrada).reduce(function (s, a) { return s + (a.bytes || 0); }, 0); }
function archivoTipo(m, tipo) {
  var a = (m.archivos || []).filter(function (x) { return x.tipo === tipo; })[0];
  return a ? a.nombre : null;
}

/* ---------- toast, aviso y tarjeta ---------- */
var toastT = null;
function toast(msg, ms) {
  var t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toastT); toastT = setTimeout(function () { t.style.display = "none"; }, ms || 3500);
}
function aviso(msg) { var a = $("aviso"); if (msg) { a.textContent = msg; a.style.display = "block"; } else a.style.display = "none"; }

/* ---------- catálogo ---------- */
async function cargarCatalogo() {
  var sep = CATALOGO_URL.indexOf("?") >= 0 ? "&" : "?";
  try {
    var r = await fetch(CATALOGO_URL + sep + "t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    var j = await r.json();
    if (j.esquema !== 1 || !Array.isArray(j.mapas)) throw new Error("Catálogo con formato no reconocido");
    cat = j; catInfo = "Catálogo del " + (j.actualizado || "?") + ", consultado " + fechaLocalHM();
    guardarJSON(LS_CAT, { fecha: fechaLocalHM(), data: j });
    return true;
  } catch (e) {
    anotarError("catálogo", e);
    var g = leerJSON(LS_CAT, null);
    if (g && g.data) { cat = g.data; catInfo = "Sin poder consultar. Catálogo guardado el " + g.fecha; }
    else { cat = null; catInfo = "Sin catálogo. Conéctate una vez para descargarlo."; }
    return false;
  }
}

/* ---------- instalación de mapas ---------- */
async function reconciliar() {
  /* verifica que lo anotado exista de verdad y limpia archivos huérfanos */
  var perdidos = [];
  for (var id in inst) {
    var ok = true;
    for (var i = 0; i < inst[id].archivos.length; i++) {
      var a = inst[id].archivos[i], f = null;
      try { f = await Alm.leer(a.nombre); } catch (e) { anotarError("leer " + a.nombre, e); }
      if (!f || (a.bytes && f.size !== a.bytes)) ok = false;
    }
    if (!ok) { perdidos.push(inst[id].nombre); delete inst[id]; }
  }
  var usados = {};
  Object.keys(inst).forEach(function (id) { inst[id].archivos.forEach(function (a) { usados[a.nombre] = 1; }); });
  try {
    var todos = await Alm.listar();
    for (var k = 0; k < todos.length; k++) if (/\.pmtiles$/.test(todos[k]) && !usados[todos[k]]) await Alm.borrar(todos[k]);
  } catch (e) { anotarError("limpieza", e); }
  guardarJSON(LS_IDX, inst);
  if (activoId && !inst[activoId]) { activoId = null; localStorage.removeItem(LS_ACTIVO); }
  if (perdidos.length) aviso("El teléfono borró mapas guardados: " + perdidos.join(", ") + ". Hay que descargarlos de nuevo.");
}

async function descargarMapa(entrada) {
  if (desc) return;
  var lista = archivosDe(entrada);
  if (lista.length === 0) { toast("El catálogo no trae archivos para este mapa"); return; }
  desc = { id: entrada.id, ctrl: new AbortController(), total: totalBytes(entrada), hecho: 0, t0: performance.now(), nombre: entrada.nombre };
  var nuevos = [], previo = inst[entrada.id];
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}
  renderHoja();
  var ultimo = 0;
  try {
    for (var i = 0; i < lista.length; i++) {
      var nombre = nombreDeUrl(lista[i].url);
      nuevos.push({ tipo: lista[i].tipo, nombre: nombre, bytes: lista[i].bytes || 0 });
      await Alm.descargar(lista[i].url, nombre, lista[i].bytes || 0, function (n) {
        desc.hecho += n;
        var t = performance.now();
        if (t - ultimo > 150) { ultimo = t; renderHoja(true); }
      }, desc.ctrl.signal);
    }
    var seg = (performance.now() - desc.t0) / 1000;
    metricas.descargas.push({ mapa: entrada.nombre, bytes: desc.hecho, seg: seg });
    inst[entrada.id] = { id: entrada.id, nombre: entrada.nombre, region: entrada.region, version: entrada.version, area: entrada.area, archivos: nuevos, fecha: fechaLocalHM() };
    guardarJSON(LS_IDX, inst);
    if (previo) previo.archivos.forEach(function (a) {
      if (!nuevos.some(function (n) { return n.nombre === a.nombre; })) Alm.borrar(a.nombre);
    });
    toast("Mapa instalado: " + mb(desc.hecho) + " en " + seg.toFixed(1) + " s");
    desc = null;
    await leerAlmacenamiento();
    if (!activoId || activoId === entrada.id) await abrirMapa(entrada.id);
  } catch (e) {
    for (var j = 0; j < nuevos.length; j++) {
      var enUso = previo && previo.archivos.some(function (a) { return a.nombre === nuevos[j].nombre; });
      if (!enUso) await Alm.borrar(nuevos[j].nombre);
    }
    var cancelo = e && (e.name === "AbortError");
    toast(cancelo ? "Descarga cancelada" : "Falló la descarga: " + (e.message || e), 6000);
    if (!cancelo) anotarError("descarga", e);
    desc = null;
  }
  renderHoja();
}

async function eliminarMapa(id) {
  var m = inst[id]; if (!m) return;
  for (var i = 0; i < m.archivos.length; i++) await Alm.borrar(m.archivos[i].nombre);
  delete inst[id]; guardarJSON(LS_IDX, inst);
  if (activoId === id) { activoId = null; localStorage.removeItem(LS_ACTIVO); relieveNombre = null; await aplicarEstilo(null); }
  await leerAlmacenamiento(); renderHoja(); toast("Mapa eliminado");
}

/* ---------- estilo ---------- */
function rutaBase() { return location.origin + location.pathname.replace(/[^\/]*$/, ""); }
function circuloMetros(lng, lat, r) {
  var pts = [], dLat = r / 111320, dLng = r / (111320 * Math.cos(lat * Math.PI / 180));
  for (var i = 0; i <= 48; i++) { var a = i / 48 * 2 * Math.PI; pts.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return pts;
}
function geoPuntos() {
  return { type: "FeatureCollection", features: puntos.map(function (p) {
    return { type: "Feature", properties: { codigo: p.codigo, sesion: p.sesion, activa: p.activa ? 1 : 0, color: p.color, id: p.id },
      geometry: { type: "Point", coordinates: [p.lng, p.lat] } };
  }) };
}
function geoGps() {
  var f = gps.fix, fc = { type: "FeatureCollection", features: [] };
  if (!f) return fc;
  var cls = f.acc <= 10 ? "ok" : f.acc <= 25 ? "ambar" : "rojo";
  var col = cls === "ok" ? "#2e7d32" : cls === "ambar" ? "#f9a825" : "#c62828";
  fc.features.push({ type: "Feature", properties: { tipo: "precision", color: col }, geometry: { type: "Polygon", coordinates: [circuloMetros(f.lng, f.lat, f.acc)] } });
  fc.features.push({ type: "Feature", properties: { tipo: "punto", color: col }, geometry: { type: "Point", coordinates: [f.lng, f.lat] } });
  return fc;
}
function vis(clave) { return capasVis[clave] ? "visible" : "none"; }

function construirEstilo(m) {
  var estilo = { version: 8, glyphs: rutaBase() + "fuentes/{fontstack}/{range}.pbf", sources: {}, layers: [] };
  var baseN = m ? archivoTipo(m, "base") : null, relN = m ? archivoTipo(m, "relieve") : null;
  var capas = [];
  if (baseN) {
    estilo.sources.base = { type: "vector", tiles: ["lcmap://" + baseN + "/{z}/{x}/{y}"], minzoom: 0, maxzoom: 15, bounds: m.area, attribution: "© OpenStreetMap" };
    capas = ESTILO_BASE.slice();
  } else {
    capas = [{ id: "fondo", type: "background", paint: { "background-color": "#eef0ec" } }];
  }
  var extra = [], etiquetas = [];
  if (relN) {
    estilo.sources.dem = { type: "raster-dem", tiles: [demSource.sharedDemProtocolUrl], tileSize: 512, maxzoom: 12, encoding: "terrarium", attribution: "Relieve: Mapterhorn" };
    estilo.sources.curvas = { type: "vector", maxzoom: 15, tiles: [demSource.contourProtocolUrl({
      thresholds: { 10: [100, 500], 11: [50, 250], 12: [20, 100], 13: [20, 100], 14: [10, 50], 15: [10, 50] },
      contourLayer: "contours", elevationKey: "ele", levelKey: "level", extent: 4096, buffer: 1 }) ] };
    extra.push({ id: "relieve-sombra", type: "hillshade", source: "dem", layout: { visibility: vis("sombra") },
      paint: { "hillshade-exaggeration": 0.5, "hillshade-shadow-color": "#3b3f45", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#6b7078" } });
    extra.push({ id: "curvas-linea", type: "line", source: "curvas", "source-layer": "contours", layout: { visibility: vis("curvas") },
      paint: { "line-color": "#8a5a2b", "line-opacity": 0.75, "line-width": ["match", ["get", "level"], 1, 1.4, 0.6] } });
    etiquetas.push({ id: "curvas-texto", type: "symbol", source: "curvas", "source-layer": "contours", filter: [">", ["get", "level"], 0],
      layout: { visibility: vis("curvas"), "symbol-placement": "line", "text-field": ["concat", ["to-string", ["get", "ele"]], " m"], "text-font": ["NotoSans-Regular"], "text-size": 11 },
      paint: { "text-color": "#6d4520", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
  }
  /* el sombreado y las curvas van antes de los caminos (primera capa de línea que no sea agua) */
  var idx = capas.length;
  for (var i = 0; i < capas.length; i++) { if (capas[i].type === "line" && !/^water/.test(capas[i].id)) { idx = i; break; } }
  capas = capas.slice(0, idx).concat(extra, capas.slice(idx), etiquetas);
  estilo.sources.puntos = { type: "geojson", data: geoPuntos() };
  estilo.sources.gps = { type: "geojson", data: geoGps() };
  capas.push({ id: "puntos-circ", type: "circle", source: "puntos",
    filter: capasVis.anteriores ? ["has", "id"] : ["==", ["get", "activa"], 1],
    paint: { "circle-radius": ["case", ["==", ["get", "activa"], 1], 10, 6], "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
  capas.push({ id: "puntos-texto", type: "symbol", source: "puntos",
    filter: capasVis.anteriores ? ["has", "id"] : ["==", ["get", "activa"], 1],
    layout: { "text-field": ["get", "codigo"], "text-font": ["NotoSans-Medium"], "text-size": ["case", ["==", ["get", "activa"], 1], 13, 10], "text-offset": [0, 1.5], "text-anchor": "top", "text-allow-overlap": true },
    paint: { "text-color": "#222222", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
  capas.push({ id: "gps-precision", type: "fill", source: "gps", filter: ["==", ["get", "tipo"], "precision"], paint: { "fill-color": ["get", "color"], "fill-opacity": 0.18 } });
  capas.push({ id: "gps-punto", type: "circle", source: "gps", filter: ["==", ["get", "tipo"], "punto"],
    paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 } });
  estilo.layers = capas;
  return estilo;
}

/* ---------- mapa ---------- */
var map = new maplibregl.Map({
  container: "mapa", style: construirEstilo(null), center: CENTRO_INICIAL, zoom: 11, maxZoom: 19,
  attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, fadeDuration: 0
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-right");
map.on("error", function (ev) {
  var msg = ev && ev.error && ev.error.message ? ev.error.message : "";
  if (/fuera del área|sin relieve/.test(msg)) return;
  anotarError("mapa", ev.error || ev);
});

function aplicarEstilo(m) {
  return new Promise(function (res) {
    var t0 = performance.now();
    map.setStyle(construirEstilo(m), { diff: false });
    map.once("idle", function () { metricas.aperturaMs = Math.round(performance.now() - t0); res(); });
    actualizarChips();
  });
}
async function abrirMapa(id) {
  var m = inst[id]; if (!m) return;
  activoId = id; localStorage.setItem(LS_ACTIVO, id);
  aviso(null);
  pmCache = {};
  relieveNombre = archivoTipo(m, "relieve");
  nuevoManagerDem();
  var a = m.area;
  var dentro = a && map.getCenter().lng >= a[0] && map.getCenter().lng <= a[2] && map.getCenter().lat >= a[1] && map.getCenter().lat <= a[3];
  if (a && !dentro) map.fitBounds([[a[0], a[1]], [a[2], a[3]]], { padding: 20, animate: false, maxZoom: 14 });
  sembrarPuntos(m);
  await aplicarEstilo(m);
  renderHoja();
}
function actualizarChips() {
  var c = $("chipMapa");
  c.textContent = activoId && inst[activoId] ? inst[activoId].nombre.replace(/\s*\(SINTETICO.*$/, "") : "Sin mapa";
  $("chipRed").style.display = online ? "none" : "inline-block";
}

/* ---------- puntos de prueba (sesión activa y anterior) ---------- */
function sembrarPuntos(m) {
  if (puntos.length || !m || !m.area) return;
  var a = m.area, cx = (a[0] + a[2]) / 2, cy = (a[1] + a[3]) / 2, dx = (a[2] - a[0]) / 14, dy = (a[3] - a[1]) / 14;
  var ant = [[-3, 2], [-4, -1], [-2, -4]], act = [[1, 1], [2, -1], [0, -2], [3, 2]];
  ant.forEach(function (o, i) { puntos.push({ id: "a" + i, codigo: "A" + (i + 1), sesion: "2026-09-18-A", activa: false, color: "#1e88e5", lng: cx + o[0] * dx, lat: cy + o[1] * dy }); });
  act.forEach(function (o, i) { puntos.push({ id: "b" + i, codigo: "P" + (i + 1), sesion: "2026-10-01-A", activa: true, color: "#d81b60", lng: cx + o[0] * dx, lat: cy + o[1] * dy }); });
  guardarJSON(LS_PTS, puntos);
}
function refrescarPuntos() { var s = map.getSource("puntos"); if (s) s.setData(geoPuntos()); }
$("btnGuardar").onclick = function () {
  var pos = gps.fix ? [gps.fix.lng, gps.fix.lat] : [map.getCenter().lng, map.getCenter().lat];
  var n = puntos.filter(function (p) { return p.activa; }).length + 1;
  puntos.push({ id: "n" + Date.now(), codigo: "P" + n, sesion: "2026-10-01-A", activa: true, color: "#d81b60", lng: pos[0], lat: pos[1] });
  guardarJSON(LS_PTS, puntos); refrescarPuntos();
  toast("Punto P" + n + " guardado (prueba, no es un registro real)" + (gps.fix ? " con ±" + Math.round(gps.fix.acc) + " m" : " en el centro del mapa"));
};
map.on("click", function (ev) {
  var fs = map.getLayer("puntos-circ") ? map.queryRenderedFeatures(ev.point, { layers: ["puntos-circ"] }) : [];
  var t = $("tarjeta");
  if (!fs.length) { t.style.display = "none"; return; }
  var p = fs[0].properties, c = fs[0].geometry.coordinates;
  t.textContent = "";
  t.appendChild(el("b", { texto: "Punto " + p.codigo }));
  t.appendChild(el("div", { class: "suave", texto: "Sesión " + p.sesion + (p.activa ? " (activa)" : " (anterior)") }));
  t.appendChild(el("div", { class: "suave", texto: c[1].toFixed(5) + ", " + c[0].toFixed(5) }));
  t.appendChild(el("div", { class: "suave", texto: "En la app real, aquí se abre Consultando registro con Volver al mapa." }));
  t.appendChild(el("div", { class: "fila" }, [el("button", { class: "btn chico", texto: "Cerrar", onclick: function () { t.style.display = "none"; } })]));
  t.style.display = "block";
});
map.on("mouseenter", "puntos-circ", function () { map.getCanvas().style.cursor = "pointer"; });
map.on("mouseleave", "puntos-circ", function () { map.getCanvas().style.cursor = ""; });

/* ---------- GPS ---------- */
function chipGps() {
  var c = $("chipGps"); c.className = "chip";
  if (gps.watch == null) { c.textContent = "GPS apagado"; return; }
  if (!gps.fix) { c.textContent = "GPS buscando…"; return; }
  var a = Math.round(gps.fix.acc);
  c.textContent = "GPS ±" + a + " m";
  c.className = "chip " + (a <= 10 ? "ok" : a <= 25 ? "ambar" : "rojo");
}
function gpsOk(p) {
  gps.fix = { lng: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy, t: Date.now() };
  metricas.gpsUltimo = { acc: Math.round(p.coords.accuracy), hora: fechaLocalHM() };
  var s = map.getSource("gps"); if (s) s.setData(geoGps());
  chipGps();
  if (gps.primera) { gps.primera = false; map.easeTo({ center: [gps.fix.lng, gps.fix.lat], zoom: Math.max(map.getZoom(), 15), duration: 600 }); }
}
function gpsError(e) {
  var c = $("chipGps"); c.className = "chip rojo";
  c.textContent = e.code === 1 ? "GPS sin permiso" : "GPS sin señal";
  anotarError("gps", e);
}
function gpsToggle() {
  if (!navigator.geolocation) { toast("Este navegador no tiene GPS"); return; }
  if (gps.watch != null) {
    if (gps.fix) { map.easeTo({ center: [gps.fix.lng, gps.fix.lat], zoom: Math.max(map.getZoom(), 15), duration: 400 }); return; }
    return;
  }
  gps.primera = true;
  gps.watch = navigator.geolocation.watchPosition(gpsOk, gpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  $("btnGps").classList.add("on"); chipGps();
}
$("btnGps").onclick = gpsToggle;
$("btnGps").ondblclick = function () {
  if (gps.watch != null) { navigator.geolocation.clearWatch(gps.watch); gps.watch = null; gps.fix = null; $("btnGps").classList.remove("on"); var s = map.getSource("gps"); if (s) s.setData(geoGps()); chipGps(); }
};
$("btnMas").onclick = function () { map.zoomIn(); };
$("btnMenos").onclick = function () { map.zoomOut(); };

/* ---------- hoja inferior (Mapas, Capas, Diagnóstico) ---------- */
var hojaEl = $("hoja");
function abrirHoja(tipo) { hojaTipo = tipo; hojaEl.style.display = "block"; renderHoja(); }
function cerrarHoja() { hojaTipo = null; hojaEl.style.display = "none"; }
$("hojaCerrar").onclick = cerrarHoja;
hojaEl.addEventListener("click", function (e) { if (e.target === hojaEl) cerrarHoja(); });
$("btnMapas").onclick = function () { abrirHoja("mapas"); };
$("btnCapas").onclick = function () { abrirHoja("capas"); };
$("btnDiag").onclick = function () { abrirHoja("diag"); };

var almEst = { usado: null, cuota: null, protegido: null };
async function leerAlmacenamiento() {
  try {
    if (navigator.storage && navigator.storage.estimate) { var e = await navigator.storage.estimate(); almEst.usado = e.usage; almEst.cuota = e.quota; }
    if (navigator.storage && navigator.storage.persisted) almEst.protegido = await navigator.storage.persisted();
  } catch (e) { anotarError("almacenamiento", e); }
}

function tarjetaMapa(entrada, estaInst) {
  var id = entrada.id, i = inst[id], cuerpo = [];
  cuerpo.push(el("h3", { texto: entrada.nombre }));
  cuerpo.push(el("p", { class: "suave", texto: (entrada.region || "") + " · versión " + (entrada.version || "?") }));
  var lista = archivosDe(entrada);
  if (lista.length) cuerpo.push(el("p", { class: "suave", texto: "Tamaño: " + mb(totalBytes(entrada)) + " (" + lista.map(function (a) { return a.tipo + " " + mb(a.bytes || 0); }).join(", ") + ")" }));
  if (desc && desc.id === id) {
    var pr = el("progress", { max: String(desc.total || 1), value: String(desc.hecho) });
    cuerpo.push(pr);
    cuerpo.push(el("p", { class: "suave", texto: "Descargando " + Math.round(desc.hecho / (desc.total || 1) * 100) + "% (" + mb(desc.hecho) + " de " + mb(desc.total) + ")" }));
    cuerpo.push(el("div", { class: "fila" }, [el("button", { class: "btn", texto: "Cancelar", onclick: function () { desc.ctrl.abort(); } })]));
  } else {
    var fila = [];
    if (i) {
      cuerpo.push(el("p", { class: "suave", texto: "Instalado, versión " + i.version + ", guardado " + i.fecha + (activoId === id ? " · en uso" : "") }));
      if (entrada.version && entrada.version !== i.version) fila.push(el("button", { class: "btn", texto: "Actualizar a " + entrada.version, disabled: online ? null : "disabled", onclick: function () { descargarMapa(entrada); } }));
      if (activoId !== id) fila.push(el("button", { class: "btn", texto: "Abrir", onclick: function () { cerrarHoja(); abrirMapa(id); } }));
      fila.push(el("button", { class: "btn", texto: "Eliminar", onclick: function () { if (confirm("¿Eliminar el mapa guardado en el teléfono?\n" + entrada.nombre)) eliminarMapa(id); } }));
    } else if (estaInst !== false) {
      var b = el("button", { class: "btn", texto: "Descargar (" + mb(totalBytes(entrada)) + ")", onclick: function () { descargarMapa(entrada); } });
      if (!online || desc) b.setAttribute("disabled", "disabled");
      fila.push(b);
    }
    cuerpo.push(el("div", { class: "fila" }, fila));
  }
  return el("div", { class: "caja" }, cuerpo);
}

function infoDiag() {
  var L = [];
  L.push("Libreta Pro · prototipo de mapa " + VERSION_PROTO);
  L.push("Fecha: " + fechaLocalHM());
  L.push("Navegador: " + navigator.userAgent);
  L.push("Pantalla: " + screen.width + "x" + screen.height + " px, factor " + (window.devicePixelRatio || 1) + ", ventana " + innerWidth + "x" + innerHeight);
  L.push("Instalada como app: " + ((window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone ? "sí" : "no"));
  L.push("Conexión: " + (online ? "en línea" : "sin conexión") + ". Service worker: " + (navigator.serviceWorker && navigator.serviceWorker.controller ? "activo" : "no activo"));
  L.push("Almacenamiento de mapas: " + Alm.modo());
  L.push("Espacio: usado " + (almEst.usado != null ? mb(almEst.usado) : "?") + " de " + (almEst.cuota != null ? mb(almEst.cuota) : "?") + ". Protegido: " + (almEst.protegido == null ? "?" : almEst.protegido ? "sí" : "no"));
  L.push("Mapas instalados: " + (Object.keys(inst).map(function (k) { return inst[k].nombre + " v" + inst[k].version; }).join("; ") || "ninguno"));
  L.push("Mapa en uso: " + (activoId && inst[activoId] ? inst[activoId].nombre : "ninguno") + ". Apertura hasta imagen estable: " + (metricas.aperturaMs != null ? metricas.aperturaMs + " ms" : "sin medir"));
  metricas.descargas.forEach(function (d) { L.push("Descarga: " + mb(d.bytes) + " en " + d.seg.toFixed(1) + " s (" + (d.bytes / 1048576 / d.seg).toFixed(2) + " MB/s)"); });
  if (tiemposCurvas.length) {
    var ps = tiemposCurvas.map(function (x) { return x.proc; }).sort(function (a, b) { return a - b; });
    var prom = function (k) { return Math.round(tiemposCurvas.reduce(function (s, x) { return s + x[k]; }, 0) / tiemposCurvas.length); };
    L.push("Curvas de nivel (" + tiemposCurvas.length + " teselas calculadas): total medio " + prom("dur") + " ms, trazado medio " + prom("proc") + " ms, decodificación media " + prom("dec") + " ms, peor trazado " + Math.round(ps[ps.length - 1]) + " ms");
  } else L.push("Curvas de nivel: aún sin teselas calculadas");
  L.push("Fluidez: " + (metricas.fluidez || "sin medir"));
  L.push("GPS último: " + (metricas.gpsUltimo ? "±" + metricas.gpsUltimo.acc + " m a las " + metricas.gpsUltimo.hora : "sin lectura"));
  L.push("Batería: " + (bateria || "sin dato"));
  L.push("Errores recientes: " + (errores.length ? "\n  " + errores.join("\n  ") : "ninguno"));
  return L.join("\n");
}
var bateria = "";
if (navigator.getBattery) navigator.getBattery().then(function (b) {
  function f() { bateria = Math.round(b.level * 100) + "% " + (b.charging ? "(cargando)" : "(descargando)"); }
  f(); b.addEventListener("levelchange", f); b.addEventListener("chargingchange", f);
});

function pruebaFluidez() {
  if (!activoId) { toast("Abre un mapa primero"); return; }
  var dur = 15000, t0 = performance.now(), last = t0, dts = [], fin = false;
  var c = map.getCenter(), z0 = map.getZoom();
  var pasos = [[0.012, 0.006, 14.5], [-0.012, 0.009, 13], [-0.01, -0.008, 15], [0.01, -0.006, 12.5], [0, 0, z0]], k = 0;
  cerrarHoja(); toast("Prueba de fluidez: 15 s, no toques el mapa", 15000);
  function paso() {
    if (fin) return;
    var p = pasos[k++ % pasos.length];
    map.easeTo({ center: [c.lng + p[0], c.lat + p[1]], zoom: p[2], duration: 2600, easing: function (t) { return t; } });
    map.once("moveend", paso);
  }
  function loop(t) {
    dts.push(t - last); last = t;
    if (t - t0 < dur) requestAnimationFrame(loop);
    else {
      fin = true; map.stop();
      var orden = dts.slice().sort(function (a, b) { return a - b; });
      var p95 = orden[Math.floor(orden.length * 0.95)] || 0, max = orden[orden.length - 1] || 0;
      var lentos = dts.filter(function (x) { return x > 50; }).length;
      metricas.fluidez = (dts.length / ((t - t0) / 1000)).toFixed(1) + " cuadros/s en promedio, p95 " + p95.toFixed(0) + " ms, peor " + max.toFixed(0) + " ms, " + lentos + " cuadros sobre 50 ms (movimiento automático, " + (gps.watch != null ? "con GPS" : "sin GPS") + ")";
      $("toast").style.display = "none"; abrirHoja("diag");
    }
  }
  paso(); requestAnimationFrame(loop);
}

function renderHoja(soloProgreso) {
  if (!hojaTipo) return;
  var cuerpo = $("hojaCuerpo"), scroll = cuerpo.scrollTop;
  cuerpo.textContent = "";
  if (hojaTipo === "mapas") {
    $("hojaTitulo").textContent = "Mapas sin conexión";
    cuerpo.appendChild(el("div", { class: "caja" }, [
      el("p", { class: "suave", texto: (online ? "En línea. " : "Sin conexión. ") + catInfo }),
      el("p", { class: "suave", texto: "Espacio usado por la app: " + (almEst.usado != null ? mb(almEst.usado) : "?") + " de " + (almEst.cuota != null ? mb(almEst.cuota) : "?") + ". Almacenamiento protegido: " + (almEst.protegido == null ? "sin dato" : almEst.protegido ? "sí" : "no") + "." }),
      el("div", { class: "fila" }, [
        el("button", { class: "btn chico", texto: "Actualizar catálogo", disabled: online ? null : "disabled", onclick: async function () { await cargarCatalogo(); await leerAlmacenamiento(); renderHoja(); } }),
        almEst.protegido === false ? el("button", { class: "btn chico", texto: "Pedir protección", onclick: async function () { try { await navigator.storage.persist(); } catch (e) {} await leerAlmacenamiento(); renderHoja(); } }) : null
      ])
    ]));
    if (!online) cuerpo.appendChild(el("p", { class: "suave", texto: "Sin conexión solo puedes abrir o eliminar los mapas instalados." }));
    var vistos = {};
    if (cat) cat.mapas.forEach(function (e) { vistos[e.id] = 1; cuerpo.appendChild(tarjetaMapa(e, true)); });
    Object.keys(inst).forEach(function (id) {
      if (vistos[id]) return;
      cuerpo.appendChild(tarjetaMapa({ id: id, nombre: inst[id].nombre, region: inst[id].region, version: inst[id].version, archivos: inst[id].archivos.map(function (a) { return { tipo: a.tipo, bytes: a.bytes, url: a.nombre }; }) }, false));
    });
  } else if (hojaTipo === "capas") {
    $("hojaTitulo").textContent = "Capas";
    var tieneRel = !!(activoId && inst[activoId] && archivoTipo(inst[activoId], "relieve"));
    function chk(clave, texto, habil) {
      var inp = el("input", { type: "checkbox" }); inp.checked = !!capasVis[clave]; if (!habil) inp.disabled = true;
      inp.onchange = function () {
        capasVis[clave] = inp.checked; guardarJSON(LS_CAPAS, capasVis);
        var v = inp.checked ? "visible" : "none";
        if (clave === "sombra" && map.getLayer("relieve-sombra")) map.setLayoutProperty("relieve-sombra", "visibility", v);
        if (clave === "curvas") ["curvas-linea", "curvas-texto"].forEach(function (id) { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v); });
        if (clave === "anteriores") { var f = inp.checked ? ["has", "id"] : ["==", ["get", "activa"], 1]; ["puntos-circ", "puntos-texto"].forEach(function (id) { if (map.getLayer(id)) map.setFilter(id, f); }); }
      };
      return el("label", { class: "chk" }, [inp, el("span", { texto: texto })]);
    }
    cuerpo.appendChild(chk("sombra", "Sombreado del relieve", tieneRel));
    cuerpo.appendChild(chk("curvas", "Curvas de nivel (calculadas en el teléfono)", tieneRel));
    cuerpo.appendChild(chk("anteriores", "Puntos de sesiones anteriores", true));
    if (!tieneRel) cuerpo.appendChild(el("p", { class: "suave", texto: "El mapa abierto no trae relieve." }));
  } else if (hojaTipo === "diag") {
    $("hojaTitulo").textContent = "Diagnóstico";
    leerAlmacenamiento().then(function () { var p = $("hojaCuerpo").querySelector("pre"); if (p && hojaTipo === "diag") p.textContent = infoDiag(); });
    cuerpo.appendChild(el("pre", { texto: infoDiag() }));
    cuerpo.appendChild(el("div", { class: "fila" }, [
      el("button", { class: "btn chico", texto: "Copiar informe", onclick: function () {
        var t = infoDiag();
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { toast("Informe copiado"); }, function () { toast("No se pudo copiar"); });
        else toast("Este navegador no permite copiar");
      } }),
      el("button", { class: "btn chico", texto: "Prueba de fluidez (15 s)", onclick: pruebaFluidez }),
      el("button", { class: "btn chico", texto: "Borrar puntos de prueba", onclick: function () { puntos = []; guardarJSON(LS_PTS, puntos); if (activoId) sembrarPuntos(inst[activoId]); refrescarPuntos(); toast("Puntos de prueba restablecidos"); } }),
      el("button", { class: "btn chico", texto: "Apagar GPS", onclick: function () { $("btnGps").ondblclick(); } })
    ]));
    cuerpo.appendChild(el("p", { class: "suave", texto: "Doble toque en el botón GPS también lo apaga. Esta página es un prototipo de prueba y no guarda registros reales." }));
  }
  if (soloProgreso) cuerpo.scrollTop = scroll;
}

/* ---------- red, instalación y arranque ---------- */
window.addEventListener("online", function () { online = true; actualizarChips(); renderHoja(); cargarCatalogo().then(function () { renderHoja(); }); });
window.addEventListener("offline", function () { online = false; actualizarChips(); renderHoja(); });
var promptInstalar = null;
window.addEventListener("beforeinstallprompt", function (e) {
  e.preventDefault(); promptInstalar = e;
  aviso("Puedes instalar esta página como app: toca aquí.");
  $("aviso").onclick = function () { promptInstalar.prompt(); aviso(null); };
});

(async function iniciar() {
  try { ESTILO_BASE = await (await fetch("estilo-base.json")).json(); } catch (e) { anotarError("estilo", e); aviso("No se pudo cargar el estilo del mapa. Recarga la página."); }
  if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
    navigator.serviceWorker.register("sw.js").catch(function (e) { anotarError("service worker", e); });
  }
  await reconciliar();
  await leerAlmacenamiento();
  if (activoId && inst[activoId]) await abrirMapa(activoId);
  else if (!Object.keys(inst).length) { aviso("Aún no hay mapas en este teléfono. Toca Mapas para descargar uno."); }
  actualizarChips();
  await cargarCatalogo();
  renderHoja();
})();

window.__lcp = { map: map, inst: function () { return inst; }, Alm: Alm, metricas: metricas, errores: errores, abrirMapa: abrirMapa };
})();
