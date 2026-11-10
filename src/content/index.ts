import { rpc } from '../shared/messages';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { Settings } from '../shared/types';
import { ChatCapture } from './capture';
import { extractLiveMessage, extractVodMessage } from './extract';
import { detectPage, samePage, type PageInfo } from './page';
import { installPopover } from './popover';
import { SELECTORS } from './selectors';
import { fetchSsrHtml, resolveVodChannel, resolveVodStart } from './vod';

const LOG_PREFIX = '[Who Said]';
/** チャットコンテナ出現待ちのポーリング間隔と上限 */
const CONTAINER_POLL_MS = 500;
const CONTAINER_WAIT_MAX_MS = 30_000;
/** SPA 遷移検知のポーリング間隔 */
const URL_POLL_MS = 1000;
/** 起動後この時間内に 1 件も取れなければ警告(セレクタ破損の自己診断) */
const SELF_CHECK_MS = 30_000;

let current: PageInfo = { kind: 'other' };
let capture: ChatCapture | null = null;
/** VOD ページで解決したチャンネル(ポップオーバーのスコープに使う) */
let vodChannel: string | null = null;
let setupToken = 0;
let warnedOnce = false;
let settings: Settings = DEFAULT_SETTINGS;

function teardown(): void {
  setupToken++;
  capture?.stop();
  capture = null;
  vodChannel = null;
}

function setup(page: PageInfo): void {
  teardown();
  current = page;
  if (page.kind === 'live') setupLive(page.channel);
  else if (page.kind === 'vod') void setupVod(page.vodId);
}

function setupLive(channel: string): void {
  const cap = new ChatCapture({
    lineSelector: SELECTORS.live.chatLine,
    extract: (line) => extractLiveMessage(line, { channel }),
  });
  capture = cap;
  const token = setupToken;
  void waitForContainer(SELECTORS.live.chatContainer, token).then((container) => {
    if (!container || token !== setupToken) return;
    cap.start(container);
    scheduleSelfCheck(cap);
  });
}

async function setupVod(vodId: string): Promise<void> {
  const token = setupToken;
  const cancelled = () => token !== setupToken;
  // SSR HTML は 1 回だけ取得して開始日時・チャンネル解決で共有する
  let ssrPromise: Promise<string | null> | null = null;
  const ssrHtml = () => (ssrPromise ??= fetchSsrHtml());

  const [channel, vodStart, container] = await Promise.all([
    resolveVodChannel(ssrHtml, cancelled),
    resolveVodStart(vodId, ssrHtml),
    waitForContainer(SELECTORS.vod.chatContainer, token),
  ]);
  if (cancelled()) return;
  if (!channel) {
    console.warn(`${LOG_PREFIX} VOD のチャンネルを判定できなかったため取り込みを行いません (${vodId})`);
    return;
  }
  if (vodStart === null) console.warn(`${LOG_PREFIX} VOD の配信開始日時が取れないため、日時は取り込み時刻になります (${vodId})`);
  vodChannel = channel;
  if (!container) return;

  const cap = new ChatCapture({
    lineSelector: SELECTORS.vod.chatLine,
    extract: (line) => extractVodMessage(line, { channel, vodId, vodStart }),
  });
  capture = cap;
  cap.start(container);
  scheduleSelfCheck(cap);
}

function scheduleSelfCheck(cap: ChatCapture): void {
  setTimeout(() => {
    if (capture === cap && cap.stats.seen === 0) warnNoMessages();
  }, SELF_CHECK_MS);
}

function waitForContainer(selector: string, token: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (token !== setupToken) return resolve(null);
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      if (Date.now() - started > CONTAINER_WAIT_MAX_MS) return resolve(null);
      setTimeout(tick, CONTAINER_POLL_MS);
    };
    tick();
  });
}

function warnNoMessages(): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(
    `${LOG_PREFIX} 30 秒間チャットメッセージを 1 件も取得できませんでした。Twitch の DOM が変わった可能性があります(src/content/selectors.ts)。`,
  );
}

function checkUrl(): void {
  const next = detectPage(location.href);
  if (!samePage(current, next)) setup(next);
}

function popoverContext() {
  if (current.kind === 'live') {
    return { channel: current.channel, enabled: !current.modView || settings.showOnModView };
  }
  if (current.kind === 'vod') return { channel: vodChannel, enabled: true };
  return { channel: null, enabled: false };
}

function main(): void {
  setup(detectPage(location.href));
  installPopover(popoverContext);
  void rpc({ type: 'ws:getSettings' }).then((s) => {
    if (s) settings = s;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue as Partial<Settings>) };
    }
  });
  // content script の isolated world からは history.pushState をフックできないため URL をポーリングする
  setInterval(checkUrl, URL_POLL_MS);
  window.addEventListener('popstate', checkUrl);
  window.addEventListener('pagehide', () => capture?.flush());
}

main();
