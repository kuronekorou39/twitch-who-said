import { getChannelCounts, getDb, getStats } from '../db/db';
import { detectPage } from '../shared/page';
import { viewerUrl } from '../shared/viewer-url';

const $ = (id: string) => document.getElementById(id)!;
const fmtNum = (n: number) => n.toLocaleString();

/** 履歴ビューアを新しいタブで開き、ポップアップを閉じる */
async function openViewer(params: { channel?: string } = {}): Promise<void> {
  await chrome.tabs.create({ url: viewerUrl(params) });
  window.close();
}

async function main(): Promise<void> {
  $('open-viewer').addEventListener('click', () => void openViewer());
  $('open-options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  });

  const db = await getDb();
  const [st, channels] = await Promise.all([getStats(db), getChannelCounts(db)]);
  $('st-messages').textContent = fmtNum(st.messages);
  $('st-users').textContent = fmtNum(st.users);
  $('st-channels').textContent = fmtNum(st.channels);
  $('last-ingest').textContent = st.lastIngestAt
    ? `最終取り込み ${new Date(st.lastIngestAt).toLocaleString()}`
    : 'まだメッセージを取り込んでいません';

  // いま開いているタブが Twitch のチャンネルなら、そのチャンネルの履歴への近道を出す。
  // twitch.tv は host_permissions にあるので tabs 権限なしで URL が読める
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const page = tab?.url && new URL(tab.url).hostname === 'www.twitch.tv' ? detectPage(tab.url) : null;
  if (page?.kind === 'live') {
    $('channel-name').textContent = page.channel;
    $('channel-count').textContent = fmtNum(channels[page.channel] ?? 0);
    const btn = $('open-channel');
    btn.hidden = false;
    btn.addEventListener('click', () => void openViewer({ channel: page.channel }));
  }
}

void main();
