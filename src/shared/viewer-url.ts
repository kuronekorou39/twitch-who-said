/** 履歴ビューアの URL。params は絞り込みの初期値(空の値は付けない) */
export function viewerUrl(params: { user?: string; channel?: string } = {}): string {
  const p = new URLSearchParams();
  if (params.user) p.set('user', params.user);
  if (params.channel) p.set('channel', params.channel);
  const qs = p.toString();
  return chrome.runtime.getURL('src/viewer/viewer.html') + (qs ? `?${qs}` : '');
}
