import type { Req } from '../shared/messages';
import type { IngestItem } from '../shared/types';

/** 1 回の問い合わせで返す件数の上限 */
const MAX_QUERY_LIMIT = 500;
/** 1 回のメッセージで受け取る配列の上限(content script のキュー上限と同じ桁) */
const MAX_LIST = 1000;

/** データの削除や設定変更など、拡張自身のページからしか受け付けない操作 */
const PRIVILEGED: ReadonlySet<Req['type']> = new Set<Req['type']>(['ws:clear', 'ws:prune', 'ws:setSettings', 'ws:deleteUsers']);

/** 送信元がこの拡張か。特権操作は Twitch のページ上で動く content script からは呼べない */
export function isAllowedSender(type: Req['type'], sender: chrome.runtime.MessageSender, extensionId: string, baseUrl: string): boolean {
  if (sender.id !== extensionId) return false;
  return !PRIVILEGED.has(type) || !!sender.url?.startsWith(baseUrl);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOptStr = (v: unknown) => v === undefined || isStr(v);
const isStrList = (v: unknown) => Array.isArray(v) && v.length <= MAX_LIST && v.every(isStr);
const isLimit = (v: unknown) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_QUERY_LIMIT;

export function isValidItem(v: unknown): v is IngestItem {
  if (!v || typeof v !== 'object') return false;
  const m = v as Partial<IngestItem>;
  return (
    isNonEmpty(m.user) &&
    isStr(m.displayName) &&
    isNonEmpty(m.channel) &&
    isStr(m.text) &&
    isNum(m.ts) &&
    isNum(m.capturedAt) &&
    (m.source === 'live' || m.source === 'vod') &&
    isOptStr(m.id) &&
    isOptStr(m.vodId) &&
    isOptStr(m.color)
  );
}

function isCursor(v: unknown): boolean {
  if (v === undefined) return true;
  const c = v as { ts?: unknown; id?: unknown } | null;
  return !!c && isNum(c.ts) && isStr(c.id);
}

/** エモートは https の画像 URL だけ受け取る */
function isEmoteMap(v: unknown): boolean {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object') return false;
  const urls = Object.values(v);
  return urls.length <= MAX_LIST && urls.every((u) => isStr(u) && u.startsWith('https://'));
}

/** リクエストの形を実行時に確かめる。ws:ingest の不正な行は取り除いて残りを通す */
export function sanitizeReq(req: Req): Req | null {
  const r = req as Req & Record<string, unknown>;
  switch (req.type) {
    case 'ws:ingest': {
      if (!Array.isArray(r.items) || r.items.length > MAX_LIST || !isOptStr(r.self) || !isEmoteMap(r.emotes)) return null;
      return { ...req, items: r.items.filter(isValidItem) };
    }
    case 'ws:emotes':
      return isStrList(r.names) ? req : null;
    case 'ws:query':
      return isNonEmpty(r.user) && isOptStr(r.channel) && isOptStr(r.keyword) && isCursor(r.before) && isLimit(r.limit) ? req : null;
    case 'ws:changes':
      return isNonEmpty(r.user) && isOptStr(r.channel) && isOptStr(r.keyword) && isNum(r.afterSeq) && isLimit(r.limit) ? req : null;
    case 'ws:count':
      return isNonEmpty(r.user) && isOptStr(r.channel) ? req : null;
    case 'ws:userStats':
      return isNonEmpty(r.user) ? req : null;
    case 'ws:openViewer':
      return isOptStr(r.user) && isOptStr(r.channel) ? req : null;
    case 'ws:getVodStart':
      return isNonEmpty(r.vodId) ? req : null;
    case 'ws:setVodStart':
      return isNonEmpty(r.vodId) && isNum(r.ts) ? req : null;
    case 'ws:deleteUsers':
      return isStrList(r.users) ? req : null;
    case 'ws:setSettings':
      return r.patch && typeof r.patch === 'object' ? req : null;
    case 'ws:stats':
    case 'ws:prune':
    case 'ws:clear':
    case 'ws:getSettings':
      return req;
    default:
      return null;
  }
}
