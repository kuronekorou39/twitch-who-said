/**
 * メッセージの一意キー生成。
 * Twitch が DOM に msg-id を出していないケース(現行のライブチャット・VOD リプレイ)では
 * 内容ハッシュで代替する。同一 VOD を見返しても同じキーになる。
 */

/** ハッシュ ID の長さ(16 進) */
const HASH_ID_LENGTH = 20;

/**
 * ライブと VOD で同じ発言が別 ID になったときの近傍重複判定ウィンドウ(ms)。
 * VOD の ts は「配信開始日時(uploadDate) + 再生位置」の推定値で、ライブ取り込み時刻とは
 * 数秒ずれる(実測で開始日時だけでも 5 秒前後)。同一 user/channel/text が 10 秒以内に
 * 2 回あるケースは稀なので、取りこぼしより広めに取る。
 */
export const NEAR_DUP_WINDOW_MS = 10_000;

/** approxTs の ts が指す幅(時刻表示は分単位) */
export const APPROX_TS_SPAN_MS = 60_000;

export interface TsLike {
  ts: number;
  approxTs?: true;
}

/**
 * 2 件の時刻が「同じ発言の二重取り込み」とみなせる関係か。
 * 精密な ts 同士は ±NEAR_DUP_WINDOW_MS。分単位の概算(approxTs)は、その 1 分間に相手の ts が
 * 入っていれば同一(両端にウィンドウ分の余裕を持たせる)。複数タブで同じ配信を開いたときや、
 * 再読み込みで既存行(分単位)と新着行(ミリ秒)が別々に取り込まれたときの重複を吸収する
 */
export function isNearTs(a: TsLike, b: TsLike): boolean {
  if (a.approxTs && !b.approxTs) {
    return b.ts >= a.ts - NEAR_DUP_WINDOW_MS && b.ts < a.ts + APPROX_TS_SPAN_MS + NEAR_DUP_WINDOW_MS;
  }
  if (b.approxTs && !a.approxTs) return isNearTs(b, a);
  return Math.abs(a.ts - b.ts) <= NEAR_DUP_WINDOW_MS;
}

/** isNearTs の相手になり得る ts の範囲 [min, max](インデックス検索用) */
export function nearTsRange(m: TsLike): [number, number] {
  return m.approxTs
    ? [m.ts - NEAR_DUP_WINDOW_MS, m.ts + APPROX_TS_SPAN_MS + NEAR_DUP_WINDOW_MS]
    : [m.ts - APPROX_TS_SPAN_MS - NEAR_DUP_WINDOW_MS, m.ts + NEAR_DUP_WINDOW_MS];
}

export function hashIdInput(channel: string, user: string, text: string, ts: number): string {
  return `${channel}\n${user}\n${text}\n${Math.round(ts / 1000)}`;
}

export async function messageHashId(channel: string, user: string, text: string, ts: number): Promise<string> {
  const data = new TextEncoder().encode(hashIdInput(channel, user, text, ts));
  const digest = await crypto.subtle.digest('SHA-1', data);
  return toHex(new Uint8Array(digest)).slice(0, HASH_ID_LENGTH);
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
