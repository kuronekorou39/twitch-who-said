// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, ingestBatch } from '../src/db/db';
import type { IngestItem } from '../src/shared/types';

const T0 = Date.now() - 3_600_000;
const html = readFileSync(resolve(__dirname, '../src/viewer/viewer.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');

function item(over: Partial<IngestItem>): IngestItem {
  return { user: 'alice', displayName: 'Alice', channel: 'ch1', text: 'hi', ts: T0, source: 'live', capturedAt: T0, ...over };
}

let stop: (() => void) | null = null;

beforeEach(async () => {
  await closeDb();
  globalThis.indexedDB = new IDBFactory();
  document.body.innerHTML = body;
  history.replaceState(null, '', '/src/viewer/viewer.html');
  vi.stubGlobal('chrome', { runtime: { id: 'test', openOptionsPage: vi.fn() } });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const db = await getDb();
  await ingestBatch(
    db,
    [
      item({ text: 'alice old', ts: T0 }),
      item({ user: 'bob', displayName: 'ボブ', channel: 'ch2', text: 'bob mid :Kappa:', ts: T0 + 60_000 }),
      item({ text: 'alice new', channel: 'ch2', ts: T0 + 120_000 }),
    ],
    new Set(),
  );
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.unstubAllGlobals();
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const texts = () => [...document.querySelectorAll('#list .msg .text')].map((e) => e.textContent);

describe('履歴ビューア', () => {
  it('全メッセージをチャット欄と同じ並び(下が最新)で出し、サイドバーに発言の多い順のユーザーを出す', async () => {
    const { startViewer } = await import('../src/viewer/viewer');
    stop = await startViewer();
    await flush();
    expect(texts()).toEqual(['alice old', 'bob mid :Kappa:', 'alice new']);
    expect([...document.querySelectorAll('#side-list li .label')].map((e) => e.textContent)).toEqual(['Alice', 'ボブbob']);
    expect(document.getElementById('summary')!.textContent).toContain('3 メッセージ · 2 ユーザー · 2 チャンネル');
    expect(document.getElementById('count')!.textContent).toBe('表示中 3 件 / 3 件');
  });

  it('読み込み中はスケルトンを出し、終わったら消す', async () => {
    const { startViewer } = await import('../src/viewer/viewer');
    const started = startViewer();
    expect(document.getElementById('loading')!.hidden).toBe(false);
    expect(document.querySelectorAll('#loading-rows .sk').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('#side-list .sk-row').length).toBeGreaterThan(0);
    stop = await started;
    await flush();
    expect(document.getElementById('loading')!.hidden).toBe(true);
    expect(document.querySelectorAll('#side-list .sk-row').length).toBe(0);
  });

  it('名前やチャンネルをクリックすると絞り込み、URL に残り、チップの × で解除できる', async () => {
    const { startViewer } = await import('../src/viewer/viewer');
    stop = await startViewer();
    await flush();
    const bob = [...document.querySelectorAll<HTMLButtonElement>('#list .msg .user')].find((b) => b.textContent === 'ボブ')!;
    bob.click();
    await flush();
    expect(texts()).toEqual(['bob mid :Kappa:']);
    expect(location.search).toBe('?user=bob');
    expect(document.querySelector('#chips .chip')!.textContent).toContain('ボブ (bob)');
    expect(document.querySelector('#side-list li[aria-current="true"]')!.getAttribute('data-key')).toBe('bob');

    document.querySelector<HTMLButtonElement>('#list .msg .ch')!.click();
    await flush();
    expect(location.search).toBe('?user=bob&channel=ch2');
    expect(document.getElementById('list')!.classList.contains('single-channel')).toBe(true);

    document.querySelector<HTMLButtonElement>('#chips .chip button')!.click(); // ユーザーの絞り込みを解除
    await flush();
    expect(location.search).toBe('?channel=ch2');
    expect(texts()).toEqual(['bob mid :Kappa:', 'alice new']);
  });

  it('URL の channel / q から始められ、チャンネルタブで開く', async () => {
    history.replaceState(null, '', '/src/viewer/viewer.html?channel=ch2&q=NEW');
    const { startViewer } = await import('../src/viewer/viewer');
    stop = await startViewer();
    await flush();
    expect(texts()).toEqual(['alice new']);
    expect((document.getElementById('keyword') as HTMLInputElement).value).toBe('NEW');
    expect(document.querySelector('.tabs [aria-selected="true"]')!.getAttribute('data-tab')).toBe('channels');
    expect([...document.querySelectorAll('#side-list li .label')].map((e) => e.textContent)).toEqual(['#ch2', '#ch1']);
  });

  it('既知のエモートは画像で出す', async () => {
    const { putEmotes } = await import('../src/db/db');
    await putEmotes(await getDb(), { Kappa: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0' });
    const { startViewer } = await import('../src/viewer/viewer');
    stop = await startViewer();
    await flush();
    expect(document.querySelector('#list .msg img.emote')!.getAttribute('alt')).toBe('Kappa');
  });
});
