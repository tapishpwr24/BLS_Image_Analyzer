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
  var SET_META = "setMeta", SET_ITEMS = "setItems";
  var dbPromise = null;
  var memory = new Map();

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve) {
      try {
        // v2 adds the photo set in progress, so a set can be resumed after the
        // phone locks, the app is closed or the battery dies
        var req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            var os = db.createObjectStore(STORE, { keyPath: "id" });
            os.createIndex("createdAt", "createdAt");
          }
          if (!db.objectStoreNames.contains(SET_META)) db.createObjectStore(SET_META);
          if (!db.objectStoreNames.contains(SET_ITEMS)) db.createObjectStore(SET_ITEMS);
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

  // The photo set being rated: meta = { total, next, done, rater, startedAt },
  // items[i] = { name, blob, repeat }. Photos are kept until the set is finished.
  var memSet = null;
  function setTx(mode, fn) {
    return openDb().then(function (db) {
      if (!db) return fn(null, null);
      return new Promise(function (resolve, reject) {
        var t = db.transaction([SET_META, SET_ITEMS], mode);
        var out = fn(t.objectStore(SET_META), t.objectStore(SET_ITEMS));
        // a read returns its request: hand back the value (undefined when nothing is stored)
        t.oncomplete = function () { resolve(out instanceof IDBRequest ? out.result : out); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error("Storage is full")); };
      });
    });
  }
  var Sets = {
    save: function (meta, items) {
      return setTx("readwrite", function (m, it) {
        if (!m) { memSet = { meta: meta, items: items }; return; }
        it.clear();
        items.forEach(function (x, i) { it.put(x, i); });
        m.put(meta, "current");
      });
    },
    update: function (meta) {
      return setTx("readwrite", function (m) {
        if (!m) { if (memSet) memSet.meta = meta; return; }
        m.put(meta, "current");
      });
    },
    meta: function () {
      return setTx("readonly", function (m) {
        if (!m) return memSet ? memSet.meta : null;
        return m.get("current");
      }).then(function (x) { return x || null; });
    },
    items: function () {
      return setTx("readonly", function (m, it) {
        if (!m) return memSet ? memSet.items : [];
        return it.getAll();
      }).then(function (x) { return x || []; });
    },
    clear: function () {
      return setTx("readwrite", function (m, it) {
        if (!m) { memSet = null; return; }
        m.clear(); it.clear();
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
    shuffle: true,    // photo sets come in random order
    repeatPct: 15     // hidden repeats in photo sets (never for photos taken with the camera)
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

  window.BLSStore = { Records: Records, Settings: Settings, Sets: Sets };
})();
