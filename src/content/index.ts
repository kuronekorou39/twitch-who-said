import { saveDiag } from '../shared/diag';
import { isContextAlive, rpc } from '../shared/messages';
import { detectPage, type PageInfo, samePage } from '../shared/page';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { Settings } from '../shared/types';
import { ChatCapture } from './capture';
import { extractLiveMessage, extractVodMessage } from './extract';
import { installPopover, type Popover } from './popover';
import { SELECTORS } from './selectors';
import { fetchSsrHtml, resolveVodChannel, resolveVodStart } from './vod';

const LOG_PREFIX = '[Who Said]';
/** チャットコンテナ出現待ちのポーリング間隔と上限 */
const CONTAINER_POLL_MS = 500;
const CONTAINER_WAIT_MAX_MS = 30_000;
/** 監視中のコンテナが DOM から外れていないかを確認する間隔(チャットの再マウント対策) */
const CONTAINER_WATCHDOG_MS = 3000;
/** SPA 遷移検知のポーリング間隔(Navigation API が使えない場合の保険) */
const URL_POLL_MS = 1000;
/** 起動後この時間内に 1 件も取れなければ警告(セレクタ破損の自己診断) */
const SELF_CHECK_MS = 30_000;

let current: PageInfo = { kind: 'other' };
let capture: ChatCapture | null = null;
let container: Element | null = null;
let containerSelector: string | null = null;
/** VOD ページで解決したチャンネル(ポップオーバーのスコープに使う) */
let vodChannel: string | null = null;
let setupToken = 0;
let warnedOnce = false;
let settings: Settings = DEFAULT_SETTINGS;
let popover: Popover | null = null;
/**
 * 直前のページで監視していたコンテナ。SPA 遷移は URL 変更 → React の再描画の順なので、
 * 遷移直後は旧チャンネルの行が残った旧コンテナがまだ DOM にある。これを掴んで既存行を
 * 新チャンネル名で取り込まないよう、別の要素が現れるまで待つ
 */
let previousContainer: Element | null = null;

function teardown(): void {
  setupToken++;
  capture?.stop();
  capture = null;
  previousContainer = container;
  container = null;
  containerSelector = null;
  vodChannel = null;
  popover?.close();
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
    extract: (line, existing) => extractLiveMessage(line, { channel, existing }),
  });
  capture = cap;
  const token = setupToken;
  void waitForContainer(SELECTORS.live.chatContainer, token).then((found) => {
    if (!found || token !== setupToken) return;
    attach(cap, found, SELECTORS.live.chatContainer, `live:${channel}`);
  });
}

