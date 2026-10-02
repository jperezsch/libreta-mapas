// Service Worker de Libreta de Campo Pro (prueba).
// - Guarda solo el "cascarón" de la app (archivos propios). Los paquetes .pmtiles y el catálogo NO se guardan aquí:
//   los maneja el almacenamiento del módulo del mapa.
// - Red primero con tope de 4 s y caché como respaldo, para no quedar esperando mala señal en terreno.
// - Solo borra cachés propias (prefijo "lcpro-"): el navegador comparte las cachés entre todas las apps del dominio.
var PREFIJO = "lcpro-";
var CACHE_NAME = "lcpro-v1";
var ARCHIVOS = ["./", "index.html", "mapa-pro.js", "mapa-pro.css", "estilo-base.json", "manifest.json", "icon-192.png", "icon-512.png", "vendor/maplibre-gl.js", "vendor/maplibre-gl.css", "vendor/maplibre-contour.min.js", "vendor/pmtiles.js", "fuentes/NotoSans-Medium/0-255.pbf", "fuentes/NotoSans-Medium/256-511.pbf", "fuentes/NotoSans-Medium/8192-8447.pbf", "fuentes/NotoSans-Italic/0-255.pbf", "fuentes/NotoSans-Italic/256-511.pbf", "fuentes/NotoSans-Italic/8192-8447.pbf", "fuentes/NotoSans-Regular/0-255.pbf", "fuentes/NotoSans-Regular/256-511.pbf", "fuentes/NotoSans-Regular/8192-8447.pbf"];

self.addEventListener("install", function(evt){
  evt.waitUntil(caches.open(CACHE_NAME).then(function(c){ return c.addAll(ARCHIVOS); }));
  self.skipWaiting();
});
self.addEventListener("activate", function(evt){
  evt.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k.indexOf(PREFIJO)===0 && k!==CACHE_NAME; }).map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});
function conTope(req){
  return new Promise(function(res, rej){
    var t = setTimeout(function(){ rej(new Error("tiempo")); }, 4000);
    fetch(req).then(function(r){ clearTimeout(t); res(r); }, function(e){ clearTimeout(t); rej(e); });
  });
}
self.addEventListener("fetch", function(evt){
  var req = evt.request;
  if(req.method !== "GET") return;
  var u = new URL(req.url);
  if(u.origin !== location.origin) return;
  if(/\.pmtiles$/.test(u.pathname) || /catalogo\.json$/.test(u.pathname)) return;
  evt.respondWith(
    conTope(req).then(function(resp){
      if(resp && resp.status === 200){
        var copia = resp.clone();
        caches.open(CACHE_NAME).then(function(c){ c.put(req, copia); });
      }
      return resp;
    }).catch(function(){
      return caches.match(req, {ignoreSearch:true}).then(function(m){
        return m || (req.mode === "navigate" ? caches.match("index.html") : new Response("", {status:504}));
      });
    })
  );
});
