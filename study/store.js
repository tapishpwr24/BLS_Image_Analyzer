/*
 * Local storage for records (IndexedDB) and settings (localStorage).
 * Records are always saved here first; connectors sync copies out.
 * Falls back to in-memory storage when the browser blocks IndexedDB
 * (private windows, embedded previews), so the app still works.
 */
(function () {
  "use strict";

  // Test copy at /study/: its own records and settings, apart from the main app at /app/
  var DB_NAME = "bls-leaf-scorer-study";
  var STORE = "records";
  var dbPromise = null;
  var memory = new Map();

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      try {
        var req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = function () {
          var os = req.result.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("createdAt", "createdAt");
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (e) {
        resolve(null);
      }
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return openDb().then(function (db) {
      if (!db) return fn(null);
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var os = t.objectStore(STORE);
        var out = fn(os);
        t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { reject(t.error); };
      });
    });
  }

  var Records = {
    put: function (rec) {
      return tx("readwrite", function (os) {
        if (!os) { memory.set(rec.id, rec); return rec; }
        os.put(rec);
        return rec;
      });
    },
    get: function (id) {
      return tx("readonly", function (os) {
        if (!os) return memory.get(id);
        return os.get(id);
      });
    },
    remove: function (id) {
      return tx("readwrite", function (os) {
        if (!os) { memory.delete(id); return; }
        os.delete(id);
      });
    },
    all: function () {
      return tx("readonly", function (os) {
        if (!os) return Array.from(memory.values());
        return os.getAll();
      }).then(function (list) {
        return (list || []).sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); });
      });
    }
  };

  var SETTINGS_KEY = "bls-study-settings-v1";
  var memSettings = null;
  var DEFAULT_SETTINGS = {
    destination: "local",
    connectors: {},
    trial: "",
    rater: "",
    uploadPhotos: true,
    blind: true,      // study mode: rater scores before the app shows its score
    shuffle: true     // photo sets come in random order
  };

  var Settings = {
    load: function () {
      var s = null;
      try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY)); } catch (e) { s = null; }
      if (!s) s = memSettings;
      return Object.assign({}, DEFAULT_SETTINGS, s || {});
    },
    save: function (s) {
      memSettings = s;
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* in-memory only */ }
    }
  };

  window.BLSStore = { Records: Records, Settings: Settings };
})();
