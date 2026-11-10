import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getStats, getUserStats, ingestBatch, queryMessages } from '../src/db/db';
import type { IngestItem } from '../src/shared/types';

const T0 = 1_700_000_000_000;

function item(over: Partial<IngestItem> = {}): IngestItem {
  return {
    user: 'alice',
    displayName: 'Alice',
    channel: 'ch1',
    text: 'hello',
    ts: T0,
    source: 'live',
    capturedAt: T0,
    ...over,
  };
}

beforeEach(async () => {
  await closeDb();
  // テストごとに新しい IndexedDB
  globalThis.indexedDB = new IDBFactory();
});

describe('ingestBatch', () => {
  it('id を補完して保存し、users / stats が更新される', async () => {
    const db = await getDb();
    const res = await ingestBatch(db, [item(), item({ text: 'second', ts: T0 + 5000 })], new Set());
    expect(res).toEqual({ accepted: 2, skipped: 0 });

    const stats = await getStats(db);
    expect(stats.messages).toBe(2);
    expect(stats.users).toBe(1);
    expect(stats.channels).toBe(1);
    expect(stats.oldestTs).toBe(T0);
    expect(stats.newestTs).toBe(T0 + 5000);

    const u = await getUserStats(db, 'Alice');
    expect(u.count).toBe(2);
    expect(u.firstTs).toBe(T0);
    expect(u.lastTs).toBe(T0 + 5000);
  });

  it('同一メッセージの再取り込みは件数を増やさない(冪等)', async () => {
    const db = await getDb();
    await ingestBatch(db, [item()], new Set());
    const res = await ingestBatch(db, [item()], new Set());
    expect(res.accepted).toBe(0);
    expect((await getStats(db)).messages).toBe(1);
    expect((await getUserStats(db, 'alice')).count).toBe(1);
  });

  it('±10 秒以内の同 user/channel/text は近傍重複としてスキップ', async () => {
    const db = await getDb();
    await ingestBatch(db, [item({ ts: T0 })], new Set());
    const res = await ingestBatch(
      db,
      [
        item({ ts: T0 + 1500 }), // 別の秒 → 別 id になるが近傍重複
        item({ ts: T0 + 1500, text: 'different' }), // 本文が違う → 保存
        item({ ts: T0 + 15_000 }), // ウィンドウ外 → 保存
      ],
      new Set(),
    );
    expect(res.accepted).toBe(2);
    expect((await getStats(db)).messages).toBe(3);
  });

  it('同じバッチ内の重複も 1 件だけ保存する', async () => {
    const db = await getDb();
    const res = await ingestBatch(db, [item(), item({ ts: T0 + 300 })], new Set());
    expect(res.accepted).toBe(1);
  });

  it('除外ユーザーは捨てる', async () => {
    const db = await getDb();
    const res = await ingestBatch(db, [item(), item({ user: 'nightbot', displayName: 'Nightbot' })], new Set(['nightbot']));
    expect(res.accepted).toBe(1);
    expect((await getStats(db)).users).toBe(1);
  });

  it('displayName は最新の発言のものに追従する', async () => {
    const db = await getDb();
    await ingestBatch(db, [item({ displayName: 'Old' })], new Set());
    await ingestBatch(db, [item({ displayName: 'New', text: 'x', ts: T0 + 10_000 })], new Set());
    expect((await getUserStats(db, 'alice')).displayName).toBe('New');
  });
});

describe('queryMessages', () => {
  async function seed() {
    const db = await getDb();
    const items: IngestItem[] = [];
    for (let i = 0; i < 10; i++) {
      items.push(item({ text: `msg ${i}`, ts: T0 + i * 10_000, channel: i % 2 ? 'ch2' : 'ch1' }));
    }
    items.push(item({ user: 'bob', displayName: 'Bob', text: 'bob says', ts: T0 + 1000 }));
    await ingestBatch(db, items, new Set());
    return db;
  }

  it('新しい順に limit 件、hasMore を返す', async () => {
    const db = await seed();
    const r = await queryMessages(db, { user: 'alice', limit: 3 });
    expect(r.items.map((m) => m.text)).toEqual(['msg 9', 'msg 8', 'msg 7']);
    expect(r.hasMore).toBe(true);
  });

  it('before でページングできる', async () => {
    const db = await seed();
    const first = await queryMessages(db, { user: 'alice', limit: 3 });
    const next = await queryMessages(db, { user: 'alice', limit: 3, before: first.items.at(-1)!.ts });
    expect(next.items.map((m) => m.text)).toEqual(['msg 6', 'msg 5', 'msg 4']);
  });

  it('channel で絞り込める', async () => {
    const db = await seed();
    const r = await queryMessages(db, { user: 'alice', channel: 'ch2', limit: 50 });
    expect(r.items.map((m) => m.text)).toEqual(['msg 9', 'msg 7', 'msg 5', 'msg 3', 'msg 1']);
    expect(r.hasMore).toBe(false);
  });

  it('keyword で絞り込める(大文字小文字を無視)', async () => {
    const db = await seed();
    const r = await queryMessages(db, { user: 'alice', keyword: 'MSG 1', limit: 50 });
    expect(r.items.map((m) => m.text)).toEqual(['msg 1']);
  });

  it('他ユーザーのメッセージは混ざらない', async () => {
    const db = await seed();
    const r = await queryMessages(db, { user: 'bob', limit: 50 });
    expect(r.items.map((m) => m.text)).toEqual(['bob says']);
  });

  it('未知ユーザーは空', async () => {
    const db = await seed();
    const r = await queryMessages(db, { user: 'nobody', limit: 50 });
    expect(r.items).toEqual([]);
    expect(r.hasMore).toBe(false);
  });
});

describe('emotes', () => {
  it('名前 → URL を保存し、既知のものだけ返す', async () => {
    const { putEmotes, getEmotes } = await import('../src/db/db');
    const db = await getDb();
    await putEmotes(db, { Kappa: 'https://e/kappa', PogChamp: 'https://e/pog' });
    await putEmotes(db, { Kappa: 'https://e/kappa2' }); // 上書き
    expect(await getEmotes(db, ['Kappa', 'PogChamp', 'Unknown', 'Kappa'])).toEqual({ Kappa: 'https://e/kappa2', PogChamp: 'https://e/pog' });
    expect(await getEmotes(db, [])).toEqual({});
  });
});
