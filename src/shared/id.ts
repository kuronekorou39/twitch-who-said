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

export function hashIdInput(channel: string, user: string, text: string, ts: number): string {
  return `${channel}\n${user}\n${text}\n${Math.round(ts / 1000)}`;
}

export async function messageHashId(
  channel: string,
  user: string,
  text: string,
  ts: number,
): Promise<string> {
  const data = new TextEncoder().encode(hashIdInput(channel, user, text, ts));
  const digest = await crypto.subtle.digest('SHA-1', data);
  return toHex(new Uint8Array(digest)).slice(0, HASH_ID_LENGTH);
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
