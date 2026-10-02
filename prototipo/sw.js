/* Service worker del prototipo de mapa. Guarda solo el "cascarón" de la app.
   Los paquetes .pmtiles y el catalogo NO se guardan aqui: los maneja el almacenamiento de la app. */
var CACHE = "lcp-proto-1";
var SHELL = ["./", "index.html", "app.js", "estilo-base.json", "manifest.webmanifest", "icon-192.png", "icon-512.png", "vendor/maplibre-gl.js", "vendor/maplibre-gl.css", "vendor/maplibre-contour.min.js", "vendor/pmtiles.js", "fuentes/NotoSans-Medium/0-255.pbf", "fuentes/NotoSans-Medium/256-511.pbf", "fuentes/NotoSans-Medium/8192-8447.pbf", "fuentes/NotoSans-Italic/0-255.pbf", "fuentes/NotoSans-Italic/256-511.pbf", "fuentes/NotoSans-Italic/8192-8447.pbf", "fuentes/NotoSans-Regular/0-255.pbf", "fuentes/NotoSans-Regular/256-511.pbf", "fuentes/NotoSans-Regular/8192-8447.pbf"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var u = new URL(req.url);
  if (u.origin !== location.origin) return;
  if (/\.pmtiles$/.test(u.pathname) || /catalogo\.json$/.test(u.pathname)) return;
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(function (r) {
    if (r) return r;
    return fetch(req).catch(function () {
      if (req.mode === "navigate") return caches.match("index.html");
      return new Response("", { status: 504 });
    });
  }));
});
