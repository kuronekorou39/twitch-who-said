/** 保存するチャットメッセージ 1 件 */
export interface ChatMessage {
  /** 一意キー。Twitch の msg-id が取れればそれ、取れなければ内容ハッシュ(shared/id.ts) */
  id: string;
  /** login 名(小文字)。検索キー */
  user: string;
  /** 表示名(大文字小文字・日本語表示名を含む) */
  displayName: string;
  /** チャンネル login 名(小文字) */
  channel: string;
  /** 本文。エモートは `:name:` に正規化したプレーンテキスト */
  text: string;
  /** 発言日時 epoch ms。VOD は推定値 */
  ts: number;
  /** ts が分単位の概算(既存行の時刻表示から取ったとき)。近傍重複判定ではその 1 分間を同一視する */
  approxTs?: true;
  source: 'live' | 'vod';
  vodId?: string;
  offsetSec?: number;
  badges?: string[];
  /** ユーザー名色 (#rrggbb または rgb(...)) */
  color?: string;
  /** 取り込み日時 epoch ms。prune の基準 */
  capturedAt: number;
}

/** content script から SW へ送る取り込み前のメッセージ。id は SW 側で補完する */
export type IngestItem = Omit<ChatMessage, 'id'> & { id?: string };

/** users store の 1 レコード(集計キャッシュ) */
export interface UserRecord {
  user: string;
  displayName: string;
  count: number;
  lastTs: number;
  firstTs: number;
}

export interface Settings {
  /** 保持日数。0 = 無期限 */
  retentionDays: number;
  /** ユーザーあたり上限件数。0 = 無制限 */
  maxPerUser: number;
  /** 全体上限件数。0 = 無制限 */
  maxTotal: number;
  /** 除外する login 名(小文字) */
  excludeUsers: string[];
  /** 自分の発言を除外する */
  excludeSelf: boolean;
  /** 既知ボットのプリセットを除外に含める */
  knownBotsPreset: boolean;
  /** Mod View (/moderator/<channel>) でもポップオーバーを出す */
  showOnModView: boolean;
}

export interface DbStats {
  messages: number;
  users: number;
  channels: number;
  oldestTs: number | null;
  newestTs: number | null;
  /** 最後に 1 件でも取り込んだ日時 */
  lastIngestAt: number | null;
  /** 最後に prune を実行した日時 */
  lastPruneAt: number | null;
}

export interface UserStats {
  user: string;
  displayName: string;
  count: number;
  firstTs: number | null;
  lastTs: number | null;
}
