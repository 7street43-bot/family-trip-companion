(() => {
  const DB_NAME = 'TwinTripV4';
  const DB_VERSION = 1;
  const STORES = ['entities','packItems','packState','itineraries','settings','meta'];

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  async function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entities')) {
          const s = db.createObjectStore('entities', { keyPath: 'id' });
          s.createIndex('entityType', 'entityType', { unique: false });
          s.createIndex('visited', 'visited', { unique: false });
        }
        if (!db.objectStoreNames.contains('packItems')) db.createObjectStore('packItems', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('packState')) db.createObjectStore('packState', { keyPath: 'itemId' });
        if (!db.objectStoreNames.contains('itineraries')) db.createObjectStore('itineraries', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAll(store) {
    const db = await openDB();
    const tx = db.transaction(store, 'readonly');
    const out = await reqP(tx.objectStore(store).getAll());
    await txDone(tx);
    db.close();
    return out;
  }

  async function get(store, key) {
    const db = await openDB();
    const tx = db.transaction(store, 'readonly');
    const out = await reqP(tx.objectStore(store).get(key));
    await txDone(tx);
    db.close();
    return out;
  }

  async function put(store, value) {
    const db = await openDB();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    await txDone(tx);
    db.close();
    return value;
  }

  async function remove(store, key) {
    const db = await openDB();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await txDone(tx);
    db.close();
  }

  async function replaceStore(store, values) {
    const db = await openDB();
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    s.clear();
    for (const v of values) s.put(v);
    await txDone(tx);
    db.close();
  }

  async function bulkPut(store, values) {
    const db = await openDB();
    const tx = db.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    for (const v of values) s.put(v);
    await txDone(tx);
    db.close();
  }

  async function snapshot() {
    const [entities, packItems, packState, itineraries, settings] = await Promise.all([
      getAll('entities'), getAll('packItems'), getAll('packState'), getAll('itineraries'), getAll('settings')
    ]);
    return {
      format: 'twin-trip-v4',
      schemaVersion: 3,
      exportedAt: new Date().toISOString(),
      entities, packItems, packState, itineraries, settings
    };
  }

  async function atomicImport(data) {
    const db = await openDB();
    const tx = db.transaction(STORES, 'readwrite');
    try {
      const old = {
        format: 'twin-trip-v4-preimport',
        schemaVersion: 3,
        exportedAt: new Date().toISOString(),
        entities: await reqP(tx.objectStore('entities').getAll()),
        packItems: await reqP(tx.objectStore('packItems').getAll()),
        packState: await reqP(tx.objectStore('packState').getAll()),
        itineraries: await reqP(tx.objectStore('itineraries').getAll()),
        settings: await reqP(tx.objectStore('settings').getAll())
      };
      tx.objectStore('meta').put({ key: 'lastPreImportBackup', value: old, savedAt: new Date().toISOString() });
      for (const store of ['entities','packItems','packState','itineraries','settings']) tx.objectStore(store).clear();
      for (const v of (data.entities || [])) tx.objectStore('entities').put(v);
      for (const v of (data.packItems || [])) tx.objectStore('packItems').put(v);
      for (const v of (data.packState || [])) tx.objectStore('packState').put(v);
      for (const v of (data.itineraries || [])) tx.objectStore('itineraries').put(v);
      for (const v of (data.settings || [])) tx.objectStore('settings').put(v);
      tx.objectStore('meta').put({ key: 'importedAt', value: new Date().toISOString() });
      await txDone(tx);
      db.close();
    } catch (err) {
      try { tx.abort(); } catch (_) {}
      db.close();
      throw err;
    }
  }

  window.TwinDB = { openDB, getAll, get, put, remove, replaceStore, bulkPut, snapshot, atomicImport };
})();
