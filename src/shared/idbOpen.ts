/**
 * Cached IndexedDB open that can retry after a failed attempt and drops the
 * connection on versionchange so another context can upgrade (M-62).
 */
export interface IdbOpenCache {
  promise: Promise<IDBDatabase> | null;
}

/** Close and forget the cached connection when another context upgrades. */
export function attachIdbLifecycle(db: IDBDatabase, cache: IdbOpenCache): void {
  db.onversionchange = () => {
    db.close();
    cache.promise = null;
  };
}

/**
 * Remember an in-flight open. A rejected attempt clears the cache so the
 * next caller can try again instead of replaying the same failure forever.
 */
export function rememberOpen(
  cache: IdbOpenCache,
  start: () => Promise<IDBDatabase>,
): Promise<IDBDatabase> {
  if (cache.promise) return cache.promise;
  cache.promise = start().then(
    (db) => {
      attachIdbLifecycle(db, cache);
      return db;
    },
    (error: unknown) => {
      cache.promise = null;
      throw error;
    },
  );
  return cache.promise;
}

export function openIndexedDb(
  cache: IdbOpenCache,
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
): Promise<IDBDatabase> {
  return rememberOpen(
    cache,
    () =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onupgradeneeded = () => upgrade(req.result);
        req.onblocked = () => {
          /* Wait for onsuccess/onerror; other connections close via onversionchange. */
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
      }),
  );
}