async function setupVod(vodId: string): Promise<void> {
  const token = setupToken;
  const cancelled = () => token !== setupToken;
  // SSR HTML は 1 回だけ取得して開始日時・チャンネル解決で共有する
  let ssrPromise: Promise<string | null> | null = null;
  const ssrHtml = () => (ssrPromise ??= fetchSsrHtml());

  const [channel, vodStart, found] = await Promise.all([
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
  if (!found) return;

  const cap = new ChatCapture({
    lineSelector: SELECTORS.vod.chatLine,
    extract: (line) => extractVodMessage(line, { channel, vodId, vodStart }),
  });
  capture = cap;
  attach(cap, found, SELECTORS.vod.chatContainer, `vod:${vodId}`);
}

function attach(cap: ChatCapture, found: FoundContainer, selector: string, pageLabel: string): void {
  container = found.el;
  containerSelector = selector;
  // 新しく現れたコンテナなら既存行も取り込む。旧コンテナを使い回している疑いがあれば新着のみ
  cap.start(found.el, { includeExisting: found.fresh });
  scheduleSelfCheck(cap, found.el, pageLabel);
}

interface FoundContainer {
  el: Element;
  /** 前のページで監視していた要素とは別物 */
  fresh: boolean;
}

/**
 * セレクタ破損の自己診断。コンテナに行らしきものがあるのに 1 件も抽出できなければ警告する。
 * 誰も発言していない静かなチャットでは警告しない。結果は設定画面のバッジ用に保存する
 */
function scheduleSelfCheck(cap: ChatCapture, el: Element, pageLabel: string): void {
  setTimeout(() => {
    if (capture !== cap) return;
    const { seen, extracted } = cap.stats;
    // システム行(「ようこそ」など)しか無い静かなチャットは疑わない
    const status = SELECTORS.live.statusLine;
    const rows = [...el.children].filter((c) => !c.matches(status) && !c.querySelector(status)).length;
    const suspicious = extracted === 0 && (seen > 0 || rows > 0);
    if (suspicious) warnNoMessages();
    void saveDiag({ at: Date.now(), page: pageLabel, seen, extracted, ok: !suspicious });
  }, SELF_CHECK_MS);
}

/**
 * チャットコンテナの出現を待つ。前のページのコンテナがまだ残っている間はそれを避け、
 * 上限時間まで待っても別の要素が現れなければ(Twitch が使い回した場合)旧要素を fresh=false で返す
 */
function waitForContainer(selector: string, token: number): Promise<FoundContainer | null> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (token !== setupToken) return resolve(null);
      const el = document.querySelector(selector);
      const timedOut = Date.now() - started > CONTAINER_WAIT_MAX_MS;
      if (el && el !== previousContainer) return resolve({ el, fresh: true });
      if (timedOut) return resolve(el ? { el, fresh: false } : null);
      setTimeout(tick, CONTAINER_POLL_MS);
    };
    tick();
  });
}

/**
 * Twitch がチャット欄を再マウントする(SPA 遷移直後に古いコンテナを掴んだ、チャット設定の変更、
 * Mod View 切替など)と MutationObserver は黙って止まる。コンテナが DOM から外れていたら張り直す
 */
function watchdog(): void {
  if (!ensureAlive()) return;
  if (!capture || !container || !containerSelector) return;
  if (container.isConnected) return;
  const cap = capture;
  const token = setupToken;
  const selector = containerSelector;
  previousContainer = container;
  container = null;
  void waitForContainer(selector, token).then((found) => {
    if (!found || token !== setupToken || capture !== cap) return;
    container = found.el;
    cap.start(found.el, { includeExisting: found.fresh }); // 重複は SW 側で弾かれる
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
  if (!ensureAlive()) return;
  const next = detectPage(location.href);
  if (!samePage(current, next)) setup(next);
}

let timers: ReturnType<typeof setInterval>[] = [];
let shutDown = false;

/**
 * 拡張が再読み込み・更新されると、このタブの content script は SW と通信できなくなる。
 * 例外を出し続けないよう、検知したら監視とタイマーを止めて静かに終了する(タブの再読み込みで復帰)
 */
function ensureAlive(): boolean {
  if (shutDown) return false;
  if (isContextAlive()) return true;
  shutDown = true;
  for (const t of timers) clearInterval(t);
  timers = [];
  setupToken++;
  capture?.stop();
  capture = null;
  popover?.close();
  return false;
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
  popover = installPopover(popoverContext);
  rpc({ type: 'ws:getSettings' })
    .then((s) => {
      if (s) settings = s;
    })
    .catch(() => {
      /* SW が応答しなければ既定値のまま */
    });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings?.newValue) {
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue as Partial<Settings>) };
    }
  });
  // SPA 遷移: content script の isolated world からは history.pushState をフックできない。
  // Navigation API があればそれで即時に、無ければ URL ポーリングで検知する
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigatesuccess', checkUrl);
  window.addEventListener('popstate', checkUrl);
  timers.push(setInterval(checkUrl, URL_POLL_MS), setInterval(watchdog, CONTAINER_WATCHDOG_MS));
  window.addEventListener('pagehide', () => capture?.flush(true));
}

main();
