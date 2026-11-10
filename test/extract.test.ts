// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractLiveMessage } from '../src/content/extract';
import { SELECTORS } from '../src/content/selectors';
import {
  LIVE_EMPTY_BODY,
  LIVE_NO_USER,
  LIVE_PLAIN,
  LIVE_WITH_EMOTES,
  LIVE_WITH_MENTION_LINK,
  LIVE_WITH_MSG_ID,
} from './fixtures/live-line';

function lineOf(html: string): Element {
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  const line = wrap.querySelector(SELECTORS.live.chatLine) ?? wrap.firstElementChild;
  if (!line) throw new Error('fixture has no line');
  return line;
}

const ctx = { channel: 'somechannel', now: () => 1_700_000_000_000 };

describe('extractLiveMessage', () => {
  it('プレーンテキスト行を抽出する', () => {
    const item = extractLiveMessage(lineOf(LIVE_PLAIN), ctx);
    expect(item).toEqual({
      user: 'someuser',
      displayName: 'SomeUser',
      channel: 'somechannel',
      text: 'こんばんは',
      ts: 1_700_000_000_000,
      capturedAt: 1_700_000_000_000,
      source: 'live',
      color: 'rgb(220, 0, 0)',
      badges: ['サブスクライバー'],
    });
    expect(item?.id).toBeUndefined();
  });

  it('エモートを :name: に正規化し、文書順に連結する', () => {
    const item = extractLiveMessage(lineOf(LIVE_WITH_EMOTES), ctx);
    expect(item?.text).toBe(':YappingDuck: hello :YappingDuck:');
    expect(item?.user).toBe('sample_chatter');
  });

  it('メンション・リンクのフラグメントもテキストとして拾う', () => {
    const item = extractLiveMessage(lineOf(LIVE_WITH_MENTION_LINK), ctx);
    expect(item?.text).toBe('@SomeUser see https://example.com/x');
  });

  it('data-a-user がない行は null', () => {
    expect(extractLiveMessage(lineOf(LIVE_NO_USER), ctx)).toBeNull();
  });

  it('本文が空の行は null', () => {
    expect(extractLiveMessage(lineOf(LIVE_EMPTY_BODY), ctx)).toBeNull();
  });

  it('msg-id 属性があれば id に採用する', () => {
    const item = extractLiveMessage(lineOf(LIVE_WITH_MSG_ID), ctx);
    expect(item?.id).toBe('abc-123');
  });

  it('ラッパー div ではなく行要素が chatLine セレクタに一致する', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = LIVE_PLAIN;
    const wrapper = wrap.firstElementChild!;
    expect(wrapper.matches(SELECTORS.live.chatLine)).toBe(false);
    expect(wrapper.querySelector(SELECTORS.live.chatLine)).not.toBeNull();
  });
});
