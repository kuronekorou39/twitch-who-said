import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, getStats, ingestBatch } from '../src/db/db';
import { exportFileName, exportLines, importLines, parseLine } from '../src/db/export';
import type { ChatMessage, IngestItem } from '../src/shared/types';

const T0 = 1_800_000_000_000;
function item(i: number, over: Partial<IngestItem> = {}): IngestItem {
  return { user: 'u', displayName: 'U', channel: 'ch', text: `m${i}`, ts: T0 + i * 1000, source: 'live', capturedAt: T0, ...over };
}

beforeEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let s = '';
  for await (const c of gen) s += c;
  return s;
}

describe('export / import', () => {
  it('全件を ts 昇順の JSON Lines で書き出し、ページ境界の同一 ts も取りこぼさない', async () => {
    const db = await getDb();
    // 同じ ts を持つメッセージを境界に置く(ページサイズ 3)
    const items = [item(0), item(1), item(2, { text: 'dup-a' }), item(2, { text: 'dup-b' }), item(2, { text: 'dup-c' }), item(3), item(4)];
    await ingestBatch(db, items, new Set());
    const text = await collect(exportLines(db, 3));
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as ChatMessage);
    expect(lines.length).toBe(7);
    expect(new Set(lines.map((l) => l.id)).size).toBe(7);
    for (let i = 1; i < lines.length; i++) expect(lines[i]!.ts).toBeGreaterThanOrEqual(lines[i - 1]!.ts);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('空の DB は空文字', async () => {
    const db = await getDb();
    expect(await collect(exportLines(db))).toBe('');
  });

  it('エクスポート → 全削除 → インポートで同じ内容に戻り、再インポートは冪等', async () => {
    const db = await getDb();
    await ingestBatch(db, [item(0), item(1, { source: 'vod', vodId: '9', offsetSec: 12 }), item(2, { badges: ['vip'], color: '#ff0000' })], new Set());
    const text = await collect(exportLines(db));
    const before = await db.getAll('messages');

    globalThis.indexedDB = new IDBFactory();
    await closeDb();
    const db2 = await getDb();
    const r = await importLines(db2, text);
    expect(r).toEqual({ read: 3, imported: 3, invalid: 0 });
    const after = await db2.getAll('messages');
    expect(after).toEqual(before);
    expect((await getStats(db2)).users).toBe(1);

    const r2 = await importLines(db2, text);
    expect(r2.imported).toBe(0);
    expect((await getStats(db2)).messages).toBe(3);
  });

  it('壊れた行・必須項目欠けは invalid として数え、残りは取り込む', async () => {
    const db = await getDb();
    const good = JSON.stringify(item(0));
    const text = `${good}\nnot json\n{"user":"x"}\n\n${JSON.stringify(item(1))}\n`;
    const r = await importLines(db, text);
    expect(r).toEqual({ read: 4, imported: 2, invalid: 2 });
  });

  it('parseLine は login / channel を小文字化し、source を正規化する', () => {
    const p = parseLine(JSON.stringify({ user: 'Foo', channel: 'Bar', text: 'x', ts: 1, source: 'weird' }));
    expect(p).toMatchObject({ user: 'foo', channel: 'bar', source: 'live', displayName: 'Foo', capturedAt: 1 });
  });

  it('ファイル名は日付付き', () => {
    expect(exportFileName(new Date(2026, 10, 9))).toBe('twitch-who-said-20261109.jsonl');
  });
});
