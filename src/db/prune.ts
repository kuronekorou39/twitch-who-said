import type { IDBPTransaction } from 'idb';
import { isNearTs, nearTsRange } from '../shared/id';
import type { ChatMessage, Settings, UserRecord } from '../shared/types';
import {
  type ChannelCounts,
  getMeta,
  META_CHANNELS,
  META_LAST_PRUNE,
  META_PRUNE_DUP_RESUME,
  META_VOD_START_PREFIX,
  type WhoSaidDatabase,
  type WhoSaidDB,
} from './db';

/** 1 トランザクションで削除する最大件数。間に yield を挟んで SW のイベントループを占有しない */
const DEFAULT_CHUNK = 5000;

export interface PruneResult {
  byRetention: number;
  byPerUser: number;
  byTotal: number;
  /** 近傍重複の掃除で消した件数 */
  byDuplicate: number;
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
 * ① retentionDays 超(capturedAt 基準)を削除 → ② ユーザーあたり上限超を古い順に削除 → ③ 全体上限超を古い順に削除
 * → ④ 取り込み時に弾けなかった近傍重複を掃除。各段階の後に users / channels の集計を更新する。
 */
export async function prune(db: WhoSaidDatabase, settings: Settings, opts: PruneOptions = {}): Promise<PruneResult> {
  const chunk = opts.chunk ?? DEFAULT_CHUNK;
  const now = opts.now ?? Date.now;
  const yieldFn = opts.yieldFn ?? defaultYield;

  const result: PruneResult = { byRetention: 0, byPerUser: 0, byTotal: 0, byDuplicate: 0, deleted: 0 };

  // ① 保持期間
  if (settings.retentionDays > 0) {
    const cutoff = now() - settings.retentionDays * 86_400_000;
    result.byRetention = await deleteByIndex(db, 'by_captured', IDBKeyRange.upperBound(cutoff, true), Infinity, chunk, yieldFn);
    await pruneAuxiliary(db, cutoff);
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

  // ④ 近傍重複(複数タブ・再読み込みで二重に取り込まれた分。判定ルールを広げた後の既存データも対象)
  result.byDuplicate = await deleteNearDuplicates(db, chunk, yieldFn);

  result.deleted = result.byRetention + result.byPerUser + result.byTotal + result.byDuplicate;
  await db.put('meta', { key: META_LAST_PRUNE, value: now() });
  return result;
}

/** 保持期間を過ぎたエモートと VOD 開始日時のキャッシュを消す。どちらも必要になれば取り直せる */
async function pruneAuxiliary(db: WhoSaidDatabase, cutoff: number): Promise<void> {
  const tx = db.transaction(['emotes', 'meta'], 'readwrite');
  let emote = await tx.objectStore('emotes').openCursor();
  while (emote) {
    if (emote.value.seenAt < cutoff) await emote.delete();
    emote = await emote.continue();
  }
  const range = IDBKeyRange.bound(META_VOD_START_PREFIX, `${META_VOD_START_PREFIX}￿`);
  let vod = await tx.objectStore('meta').openCursor(range);
  while (vod) {
    if (typeof vod.value.value === 'number' && vod.value.value < cutoff) await vod.delete();
    vod = await vod.continue();
  }
  await tx.done;
}

/** 指定ユーザーの保存済み発言をすべて消す(除外に追加したとき) */
export async function deleteUsers(db: WhoSaidDatabase, users: string[], opts: PruneOptions = {}): Promise<number> {
  const chunk = opts.chunk ?? DEFAULT_CHUNK;
  const yieldFn = opts.yieldFn ?? defaultYield;
  let deleted = 0;
  for (const raw of users) {
    const user = raw.trim().toLowerCase();
    if (!user) continue;
    deleted += await deleteByIndex(db, 'by_user_ts', IDBKeyRange.bound([user, -Infinity], [user, Infinity]), Infinity, chunk, yieldFn);
  }
  return deleted;
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

/**
 * by_user_channel_ts を昇順に走査し、同 user/channel で本文が同じ・時刻が近い(isNearTs)ものを 1 件に減らす。
 * 分単位の概算(approxTs)と精密な時刻が並んでいれば精密なほうを残す。
 *
 * 走査は読み取りトランザクションで行い、消す行があるときだけ短い書き込みトランザクションを張るので、
 * 取り込みを止めない。進捗は meta に残し、Service Worker が途中で止まっても次回は続きから再開する
 */
async function deleteNearDuplicates(db: WhoSaidDatabase, chunk: number, yieldFn: () => Promise<void>): Promise<number> {
  let deleted = 0;
  let resume = (await getMeta<DupResume>(db, META_PRUNE_DUP_RESUME)) ?? null;
  let group = '';
  /** 現在の user/channel で、まだ相手になり得る直近の生存レコード */
  let recent: ChatMessage[] = [];
  for (;;) {
    const readTx = db.transaction('messages', 'readonly');
    const victims: ChatMessage[] = [];
    // 同じインデックスキーの行は主キー順に並ぶので、キーと id の組で続きの位置が一意に決まる
    const range = resume ? IDBKeyRange.lowerBound(resume.key) : null;
    let cursor = await readTx.store.index('by_user_channel_ts').openCursor(range, 'next');
    let n = 0;
    while (cursor && n < chunk) {
      const v = cursor.value;
      if (resume && indexedDB.cmp(cursor.key, resume.key) === 0 && v.id <= resume.id) {
        cursor = await cursor.continue();
        continue;
      }
      n++;
      resume = { key: cursor.key, id: v.id };
      const g = `${v.user}\n${v.channel}`;
      if (g !== group) {
        group = g;
        recent = [];
      }
      const oldest = nearTsRange(v)[0];
      recent = recent.filter((r) => r.ts >= oldest);
      const dup = recent.find((r) => r.text === v.text && isNearTs(r, v));
      if (!dup) {
        recent.push(v);
      } else {
        let victim = v;
        if (dup.approxTs && !v.approxTs) {
          victim = dup;
          recent[recent.indexOf(dup)] = v;
        }
        victims.push(victim);
      }
      cursor = await cursor.continue();
    }
    const finished = !cursor;
    await readTx.done;

    const tx = db.transaction(['messages', 'users', 'meta'], 'readwrite');
    const messages = tx.objectStore('messages');
    const affectedUsers = new Set<string>();
    const channelDelta = new Map<string, number>();
    for (const victim of victims) {
      // 走査の後に別の処理で消えていたら数えない
      if ((await messages.getKey(victim.id)) === undefined) continue;
      await messages.delete(victim.id);
      affectedUsers.add(victim.user);
      channelDelta.set(victim.channel, (channelDelta.get(victim.channel) ?? 0) + 1);
      deleted++;
    }
    if (affectedUsers.size > 0) await applyDeletions(tx, affectedUsers, channelDelta);
    const meta = tx.objectStore('meta');
    if (finished || !resume) await meta.delete(META_PRUNE_DUP_RESUME);
    else await meta.put({ key: META_PRUNE_DUP_RESUME, value: resume });
    await tx.done;
    if (finished) break;
    await yieldFn();
  }
  return deleted;
}

interface DupResume {
  key: [string, string, number];
  id: string;
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
