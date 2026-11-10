// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractLiveMessage, parseClockTime } from '../src/content/extract';
import { SELECTORS } from '../src/content/selectors';
import {
  LIVE_EMPTY_BODY,
  LIVE_NO_USER,
  LIVE_PLAIN,
  LIVE_WITH_EMOTES,
  LIVE_WITH_MENTION_LINK,
  LIVE_WITH_MSG_ID,
  LIVE_WITH_TIMESTAMP,
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

describe('エモートの収集', () => {
  it('本文のエモート画像から 名前 → URL を集める', () => {
    const item = extractLiveMessage(lineOf(LIVE_WITH_EMOTES), ctx);
    expect(item?.emotes).toEqual({ YappingDuck: 'https://static-cdn.jtvnw.net/emoticons/v2/1/default/dark/1.0' });
  });
  it('エモートが無ければ emotes は付かない', () => {
    expect(extractLiveMessage(lineOf(LIVE_PLAIN), ctx)?.emotes).toBeUndefined();
  });
});

describe('既存行(監視開始時に表示済み)の時刻', () => {
  const now = new Date(2026, 10, 10, 22, 0).getTime(); // 22:00
  it('タイムスタンプ表示が無ければ捨てる', () => {
    expect(extractLiveMessage(lineOf(LIVE_PLAIN), { channel: 'c', now: () => now, existing: true })).toBeNull();
  });
  it('タイムスタンプがあれば同日のその時刻にする', () => {
    const item = extractLiveMessage(lineOf(LIVE_WITH_TIMESTAMP), { channel: 'c', now: () => now, existing: true });
    expect(item?.ts).toBe(new Date(2026, 10, 10, 21, 34).getTime());
    expect(item?.capturedAt).toBe(now);
  });
  it('新着行(existing でない)はタイムスタンプがあっても取り込み時刻', () => {
    const item = extractLiveMessage(lineOf(LIVE_WITH_TIMESTAMP), { channel: 'c', now: () => now });
    expect(item?.ts).toBe(now);
  });
});

describe('parseClockTime', () => {
  const base = new Date(2026, 10, 10, 22, 0).getTime();
  it('24 時間表記', () => {
    expect(parseClockTime('21:34', base)).toBe(new Date(2026, 10, 10, 21, 34).getTime());
  });
  it('AM/PM 表記', () => {
    expect(parseClockTime('9:05 PM', base)).toBe(new Date(2026, 10, 10, 21, 5).getTime());
    expect(parseClockTime('12:30 AM', base)).toBe(new Date(2026, 10, 10, 0, 30).getTime());
  });
  it('now より未来なら前日とみなす(日付またぎ)', () => {
    const justAfterMidnight = new Date(2026, 10, 10, 0, 10).getTime();
    expect(parseClockTime('23:58', justAfterMidnight)).toBe(new Date(2026, 10, 9, 23, 58).getTime());
  });
  it('時刻が無ければ null', () => {
    expect(parseClockTime('', base)).toBeNull();
    expect(parseClockTime('99:99', base)).toBeNull();
  });
});
