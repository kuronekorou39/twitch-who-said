import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, countMessages, getDb, getStats, getUserStats, ingestBatch, queryChanges, queryMessages } from '../src/db/db';
import type { IngestItem, PageCursor } from '../src/shared/types';

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
    expect(u.channels).toEqual(['ch1']);
  });

  it('getUserStats はそのユーザーの発言があるチャンネルだけを名前順に返す', async () => {
    const db = await getDb();
    await ingestBatch(
      db,
      [
        item({ channel: 'zeta', text: 'a' }),
        item({ channel: 'beta', text: 'b' }),
        item({ channel: 'beta', text: 'c', ts: T0 + 60_000 }),
        item({ user: 'bob', displayName: 'Bob', channel: 'gamma', text: 'd' }),
        item({ user: 'alice2', displayName: 'Alice2', channel: 'delta', text: 'e' }),
      ],
      new Set(),
    );
    expect((await getUserStats(db, 'alice')).channels).toEqual(['beta', 'zeta']);
    expect((await getUserStats(db, 'nobody')).channels).toEqual([]);
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

  it('分単位の既存行(approxTs)と、その 1 分内に取り込んだ精密な時刻は同一とみなす', async () => {
    const db = await getDb();
    const minute = Math.floor(T0 / 60_000) * 60_000;
    // 精密 → 概算: スキップ
    await ingestBatch(db, [item({ ts: minute + 45_000 })], new Set());
    let res = await ingestBatch(db, [item({ ts: minute, approxTs: true })], new Set());
    expect(res.accepted).toBe(0);
    expect((await getStats(db)).messages).toBe(1);
    // 次の分の概算は別の発言
    res = await ingestBatch(db, [item({ ts: minute + 60_000, approxTs: true })], new Set());
    expect(res.accepted).toBe(1);
  });

  it('概算で保存済みのものに精密な時刻が来たら置き換える(件数は増えない)', async () => {
    const db = await getDb();
    const minute = Math.floor(T0 / 60_000) * 60_000;
    await ingestBatch(db, [item({ ts: minute, approxTs: true })], new Set());
    const res = await ingestBatch(db, [item({ ts: minute + 45_000 })], new Set());
    expect(res.accepted).toBe(0);
    const q = await queryMessages(db, { user: 'alice', limit: 10 });
    expect(q.items.map((m) => [m.ts, m.approxTs ?? null])).toEqual([[minute + 45_000, null]]);
    expect((await getUserStats(db, 'alice')).count).toBe(1);
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
    const next = await queryMessages(db, { user: 'alice', limit: 3, before: first.cursor! });
    expect(next.items.map((m) => m.text)).toEqual(['msg 6', 'msg 5', 'msg 4']);
  });

  it('同じ時刻の行がページ境界をまたいでも全件読める', async () => {
    const db = await getDb();
    await ingestBatch(
      db,
      Array.from({ length: 10 }, (_, i) => item({ text: `same ${i}`, ts: T0 })),
      new Set(),
    );
    const seen: string[] = [];
    let before: PageCursor | undefined;
    for (;;) {
      const r = await queryMessages(db, { user: 'alice', limit: 3, before });
      seen.push(...r.items.map((m) => m.text));
      if (!r.hasMore) break;
      before = r.cursor!;
    }
    expect(seen.length).toBe(10);
    expect(new Set(seen).size).toBe(10);
  });

  it('queryChanges は連番より後の行を書き込み順に返し、一度に多くても続きから全件読める', async () => {
    const db = await seed();
    const { seq } = await queryMessages(db, { user: 'alice', limit: 1 });
    await ingestBatch(
      db,
      Array.from({ length: 120 }, (_, i) => item({ text: `burst ${i}`, ts: T0 + 200_000 + i * 20_000 })),
      new Set(),
    );
    const seen: string[] = [];
    let afterSeq = seq;
    for (;;) {
      const r = await queryChanges(db, { user: 'alice', afterSeq, limit: 50 });
      seen.push(...r.items.map((m) => m.text));
      afterSeq = r.lastSeq;
      if (!r.hasMore) break;
    }
    expect(seen.length).toBe(120);
    expect((await queryChanges(db, { user: 'alice', afterSeq, limit: 50 })).items).toEqual([]);
  });

  it('queryChanges は発言時刻が古い行(遅れて届いた行)も拾い、絞り込みも効く', async () => {
    const db = await seed();
    const { seq } = await queryMessages(db, { user: 'alice', limit: 1 });
    await ingestBatch(
      db,
      [item({ text: 'late', ts: T0 - 500_000 }), item({ user: 'bob', displayName: 'Bob', text: 'other', ts: T0 + 500_000 })],
      new Set(),
    );
    const r = await queryChanges(db, { user: 'alice', afterSeq: seq, limit: 50 });
    expect(r.items.map((m) => m.text)).toEqual(['late']);
    // 一致しなかった行も読み済みとして進む
    expect(r.lastSeq).toBe(seq + 2);
  });

  it('countMessages はユーザー・チャンネルの組み合わせで数える', async () => {
    const db = await seed();
    expect(await countMessages(db, { user: 'alice' })).toBe(10);
    expect(await countMessages(db, { user: 'alice', channel: 'ch2' })).toBe(5);
    expect(await countMessages(db, { channel: 'ch1' })).toBe(6);
    expect(await countMessages(db, {})).toBe(11);
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

  describe('user を省略(履歴ビューア)', () => {
    it('全ユーザーを新しい順に返す', async () => {
      const db = await seed();
      const r = await queryMessages(db, { limit: 50 });
      expect(r.items.map((m) => m.text).slice(-3)).toEqual(['msg 1', 'bob says', 'msg 0']);
      expect(r.items.length).toBe(11);
      const page = await queryMessages(db, { limit: 3, before: { ts: T0 + 70_000, id: '' } });
      expect(page.items.map((m) => m.text)).toEqual(['msg 6', 'msg 5', 'msg 4']);
      expect(page.hasMore).toBe(true);
    });

    it('channel だけで絞り込める(全ユーザー)', async () => {
      const db = await seed();
      const r = await queryMessages(db, { channel: 'ch1', limit: 50 });
      expect(r.items.map((m) => m.text)).toEqual(['msg 8', 'msg 6', 'msg 4', 'msg 2', 'bob says', 'msg 0']);
    });

    it('keyword だけで全体を検索できる', async () => {
      const db = await seed();
      expect((await queryMessages(db, { keyword: 'BOB', limit: 50 })).items.map((m) => m.text)).toEqual(['bob says']);
    });
  });

  it('listUsers は発言の多い順。login・表示名の部分一致で絞れる', async () => {
    const { listUsers } = await import('../src/db/db');
    const db = await seed();
    expect((await listUsers(db, { limit: 10 })).map((u) => [u.user, u.count])).toEqual([
      ['alice', 10],
      ['bob', 1],
    ]);
    expect((await listUsers(db, { query: 'BO', limit: 10 })).map((u) => u.user)).toEqual(['bob']);
    expect((await listUsers(db, { query: 'Alic', limit: 10 })).map((u) => u.user)).toEqual(['alice']);
    expect((await listUsers(db, { limit: 1 })).map((u) => u.user)).toEqual(['alice']);
  });

  it('getChannelCounts はチャンネルごとの件数を返す', async () => {
    const { getChannelCounts } = await import('../src/db/db');
    const db = await seed();
    expect(await getChannelCounts(db)).toEqual({ ch1: 6, ch2: 5 });
  });
});

describe('DB のアップグレード', () => {
  it('v2 の既存データを残したまま by_channel_ts を足す', async () => {
    const { openDB } = await import('idb');
    const old = await openDB('twitch-who-said', 2, {
      upgrade(db) {
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('by_user_ts', ['user', 'ts']);
        messages.createIndex('by_user_channel_ts', ['user', 'channel', 'ts']);
        messages.createIndex('by_ts', 'ts');
        messages.createIndex('by_captured', 'capturedAt');
        db.createObjectStore('users', { keyPath: 'user' }).createIndex('by_count', 'count');
        db.createObjectStore('meta', { keyPath: 'key' });
        db.createObjectStore('emotes', { keyPath: 'name' });
      },
    });
    await old.put('messages', { id: 'x', ...item({ channel: 'old_ch', text: 'before upgrade' }) });
    old.close();

    const db = await getDb();
    expect(db.version).toBe(4);
    const r = await queryMessages(db, { channel: 'old_ch', limit: 10 });
    expect(r.items.map((m) => m.text)).toEqual(['before upgrade']);
  });
});

describe('emotes', () => {
  it('名前 → URL を保存し、既知のものだけ返す', async () => {
    const { putEmotes, getEmotes } = await import('../src/db/db');
    const db = await getDb();
    await putEmotes(db, { Kappa: 'https://e/kappa', PogChamp: 'https://e/pog' });
    await putEmotes(db, { Kappa: 'https://e/kappa2' }); // 上書き
    expect(await getEmotes(db, ['Kappa', 'PogChamp', 'Unknown', 'Kappa'])).toEqual({
      Kappa: 'https://e/kappa2',
      PogChamp: 'https://e/pog',
    });
    expect(await getEmotes(db, [])).toEqual({});
  });
});
