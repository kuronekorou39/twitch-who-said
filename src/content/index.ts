import { LiveCapture } from './capture';
import { detectPage, samePage, type PageInfo } from './page';
import { SELECTORS } from './selectors';

const LOG_PREFIX = '[Who Said]';
/** チャットコンテナ出現待ちのポーリング間隔と上限 */
const CONTAINER_POLL_MS = 500;
const CONTAINER_WAIT_MAX_MS = 30_000;
/** SPA 遷移検知のポーリング間隔 */
const URL_POLL_MS = 1000;
/** 起動後この時間内に 1 件も取れなければ警告(セレクタ破損の自己診断) */
const SELF_CHECK_MS = 30_000;

let current: PageInfo = { kind: 'other' };
let capture: LiveCapture | null = null;
let containerWaitToken = 0;
let warnedOnce = false;

function teardown(): void {
  containerWaitToken++;
  capture?.stop();
  capture = null;
}

function setup(page: PageInfo): void {
  teardown();
  current = page;
  if (page.kind !== 'live') return; // VOD は M3 で対応

  const cap = new LiveCapture(page.channel);
  capture = cap;
  const token = ++containerWaitToken;
  void waitForContainer(SELECTORS.live.chatContainer, token).then((container) => {
    if (!container || token !== containerWaitToken) return;
    cap.start(container);
    setTimeout(() => {
      if (capture === cap && cap.stats.seen === 0) warnNoMessages();
    }, SELF_CHECK_MS);
  });
}

function waitForContainer(selector: string, token: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (token !== containerWaitToken) return resolve(null);
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

function main(): void {
  setup(detectPage(location.href));
  // content script の isolated world からは history.pushState をフックできないため URL をポーリングする
  setInterval(checkUrl, URL_POLL_MS);
  window.addEventListener('popstate', checkUrl);
  window.addEventListener('pagehide', () => capture?.flush());
}

main();
