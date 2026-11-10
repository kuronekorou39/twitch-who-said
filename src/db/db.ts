import { openDB, type DBSchema, type IDBPDatabase, type IDBPObjectStore } from 'idb';
import { messageHashId, NEAR_DUP_WINDOW_MS } from '../shared/id';
import type { ChatMessage, DbStats, IngestItem, UserRecord, UserStats } from '../shared/types';

export const DB_NAME = 'twitch-who-said';
const DB_VERSION = 1;

export interface WhoSaidDB extends DBSchema {
  messages: {
    key: string;
    value: ChatMessage;
    indexes: {
      by_user_ts: [string, number];
      by_user_channel_ts: [string, string, number];
      by_ts: number;
      by_captured: number;
    };
  };
  users: {
    key: string;
    value: UserRecord;
    indexes: { by_count: number };
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
}

export type WhoSaidDatabase = IDBPDatabase<WhoSaidDB>;

/** meta store のキー */
export const META_CHANNELS = 'channels';
export const META_LAST_INGEST = 'lastIngestAt';
export const META_LAST_PRUNE = 'lastPruneAt';

/** チャンネルごとの件数(meta の `channels`) */
export type ChannelCounts = Record<string, number>;

let dbPromise: Promise<WhoSaidDatabase> | null = null;

export function getDb(): Promise<WhoSaidDatabase> {
  dbPromise ??= openDB<WhoSaidDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const messages = db.createObjectStore('messages', { keyPath: 'id' });
      messages.createIndex('by_user_ts', ['user', 'ts']);
      messages.createIndex('by_user_channel_ts', ['user', 'channel', 'ts']);
      messages.createIndex('by_ts', 'ts');
      messages.createIndex('by_captured', 'capturedAt');
      const users = db.createObjectStore('users', { keyPath: 'user' });
      users.createIndex('by_count', 'count');
      db.createObjectStore('meta', { keyPath: 'key' });
    },
  });
  return dbPromise;
}

/** テスト用: 接続を閉じてキャッシュを破棄 */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  (await dbPromise).close();
  dbPromise = null;
}

export interface IngestResult {
  accepted: number;
  skipped: number;
}

/**
 * 1 バッチを 1 トランザクションで書き込む。
 * - 除外ユーザーは捨てる
 * - id 未設定なら内容ハッシュで補完
 * - 近傍重複(同 user/channel/text が ±NEAR_DUP_WINDOW_MS 以内)はスキップ
 * - users / meta の集計を更新
 */
export async function ingestBatch(
  db: WhoSaidDatabase,
  items: IngestItem[],
  exclude: ReadonlySet<string>,
): Promise<IngestResult> {
  // ハッシュ計算(非同期)はトランザクション開始前に済ませる。IndexedDB のトランザクションは
  // 自身のリクエスト以外を await すると自動コミットされるため
  const prepared: ChatMessage[] = [];
  for (const it of items) {
    if (!it.user || !it.text || exclude.has(it.user)) continue;
    const id = it.id ?? (await messageHashId(it.channel, it.user, it.text, it.ts));
    prepared.push({ ...it, id });
  }
  if (prepared.length === 0) return { accepted: 0, skipped: items.length };

  const tx = db.transaction(['messages', 'users', 'meta'], 'readwrite');
  const messages = tx.objectStore('messages');
  const users = tx.objectStore('users');
  const meta = tx.objectStore('meta');

  const userDelta = new Map<string, Omit<UserRecord, 'user'>>();
  const channelDelta = new Map<string, number>();
  let accepted = 0;

  for (const msg of prepared) {
    if (await isNearDuplicate(messages, msg)) continue;
    const existed = (await messages.getKey(msg.id)) !== undefined;
    await messages.put(msg);
    if (existed) continue; // 同一 id の上書きは集計に影響させない
    accepted++;
    const d = userDelta.get(msg.user);
    if (d) {
      d.count++;
      if (msg.ts >= d.lastTs) {
        d.lastTs = msg.ts;
        d.displayName = msg.displayName;
      }
      d.firstTs = Math.min(d.firstTs, msg.ts);
    } else {
      userDelta.set(msg.user, { displayName: msg.displayName, count: 1, lastTs: msg.ts, firstTs: msg.ts });
    }
    channelDelta.set(msg.channel, (channelDelta.get(msg.channel) ?? 0) + 1);
  }

  for (const [user, d] of userDelta) {
    const cur = await users.get(user);
    const rec: UserRecord = cur
      ? {
          user,
          displayName: d.lastTs >= cur.lastTs ? d.displayName : cur.displayName,
          count: cur.count + d.count,
          lastTs: Math.max(cur.lastTs, d.lastTs),
          firstTs: Math.min(cur.firstTs, d.firstTs),
        }
      : { user, ...d };
    await users.put(rec);
  }

  if (accepted > 0) {
    const channels = ((await meta.get(META_CHANNELS))?.value as ChannelCounts | undefined) ?? {};
    for (const [ch, n] of channelDelta) channels[ch] = (channels[ch] ?? 0) + n;
    await meta.put({ key: META_CHANNELS, value: channels });
    await meta.put({ key: META_LAST_INGEST, value: Date.now() });
  }

  await tx.done;
  return { accepted, skipped: items.length - accepted };
}

