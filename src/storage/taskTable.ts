/**
 * Resume task table (spec 3.0 §8.4): persists in-flight translation tasks so
 * the background can rebuild the queue after a service-worker restart.
 *
 * Storage: IndexedDB (service worker context). The store backend is
 * injectable so unit tests run against an in-memory implementation.
 *
 * Semantics:
 *  - tasks are recorded `inflight` when submitted to the queue;
 *  - records are deleted on completion (cache idempotency covers re-runs);
 *  - `tabs.onRemoved` clears a tab's records;
 *  - total ring size capped at TASK_TABLE_MAX (oldest evicted).
 */
import { TASK_TABLE_MAX } from '../shared/constants';
import type { TaskRecord } from '../shared/types';
import { hashText } from '../shared/utils';

export interface TaskStore {
  add(record: TaskRecord): Promise<void>;
  deleteMany(match: (rec: TaskRecord) => boolean): Promise<void>;
  getAll(): Promise<TaskRecord[]>;
}

/** In-memory store for unit tests and environments without IndexedDB. */
export class MemoryTaskStore implements TaskStore {
  records: TaskRecord[] = [];

  async add(record: TaskRecord): Promise<void> {
    this.records.push({ ...record });
  }

  async deleteMany(match: (rec: TaskRecord) => boolean): Promise<void> {
    this.records = this.records.filter((r) => !match(r));
  }

  async getAll(): Promise<TaskRecord[]> {
    return this.records.map((r) => ({ ...r }));
  }
}

/** IndexedDB-backed store used by the service worker. */
export class IdbTaskStore implements TaskStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly dbName = 'polypage-tasktable') {}

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('tasks')) {
          const store = db.createObjectStore('tasks', { keyPath: 'id', autoIncrement: true });
          store.createIndex('by-tab', 'tabId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  private withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T> | void,
  ): Promise<T> {
    return this.open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction('tasks', mode);
          const store = tx.objectStore('tasks');
          const request = fn(store);
          let result: T;
          if (request) {
            request.onsuccess = () => {
              result = request.result;
            };
          }
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        }),
    );
  }

  async add(record: TaskRecord): Promise<void> {
    await this.withStore('readwrite', (store) => {
      store.add({ ...record });
    });
  }

  async deleteMany(match: (rec: TaskRecord) => boolean): Promise<void> {
    await this.withStore('readwrite', (store) => {
      const cursorReq = store.openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor) return;
        const value = cursor.value as TaskRecord;
        if (match(value)) cursor.delete();
        cursor.continue();
      };
    });
  }

  async getAll(): Promise<TaskRecord[]> {
    return this.withStore('readonly', (store) => store.getAll() as IDBRequest<TaskRecord[]>);
  }
}

/** High-level task table with ring eviction and resume queries. */
export class TaskTable {
  constructor(
    private readonly store: TaskStore,
    private readonly maxRecords: number = TASK_TABLE_MAX,
  ) {}

  /** Record tasks that are about to be sent to a provider. */
  async markInflight(
    tabId: number,
    frameId: number,
    items: { key: string; text: string }[],
  ): Promise<void> {
    const ts = Date.now();
    for (const item of items) {
      await this.store.add({
        tabId,
        frameId,
        taskKey: item.key,
        textHash: hashText(item.text),
        state: 'inflight',
        ts,
      });
    }
    await this.prune();
  }

  /** Delete completed tasks (idempotent: absent records are fine). */
  async markDone(tabId: number, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const keySet = new Set(keys);
    await this.store.deleteMany(
      (r) => r.tabId === tabId && keySet.has(r.taskKey),
    );
  }

  /** All in-flight records, oldest first. */
  async listInflight(): Promise<TaskRecord[]> {
    const all = await this.store.getAll();
    return all
      .filter((r) => r.state === 'inflight')
      .sort((a, b) => a.ts - b.ts);
  }

  /** Clear every record of a closed tab. */
  async removeTab(tabId: number): Promise<void> {
    await this.store.deleteMany((r) => r.tabId === tabId);
  }

  async count(): Promise<number> {
    return (await this.store.getAll()).length;
  }

  /** Ring eviction: keep only the newest maxRecords entries. */
  private async prune(): Promise<void> {
    const all = await this.store.getAll();
    if (all.length <= this.maxRecords) return;
    const sorted = [...all].sort((a, b) => a.ts - b.ts);
    const evictKeys = new Set(
      sorted.slice(0, all.length - this.maxRecords).map(
        (r) => `${r.tabId}|${r.frameId}|${r.taskKey}|${r.ts}`,
      ),
    );
    await this.store.deleteMany((r) =>
      evictKeys.has(`${r.tabId}|${r.frameId}|${r.taskKey}|${r.ts}`),
    );
  }
}