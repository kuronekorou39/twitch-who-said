/** ポップオーバーと履歴ビューアで共通の、本文の描画 */

/** 本文中の `:name:` を見つける。name は空白とコロンを含まない */
const EMOTE_TOKEN_RE = /:([^\s:]+):/g;

/** 本文中の `:name:` の name を列挙する */
export function emoteNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(EMOTE_TOKEN_RE)) out.push(m[1]!);
  return out;
}

/**
 * Twitch のエモート URL はテーマ別(/default/dark/1.0 など)。保存時のテーマに関わらず
 * 表示時のテーマに合わせる
 */
export function themedEmoteUrl(url: string, dark: boolean): string {
  return url.replace(/\/(dark|light)\//, dark ? '/dark/' : '/light/');
}

/** 本文を、既知のエモートは画像、それ以外はテキストとして要素に流し込む */
export function renderText(el: HTMLElement, text: string, emotes: Map<string, string>, dark: boolean): void {
  if (emotes.size === 0 || !text.includes(':')) {
    el.textContent = text;
    return;
  }
  let last = 0;
  for (const m of text.matchAll(EMOTE_TOKEN_RE)) {
    const name = m[1]!;
    const url = emotes.get(name);
    if (!url) continue;
    const start = m.index;
    if (start > last) el.append(text.slice(last, start));
    const img = document.createElement('img');
    img.className = 'emote';
    img.src = themedEmoteUrl(url, dark);
    img.alt = name;
    img.title = name;
    img.loading = 'lazy';
    el.append(img);
    last = start + m[0].length;
  }
  if (last < text.length) el.append(text.slice(last));
}
