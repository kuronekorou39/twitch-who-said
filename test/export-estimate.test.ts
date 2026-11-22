import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, ingestBatch } from '../src/db/db';
import { estimateExportBytes, exportLines } from '../src/db/export';

beforeEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
});

describe('estimateExportBytes', () => {
  it('0 件なら 0 を返す', async () => {
    expect(await estimateExportBytes(await getDb(), 0)).toBe(0);
  });

  it('同じ長さの行なら実際の書き出しサイズと一致する', async () => {
    const db = await getDb();
    const items = Array.from({ length: 10 }, (_, i) => ({
      user: 'alice',
      displayName: 'Alice',
      channel: 'ch1',
      text: `発言${i}`,
      ts: 1_000_000 + i * 60_000,
      source: 'live' as const,
      capturedAt: 1_000_000 + i * 60_000,
    }));
    await ingestBatch(db, items, new Set());
    let actual = 0;
    for await (const chunk of exportLines(db)) actual += new TextEncoder().encode(chunk).byteLength;
    expect(await estimateExportBytes(db, 10)).toBe(actual);
  });
});