type MessagesStore = Pick<
  IDBPObjectStore<WhoSaidDB, ['messages', 'users', 'meta'], 'messages', 'readwrite'>,
  'index'
>;

async function isNearDuplicate(messages: MessagesStore, msg: ChatMessage): Promise<boolean> {
  const range = IDBKeyRange.bound(
    [msg.user, msg.channel, msg.ts - NEAR_DUP_WINDOW_MS],
    [msg.user, msg.channel, msg.ts + NEAR_DUP_WINDOW_MS],
  );
  let cursor = await messages.index('by_user_channel_ts').openCursor(range);
  while (cursor) {
    if (cursor.value.id !== msg.id && cursor.value.text === msg.text) return true;
    cursor = await cursor.continue();
  }
  return false;
}

export interface QueryParams {
  user: string;
  channel?: string;
  keyword?: string;
  before?: number;
  limit: number;
}

/** ユーザーのメッセージを新しい順に取得。インデックスをカーソル走査し、全件スキャンはしない */
export async function queryMessages(
  db: WhoSaidDatabase,
  p: QueryParams,
): Promise<{ items: ChatMessage[]; hasMore: boolean }> {
  const user = p.user.toLowerCase();
  const upper = p.before ?? Number.MAX_SAFE_INTEGER;
  const tx = db.transaction('messages', 'readonly');
  const store = tx.objectStore('messages');
  const cursorReq = p.channel
    ? store
        .index('by_user_channel_ts')
        .openCursor(IDBKeyRange.bound([user, p.channel, -Infinity], [user, p.channel, upper], false, true), 'prev')
    : store.index('by_user_ts').openCursor(IDBKeyRange.bound([user, -Infinity], [user, upper], false, true), 'prev');

  const keyword = p.keyword?.toLowerCase();
  const items: ChatMessage[] = [];
  let hasMore = false;
  let cursor = await cursorReq;
  while (cursor) {
    const v = cursor.value;
    if (!keyword || v.text.toLowerCase().includes(keyword)) {
      if (items.length >= p.limit) {
        hasMore = true;
        break;
      }
      items.push(v);
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return { items, hasMore };
}

export async function getUserStats(db: WhoSaidDatabase, user: string): Promise<UserStats> {
  const rec = await db.get('users', user.toLowerCase());
  return rec
    ? { user: rec.user, displayName: rec.displayName, count: rec.count, firstTs: rec.firstTs, lastTs: rec.lastTs }
    : { user: user.toLowerCase(), displayName: user, count: 0, firstTs: null, lastTs: null };
}

export async function getStats(db: WhoSaidDatabase): Promise<DbStats> {
  const tx = db.transaction(['messages', 'users', 'meta'], 'readonly');
  const messages = tx.objectStore('messages');
  const meta = tx.objectStore('meta');
  const [count, users, channelsRec, lastIngest, lastPrune, oldest, newest] = await Promise.all([
    messages.count(),
    tx.objectStore('users').count(),
    meta.get(META_CHANNELS),
    meta.get(META_LAST_INGEST),
    meta.get(META_LAST_PRUNE),
    messages.index('by_ts').openKeyCursor(null, 'next'),
    messages.index('by_ts').openKeyCursor(null, 'prev'),
  ]);
  await tx.done;
  const channels = (channelsRec?.value as ChannelCounts | undefined) ?? {};
  return {
    messages: count,
    users,
    channels: Object.keys(channels).length,
    oldestTs: oldest ? oldest.key : null,
    newestTs: newest ? newest.key : null,
    lastIngestAt: (lastIngest?.value as number | undefined) ?? null,
    lastPruneAt: (lastPrune?.value as number | undefined) ?? null,
  };
}

export async function clearAll(db: WhoSaidDatabase): Promise<void> {
  const tx = db.transaction(['messages', 'users', 'meta'], 'readwrite');
  await Promise.all([
    tx.objectStore('messages').clear(),
    tx.objectStore('users').clear(),
    tx.objectStore('meta').clear(),
  ]);
  await tx.done;
}

export async function getMeta<T>(db: WhoSaidDatabase, key: string): Promise<T | undefined> {
  return (await db.get('meta', key))?.value as T | undefined;
}

export async function setMeta(db: WhoSaidDatabase, key: string, value: unknown): Promise<void> {
  await db.put('meta', { key, value });
}
