import { rpc } from '../shared/messages';
import { SELECTORS } from './selectors';

/** チャンネルリンク出現待ちのポーリング */
const CHANNEL_POLL_MS = 500;
const CHANNEL_WAIT_MAX_MS = 30_000;

const LOGIN_RE = /^[a-z0-9_]{1,25}$/i;

/**
 * ld+json(VideoObject)を含む HTML / テキストから配信開始日時(uploadDate)を取り出す。
 * 見つからなければ null。
 */
export function parseVodStartFromLdJson(json: string): number | null {
  try {
    const data = JSON.parse(json) as unknown;
    const nodes = flattenLd(data);
    for (const n of nodes) {
      if (typeof n.uploadDate === 'string') {
        const t = Date.parse(n.uploadDate);
        if (!Number.isNaN(t)) return t;
      }
    }
  } catch {
    /* 壊れた JSON は無視 */
  }
  return null;
}

/** SSR された HTML 文字列から ld+json を順に試す */
export function parseVodStartFromHtml(html: string): number | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const ts = parseVodStartFromLdJson(m[1] ?? '');
    if (ts !== null) return ts;
  }
  return null;
}

/** ld+json の name("... - <login>")からチャンネル login を推定する(最後の手段) */
export function parseChannelFromHtml(html: string): string | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      for (const n of flattenLd(JSON.parse(m[1] ?? '') as unknown)) {
        if (typeof n.name !== 'string') continue;
        const tail = /-\s*([A-Za-z0-9_]{1,25})\s*$/.exec(n.name)?.[1];
        if (tail && LOGIN_RE.test(tail)) return tail.toLowerCase();
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function flattenLd(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.flatMap(flattenLd);
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const graph = obj['@graph'];
    return Array.isArray(graph) ? [obj, ...graph.flatMap(flattenLd)] : [obj];
  }
  return [];
}

/** DOM のチャンネルリンクから login を読む */
export function readChannelFromDom(doc: Document = document): string | null {
  for (const a of doc.querySelectorAll<HTMLAnchorElement>(SELECTORS.vod.channelLink)) {
    const seg = a.getAttribute('href')?.split('?')[0]?.split('/').filter(Boolean);
    if (seg?.length === 1 && LOGIN_RE.test(seg[0]!)) return seg[0]!.toLowerCase();
  }
  return null;
}

/**
 * 配信開始日時を解決する。優先順: SW のキャッシュ → ページ内 ld+json → 同じ URL の SSR HTML。
 * 解決できたら SW にキャッシュする。
 */
export async function resolveVodStart(vodId: string, ssrHtml: () => Promise<string | null>): Promise<number | null> {
  try {
    const cached = await rpc({ type: 'ws:getVodStart', vodId });
    if (cached?.ts) return cached.ts;
  } catch {
    /* SW 未応答でも続行 */
  }
  let ts: number | null = null;
  for (const s of document.querySelectorAll(SELECTORS.vod.ldJson)) {
    ts = parseVodStartFromLdJson(s.textContent ?? '');
    if (ts !== null) break;
  }
  if (ts === null) {
    const html = await ssrHtml();
    if (html) ts = parseVodStartFromHtml(html);
  }
  if (ts !== null) void rpc({ type: 'ws:setVodStart', vodId, ts }).catch(() => {});
  return ts;
}

/** 同じ VOD ページの SSR HTML を取得する(twitch.tv 自身への同一オリジン要求のみ) */
export async function fetchSsrHtml(): Promise<string | null> {
  try {
    const res = await fetch(location.pathname, { credentials: 'same-origin' });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/** チャンネル login を解決する。DOM のリンクを待ち、だめなら SSR HTML から推定 */
export async function resolveVodChannel(
  ssrHtml: () => Promise<string | null>,
  isCancelled: () => boolean,
): Promise<string | null> {
  const started = Date.now();
  while (!isCancelled() && Date.now() - started < CHANNEL_WAIT_MAX_MS) {
    const ch = readChannelFromDom();
    if (ch) return ch;
    const html = Date.now() - started > CHANNEL_POLL_MS * 4 ? await ssrHtml() : null;
    if (html) {
      const fromLd = parseChannelFromHtml(html);
      if (fromLd) return fromLd;
    }
    await new Promise((r) => setTimeout(r, CHANNEL_POLL_MS));
  }
  return null;
}
