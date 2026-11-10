import type { IDBPTransaction } from 'idb';
import type { Settings, UserRecord } from '../shared/types';
import { META_CHANNELS, META_LAST_PRUNE, type ChannelCounts, type WhoSaidDatabase, type WhoSaidDB } from './db';

/** 1 トランザクションで削除する最大件数。間に yield を挟んで SW のイベントループを占有しない */
const DEFAULT_CHUNK = 5000;

export interface PruneResult {
  byRetention: number;
  byPerUser: number;
  byTotal: number;
  deleted: number;
}

export interface PruneOptions {
  chunk?: number;
  now?: () => number;
  /** チャンク間で制御を返す(テストでは no-op にできる) */
  yieldFn?: () => Promise<void>;
}

const defaultYield = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * 保持ポリシーを適用する。
 * ① retentionDays 超(capturedAt 基準)を削除 → ② ユーザーあたり上限超を古い順に削除 → ③ 全体上限超を古い順に削除。
 * 各段階の後に users / channels の集計を更新する。
 */
export async function prune(db: WhoSaidDatabase, settings: Settings, opts: PruneOptions = {}): Promise<PruneResult> {
  const chunk = opts.chunk ?? DEFAULT_CHUNK;
  const now = opts.now ?? Date.now;
  const yieldFn = opts.yieldFn ?? defaultYield;

  const result: PruneResult = { byRetention: 0, byPerUser: 0, byTotal: 0, deleted: 0 };

  // ① 保持期間
  if (settings.retentionDays > 0) {
    const cutoff = now() - settings.retentionDays * 86_400_000;
    result.byRetention = await deleteByIndex(
      db,
      'by_captured',
      IDBKeyRange.upperBound(cutoff, true),
      Infinity,
      chunk,
      yieldFn,
    );
  }

  // ② ユーザーあたり上限
  if (settings.maxPerUser > 0) {
    const over = await db.getAllFromIndex('users', 'by_count', IDBKeyRange.lowerBound(settings.maxPerUser, true));
    for (const u of over) {
      const excess = u.count - settings.maxPerUser;
      if (excess <= 0) continue;
      result.byPerUser += await deleteByIndex(
        db,
        'by_user_ts',
        IDBKeyRange.bound([u.user, -Infinity], [u.user, Infinity]),
        excess,
        chunk,
        yieldFn,
      );
    }
  }

  // ③ 全体上限
  if (settings.maxTotal > 0) {
    const total = await db.count('messages');
    const excess = total - settings.maxTotal;
    if (excess > 0) {
      result.byTotal = await deleteByIndex(db, 'by_ts', null, excess, chunk, yieldFn);
    }
  }

  result.deleted = result.byRetention + result.byPerUser + result.byTotal;
  await db.put('meta', { key: META_LAST_PRUNE, value: now() });
  return result;
}

type MessageIndex = 'by_captured' | 'by_user_ts' | 'by_ts';

/**
 * インデックスを古い順に走査して最大 limit 件削除する。chunk 件ごとにトランザクションを区切り、
 * 削除したメッセージの user / channel を集計して users / meta を更新する。
 */
async function deleteByIndex(
  db: WhoSaidDatabase,
  index: MessageIndex,
  range: IDBKeyRange | null,
  limit: number,
  chunk: number,
  yieldFn: () => Promise<void>,
): Promise<number> {
  let deleted = 0;
  while (deleted < limit) {
    const budget = Math.min(chunk, limit - deleted);
    const tx = db.transaction(['messages', 'users', 'meta'], 'readwrite');
    const messages = tx.objectStore('messages');
    const affectedUsers = new Set<string>();
    const channelDelta = new Map<string, number>();
    let n = 0;
    let cursor = await messages.index(index).openCursor(range, 'next');
    while (cursor && n < budget) {
      const v = cursor.value;
      affectedUsers.add(v.user);
      channelDelta.set(v.channel, (channelDelta.get(v.channel) ?? 0) + 1);
      await cursor.delete();
      n++;
      cursor = await cursor.continue();
    }
    if (n > 0) await applyDeletions(tx, affectedUsers, channelDelta);
    await tx.done;
    deleted += n;
    if (n < budget) break; // 走査し尽くした
    await yieldFn();
  }
  return deleted;
}

type RwTx = IDBPTransaction<WhoSaidDB, ('messages' | 'users' | 'meta')[], 'readwrite'>;

/** 削除後の集計更新。users は by_user_ts を数え直し、channels はデルタで減算 */
async function applyDeletions(tx: RwTx, affectedUsers: Set<string>, channelDelta: Map<string, number>): Promise<void> {
  const messages = tx.objectStore('messages');
  const users = tx.objectStore('users');
  const meta = tx.objectStore('meta');
  const byUserTs = messages.index('by_user_ts');

  for (const user of affectedUsers) {
    const range = IDBKeyRange.bound([user, -Infinity], [user, Infinity]);
    const count = await byUserTs.count(range);
    const cur = await users.get(user);
    if (count === 0) {
      if (cur) await users.delete(user);
      continue;
    }
    const firstKey = await byUserTs.openKeyCursor(range, 'next');
    const lastKey = await byUserTs.openKeyCursor(range, 'prev');
    const rec: UserRecord = {
      user,
      displayName: cur?.displayName ?? user,
      count,
      firstTs: firstKey ? firstKey.key[1] : (cur?.firstTs ?? 0),
      lastTs: lastKey ? lastKey.key[1] : (cur?.lastTs ?? 0),
    };
    await users.put(rec);
  }

  const channels = ((await meta.get(META_CHANNELS))?.value as ChannelCounts | undefined) ?? {};
  for (const [ch, n] of channelDelta) {
    const next = (channels[ch] ?? 0) - n;
    if (next > 0) channels[ch] = next;
    else delete channels[ch];
  }
  await meta.put({ key: META_CHANNELS, value: channels });
}
