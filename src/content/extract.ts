import type { IngestItem } from '../shared/types';
import { SELECTORS, type LiveSelectors, type VodSelectors } from './selectors';

export interface LiveContext {
  channel: string;
  /** 取り込み時刻を注入可能にする(テスト用) */
  now?: () => number;
  /**
   * 監視開始時に既に表示されていた行か。既存行の発言時刻は取り込み時刻では無いので、
   * Twitch の「タイムスタンプ表示」設定で出る行内の時刻(HH:MM)を使い、無ければ捨てる
   */
  existing?: boolean;
}

export interface VodContext {
  channel: string;
  vodId: string;
  /** 配信開始日時 epoch ms。不明なら null(ts は取り込み時刻になる) */
  vodStart: number | null;
  now?: () => number;
}

/** 抽出結果。emotes は保存せず、capture がエモートキャッシュ用にまとめて送る */
export type ExtractedMessage = IngestItem & { emotes?: Record<string, string> };

/**
 * ライブチャットの 1 行 → メッセージ。失敗したら null(例外は投げない)。
 * DOM 読み取りのみを行い、I/O はしない。
 */
export function extractLiveMessage(
  line: Element,
  ctx: LiveContext,
  sel: LiveSelectors = SELECTORS.live,
): ExtractedMessage | null {
  try {
    const user = line.getAttribute(sel.userLoginAttr)?.trim().toLowerCase();
    if (!user) return null;

    const nameEl = line.querySelector<HTMLElement>(sel.displayName);
    const displayName = nameEl?.textContent?.trim() || user;

    const body = line.querySelector(sel.body);
    if (!body) return null;
    const text = collectText(body, sel.emoteImg);
    if (!text) return null;

    const now = ctx.now?.() ?? Date.now();
    let ts = now;
    if (ctx.existing) {
      const shown = parseClockTime(line.querySelector(sel.timestamp)?.textContent ?? '', now);
      if (shown === null) return null;
      ts = shown;
    }
    const item: ExtractedMessage = {
      user,
      displayName,
      channel: ctx.channel,
      text,
      ts,
      source: 'live',
      capturedAt: now,
    };

    if (ctx.existing) item.approxTs = true; // 時刻表示は分単位

    const msgId =
      line.getAttribute(sel.msgIdAttr) ?? line.querySelector(`[${sel.msgIdAttr}]`)?.getAttribute(sel.msgIdAttr);
    if (msgId) item.id = msgId;

    const color = nameEl?.style.color;
    if (color) item.color = color;

    const badges = collectBadges(line, sel.badgeImg);
    if (badges.length) item.badges = badges;

    const emotes = collectEmotes(body, sel.emoteImg);
    if (emotes) item.emotes = emotes;

    return item;
  } catch {
    return null;
  }
}

/** VOD チャットリプレイの 1 行 → メッセージ。失敗したら null */
export function extractVodMessage(
  line: Element,
  ctx: VodContext,
  sel: VodSelectors = SELECTORS.vod,
): ExtractedMessage | null {
  try {
    const nameEl = line.querySelector<HTMLElement>(sel.displayName);
    const user =
      nameEl?.getAttribute(sel.userLoginAttr)?.trim().toLowerCase() ||
      line.querySelector(`[${sel.userLoginAttr}]`)?.getAttribute(sel.userLoginAttr)?.trim().toLowerCase();
    if (!user) return null;
    const displayName = nameEl?.textContent?.trim() || user;

    const body = line.querySelector(sel.body);
    if (!body) return null;
    const text = collectText(body, sel.emoteImg, { skipLeadingColon: true });
    if (!text) return null;

    const offsetSec = parseOffset(line.querySelector(sel.timestamp)?.textContent ?? '');
    const now = ctx.now?.() ?? Date.now();
    const item: ExtractedMessage = {
      user,
      displayName,
      channel: ctx.channel,
      text,
      ts: ctx.vodStart !== null && offsetSec !== null ? ctx.vodStart + offsetSec * 1000 : now,
      source: 'vod',
      vodId: ctx.vodId,
      capturedAt: now,
    };
    if (offsetSec !== null) item.offsetSec = offsetSec;

    const color = nameEl?.style.color;
    if (color) item.color = color;

    const badges = collectBadges(line, sel.badgeImg);
    if (badges.length) item.badges = badges;

    const emotes = collectEmotes(body, sel.emoteImg);
    if (emotes) item.emotes = emotes;

    return item;
  } catch {
    return null;
  }
}

/** "m:ss" / "mm:ss" / "h:mm:ss" を秒に変換。見つからなければ null */
export function parseOffset(text: string): number | null {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * ライブチャットの行に表示される時刻("21:34" / "9:05 PM" など)を、now と同じ日付の epoch ms にする。
 * now より 1 分以上未来になる場合は前日とみなす(日付をまたいだ直後の既存行)。
 */
export function parseClockTime(text: string, now: number): number | null {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  const ampm = m[4]?.toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  const d = new Date(now);
  d.setHours(h, min, sec, 0);
  let ts = d.getTime();
  if (ts > now + 60_000) ts -= 86_400_000;
  return ts;
}

/**
 * 本文要素のテキストを文書順に連結する。
 * テキストノードはそのまま、エモート画像は `:alt:` に置き換える。
 * メンション・リンクなど未知の span もテキストノード経由で拾えるため、Twitch の
 * フラグメント種別の追加に強い。
 */
export function collectText(
  body: Node,
  emoteImgSelector: string,
  opts: { skipLeadingColon?: boolean } = {},
): string {
  const doc = body.ownerDocument ?? document;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  // VOD 行は本文の先頭に区切りの ":" だけの要素が入る
  const skip = opts.skipLeadingColon ? firstColonSeparator(body) : null;
  let out = '';
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (skip && skip.contains(n)) continue;
    if (n.nodeType === Node.TEXT_NODE) {
      out += n.nodeValue ?? '';
    } else if (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === 'IMG') {
      const img = n as HTMLImageElement;
      if (img.matches(emoteImgSelector)) {
        const alt = img.getAttribute('alt')?.trim();
        if (alt) out += `:${alt}:`;
      }
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 本文中のエモート画像から 名前 → URL を集める。無ければ undefined */
export function collectEmotes(body: Element, emoteImgSelector: string): Record<string, string> | undefined {
  let out: Record<string, string> | undefined;
  for (const img of body.querySelectorAll<HTMLImageElement>(emoteImgSelector)) {
    const name = img.getAttribute('alt')?.trim();
    const src = img.getAttribute('src');
    if (!name || !src || !src.startsWith('https://')) continue;
    (out ??= {})[name] = src;
  }
  return out;
}

function firstColonSeparator(body: Node): Element | null {
  const first = (body as Element).firstElementChild;
  return first && first.textContent?.trim() === ':' ? first : null;
}

function collectBadges(line: Element, badgeImgSelector: string): string[] {
  const out: string[] = [];
  for (const img of line.querySelectorAll<HTMLImageElement>(badgeImgSelector)) {
    const label = img.getAttribute('alt')?.trim() || img.getAttribute('aria-label')?.trim();
    if (label) out.push(label);
  }
  return out;
}
