/** URL からページ種別とチャンネル/VOD を判定する(純粋関数) */

export type PageInfo =
  | { kind: 'live'; channel: string; modView: boolean }
  | { kind: 'vod'; vodId: string }
  | { kind: 'other' };

/** `/<channel>` として扱わない先頭セグメント */
const RESERVED_PATHS = new Set([
  'videos',
  'directory',
  'settings',
  'popout',
  'moderator',
  'u',
  'p',
  'search',
  'downloads',
  'jobs',
  'turbo',
  'subscriptions',
  'inventory',
  'wallet',
  'drops',
  'friends',
  'messages',
  'following',
  'prime',
  'store',
  'collections',
  'clip',
  'embed',
  'login',
  'signup',
  'logout',
  'user',
  'team',
  'event',
  'products',
  'bits',
  'creatorcamp',
  'broadcast',
  'dashboard',
  'legal',
  'privacy',
  'help',
]);

const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

export function detectPage(url: string | URL): PageInfo {
  const u = typeof url === 'string' ? new URL(url) : url;
  const seg = u.pathname.split('/').filter(Boolean);
  const first = seg[0]?.toLowerCase();
  if (!first) return { kind: 'other' };

  if (first === 'videos') {
    const id = seg[1];
    return id && /^\d+$/.test(id) ? { kind: 'vod', vodId: id } : { kind: 'other' };
  }
  if (first === 'popout' || first === 'embed') {
    // /popout/<channel>/chat(ポップアウト)と /embed/<channel>/chat(他サイトへの埋め込み)。
    // 埋め込みは iframe 内で動くため、manifest の all_frames で注入される
    const ch = seg[1]?.toLowerCase();
    return ch && seg[2] === 'chat' && LOGIN_RE.test(ch)
      ? { kind: 'live', channel: ch, modView: false }
      : { kind: 'other' };
  }
  if (first === 'moderator') {
    const ch = seg[1]?.toLowerCase();
    return ch && LOGIN_RE.test(ch) ? { kind: 'live', channel: ch, modView: true } : { kind: 'other' };
  }
  if (RESERVED_PATHS.has(first)) return { kind: 'other' };
  // /<channel> のみ対象。/<channel>/about や /<channel>/videos にはチャットが出ない
  if (seg.length === 1 && LOGIN_RE.test(first)) return { kind: 'live', channel: first, modView: false };
  return { kind: 'other' };
}

export function samePage(a: PageInfo, b: PageInfo): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'live' && b.kind === 'live') return a.channel === b.channel && a.modView === b.modView;
  if (a.kind === 'vod' && b.kind === 'vod') return a.vodId === b.vodId;
  return true;
}
