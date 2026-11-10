import type { ChatMessage, DbStats, IngestItem, Settings, UserStats } from './types';

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
      before?: number;
      limit: number;
    }
  | { type: 'ws:userStats'; user: string }
  | { type: 'ws:getVodStart'; vodId: string }
  | { type: 'ws:setVodStart'; vodId: string; ts: number }
  | { type: 'ws:stats' }
  | { type: 'ws:prune' }
  | { type: 'ws:clear' }
  | { type: 'ws:getSettings' }
  | { type: 'ws:setSettings'; patch: Partial<Settings> };

/** リクエスト種別ごとの応答型 */
export interface ResMap {
  'ws:ingest': { accepted: number; skipped: number };
  'ws:query': { items: ChatMessage[]; hasMore: boolean };
  'ws:userStats': UserStats;
  'ws:emotes': Record<string, string>;
  'ws:getVodStart': { ts: number | null };
  'ws:setVodStart': { ok: true };
  'ws:stats': DbStats;
  'ws:prune': { deleted: number; byRetention: number; byPerUser: number; byTotal: number };
  'ws:clear': { ok: true };
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

/** 応答を待つ RPC(popover / options 用)。同期例外も reject に変換する */
export function rpc<T extends Req['type']>(req: ReqOf<T>): Promise<ResOf<T>> {
  try {
    return chrome.runtime.sendMessage(req) as Promise<ResOf<T>>;
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/** 応答を待たない送信(capture 用)。SW が停止していても sendMessage が起こす */
export function fireAndForget(req: Req): void {
  try {
    void chrome.runtime.sendMessage(req).catch(() => {
      /* SW 未起動・ポート切断などは無視。再送は呼び出し側のキューに任せる */
    });
  } catch {
    /* コンテキスト無効(拡張の再読み込み後)。このタブの content script はもう動けない */
  }
}
