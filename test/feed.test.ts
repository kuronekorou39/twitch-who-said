// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, ingestBatch, queryChanges, queryMessages } from '../src/db/db';
import { ChatFeed } from '../src/shared/feed';
import type { IngestItem } from '../src/shared/types';

const T0 = 1_800_000_000_000;
const item = (text: string, ts: number, over: Partial<IngestItem> = {}): IngestItem => ({
  user: 'alice',
  displayName: 'Alice',
  channel: 'ch',
  text,
  ts,
  source: 'live',
  capturedAt: ts,
  ...over,
});

async function setup(pageSize = 3, maxRows = 1000) {
  const db = await getDb();
  const list = document.createElement('div');
  const sentinel = document.createElement('div');
  const status = document.createElement('div');
  list.append(sentinel, status);
  document.body.replaceChildren(list);
  const feed = new ChatFeed<null>({
    list,
    status,
    page: (before) => queryMessages(db, { user: 'alice', before, limit: pageSize }),
    changes: (afterSeq) => queryChanges(db, { user: 'alice', afterSeq, limit: pageSize }),
    prepare: async () => null,
    render: (m) => {
      const el = document.createElement('p');
      el.textContent = m.text;
      return el;
    },
    emptyText: () => 'empty',
    stickPx: 24,
    maxRows,
  });
  const shown = () => [...list.querySelectorAll('p')].map((p) => p.textContent);
  return { db, feed, shown };
}

beforeEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

describe('ChatFeed', () => {
  it('同じ時刻の行がページ境界にあっても、遡ると全件出る', async () => {
    const { db, feed, shown } = await setup();
    await ingestBatch(
      db,
      Array.from({ length: 10 }, (_, i) => item(`m${i}`, T0)),
      new Set(),
    );
    await feed.reload();
    while (feed.hasMore) await feed.loadOlder();
    expect(new Set(shown()).size).toBe(10);
  });

  it('1 回の間隔で上限を超える新着が来ても全件足す', async () => {
    const { db, feed, shown } = await setup();
    await ingestBatch(db, [item('first', T0)], new Set());
    await feed.reload();
    await ingestBatch(
      db,
      Array.from({ length: 12 }, (_, i) => item(`n${i}`, T0 + (i + 1) * 20_000)),
      new Set(),
    );
    await feed.poll();
    expect(shown().length).toBe(13);
    expect(shown().at(-1)).toBe('n11');
  });

  it('遅れて届いた古い時刻の行は、時刻の位置に入る', async () => {
    const { db, feed, shown } = await setup(10);
    await ingestBatch(db, [item('a', T0), item('c', T0 + 40_000)], new Set());
    await feed.reload();
    await ingestBatch(db, [item('b', T0 + 20_000)], new Set());
    await feed.poll();
    expect(shown()).toEqual(['a', 'b', 'c']);
  });

  it('未読込の範囲より古い行は足さず、遡ったときに一度だけ出す', async () => {
    const { db, feed, shown } = await setup(2);
    await ingestBatch(db, [item('b', T0 + 20_000), item('c', T0 + 40_000), item('d', T0 + 60_000)], new Set());
    await feed.reload();
    expect(shown()).toEqual(['c', 'd']);
    await ingestBatch(db, [item('a', T0)], new Set());
    await feed.poll();
    expect(shown()).toEqual(['c', 'd']);
    while (feed.hasMore) await feed.loadOlder();
    expect(shown()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('概算の行が精密な時刻に置き換わったら、表示も 1 行のまま', async () => {
    const { db, feed, shown } = await setup(10);
    await ingestBatch(db, [item('hi', T0, { approxTs: true })], new Set());
    await feed.reload();
    await ingestBatch(db, [item('hi', T0 + 20_000)], new Set());
    await feed.poll();
    expect(shown()).toEqual(['hi']);
  });

  it('最新を見ている間は上限を超えた古い行を外し、遡れば読み直せる', async () => {
    const { db, feed, shown } = await setup(3, 5);
    await ingestBatch(
      db,
      Array.from({ length: 3 }, (_, i) => item(`m${i}`, T0 + i * 20_000)),
      new Set(),
    );
    await feed.reload();
    await ingestBatch(
      db,
      Array.from({ length: 4 }, (_, i) => item(`m${i + 3}`, T0 + (i + 3) * 20_000)),
      new Set(),
    );
    await feed.poll();
    expect(shown()).toEqual(['m2', 'm3', 'm4', 'm5', 'm6']);
    expect(feed.hasMore).toBe(true);
    await feed.loadOlder();
    expect(shown()[0]).toBe('m0');
  });

  it('一致が 0 件でも新着の確認は全件を読み直さない', async () => {
    const { db, feed } = await setup();
    await ingestBatch(db, [item('x', T0)], new Set());
    await feed.reload();
    const { seq } = await queryMessages(db, { limit: 1 });
    const r = await queryChanges(db, { keyword: 'no-match', afterSeq: seq, limit: 10 });
    expect(r).toEqual({ items: [], lastSeq: seq, hasMore: false });
  });
});
