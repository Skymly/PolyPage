/**
 * Resume task table tests (spec 3.0 §8.4, §12.1): persistence through the
 * injectable store, recovery listing, per-tab cleanup, ring eviction and
 * cache-idempotent completion.
 */
import { describe, expect, it } from 'vitest';
import { MemoryTaskStore, TaskTable } from '../src/storage/taskTable';
import { hashText } from '../src/shared/utils';

function makeTable(max = 5000): { table: TaskTable; store: MemoryTaskStore } {
  const store = new MemoryTaskStore();
  return { table: new TaskTable(store, max), store };
}

describe('TaskTable persistence', () => {
  it('records in-flight tasks with text hashes', async () => {
    const { table, store } = makeTable();
    await table.markInflight(1, 0, [{ key: 'wt-1', text: 'hello' }]);
    const all = await store.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      tabId: 1,
      frameId: 0,
      taskKey: 'wt-1',
      textHash: hashText('hello'),
      state: 'inflight',
    });
  });

  it('lists only in-flight records, oldest first', async () => {
    const { table } = makeTable();
    await table.markInflight(1, 0, [{ key: 'a', text: 'x' }]);
    await new Promise((r) => setTimeout(r, 2));
    await table.markInflight(2, 0, [{ key: 'b', text: 'y' }]);
    const inflight = await table.listInflight();
    expect(inflight.map((r) => r.taskKey)).toEqual(['a', 'b']);
  });
});

describe('resume idempotency (缓存幂等跳过已完成条目)', () => {
  it('markDone removes records so they are never resumed twice', async () => {
    const { table } = makeTable();
    await table.markInflight(1, 0, [
      { key: 'a', text: 'x' },
      { key: 'b', text: 'y' },
    ]);
    await table.markDone(1, ['a']);
    const inflight = await table.listInflight();
    expect(inflight.map((r) => r.taskKey)).toEqual(['b']);
    // Completing again (idempotent) is a no-op.
    await table.markDone(1, ['a']);
    expect((await table.listInflight()).map((r) => r.taskKey)).toEqual(['b']);
  });

  it('markDone on another tab does not touch this tab', async () => {
    const { table } = makeTable();
    await table.markInflight(1, 0, [{ key: 'a', text: 'x' }]);
    await table.markDone(2, ['a']);
    expect(await table.count()).toBe(1);
  });
});

describe('tab cleanup (tabs.onRemoved)', () => {
  it('removeTab clears every record of that tab', async () => {
    const { table } = makeTable();
    await table.markInflight(1, 0, [{ key: 'a', text: 'x' }]);
    await table.markInflight(1, 3, [{ key: 'b', text: 'y' }]);
    await table.markInflight(2, 0, [{ key: 'c', text: 'z' }]);
    await table.removeTab(1);
    const left = await table.listInflight();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ tabId: 2, taskKey: 'c' });
  });
});

describe('ring eviction (总量上限 5000 条环形淘汰)', () => {
  it('keeps only the newest N records', async () => {
    const { table, store } = makeTable(5);
    for (let i = 0; i < 8; i++) {
      await table.markInflight(1, 0, [{ key: `k${i}`, text: `t${i}` }]);
      // Distinct timestamps so eviction order is deterministic.
      store.records[store.records.length - 1].ts = 1000 + i;
    }
    const all = await store.getAll();
    expect(all.length).toBe(5);
    expect(all.map((r) => r.taskKey).sort()).toEqual(['k3', 'k4', 'k5', 'k6', 'k7']);
  });
});