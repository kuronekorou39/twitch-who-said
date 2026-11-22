import { type DBSchema, type IDBPDatabase, type IDBPObjectStore, openDB } from 'idb';
import { isNearTs, messageHashId, nearTsRange } from '../shared/id';
import type { ChatMessage, DbStats, IngestItem, PageCursor, UserRecord, UserStats } from '../shared/types';

export const DB_NAME = 'twitch-who-said';
const DB_VERSION = 4;
/**
 * 1 回の問い合わせで走査する上限。キーワード検索で一致が少なくても読み取りトランザクションを
 * 長く保持せず(保持している間は取り込みの書き込みが待たされる)、続きは cursor から再開させる
 */
const MAX_SCAN_PER_QUERY = 5000;

export interface WhoSaidDB extends DBSchema {
  messages: {
    key: string;
    value: ChatMessage;
    indexes: {
      by_user_ts: [string, number];
      by_user_channel_ts: [string, string, number];
      /** 履歴ビューアでユーザーを指定せずチャンネルで絞るとき用 */
      by_channel_ts: [string, number];
      by_ts: number;
      by_captured: number;
      /** 書き込み順。seq の無い旧データはこのインデックスに載らない */
      by_seq: number;
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
  /** エモート名 → 画像 URL(ポップオーバーで `:name:` を画像にするためのキャッシュ) */
  emotes: {
    key: string;
    value: EmoteRecord;
  };
}

export interface EmoteRecord {
  name: string;
  url: string;
  seenAt: number;
}

export type WhoSaidDatabase = IDBPDatabase<WhoSaidDB>;

/** meta store のキー */
export const META_CHANNELS = 'channels';
export const META_LAST_INGEST = 'lastIngestAt';
export const META_LAST_PRUNE = 'lastPruneAt';
/** 最後に振った書き込み連番 */
export const META_SEQ = 'seq';
/** 近傍重複の掃除をどこまで進めたか(Service Worker が途中で止まっても続きから再開する) */
export const META_PRUNE_DUP_RESUME = 'pruneDupResume';
/** VOD の配信開始日時のキャッシュ(`vodStart:<vodId>`) */
export const META_VOD_START_PREFIX = 'vodStart:';

/** チャンネルごとの件数(meta の `channels`) */
export type ChannelCounts = Record<string, number>;

let dbPromise: Promise<WhoSaidDatabase> | null = null;

/**
 * DB 接続を返す。接続は使い回すが、閉じられたら次の呼び出しで開き直すので、長く開いているページは
 * 結果を保持せず毎回これを呼ぶこと
 */
export function getDb(): Promise<WhoSaidDatabase> {
  if (dbPromise) return dbPromise;
  const opening: Promise<WhoSaidDatabase> = openDB<WhoSaidDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      if (oldVersion < 1) {
        const messages = db.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('by_user_ts', ['user', 'ts']);
        messages.createIndex('by_user_channel_ts', ['user', 'channel', 'ts']);
        messages.createIndex('by_ts', 'ts');
        messages.createIndex('by_captured', 'capturedAt');
        const users = db.createObjectStore('users', { keyPath: 'user' });
        users.createIndex('by_count', 'count');
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        db.createObjectStore('emotes', { keyPath: 'name' });
      }
      if (oldVersion < 3) {
        tx.objectStore('messages').createIndex('by_channel_ts', ['channel', 'ts']);
      }
      if (oldVersion < 4) {
        tx.objectStore('messages').createIndex('by_seq', 'seq');
      }
    },
    // SW・設定画面・履歴ビューアが同じ DB を開く。新しい版が開こうとしたら古い接続は譲って、次回開き直す
    blocking() {
      void opening.then((db) => db.close());
      if (dbPromise === opening) dbPromise = null;
    },
    // ブラウザ側の都合(ストレージ障害など)で接続が切れたら次回開き直す
    terminated() {
      if (dbPromise === opening) dbPromise = null;
    },
  });
  dbPromise = opening;
  // 開くのに失敗した結果を保持し続けない
  opening.catch(() => {
    if (dbPromise === opening) dbPromise = null;
  });
  return opening;
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
 * - 近傍重複(同 user/channel/text で時刻が近い: shared/id.ts の isNearTs)はスキップ。
 *   ただし既存が分単位の概算で新着が精密な時刻なら、精密なほうに置き換える
 * - users / meta の集計を更新
 */
