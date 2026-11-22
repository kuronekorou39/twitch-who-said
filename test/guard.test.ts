import { describe, expect, it } from 'vitest';
import type { Req } from '../src/shared/messages';
import { isAllowedSender, sanitizeReq } from '../src/sw/guard';

const ID = 'ext-id';
const BASE = `chrome-extension://${ID}/`;
const content = { id: ID, url: 'https://www.twitch.tv/somechannel', tab: { id: 1 } } as chrome.runtime.MessageSender;
const page = { id: ID, url: `${BASE}src/options/options.html` } as chrome.runtime.MessageSender;

const item = { user: 'a', displayName: 'A', channel: 'c', text: 'x', ts: 1, source: 'live', capturedAt: 1 };

describe('isAllowedSender', () => {
  it('削除・設定変更は拡張のページからだけ受け付ける', () => {
    for (const type of ['ws:clear', 'ws:prune', 'ws:setSettings', 'ws:deleteUsers'] as const) {
      expect(isAllowedSender(type, content, ID, BASE)).toBe(false);
      expect(isAllowedSender(type, page, ID, BASE)).toBe(true);
    }
  });

  it('通常の操作は content script からも呼べる', () => {
    expect(isAllowedSender('ws:ingest', content, ID, BASE)).toBe(true);
    expect(isAllowedSender('ws:query', content, ID, BASE)).toBe(true);
  });

  it('他の拡張からは何も受け付けない', () => {
    expect(isAllowedSender('ws:query', { ...content, id: 'other' }, ID, BASE)).toBe(false);
  });
});

describe('sanitizeReq', () => {
  it('ws:ingest の不正な行だけを取り除く', () => {
    const r = sanitizeReq({ type: 'ws:ingest', items: [item, { user: 1 }] } as unknown as Req);
    expect(r).toMatchObject({ items: [item] });
  });

  it('https 以外のエモート URL を拒否する', () => {
    expect(sanitizeReq({ type: 'ws:ingest', items: [], emotes: { x: 'javascript:alert(1)' } } as unknown as Req)).toBeNull();
  });

  it('limit の範囲外や形の違う cursor を拒否する', () => {
    expect(sanitizeReq({ type: 'ws:query', user: 'a', limit: 100_000 } as Req)).toBeNull();
    expect(sanitizeReq({ type: 'ws:query', user: 'a', limit: 10, before: 5 } as unknown as Req)).toBeNull();
    expect(sanitizeReq({ type: 'ws:query', user: 'a', limit: 10, before: { ts: 5, id: 'x' } } as Req)).not.toBeNull();
  });

  it('未知の種別を拒否する', () => {
    expect(sanitizeReq({ type: 'ws:unknown' } as unknown as Req)).toBeNull();
  });
});
