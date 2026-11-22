import type { ChangesResult, QueryResult } from '../db/db';
import type { DbStats, IngestItem, PageCursor, Settings, UserStats } from './types';

/** content / options → SW のリクエスト */
export type Req =
  | {
      type: 'ws:ingest';
      items: IngestItem[];
      /** ログイン中ユーザーの login(excludeSelf 用)。content script が cookie から読む */
      self?: string;
      /** このバッチで新しく見たエモート名 → 画像 URL */
      emotes?: Record<string, string>;
    }
  | { type: 'ws:emotes'; names: string[] }
  | {
      type: 'ws:query';
      user: string;
      channel?: string;
      keyword?: string;
      before?: PageCursor;
      limit: number;
    }
  /** 指定の連番より後に書き込まれた行(開いている一覧の新着) */
  | {
      type: 'ws:changes';
      user: string;
      channel?: string;
      keyword?: string;
      afterSeq: number;
      limit: number;
    }
  | { type: 'ws:count'; user: string; channel?: string }
  | { type: 'ws:userStats'; user: string }
  /** 履歴ビューアを新しいタブで開く(content script は tabs API を使えないので SW に頼む) */
  | { type: 'ws:openViewer'; user?: string; channel?: string }
  | { type: 'ws:getVodStart'; vodId: string }
  | { type: 'ws:setVodStart'; vodId: string; ts: number }
  | { type: 'ws:stats' }
  | { type: 'ws:prune' }
  | { type: 'ws:clear' }
  /** 指定ユーザーの保存済み発言を消す(除外に追加したとき) */
  | { type: 'ws:deleteUsers'; users: string[] }
  | { type: 'ws:getSettings' }
  | { type: 'ws:setSettings'; patch: Partial<Settings> };

/** リクエスト種別ごとの応答型 */
export interface ResMap {
  'ws:ingest': { accepted: number; skipped: number };
  'ws:query': QueryResult;
  'ws:changes': ChangesResult;
  'ws:count': number;
  'ws:userStats': UserStats;
  'ws:openViewer': { ok: true };
  'ws:emotes': Record<string, string>;
  'ws:getVodStart': { ts: number | null };
  'ws:setVodStart': { ok: true };
  'ws:stats': DbStats;
  'ws:prune': { deleted: number; byRetention: number; byPerUser: number; byTotal: number; byDuplicate: number };
  'ws:clear': { ok: true };
  'ws:deleteUsers': { deleted: number };
  'ws:getSettings': Settings;
  'ws:setSettings': Settings;
}

export type ReqOf<T extends Req['type']> = Extract<Req, { type: T }>;
export type ResOf<T extends Req['type']> = ResMap[T];

/**
 * 拡張のコンテキストが生きているか。拡張を再読み込み・更新すると、開いたままのタブの
 * content script は孤児になり、chrome.runtime.* が同期的に "Extension context invalidated" を投げる
 */
export function isContextAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

/** SW への RPC。SW が停止していても sendMessage が起こす。同期例外も reject に変換する */
export function rpc<T extends Req['type']>(req: ReqOf<T>): Promise<ResOf<T>> {
  try {
    return chrome.runtime.sendMessage(req) as Promise<ResOf<T>>;
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}
