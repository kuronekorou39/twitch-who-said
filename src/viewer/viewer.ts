/**
 * 履歴ビューア(拡張ページ)。保存済みの全メッセージを、ユーザー・チャンネル・キーワードで絞って読む。
 * 拡張オリジンの IndexedDB を直接読む(設定画面のエクスポートと同じ。SW を経由しない)
 */

import {
  countMessages,
  getChannelCounts,
  getDb,
  getEmotes,
  getStats,
  getUserStats,
  listUsers,
  queryChanges,
  queryMessages,
} from '../db/db';
import { ChatFeed, createEmoteResolver } from '../shared/feed';
import { adjustNameColor, formatOffsetDisplay, formatTime, vodUrl } from '../shared/format';
import { renderText } from '../shared/render';
import type { ChatMessage } from '../shared/types';

/** 1 ページの取得件数 */
const PAGE_SIZE = 100;
/** サイドバーに出すユーザーの上限(発言の多い順) */
const SIDEBAR_USERS = 300;
/** 新着の問い合わせ間隔 */
const LIVE_POLL_MS = 3000;
const SEARCH_DEBOUNCE_MS = 250;
/** 最下部からこの距離以内なら「最新を見ている」とみなし、新着に追従する */
const STICK_BOTTOM_PX = 32;
/** DOM に置く行数の上限 */
const MAX_ROWS = 3000;
/** 新着があってもサイドバーを描き直す最短間隔 */
const SIDEBAR_REFRESH_MS = 10_000;
/** 絞り込みの切り替えがこれより速く終われば、読み込み表示を出さない(ちらつき防止) */
const LOADING_DELAY_MS = 200;
/** 読み込みがこれより長引いたら、時間がかかる旨と経過秒数を出す */
const LOADING_HINT_MS = 1500;
const LOADING_TICK_MS = 500;
const SKELETON_ROWS = 18;
const SKELETON_SIDE_ROWS = 12;

type Tab = 'users' | 'channels';

interface Filter {
  user: string | null;
  channel: string | null;
  keyword: string;
}

