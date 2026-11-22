/** 吹き出しと履歴ビューアで共用する純粋な整形関数 */

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 日時を端末ローカルで短く表示する。
 * 同日なら時刻のみ、同年なら MM/DD HH:MM、それ以外は YYYY/MM/DD HH:MM
 */
export function formatTime(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  if (sameDay) return hm;
  const md = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  if (d.getFullYear() === n.getFullYear()) return `${md} ${hm}`;
  return `${d.getFullYear()}/${md} ${hm}`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** 秒 → 1h23m45s 形式(Twitch の ?t= パラメータ) */
export function formatOffset(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}h${m}m${r}s` : `${m}m${r}s`;
}

/** 秒 → 表示用 h:mm:ss */
export function formatOffsetDisplay(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(r)}` : `${m}:${pad2(r)}`;
}

export function vodUrl(vodId: string, offsetSec?: number): string {
  const base = `https://www.twitch.tv/videos/${encodeURIComponent(vodId)}`;
  return offsetSec === undefined ? base : `${base}?t=${formatOffset(offsetSec)}`;
}

export type Rgb = [number, number, number];

/** `#rgb` / `#rrggbb` / `rgb(r, g, b)` を解析。失敗したら null */
export function parseColor(input: string | undefined): Rgb | null {
  if (!input) return null;
  const s = input.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1]!;
    return [parseInt(h[0]! + h[0]!, 16), parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16)];
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const h = m[1]!;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/** 相対輝度(0..1)。WCAG の定義 */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 背景に対して読めない名前色を Twitch と同様に明度補正する */
export function adjustNameColor(color: string | undefined, darkTheme: boolean): string | undefined {
  const rgb = parseColor(color);
  if (!rgb) return undefined;
  let [r, g, b] = rgb;
  const lum = luminance(rgb);
  // ダークテーマで暗すぎる → 白へ寄せる。ライトテーマで明るすぎる → 黒へ寄せる
  const target = darkTheme ? 255 : 0;
  const bad = darkTheme ? lum < 0.12 : lum > 0.6;
  if (!bad) return `rgb(${r}, ${g}, ${b})`;
  const t = darkTheme ? 0.5 : 0.45;
  r = Math.round(r + (target - r) * t);
  g = Math.round(g + (target - g) * t);
  b = Math.round(b + (target - b) * t);
  return `rgb(${r}, ${g}, ${b})`;
}
