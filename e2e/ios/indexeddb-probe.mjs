// Diagnostic only: a separate throwaway database and non-extractable test key.
// Never substitutes for the product's persisted draft/history assertions.
export async function probeIndexedDbTransactions() {
  const facts = {};
  const name = 'bridge-ios-acceptance-key-probe';
  const errorName = error => ['TransactionInactiveError', 'DataCloneError', 'InvalidStateError',
    'QuotaExceededError', 'SecurityError', 'AbortError', 'UnknownError'].includes(error?.name) ? error.name : 'Other';
  const request = req => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const completed = tx => new Promise(resolve => {
    tx.oncomplete = () => resolve(true);
    tx.onabort = () => resolve(false);
    tx.onerror = () => resolve(false);
  });
  let db;
  try {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys', { keyPath: 'id' });
    db = await request(open);
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    facts.nonExtractableGenerated = key.extractable === false;

    const late = db.transaction('keys', 'readonly');
    await request(late.objectStore('keys').get('missing'));
    facts.completionObservedAfterAwait = await Promise.race([
      completed(late), new Promise(resolve => setTimeout(() => resolve(false), 500)),
    ]);

    const immediate = db.transaction('keys', 'readwrite');
    const immediateDone = completed(immediate);
    try { immediate.objectStore('keys').put({ id: 'immediate', key }); }
    catch (error) { facts.immediateWriteError = errorName(error); }
    facts.immediateTransactionCommitted = await immediateDone;

    const awaited = db.transaction('keys', 'readwrite');
    const awaitedDone = completed(awaited);
    const store = awaited.objectStore('keys');
    await request(store.get('missing'));
    try { store.put({ id: 'after-await', key }); }
    catch (error) { facts.afterAwaitWriteError = errorName(error); }
    facts.afterAwaitTransactionCommitted = await awaitedDone;

    const callback = db.transaction('keys', 'readwrite');
    const callbackDone = completed(callback);
    callback.objectStore('keys').get('missing').onsuccess = () => {
      try { callback.objectStore('keys').put({ id: 'callback', key }); }
      catch (error) { facts.callbackWriteError = errorName(error); }
    };
    facts.callbackTransactionCommitted = await callbackDone;
    const read = db.transaction('keys', 'readonly');
    const readDone = completed(read);
    const stored = await request(read.objectStore('keys').get('callback'));
    await readDone;
    facts.nonExtractableReadBack = stored?.key?.extractable === false && stored.key.algorithm?.name === 'AES-GCM';
    if (facts.nonExtractableReadBack) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, stored.key, bytes);
      const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, stored.key, encrypted));
      facts.persistedKeyRoundTrip = decrypted.length === bytes.length && decrypted.every((value, i) => value === bytes[i]);
    }
  } catch (error) { facts.probeError = errorName(error); }
  finally {
    db?.close();
    await new Promise(resolve => {
      const removal = indexedDB.deleteDatabase(name);
      removal.onsuccess = () => { facts.probeRemoved = true; resolve(); };
      removal.onerror = removal.onblocked = () => { facts.probeRemoved = false; resolve(); };
    });
  }
  return facts;
}
