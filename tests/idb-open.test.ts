/**
 * M-62: failed IndexedDB opens must be retryable; versionchange drops the cache.
 */
import { describe, expect, it, vi } from 'vitest';
import { attachIdbLifecycle, rememberOpen, type IdbOpenCache } from '../src/shared/idbOpen';

function fakeDb(): IDBDatabase {
  return {
    close: vi.fn(),
    onversionchange: null,
  } as unknown as IDBDatabase;
}

describe('rememberOpen (M-62)', () => {
  it('clears the cache after a rejected open so the next call retries', async () => {
    const cache: IdbOpenCache = { promise: null };
    let calls = 0;
    await expect(
      rememberOpen(cache, async () => {
        calls += 1;
        throw new Error('open failed');
      }),
    ).rejects.toThrow('open failed');
    expect(cache.promise).toBeNull();
    const db = fakeDb();
    const opened = await rememberOpen(cache, async () => {
      calls += 1;
      return db;
    });
    expect(opened).toBe(db);
    expect(calls).toBe(2);
  });

  it('closes the db and forgets the cache on versionchange', async () => {
    const cache: IdbOpenCache = { promise: null };
    const db = fakeDb();
    await rememberOpen(cache, async () => db);
    expect(cache.promise).not.toBeNull();
    db.onversionchange?.call(db, new Event('versionchange') as IDBVersionChangeEvent);
    expect(db.close).toHaveBeenCalled();
    expect(cache.promise).toBeNull();
  });
});

describe('attachIdbLifecycle', () => {
  it('is idempotent with a close handler', () => {
    const cache: IdbOpenCache = { promise: Promise.resolve(fakeDb()) };
    const db = fakeDb();
    attachIdbLifecycle(db, cache);
    db.onversionchange?.call(db, new Event('versionchange') as IDBVersionChangeEvent);
    expect(cache.promise).toBeNull();
  });
});