/** ビューアを起動する。戻り値は新着の問い合わせを止める関数(テスト用) */
export async function startViewer(doc: Document = document): Promise<() => void> {
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const els = {
    summary: $('summary'),
    tabs: [...doc.querySelectorAll<HTMLButtonElement>('.tabs [data-tab]')],
    sideSearch: $<HTMLInputElement>('side-search'),
    sideList: $('side-list'),
    chips: $('chips'),
    keyword: $<HTMLInputElement>('keyword'),
    list: $('list'),
    sentinel: doc.querySelector<HTMLElement>('#list .sentinel')!,
    status: doc.querySelector<HTMLElement>('#list .status')!,
    count: $('count'),
    jumpLatest: $<HTMLButtonElement>('jump-latest'),
    loading: $('loading'),
    loadingText: $('loading-text'),
    loadingPct: $('loading-pct'),
    loadingBar: $('loading-bar'),
    loadingFill: $('loading-fill'),
    loadingRows: $('loading-rows'),
  };
  const dark = !matchMedia('(prefers-color-scheme: light)').matches;

  const params = new URLSearchParams(location.search);
  const filter: Filter = {
    user: params.get('user')?.toLowerCase() || null,
    channel: params.get('channel')?.toLowerCase() || null,
    keyword: params.get('q') ?? '',
  };
  els.keyword.value = filter.keyword;
  let tab: Tab = filter.channel && !filter.user ? 'channels' : 'users';

  /** 表示中ユーザーの表示名(チップ用) */
  let userLabel: string | null = null;
  let sidebarAt = 0;

  function renderMessage(m: ChatMessage, emotes: Map<string, string>): HTMLElement {
    const row = doc.createElement('div');
    row.className = 'msg';
    const time = doc.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(m.ts, Date.now());
    time.title = new Date(m.ts).toLocaleString();
    const ch = doc.createElement('button');
    ch.type = 'button';
    ch.className = 'ch';
    ch.textContent = `#${m.channel}`;
    ch.title = `#${m.channel} で絞り込む`;
    ch.addEventListener('click', () => setFilter({ channel: m.channel }));
    const user = doc.createElement('button');
    user.type = 'button';
    user.className = 'user';
    user.textContent = m.displayName;
    user.title = `${m.user} で絞り込む`;
    const color = adjustNameColor(m.color, dark);
    if (color) user.style.color = color;
    user.addEventListener('click', () => setFilter({ user: m.user }));
    const text = doc.createElement('span');
    text.className = 'text';
    renderText(text, m.text, emotes, dark);
    row.append(time, ch, user, ': ', text);
    if (m.source === 'vod' && m.vodId) {
      const a = doc.createElement('a');
      a.className = 'vod';
      a.href = vodUrl(m.vodId, m.offsetSec);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = m.offsetSec !== undefined ? `▶ VOD ${formatOffsetDisplay(m.offsetSec)}` : '▶ VOD';
      row.append(a);
    }
    return row;
  }

  const scope = () => ({
    user: filter.user ?? undefined,
    channel: filter.channel ?? undefined,
    keyword: filter.keyword || undefined,
    limit: PAGE_SIZE,
  });
  const feed = new ChatFeed({
    list: els.list,
    status: els.status,
    page: async (before) => queryMessages(await getDb(), { ...scope(), before }),
    changes: async (afterSeq) => queryChanges(await getDb(), { ...scope(), afterSeq }),
    prepare: createEmoteResolver(async (names) => getEmotes(await getDb(), names)),
    render: renderMessage,
    emptyText: () => (filter.keyword ? '一致するメッセージはありません' : 'メッセージはまだありません'),
    stickPx: STICK_BOTTOM_PX,
    maxRows: MAX_ROWS,
    onChange: (kind) => {
      void updateCount();
      if (kind === 'page') return;
      void updateSummary();
      if (Date.now() - sidebarAt >= SIDEBAR_REFRESH_MS) void renderSidebar();
    },
    onScan: (scanned) => {
      if (scanTotal === null || scanTotal === 0) return;
      scanning = true;
      els.loadingText.textContent = '本文を検索しています…';
      setLoadingPct(Math.min(99, Math.floor((scanned / scanTotal) * 100)));
    },
  });

  // ---- 読み込み表示 ----

  let loadSeq = 0;
  /** キーワード検索の対象件数。わかるまでは % を出さない */
  let scanTotal: number | null = null;
  let scanning = false;
  let loadingShowTimer: ReturnType<typeof setTimeout> | undefined;
  let loadingTick: ReturnType<typeof setInterval> | undefined;

  /** 実際の進捗がわかるときだけ % を出す。null は進捗不明(流れるバー) */
  function setLoadingPct(pct: number | null): void {
    els.loadingBar.classList.toggle('indeterminate', pct === null);
    els.loadingPct.textContent = pct === null ? '' : `${pct}%`;
    els.loadingFill.style.width = pct === null ? '' : `${pct}%`;
  }

  function hideLoading(): void {
    clearTimeout(loadingShowTimer);
    clearInterval(loadingTick);
    els.loading.hidden = true;
  }

  function showLoading(delayMs: number): void {
    hideLoading();
    scanning = false;
    setLoadingPct(null);
    els.loadingText.textContent = '履歴を読み込んでいます…';
    const startedAt = Date.now();
    loadingTick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (scanning || elapsed < LOADING_HINT_MS) return;
      els.loadingText.textContent = `履歴が多いと時間がかかります(更新後の初回は特に)。経過 ${Math.floor(elapsed / 1000)} 秒`;
    }, LOADING_TICK_MS);
    if (delayMs === 0) els.loading.hidden = false;
    else loadingShowTimer = setTimeout(() => (els.loading.hidden = false), delayMs);
  }

  const skeleton = () => {
    const s = doc.createElement('span');
    s.className = 'sk';
    return s;
  };
  els.loadingRows.replaceChildren(...Array.from({ length: SKELETON_ROWS }, skeleton));
  els.sideList.replaceChildren(
    ...Array.from({ length: SKELETON_SIDE_ROWS }, () => {
      const li = doc.createElement('li');
      li.className = 'sk-row';
      li.setAttribute('aria-hidden', 'true');
      li.append(skeleton());
      return li;
    }),
  );
  els.summary.textContent = '集計中…';

  const load = async () => {
    const my = ++loadSeq;
    scanTotal = null;
    showLoading(my === 1 ? 0 : LOADING_DELAY_MS);
    if (filter.keyword) {
      void getDb()
        .then((db) => countMessages(db, { user: filter.user ?? undefined, channel: filter.channel ?? undefined }))
        .then((n) => {
          if (my === loadSeq) scanTotal = n;
        })
        .catch(() => {
          /* 件数が取れなければ % なしで続ける */
        });
    }
    try {
      await feed.reload();
    } finally {
      if (my === loadSeq) hideLoading();
    }
    await updateSummary();
  };

  /** フッタ: 表示中の件数と、絞り込みに対応する総件数(わかるときだけ) */
  async function updateCount(): Promise<void> {
    const total = filter.keyword
      ? null
      : await countMessages(await getDb(), { user: filter.user ?? undefined, channel: filter.channel ?? undefined });
    const shown = feed.size;
    const s = `表示中 ${shown.toLocaleString()} 件`;
    els.count.textContent = total !== null ? `${s} / ${total.toLocaleString()} 件` : feed.hasMore ? `${s}(さらに古いものがあります)` : s;
  }

  async function updateSummary(): Promise<void> {
    const st = await getStats(await getDb());
    const range =
      st.oldestTs && st.newestTs ? ` · ${new Date(st.oldestTs).toLocaleDateString()} 〜 ${new Date(st.newestTs).toLocaleDateString()}` : '';
    els.summary.textContent = `${st.messages.toLocaleString()} メッセージ · ${st.users.toLocaleString()} ユーザー · ${st.channels.toLocaleString()} チャンネル${range}`;
  }

  // ---- 絞り込み ----

  function syncUrl(): void {
    const p = new URLSearchParams();
    if (filter.user) p.set('user', filter.user);
    if (filter.channel) p.set('channel', filter.channel);
    if (filter.keyword) p.set('q', filter.keyword);
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  function renderChips(): void {
    els.chips.replaceChildren();
    const chip = (label: string, clear: Partial<Filter>) => {
      const c = doc.createElement('span');
      c.className = 'chip';
      c.append(label);
      const x = doc.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `${label} の絞り込みを解除`);
      x.addEventListener('click', () => setFilter(clear));
      c.append(x);
      els.chips.append(c);
    };
    if (filter.user)
      chip(userLabel && userLabel.toLowerCase() !== filter.user ? `${userLabel} (${filter.user})` : (userLabel ?? filter.user), {
        user: null,
      });
    if (filter.channel) chip(`#${filter.channel}`, { channel: null });
    if (!filter.user && !filter.channel) {
      const p = doc.createElement('span');
      p.className = 'chip placeholder';
      p.textContent = 'すべてのユーザー・チャンネル';
      els.chips.append(p);
    }
    els.list.classList.toggle('single-channel', !!filter.channel);
  }

  function setFilter(patch: Partial<Filter>): void {
    const changed = (Object.keys(patch) as (keyof Filter)[]).some((k) => patch[k] !== filter[k]);
    if (!changed) return;
    Object.assign(filter, patch);
    if ('user' in patch) userLabel = null;
    syncUrl();
    void refreshUserLabel();
    renderChips();
    void renderSidebar();
    void load();
  }

  async function refreshUserLabel(): Promise<void> {
    if (!filter.user) return;
    const user = filter.user;
    const st = await getUserStats(await getDb(), user);
    if (filter.user !== user) return;
    userLabel = st.count > 0 ? st.displayName : user;
    renderChips();
  }

  // ---- サイドバー ----

  let sideSeq = 0;
  async function renderSidebar(): Promise<void> {
    const my = ++sideSeq;
    sidebarAt = Date.now();
    const q = els.sideSearch.value.trim().toLowerCase();
    const rows: { key: string; label: string; sub?: string; n: number; active: boolean; onClick: () => void }[] = [];
    if (tab === 'users') {
      const users = await listUsers(await getDb(), { query: q, limit: SIDEBAR_USERS });
      for (const u of users) {
        rows.push({
          key: u.user,
          label: u.displayName,
          sub: u.displayName.toLowerCase() !== u.user ? u.user : undefined,
          n: u.count,
          active: filter.user === u.user,
          onClick: () => setFilter({ user: filter.user === u.user ? null : u.user }),
        });
      }
    } else {
      const counts = await getChannelCounts(await getDb());
      const chans = Object.entries(counts)
        .filter(([ch]) => !q || ch.includes(q))
        .sort((a, b) => b[1] - a[1]);
      for (const [ch, n] of chans) {
        rows.push({
          key: ch,
          label: `#${ch}`,
          n,
          active: filter.channel === ch,
          onClick: () => setFilter({ channel: filter.channel === ch ? null : ch }),
        });
      }
    }
    if (my !== sideSeq) return;
    const frag = doc.createDocumentFragment();
    for (const r of rows) {
      const li = doc.createElement('li');
      li.dataset.key = r.key;
      if (r.active) li.setAttribute('aria-current', 'true');
      const label = doc.createElement('span');
      label.className = 'label';
      label.textContent = r.label;
      if (r.sub) {
        const s = doc.createElement('span');
        s.className = 'login';
        s.textContent = r.sub;
        label.append(s);
      }
      const n = doc.createElement('span');
      n.className = 'n';
      n.textContent = r.n.toLocaleString();
      li.append(label, n);
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.addEventListener('click', r.onClick);
      li.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        r.onClick();
      });
      frag.append(li);
    }
    if (rows.length === 0) {
      const li = doc.createElement('li');
      li.className = 'empty';
      li.textContent = q ? '見つかりません' : 'まだありません';
      frag.append(li);
    }
    els.sideList.replaceChildren(frag);
  }

  function selectTab(next: Tab): void {
    tab = next;
    for (const b of els.tabs) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    els.sideSearch.placeholder = tab === 'users' ? 'ユーザーを検索…' : 'チャンネルを検索…';
    els.sideSearch.value = '';
    void renderSidebar();
  }

  // ---- イベント ----

  for (const b of els.tabs) b.addEventListener('click', () => selectTab(b.dataset.tab as Tab));
  let sideTimer: ReturnType<typeof setTimeout> | undefined;
  els.sideSearch.addEventListener('input', () => {
    clearTimeout(sideTimer);
    sideTimer = setTimeout(() => void renderSidebar(), SEARCH_DEBOUNCE_MS);
  });
  let kwTimer: ReturnType<typeof setTimeout> | undefined;
  els.keyword.addEventListener('input', () => {
    clearTimeout(kwTimer);
    kwTimer = setTimeout(() => setFilter({ keyword: els.keyword.value.trim() }), SEARCH_DEBOUNCE_MS);
  });
  doc.getElementById('open-options')?.addEventListener('click', () => void chrome.runtime.openOptionsPage());
  els.list.addEventListener('scroll', () => {
    els.jumpLatest.hidden = feed.atBottom;
  });
  els.jumpLatest.addEventListener('click', () => {
    els.list.scrollTop = els.list.scrollHeight;
  });
  new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) void feed.loadOlder();
    },
    { root: els.list },
  ).observe(els.sentinel);
  const pollTimer = setInterval(() => void feed.poll(), LIVE_POLL_MS);
  doc.addEventListener('visibilitychange', () => void feed.poll());

  for (const b of els.tabs) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  renderChips();
  void refreshUserLabel();
  void renderSidebar();
  await load();
  return () => {
    clearInterval(pollTimer);
    hideLoading();
  };
}
