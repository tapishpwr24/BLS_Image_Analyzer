/*
 * Offline support + cross-origin isolation.
 *
 * - The app shell is cached so scoring works with no signal.
 * - The leaf-finder model and runtime (~25 MB) are cached once and served from
 *   the cache afterwards (cache-first), so they never re-download.
 * - Every page response gets COOP/COEP headers. GitHub Pages can't set them,
 *   and they let the leaf finder use several CPU cores (about 3x faster).
 */
var VERSION = "v0.13.0";
var SHELL_CACHE = "bls-study-shell-" + VERSION;   // test copy: own cache, never touches /app/'s
var MODEL_CACHE = "bls-models-v1";          // only bump when the model files change
var SHELL = [
  "./", "index.html", "privacy.html", "engine.js", "leaffind.js", "store.js", "app.js", "segment.js", "connectors/connectors.js",
  "vendor/jszip.min.js", "vendor/qrcode.js", "vendor/fonts/fonts.css",
  "vendor/fonts/archivo-latin-wdth-normal.woff2", "vendor/fonts/ibm-plex-sans-latin-400-normal.woff2",
  "vendor/fonts/ibm-plex-sans-latin-500-normal.woff2", "vendor/fonts/ibm-plex-sans-latin-600-normal.woff2",
  "vendor/fonts/ibm-plex-mono-latin-500-normal.woff2",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "icons/apple-touch-icon.png", "icons/icon-maskable-512.png", "samples/BLS_02.jpg", "samples/field_check.jpg"
];
var HEAVY = /\/(models\/|vendor\/ort\/)/;   // big, versioned files: cache-first

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(SHELL_CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("bls-study-shell-") === 0 && k !== SHELL_CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

function isolate(res) {
  if (!res || res.type === "opaque" || res.status === 0) return res;
  var h = new Headers(res.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;                      // uploads always go to the network
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;            // other sites: browser handles it

  if (HEAVY.test(url.pathname)) {
    e.respondWith(caches.open(MODEL_CACHE).then(function (c) {
      return c.match(req).then(function (hit) {
        if (hit) return isolate(hit);
        return fetch(req).then(function (res) {
          if (res.ok) c.put(req, res.clone());
          return isolate(res);
        });
      });
    }));
    return;
  }

  // App files: network first (to get updates), cache when offline.
  // "no-cache" makes the browser check with the server instead of reusing a
  // stale copy, so phones get a new version as soon as it's published.
  // (A navigation request can't take options, so fetch its URL instead.)
  var fresh = req.mode === "navigate" ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" }) : fetch(req, { cache: "no-cache" });
  e.respondWith(fresh.then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(SHELL_CACHE).then(function (c) { c.put(req, copy); });
    }
    return isolate(res);
  }).catch(function () {
    return caches.match(req, { ignoreSearch: true }).then(function (hit) {
      if (hit) return isolate(hit);
      return req.mode === "navigate" ? caches.match("index.html").then(isolate) : undefined;
    });
  }));
});
