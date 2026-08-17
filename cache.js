// Persistent cache for the planner's sampled odds curves.
//
// The fine sampling pass costs a few seconds of CPU, and the answer only depends
// on the config it was asked about — so it is worth computing once and keeping.
// This fills lazily from real usage rather than being enumerated up front: the
// first time a config is asked it is computed and stored, and every time after it
// is a read. No download, no build step, and no coverage gaps — a custom item
// level or an unusual star range caches exactly like a common one.
//
// Everything here degrades to "just compute it": IndexedDB is unavailable in
// private windows in some browsers and under file:// in others, and a planner that
// works without a cache is worth more than one that breaks with it. Every entry
// point resolves rather than rejects.

(function (global) {
  const DB_NAME = "sf-planner";
  const DB_VERSION = 1;
  const STORE = "curves";

  // Cap on stored configs. Each entry is a few hundred KB of Float64 curves, so
  // this is a disk-usage bound, not a correctness one — evicting the oldest just
  // means recomputing it next time.
  const MAX_ENTRIES = 60;

  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try {
        if (!global.indexedDB) return resolve(null);
        req = global.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (e) {
        return resolve(null);
      }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "key" });
          // Eviction walks entries oldest-first; the version index makes purging
          // a stale rate table a single cursor pass.
          store.createIndex("savedAt", "savedAt");
          store.createIndex("ratesVersion", "ratesVersion");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      // Another tab holding an old version open would otherwise hang this forever.
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  function tx(mode) {
    return openDb().then((db) => {
      if (!db) return null;
      try {
        return db.transaction(STORE, mode).objectStore(STORE);
      } catch (e) {
        return null;
      }
    });
  }

  // A stable key for one planner question. Property order is fixed here rather
  // than left to JSON.stringify's insertion order, so the same config always
  // hashes the same way regardless of how the caller built its object.
  //
  // itemLevel is part of the key even though cost scales as levelTier³ and one
  // sample could in principle be rescaled to every level: rescaling is exact for
  // this layout (a uniform scalar commutes with quantiles) but the cost formula's
  // round() makes it approximate in the third decimal, and a player uses a handful
  // of item levels, not hundreds. Keying on it is simpler and exact.
  function configKey(c) {
    return [
      global.RATES_VERSION,
      c.currentStar,
      c.targetStar,
      c.itemLevel,
      c.starCatching ? "sc" : "-",
      c.mvp || "none",
      c.event || "none",
      "t" + c.trials,
    ].join("|");
  }

  function get(key) {
    return tx("readonly")
      .then(
        (store) =>
          new Promise((resolve) => {
            if (!store) return resolve(null);
            const req = store.get(key);
            req.onsuccess = () => {
              const row = req.result;
              // A version mismatch can't happen while the stamp is in the key, but
              // check anyway — the key format is the kind of thing that changes.
              if (!row || row.ratesVersion !== global.RATES_VERSION)
                return resolve(null);
              resolve(row.value);
            };
            req.onerror = () => resolve(null);
          }),
      )
      .catch(() => null);
  }

  function put(key, value) {
    return tx("readwrite")
      .then(
        (store) =>
          new Promise((resolve) => {
            if (!store) return resolve(false);
            const req = store.put({
              key,
              value,
              ratesVersion: global.RATES_VERSION,
              savedAt: Date.now(),
            });
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
          }),
      )
      .then((ok) => (ok ? evict() : false))
      .catch(() => false);
  }

  // Drop entries built from superseded rates, then trim the oldest back to the
  // cap. Runs after a write rather than on open so a cold start stays fast.
  function evict() {
    return tx("readwrite")
      .then(
        (store) =>
          new Promise((resolve) => {
            if (!store) return resolve(false);
            const stale = [];
            const live = [];
            const cursor = store.index("savedAt").openCursor();
            cursor.onsuccess = () => {
              const c = cursor.result;
              if (c) {
                (c.value.ratesVersion === global.RATES_VERSION ? live : stale).push(
                  c.value.key,
                );
                return c.continue();
              }
              const overflow = Math.max(0, live.length - MAX_ENTRIES);
              // `live` is in savedAt order, so its head is the oldest.
              stale.concat(live.slice(0, overflow)).forEach((k) => {
                try {
                  store.delete(k);
                } catch (e) {}
              });
              resolve(true);
            };
            cursor.onerror = () => resolve(false);
          }),
      )
      .catch(() => false);
  }

  function clear() {
    return tx("readwrite")
      .then(
        (store) =>
          new Promise((resolve) => {
            if (!store) return resolve(false);
            const req = store.clear();
            req.onsuccess = () => resolve(true);
            req.onerror = () => resolve(false);
          }),
      )
      .catch(() => false);
  }

  global.SF = global.SF || {};
  global.SF.cache = { configKey, get, put, clear };
})(window);