export async function ingestBatch(db: WhoSaidDatabase, items: IngestItem[], exclude: ReadonlySet<string>): Promise<IngestResult> {
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
  // 同じトランザクション内で読み書きするので、複数タブから同時に来ても連番は重複しない
  const startSeq = ((await meta.get(META_SEQ))?.value as number | undefined) ?? 0;
  let seq = startSeq;

  for (const msg of prepared) {
    const dup = await findNearDuplicate(messages, msg);
    if (dup) {
      if (!dup.approxTs || msg.approxTs) continue;
      // 概算 → 精密への置き換え。件数は変わらないので集計はそのまま
      await messages.delete(dup.id);
      await messages.put({ ...msg, seq: ++seq });
      continue;
    }
    const existed = (await messages.getKey(msg.id)) !== undefined;
    await messages.put({ ...msg, seq: ++seq });
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

  if (seq !== startSeq) await meta.put({ key: META_SEQ, value: seq });
  if (accepted > 0) {
    const channels = ((await meta.get(META_CHANNELS))?.value as ChannelCounts | undefined) ?? {};
    for (const [ch, n] of channelDelta) channels[ch] = (channels[ch] ?? 0) + n;
    await meta.put({ key: META_CHANNELS, value: channels });
    await meta.put({ key: META_LAST_INGEST, value: Date.now() });
  }

  await tx.done;
  return { accepted, skipped: items.length - accepted };
}

type MessagesStore = Pick<IDBPObjectStore<WhoSaidDB, ['messages', 'users', 'meta'], 'messages', 'readwrite'>, 'index'>;

async function findNearDuplicate(messages: MessagesStore, msg: ChatMessage): Promise<ChatMessage | null> {
  const [lo, hi] = nearTsRange(msg);
  const range = IDBKeyRange.bound([msg.user, msg.channel, lo], [msg.user, msg.channel, hi]);
  let cursor = await messages.index('by_user_channel_ts').openCursor(range);
  while (cursor) {
    const v = cursor.value;
    if (v.id !== msg.id && v.text === msg.text && isNearTs(v, msg)) return v;
    cursor = await cursor.continue();
  }
  return null;
}

export interface QueryParams {
  /** 省略すると全ユーザー(履歴ビューア) */
  user?: string;
  channel?: string;
  keyword?: string;
  /** この位置より古いものを返す(古いページの追加ロード用) */
  before?: PageCursor;
  limit: number;
}

export interface QueryResult {
  items: ChatMessage[];
  hasMore: boolean;
  /** 次のページの before に渡す位置。走査上限で止まったときは items が空でも進む */
  cursor: PageCursor | null;
  /** このページを読んだ時点の書き込み連番。以降の新着は queryChanges でこの続きから取る */
  seq: number;
}

/**
 * メッセージを新しい順(ts、同時刻は id の降順)に取得。user / channel に合うインデックスをカーソル走査する。
 * keyword だけはインデックスが無いので、範囲内を走査しながら照合する
 */
export async function queryMessages(db: WhoSaidDatabase, p: QueryParams): Promise<QueryResult> {
  const user = p.user?.toLowerCase();
  const upper = p.before?.ts ?? Number.MAX_SAFE_INTEGER;
  const tx = db.transaction(['messages', 'meta'], 'readonly');
  const store = tx.objectStore('messages');
  const seq = ((await tx.objectStore('meta').get(META_SEQ))?.value as number | undefined) ?? 0;
  const cursorReq = user
    ? p.channel
      ? store.index('by_user_channel_ts').openCursor(IDBKeyRange.bound([user, p.channel, -Infinity], [user, p.channel, upper]), 'prev')
      : store.index('by_user_ts').openCursor(IDBKeyRange.bound([user, -Infinity], [user, upper]), 'prev')
    : p.channel
      ? store.index('by_channel_ts').openCursor(IDBKeyRange.bound([p.channel, -Infinity], [p.channel, upper]), 'prev')
      : store.index('by_ts').openCursor(IDBKeyRange.upperBound(upper), 'prev');

  const keyword = p.keyword?.toLowerCase();
  const items: ChatMessage[] = [];
  let hasMore = false;
  let last: PageCursor | null = null;
  let scanned = 0;
  let cursor = await cursorReq;
  while (cursor) {
    const v = cursor.value;
    // 範囲は before の時刻を含むので、同時刻のうち before 以降(読み済み)を飛ばす
    if (!p.before || v.ts !== p.before.ts || v.id < p.before.id) {
      if (scanned >= MAX_SCAN_PER_QUERY) {
        hasMore = true;
        break;
      }
      scanned++;
      if (!keyword || v.text.toLowerCase().includes(keyword)) {
        if (items.length >= p.limit) {
          hasMore = true;
          break;
        }
        items.push(v);
      }
      last = { ts: v.ts, id: v.id };
    }
    cursor = await cursor.continue();
  }
  await tx.done;
  return { items, hasMore, cursor: last, seq };
}

export interface ChangesParams {
  user?: string;
  channel?: string;
  keyword?: string;
  /** この連番より後に書かれたものを返す */
  afterSeq: number;
  limit: number;
}

export interface ChangesResult {
  /** 書き込み順。発言時刻の順とは限らない(複数タブ・VOD の取り込みで前後する) */
  items: ChatMessage[];
  /** ここまで確認した連番。一致しなかった行も含めて進むので、次回は同じ行を読まない */
  lastSeq: number;
  hasMore: boolean;
}

/** 指定の連番より後に書き込まれたメッセージを取る(開いている一覧の新着用)。新着の行数ぶんしか走査しない */
export async function queryChanges(db: WhoSaidDatabase, p: ChangesParams): Promise<ChangesResult> {
  const user = p.user?.toLowerCase();
  const keyword = p.keyword?.toLowerCase();
  const tx = db.transaction('messages', 'readonly');
  const items: ChatMessage[] = [];
  let lastSeq = p.afterSeq;
  let hasMore = false;
  let scanned = 0;
  let cursor = await tx.store.index('by_seq').openCursor(IDBKeyRange.lowerBound(p.afterSeq, true));
  while (cursor) {
    const v = cursor.value;
    const matched =
      (!user || v.user === user) && (!p.channel || v.channel === p.channel) && (!keyword || v.text.toLowerCase().includes(keyword));
    if (scanned >= MAX_SCAN_PER_QUERY || (matched && items.length >= p.limit)) {
      hasMore = true;
      break;
    }
    scanned++;
    if (matched) items.push(v);
    lastSeq = cursor.key;
    cursor = await cursor.continue();
  }
  await tx.done;
  return { items, lastSeq, hasMore };
}

/** 絞り込みに一致する件数(キーワードは対象外)。インデックスの範囲を数えるだけ */
export async function countMessages(db: WhoSaidDatabase, p: { user?: string; channel?: string }): Promise<number> {
  const user = p.user?.toLowerCase();
  const store = db.transaction('messages').store;
  if (user && p.channel) {
    return store.index('by_user_channel_ts').count(IDBKeyRange.bound([user, p.channel, -Infinity], [user, p.channel, Infinity]));
  }
  if (user) return store.index('by_user_ts').count(IDBKeyRange.bound([user, -Infinity], [user, Infinity]));
  if (p.channel) return store.index('by_channel_ts').count(IDBKeyRange.bound([p.channel, -Infinity], [p.channel, Infinity]));
  return store.count();
}

export async function getUserStats(db: WhoSaidDatabase, user: string): Promise<UserStats> {
  const login = user.toLowerCase();
  const tx = db.transaction(['users', 'messages'], 'readonly');
  const rec = await tx.objectStore('users').get(login);
  // チャンネルごとに先頭のキーだけ見て次のチャンネルへ飛ぶ(メッセージ件数ぶんは走査しない)
  const channels: string[] = [];
  const index = tx.objectStore('messages').index('by_user_channel_ts');
  let cursor = await index.openKeyCursor(IDBKeyRange.bound([login, ''], [login, []]));
  while (cursor) {
    const channel = cursor.key[1];
    channels.push(channel);
    cursor = await cursor.continue([login, channel, Infinity]);
  }
  await tx.done;
  return rec
    ? { user: rec.user, displayName: rec.displayName, count: rec.count, firstTs: rec.firstTs, lastTs: rec.lastTs, channels }
    : { user: login, displayName: user, count: 0, firstTs: null, lastTs: null, channels };
}

/** 発言の多い順にユーザーを返す。query は login・表示名の部分一致(大文字小文字を無視) */
export async function listUsers(db: WhoSaidDatabase, p: { query?: string; limit: number }): Promise<UserRecord[]> {
  const q = p.query?.trim().toLowerCase();
  const out: UserRecord[] = [];
  let cursor = await db.transaction('users').store.index('by_count').openCursor(null, 'prev');
  while (cursor && out.length < p.limit) {
    const v = cursor.value;
    if (!q || v.user.includes(q) || v.displayName.toLowerCase().includes(q)) out.push(v);
    cursor = await cursor.continue();
  }
  return out;
}

/** チャンネルごとの件数(取り込み・prune で更新している集計) */
export async function getChannelCounts(db: WhoSaidDatabase): Promise<ChannelCounts> {
  return (await getMeta<ChannelCounts>(db, META_CHANNELS)) ?? {};
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
  const tx = db.transaction(['messages', 'users', 'meta', 'emotes'], 'readwrite');
  const meta = tx.objectStore('meta');
  // 連番は巻き戻さない。開いたままの一覧が、削除後の新着を「読み済み」と誤認しないように
  const seq = await meta.get(META_SEQ);
  await Promise.all([tx.objectStore('messages').clear(), tx.objectStore('users').clear(), meta.clear(), tx.objectStore('emotes').clear()]);
  if (seq) await meta.put(seq);
  await tx.done;
}

/** エモート名 → URL を保存(上書き)。content script が新しく見たものだけ送ってくる */
export async function putEmotes(db: WhoSaidDatabase, emotes: Record<string, string>): Promise<void> {
  const names = Object.keys(emotes);
  if (names.length === 0) return;
  const tx = db.transaction('emotes', 'readwrite');
  const now = Date.now();
  for (const name of names) {
    const url = emotes[name];
    if (url) await tx.store.put({ name, url, seenAt: now });
  }
  await tx.done;
}

/** 指定した名前のうち既知のものだけ URL を返す */
export async function getEmotes(db: WhoSaidDatabase, names: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (names.length === 0) return out;
  const tx = db.transaction('emotes', 'readonly');
  await Promise.all(
    [...new Set(names)].map(async (name) => {
      const rec = await tx.store.get(name);
      if (rec) out[name] = rec.url;
    }),
  );
  await tx.done;
  return out;
}

export async function getMeta<T>(db: WhoSaidDatabase, key: string): Promise<T | undefined> {
  return (await db.get('meta', key))?.value as T | undefined;
}

export async function setMeta(db: WhoSaidDatabase, key: string, value: unknown): Promise<void> {
  await db.put('meta', { key, value });
}
