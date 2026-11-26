/* Offline support: the app shell is cached so scoring works with no signal. */
var CACHE = "bls-leaf-scorer-v0.3.0";
var SHELL = [
  "./", "index.html", "engine.js", "store.js", "app.js", "connectors/connectors.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/icon-maskable-512.png",
  "samples/BLS_02.jpg"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return; // uploads always go to the network
  var url = new URL(req.url);
  var cacheable = url.origin === location.origin ||
    url.host === "fonts.googleapis.com" || url.host === "fonts.gstatic.com" || url.host === "cdnjs.cloudflare.com";
  if (!cacheable) return;
  // Network first for our own files (get updates), cache as fallback offline
  e.respondWith(fetch(req).then(function (res) {
    if (res.ok || res.type === "opaque") {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      return hit || (req.mode === "navigate" ? caches.match("index.html") : undefined);
    });
  }));
});
