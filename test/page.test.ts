import { describe, expect, it } from 'vitest';
import { detectPage, samePage } from '../src/content/page';

const base = 'https://www.twitch.tv';

describe('detectPage', () => {
  it.each([
    ['/somechannel', { kind: 'live', channel: 'somechannel', modView: false }],
    ['/SomeChannel/', { kind: 'live', channel: 'somechannel', modView: false }],
    ['/popout/somechannel/chat', { kind: 'live', channel: 'somechannel', modView: false }],
    ['/popout/somechannel/chat?popout=', { kind: 'live', channel: 'somechannel', modView: false }],
    ['/moderator/somechannel', { kind: 'live', channel: 'somechannel', modView: true }],
    ['/videos/123456789', { kind: 'vod', vodId: '123456789' }],
    ['/videos/123456789?t=1h2m3s', { kind: 'vod', vodId: '123456789' }],
    ['/', { kind: 'other' }],
    ['/directory/category/just-chatting', { kind: 'other' }],
    ['/settings/profile', { kind: 'other' }],
    ['/somechannel/about', { kind: 'other' }],
    ['/somechannel/videos', { kind: 'other' }],
    ['/videos/notanumber', { kind: 'other' }],
    ['/popout/somechannel/notchat', { kind: 'other' }],
    ['/u/somechannel', { kind: 'other' }],
  ])('%s → %o', (path, expected) => {
    expect(detectPage(base + path)).toEqual(expected);
  });
});

describe('samePage', () => {
  it('同じチャンネルの live は同一', () => {
    expect(samePage(detectPage(`${base}/a`), detectPage(`${base}/a?x=1`))).toBe(true);
  });
  it('チャンネルが違えば別', () => {
    expect(samePage(detectPage(`${base}/a`), detectPage(`${base}/b`))).toBe(false);
  });
  it('通常と Mod View は別', () => {
    expect(samePage(detectPage(`${base}/a`), detectPage(`${base}/moderator/a`))).toBe(false);
  });
  it('other 同士は同一', () => {
    expect(samePage(detectPage(`${base}/`), detectPage(`${base}/directory`))).toBe(true);
  });
});
