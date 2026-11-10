import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getStats, getUserStats, ingestBatch } from '../src/db/db';
import { prune } from '../src/db/prune';
import { DEFAULT_SETTINGS } from '../src/shared/settings';
import type { IngestItem, Settings } from '../src/shared/types';

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function item(user: string, i: number, over: Partial<IngestItem> = {}): IngestItem {
  const ts = NOW - i * 60_000;
  return { user, displayName: user, channel: 'ch', text: `${user} ${i}`, ts, source: 'live', capturedAt: ts, ...over };
}

const noLimits: Settings = { ...DEFAULT_SETTINGS, retentionDays: 0, maxPerUser: 0, maxTotal: 0 };
const opts = { now: () => NOW, chunk: 3, yieldFn: async () => {} };

beforeEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

describe('prune', () => {
  it('保持期間を超えたもの(capturedAt 基準)を削除し、users / channels を更新する', async () => {
    const db = await getDb();
    await ingestBatch(
      db,
      [
        item('a', 0),
        item('a', 1, { capturedAt: NOW - 10 * DAY }),
        item('b', 2, { capturedAt: NOW - 400 * DAY, channel: 'old' }),
        item('b', 3, { capturedAt: NOW - 401 * DAY, channel: 'old' }),
      ],
      new Set(),
    );
    const r = await prune(db, { ...noLimits, retentionDays: 365 }, opts);
    expect(r).toEqual({ byRetention: 2, byPerUser: 0, byTotal: 0, deleted: 2 });
    const st = await getStats(db);
    expect(st.messages).toBe(2);
    expect(st.users).toBe(1); // b は 0 件になり削除
    expect(st.channels).toBe(1); // old は 0 件になり削除
    expect(st.lastPruneAt).toBe(NOW);
    expect((await getUserStats(db, 'a')).count).toBe(2);
  });

  it('ユーザーあたり上限を超えた分を古い順に削除する(チャンク分割あり)', async () => {
    const db = await getDb();
    const items = [...Array.from({ length: 10 }, (_, i) => item('a', i)), ...Array.from({ length: 3 }, (_, i) => item('b', i))];
    await ingestBatch(db, items, new Set());
    const r = await prune(db, { ...noLimits, maxPerUser: 4 }, opts);
    expect(r.byPerUser).toBe(6);
    const a = await getUserStats(db, 'a');
    expect(a.count).toBe(4);
    expect(a.firstTs).toBe(NOW - 3 * 60_000); // 新しい 4 件(i = 0..3)が残る
    expect(a.lastTs).toBe(NOW);
    expect((await getUserStats(db, 'b')).count).toBe(3);
  });

  it('全体上限を超えた分を古い順に削除する', async () => {
    const db = await getDb();
    await ingestBatch(db, [...Array.from({ length: 5 }, (_, i) => item('a', i)), ...Array.from({ length: 5 }, (_, i) => item('b', i + 10))], new Set());
    const r = await prune(db, { ...noLimits, maxTotal: 7 }, opts);
    expect(r.byTotal).toBe(3);
    const st = await getStats(db);
    expect(st.messages).toBe(7);
    // b の古い 3 件(i = 14, 13, 12)が消える
    expect((await getUserStats(db, 'b')).count).toBe(2);
    expect((await getUserStats(db, 'a')).count).toBe(5);
  });

  it('3 段階は 期間 → ユーザー上限 → 全体上限 の順に適用される', async () => {
    const db = await getDb();
    await ingestBatch(
      db,
      [
        ...Array.from({ length: 6 }, (_, i) => item('a', i)),
        item('a', 50, { capturedAt: NOW - 2 * DAY }),
        ...Array.from({ length: 3 }, (_, i) => item('b', i + 20)),
      ],
      new Set(),
    );
    const r = await prune(db, { ...noLimits, retentionDays: 1, maxPerUser: 4, maxTotal: 5 }, opts);
    expect(r).toEqual({ byRetention: 1, byPerUser: 2, byTotal: 2, deleted: 5 });
    const st = await getStats(db);
    expect(st.messages).toBe(5);
  });

  it('0 は無効(何も消さない)', async () => {
    const db = await getDb();
    await ingestBatch(db, [item('a', 0, { capturedAt: 0 })], new Set());
    const r = await prune(db, noLimits, opts);
    expect(r.deleted).toBe(0);
    expect((await getStats(db)).messages).toBe(1);
  });
});
