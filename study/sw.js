/*
 * The study version moved to /app/. This service worker replaces the old /study/
 * one on phones that had it: it clears the study copy's cached files and removes
 * itself, so /study/ just forwards to /app/. Saved ratings are not touched; the
 * app at /app/ copies them over the first time it opens.
 */
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf("bls-study-shell-") === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.registration.unregister(); })
    .then(function () { return self.clients.matchAll({ type: "window" }); })
    .then(function (list) { list.forEach(function (c) { try { c.navigate(c.url); } catch (err) { /* ignore */ } }); }));
});
