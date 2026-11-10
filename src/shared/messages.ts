import type { ChatMessage, DbStats, IngestItem, Settings, UserStats } from './types';

/** content / options → SW のリクエスト */
export type Req =
  | {
      type: 'ws:ingest';
      items: IngestItem[];
      /** ログイン中ユーザーの login(excludeSelf 用)。content script が cookie から読む */
      self?: string;
    }
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

/** 応答を待つ RPC(popover / options 用) */
export function rpc<T extends Req['type']>(req: ReqOf<T>): Promise<ResOf<T>> {
  return chrome.runtime.sendMessage(req) as Promise<ResOf<T>>;
}

/** 応答を待たない送信(capture 用)。SW が停止していても sendMessage が起こす */
export function fireAndForget(req: Req): void {
  void chrome.runtime.sendMessage(req).catch(() => {
    /* SW 未起動・ポート切断などは無視。再送は呼び出し側のキューに任せる */
  });
}
