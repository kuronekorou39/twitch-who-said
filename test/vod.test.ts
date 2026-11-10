// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { extractVodMessage, parseOffset } from '../src/content/extract';
import { SELECTORS } from '../src/content/selectors';
import { parseChannelFromHtml, parseVodStartFromHtml, parseVodStartFromLdJson, readChannelFromDom } from '../src/content/vod';
import { VOD_EMPTY, VOD_PLAIN, VOD_SSR_HTML, VOD_WITH_EMOTE_AND_HOURS } from './fixtures/vod-line';

function lineOf(html: string): Element {
  const wrap = document.createElement('ul');
  wrap.innerHTML = html;
  const li = wrap.firstElementChild!;
  // 実際の監視では li が追加され、その中の .vod-message を行として扱う
  expect(li.matches(SELECTORS.vod.chatLine)).toBe(false);
  return li.querySelector(SELECTORS.vod.chatLine)!;
}

const VOD_START = Date.UTC(2026, 10, 8, 1, 0, 40);
const NOW = 1_800_000_000_000;
const ctx = { channel: 'sample_streamer', vodId: '1234567890', vodStart: VOD_START, now: () => NOW };

describe('parseOffset', () => {
  it.each([
    ['10:19', 619],
    ['0:06', 6],
    ['1:02:05', 3725],
    ['  12:34:56 ', 45296],
    ['no time', null],
  ])('%s → %s', (text, expected) => {
    expect(parseOffset(text)).toBe(expected);
  });
});

describe('extractVodMessage', () => {
  it('行から user / 本文 / オフセット / 推定日時を抽出する(先頭の ":" は除く)', () => {
    const item = extractVodMessage(lineOf(VOD_PLAIN), ctx);
    expect(item).toEqual({
      user: 'sample_viewer',
      displayName: 'sample_viewer',
      channel: 'sample_streamer',
      text: 'これはテスト用のコメントです',
      ts: VOD_START + 619_000,
      source: 'vod',
      vodId: '1234567890',
      offsetSec: 619,
      color: 'rgb(0, 128, 0)',
      capturedAt: NOW,
    });
  });

  it('エモートと h:mm:ss、intl-login 付き表示名', () => {
    const item = extractVodMessage(lineOf(VOD_WITH_EMOTE_AND_HOURS), ctx);
    expect(item?.text).toBe('gg :Kappa:');
    expect(item?.displayName).toBe('Someone');
    expect(item?.offsetSec).toBe(3725);
    expect(item?.ts).toBe(VOD_START + 3725_000);
  });

  it('配信開始日時が不明なら ts は取り込み時刻、offsetSec は残る', () => {
    const item = extractVodMessage(lineOf(VOD_PLAIN), { ...ctx, vodStart: null });
    expect(item?.ts).toBe(NOW);
    expect(item?.offsetSec).toBe(619);
  });

  it('本文が空なら null', () => {
    expect(extractVodMessage(lineOf(VOD_EMPTY), ctx)).toBeNull();
  });
});

describe('vod start / channel の解析', () => {
  it('ld+json の uploadDate を読む(@graph 配下)', () => {
    expect(parseVodStartFromHtml(VOD_SSR_HTML)).toBe(VOD_START);
  });
  it('直接の VideoObject でも読む', () => {
    expect(parseVodStartFromLdJson('{"@type":"VideoObject","uploadDate":"2026-01-01T00:00:00Z"}')).toBe(Date.UTC(2026, 0, 1));
  });
  it('壊れた JSON / uploadDate 無しは null', () => {
    expect(parseVodStartFromLdJson('{oops')).toBeNull();
    expect(parseVodStartFromHtml('<html></html>')).toBeNull();
  });
  it('ld+json の name 末尾からチャンネルを推定する', () => {
    expect(parseChannelFromHtml(VOD_SSR_HTML)).toBe('sample_streamer');
  });
  it('DOM のチャンネルリンクから login を読む', () => {
    document.body.innerHTML = `
      <div class="metadata-layout__support">
        <div class="metadata-layout__display-name-spacing"><a href="/Sample_Streamer?tt=1">サンプル配信者</a></div>
        <div class="metadata-layout__secondary-button-spacing"><a href="/sample_streamer">ライブ配信を見る</a></div>
      </div>`;
    expect(readChannelFromDom()).toBe('sample_streamer');
    document.body.innerHTML = '';
    expect(readChannelFromDom()).toBeNull();
  });
});
