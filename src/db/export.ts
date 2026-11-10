import type { ChatMessage, IngestItem } from '../shared/types';
import { ingestBatch, type WhoSaidDatabase } from './db';

/** エクスポート時に 1 トランザクションで読む件数 */
const EXPORT_PAGE = 2000;
/** インポート時に 1 バッチで書く件数 */
const IMPORT_BATCH = 500;

/**
 * 全メッセージを JSON Lines の文字列チャンクとして順に返す(ts 昇順)。
 * 1 本の巨大文字列を作らず、呼び出し側で Blob にまとめる。
 */
export async function* exportLines(db: WhoSaidDatabase, pageSize = EXPORT_PAGE): AsyncGenerator<string> {
  let after: number | undefined;
  let lastIds = new Set<string>();
  for (;;) {
    const range = after === undefined ? null : IDBKeyRange.lowerBound(after);
    const page = await db.getAllFromIndex('messages', 'by_ts', range, pageSize + lastIds.size);
    const fresh = page.filter((m) => !lastIds.has(m.id));
    if (fresh.length === 0) return;
    yield fresh.map((m) => JSON.stringify(m)).join('\n') + '\n';
    const lastTs = fresh[fresh.length - 1]!.ts;
    // 同じ ts のメッセージが境界にあっても取りこぼさないよう、境界 ts の id を覚えて次ページで除外する
    after = lastTs;
    lastIds = new Set(fresh.filter((m) => m.ts === lastTs).map((m) => m.id));
    if (page.length < pageSize + (page.length - fresh.length)) return;
  }
}

export function exportFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `twitch-who-said-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}.jsonl`;
}

/** 1 行を ChatMessage として検証する。壊れていれば null */
export function parseLine(line: string): IngestItem | null {
  const t = line.trim();
  if (!t) return null;
  let o: unknown;
  try {
    o = JSON.parse(t);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const m = o as Partial<ChatMessage>;
  if (typeof m.user !== 'string' || typeof m.channel !== 'string' || typeof m.text !== 'string') return null;
  if (typeof m.ts !== 'number' || !Number.isFinite(m.ts)) return null;
  const item: IngestItem = {
    user: m.user.toLowerCase(),
    displayName: typeof m.displayName === 'string' ? m.displayName : m.user,
    channel: m.channel.toLowerCase(),
    text: m.text,
    ts: m.ts,
    source: m.source === 'vod' ? 'vod' : 'live',
    capturedAt: typeof m.capturedAt === 'number' ? m.capturedAt : m.ts,
  };
  if (typeof m.id === 'string' && m.id) item.id = m.id;
  if (typeof m.vodId === 'string') item.vodId = m.vodId;
  if (typeof m.offsetSec === 'number') item.offsetSec = m.offsetSec;
  if (Array.isArray(m.badges)) item.badges = m.badges.filter((b): b is string => typeof b === 'string');
  if (typeof m.color === 'string') item.color = m.color;
  return item;
}

export interface ImportProgress {
  read: number;
  imported: number;
  invalid: number;
}

/**
 * JSON Lines テキストを取り込む。ingestBatch を通すので冪等で、集計も更新される。
 * 除外ユーザーは適用しない(自分のエクスポートを戻す用途のため)。
 */
export async function importLines(
  db: WhoSaidDatabase,
  text: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportProgress> {
  const progress: ImportProgress = { read: 0, imported: 0, invalid: 0 };
  let batch: IngestItem[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const r = await ingestBatch(db, batch, new Set());
    progress.imported += r.accepted;
    batch = [];
    onProgress?.(progress);
  };
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    if (!line.trim()) continue;
    progress.read++;
    const item = parseLine(line);
    if (!item) {
      progress.invalid++;
      continue;
    }
    batch.push(item);
    if (batch.length >= IMPORT_BATCH) await flush();
  }
  await flush();
  return progress;
}
