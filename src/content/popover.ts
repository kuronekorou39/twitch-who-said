import { ChatFeed, createEmoteResolver } from '../shared/feed';
import { adjustNameColor, formatOffsetDisplay, formatTime, vodUrl } from '../shared/format';
import { isContextAlive, rpc } from '../shared/messages';
import { renderText } from '../shared/render';
import type { ChatMessage } from '../shared/types';
import { NativeCardTracker } from './native-card';
import css from './popover.css?inline';
import { loadPosition, loadSize, type Point, type Size, savePosition, saveSize } from './popover-storage';
import { SELECTORS } from './selectors';

/** 1 ページの取得件数 */
const PAGE_SIZE = 50;
/** 絞り込み入力のデバウンス */
const FILTER_DEBOUNCE_MS = 200;
/** 開いている間、新着を問い合わせる間隔 */
const LIVE_POLL_MS = 2000;
/** DOM に置く行数の上限 */
const MAX_ROWS = 1000;
/** 最下部からこの距離以内なら「最新を見ている」とみなし、新着が来たら最下部に追従する */
const STICK_BOTTOM_PX = 24;
/** 純正カードとの間隔・画面端との余白 */
const GAP_PX = 8;
const EDGE_PX = 4;
const WIDTH_PX = 280;
const MAX_HEIGHT_PX = 480;
/** 右下のつまみで変えられるサイズの下限 */
const MIN_WIDTH_PX = 220;
const MIN_HEIGHT_PX = 160;
/** つまみを矢印キーで動かしたときの変化量 */
const RESIZE_STEP_PX = 16;

export interface PopoverTarget {
  user: string;
  displayName: string;
  /** 現在のページのチャンネル。不明なら null(全チャンネル固定) */
  channel: string | null;
  color?: string;
  /** 純正カードが見つからなかったときの表示基準点 */
  anchor: { x: number; y: number };
}

export interface PopoverContext {
  channel: string | null;
  enabled: boolean;
}

type Scope = 'channel' | 'all';
/** スコープ選択肢で「全チャンネル」を表す値。チャンネル名は空にならないので衝突しない */
const SCOPE_ALL = '';

/** 直近に選んだスコープ(ページ内で保持)。他チャンネルを選んだ場合は覚えない */
let lastScope: Scope = 'channel';

export class Popover {
  private readonly host: HTMLElement;
  private readonly els: {
    header: HTMLElement;
    grip: HTMLElement;
    reset: HTMLButtonElement;
    name: HTMLElement;
    count: HTMLElement;
    scope: HTMLSelectElement;
    filterBox: HTMLElement;
    filter: HTMLInputElement;
    searchToggle: HTMLButtonElement;
    list: HTMLElement;
    sentinel: HTMLElement;
    status: HTMLElement;
  };
  private target: PopoverTarget | null = null;
  /** 表示中のチャンネル。null は全チャンネル */
  private scopeChannel: string | null = null;
  private keyword = '';
  private readonly feed: ChatFeed<Map<string, string>>;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  /** 件数の問い合わせの世代。スコープや絞り込みが変わったら古い応答を捨てる */
  private countSeq = 0;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly cardTracker = new NativeCardTracker(
    () => this.isOpen,
    () => this.reposition(),
  );
  private readonly sentinelObserver: IntersectionObserver;
  /** ユーザーがドラッグで決めた位置。設定されている間は純正カードに追従しない */
  private manualPos: Point | null = loadPosition();
  /** 右下のつまみで変えたサイズ。null は既定(幅固定・高さは中身なり) */
  private manualSize: Size | null = loadSize();

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'ws-popover';
    this.host.hidden = true;
    this.host.setAttribute('role', 'dialog');
    const root = this.host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];

    root.innerHTML = `
      <div class="header" title="ドラッグで移動">
        <span class="name"></span>
        <select class="scope" aria-label="表示範囲"></select>
        <button class="close" type="button" aria-label="閉じる">×</button>
      </div>
      <div class="list" part="list">
        <div class="sentinel"></div>
        <div class="status"></div>
      </div>
      <div class="filter" hidden><input type="search" placeholder="絞り込み…" aria-label="絞り込み" /></div>
      <div class="footer">
        <span class="count"></span>
        <button class="search-toggle" type="button" title="絞り込み" aria-label="絞り込み" aria-expanded="false">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>
        </button>
        <button class="open-viewer" type="button" title="履歴ビューアで開く" aria-label="履歴ビューアで開く">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3h4v4M13 3 7.5 8.5M12 9.5V13H3V4h3.5"/></svg>
        </button>
        <button class="reset" type="button" title="元の位置・サイズに戻す" aria-label="位置とサイズを戻す" hidden>↺</button>
      </div>
      <div class="grip" role="button" tabindex="0" title="ドラッグか矢印キーでサイズ変更(ダブルクリックで元のサイズ)" aria-label="サイズ変更(矢印キー)"></div>`;
    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    this.els = {
      header: q('.header'),
      grip: q('.grip'),
      reset: q<HTMLButtonElement>('.reset'),
      name: q('.name'),
      count: q('.count'),
      scope: q<HTMLSelectElement>('.scope'),
      filterBox: q('.filter'),
      filter: q<HTMLInputElement>('.filter input'),
      searchToggle: q<HTMLButtonElement>('.search-toggle'),
      list: q('.list'),
      sentinel: q('.sentinel'),
      status: q('.status'),
    };
    this.feed = new ChatFeed({
      list: this.els.list,
      status: this.els.status,
      page: (before) => rpc({ type: 'ws:query', ...this.queryScope(), before, limit: PAGE_SIZE }),
      changes: (afterSeq) => rpc({ type: 'ws:changes', ...this.queryScope(), afterSeq, limit: PAGE_SIZE }),
      prepare: createEmoteResolver((names) => rpc({ type: 'ws:emotes', names })),
      render: (m, emotes) => renderItem(m, Date.now(), emotes, isDarkTheme()),
      emptyText: () => (this.keyword ? '一致するメッセージはありません' : '保存されたメッセージはありません'),
      stickPx: STICK_BOTTOM_PX,
      maxRows: MAX_ROWS,
      onChange: (kind) => {
        void this.updateCount();
        if (kind === 'live') void this.loadStats();
      },
    });

    q('.close').addEventListener('click', () => this.close());
    this.els.searchToggle.addEventListener('click', () => this.setFilterVisible(this.els.filterBox.hasAttribute('hidden')));
    q('.open-viewer').addEventListener('click', () => {
      if (!this.target) return;
      void rpc({ type: 'ws:openViewer', user: this.target.user, channel: this.scopeChannel ?? undefined }).catch(() => {
        /* 拡張の再読み込み後などで SW に届かない */
      });
    });
    this.els.scope.addEventListener('change', () => {
      const value = this.els.scope.value;
      this.scopeChannel = value === SCOPE_ALL ? null : value;
      if (value === SCOPE_ALL) lastScope = 'all';
      else if (value === this.target?.channel) lastScope = 'channel';
      this.applyScopeClass();
      void this.reload();
    });
    this.els.filter.addEventListener('input', () => {
      if (this.filterTimer) clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.keyword = this.els.filter.value.trim();
        void this.reload();
      }, FILTER_DEBOUNCE_MS);
    });
    this.installDrag();
    this.installResize();
    // ポップオーバー内の操作が Twitch 側の「外側クリック」扱いにならないよう伝播を止める
    for (const type of ['mousedown', 'pointerdown', 'click', 'keydown', 'wheel'] as const) {
      this.host.addEventListener(type, (e) => e.stopPropagation());
    }
    this.sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void this.feed.loadOlder();
      },
      { root: this.els.list },
    );
    this.sentinelObserver.observe(this.els.sentinel);

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && this.isOpen) this.close();
      },
      true,
    );
    document.addEventListener(
      'mousedown',
      (e) => {
        // 純正カードと並べて出したときは、純正カードと同じく外側クリックでは閉じない(× か Esc で閉じる)
        if (!this.isOpen || this.cardTracker.hadCard) return;
        if (e.composedPath().includes(this.host)) return;
        this.close();
      },
      true,
    );
    window.addEventListener('resize', () => this.isOpen && this.reposition());
  }

  get isOpen(): boolean {
    return !this.host.hidden;
  }

  get element(): HTMLElement {
    return this.host;
  }

  open(target: PopoverTarget): void {
    if (!this.host.isConnected) document.body.append(this.host);
    this.target = target;
    this.keyword = '';
    this.els.filter.value = '';
    this.setFilterVisible(false);

    const dark = isDarkTheme();
    this.host.setAttribute('aria-label', `${target.displayName} の発言履歴`);
    this.els.name.textContent = target.displayName;
    this.els.name.title = target.user;
    this.els.name.style.color = adjustNameColor(target.color, dark) ?? '';
    this.els.count.textContent = '';

    this.els.scope.replaceChildren();
    // 他チャンネルの選択肢は統計の応答を待って loadStats が足す
    if (target.channel) this.els.scope.append(makeOption(`#${target.channel}`, target.channel));
    this.els.scope.append(makeOption('全チャンネル', SCOPE_ALL));
    this.scopeChannel = lastScope === 'channel' ? target.channel : null;
    this.els.scope.value = this.scopeChannel ?? SCOPE_ALL;
    this.applyScopeClass();

    this.host.hidden = false;
    // 位置が決まるまで描画しない。先に出すとアンカー位置に一瞬現れてから純正カードの隣へ飛ぶ
    this.host.style.visibility = 'hidden';
    this.host.style.left = `${target.anchor.x}px`;
    this.host.style.top = `${target.anchor.y}px`;
    this.cardTracker.start();
    if (this.manualPos) this.reposition();
    void this.reload();
    void this.loadStats();
    this.stopLive();
    this.liveTimer = setInterval(() => {
      // 拡張の再読み込み後は SW に届かないので止める
      if (isContextAlive()) void this.feed.poll();
      else this.stopLive();
    }, LIVE_POLL_MS);
  }

  close(): void {
    if (!this.isOpen) return;
    this.host.hidden = true;
    this.target = null;
    this.countSeq++;
    this.stopLive();
    this.cardTracker.stop();
    this.feed.clear();
  }

  /** 絞り込み欄(既定は非表示)を出し入れする。しまうときは絞り込みも解除する */
  private setFilterVisible(show: boolean): void {
    const list = this.els.list;
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= STICK_BOTTOM_PX;
    this.els.filterBox.hidden = !show;
    this.els.searchToggle.setAttribute('aria-expanded', String(show));
    if (show) {
      this.els.filter.focus();
    } else {
      if (this.filterTimer) clearTimeout(this.filterTimer);
      this.els.filter.value = '';
      if (this.keyword) {
        this.keyword = '';
        void this.reload();
      }
    }
    // 欄の出し入れで一覧の高さが変わっても、最新を見ていたなら最新のまま
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  private applyScopeClass(): void {
    this.els.list.classList.toggle('single-channel', this.scopeChannel !== null);
  }

  /**
   * そのユーザーの発言が保存されている、現在のページ以外のチャンネルを「全チャンネル」の手前に足す。
   * 新着のたびに呼ばれるので、既にある選択肢は足さない
   */
  private addOtherChannels(channels: string[]): void {
    const all = this.els.scope.lastElementChild;
    const known = new Set([...this.els.scope.options].map((o) => o.value));
    for (const ch of channels) {
      if (!known.has(ch)) this.els.scope.insertBefore(makeOption(`#${ch}`, ch), all);
    }
    this.els.scope.value = this.scopeChannel ?? SCOPE_ALL;
  }

  // ---- データ取得 ----

  private queryScope(): { user: string; channel?: string; keyword?: string } {
    return { user: this.target?.user ?? '', channel: this.scopeChannel ?? undefined, keyword: this.keyword || undefined };
  }

  private reload(): Promise<void> {
    if (!this.target) return Promise.resolve();
    this.countSeq++;
    this.els.count.textContent = '';
    return this.feed.reload();
  }

  private stopLive(): void {
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.liveTimer = null;
  }

  private async loadStats(): Promise<void> {
    const target = this.target;
    if (!target) return;
    try {
      const st = await rpc({ type: 'ws:userStats', user: target.user });
      if (this.target !== target) return; // 閉じた・別ユーザーで開き直した
      this.addOtherChannels(st.channels);
    } catch {
      /* 統計は表示できなくても致命的ではない */
    }
  }

  /** フッタの件数。いま選んでいるチャンネルの総数。絞り込み中は読み込んだ一致件数(続きがあれば +) */
  private async updateCount(): Promise<void> {
    const target = this.target;
    if (!target) return;
    if (this.keyword) {
      this.els.count.textContent = `${this.feed.size.toLocaleString()}${this.feed.hasMore ? '+' : ''} 件`;
      return;
    }
    const seq = ++this.countSeq;
    try {
      const n = await rpc({ type: 'ws:count', user: target.user, channel: this.scopeChannel ?? undefined });
      if (seq === this.countSeq) this.els.count.textContent = `${n.toLocaleString()} 件`;
    } catch {
      /* 件数は表示できなくても致命的ではない */
    }
  }

  // ---- ドラッグ移動 ----

  private installDrag(): void {
    const header = this.els.header;
    let start: Point | null = null;
    let origin: Point | null = null;
    header.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if ((e.target as Element).closest('select, button, input')) return;
      start = { x: e.clientX, y: e.clientY };
      // 位置は常に style.left/top で与えているので、レイアウトに依存せずそこから読む
      origin = { x: parseFloat(this.host.style.left) || 0, y: parseFloat(this.host.style.top) || 0 };
      header.classList.add('dragging');
      header.setPointerCapture?.(e.pointerId);
      // preventDefault すると後続の click / dblclick が発火しなくなるので呼ばない(文字選択は CSS で抑止)
    });
    header.addEventListener('pointermove', (e) => {
      if (!start || !origin) return;
      this.manualPos = this.clamp({ x: origin.x + e.clientX - start.x, y: origin.y + e.clientY - start.y });
      this.applyPosition(this.manualPos);
    });
    const end = () => {
      if (!start) return;
      start = origin = null;
      header.classList.remove('dragging');
      if (this.manualPos) savePosition(this.manualPos);
      this.updateResetButton();
    };
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
    // 自動配置(純正カードの隣)に戻す。ボタンは動かしたか、サイズを変えたときだけ出す
    const resetPosition = () => {
      this.manualPos = null;
      savePosition(null);
      this.updateResetButton();
      this.reposition();
    };
    this.els.reset.addEventListener('click', () => {
      this.setSize(null);
      resetPosition();
    });
    header.addEventListener('dblclick', (e) => {
      if ((e.target as Element).closest('select, button, input')) return;
      resetPosition();
    });
    this.updateResetButton();
  }

  /** 右下のつまみで幅・高さを変える。左上は動かさず、画面からはみ出さない範囲に収める */
  private installResize(): void {
    const grip = this.els.grip;
    let start: Point | null = null;
    let origin: Size | null = null;
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // 文字選択を始めない
      start = { x: e.clientX, y: e.clientY };
      origin = { w: this.host.offsetWidth || this.width, h: this.host.offsetHeight || this.defaultHeight };
      grip.setPointerCapture?.(e.pointerId);
    });
    grip.addEventListener('pointermove', (e) => {
      if (!start || !origin) return;
      this.manualSize = this.clampSize({ w: origin.w + e.clientX - start.x, h: origin.h + e.clientY - start.y });
      this.applySize();
    });
    const end = () => {
      if (!start) return;
      start = origin = null;
      saveSize(this.manualSize);
      this.updateResetButton();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', () => {
      this.setSize(null);
      this.reposition();
    });
    grip.addEventListener('keydown', (e) => {
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!delta) return;
      e.preventDefault();
      const w = (this.host.offsetWidth || this.width) + delta[0]! * RESIZE_STEP_PX;
      const h = (this.host.offsetHeight || this.defaultHeight) + delta[1]! * RESIZE_STEP_PX;
      this.setSize(this.clampSize({ w, h }));
    });
    this.applySize();
  }

  private setSize(size: Size | null): void {
    this.manualSize = size;
    saveSize(size);
    this.applySize();
    this.updateResetButton();
  }

  private clampSize(s: Size): Size {
    const left = parseFloat(this.host.style.left) || 0;
    const top = parseFloat(this.host.style.top) || 0;
    return {
      w: Math.round(Math.max(MIN_WIDTH_PX, Math.min(s.w, window.innerWidth - left - EDGE_PX))),
      h: Math.round(Math.max(MIN_HEIGHT_PX, Math.min(s.h, window.innerHeight - top - EDGE_PX))),
    };
  }

  /** サイズ未指定なら CSS の既定(幅 280px・高さは中身なりで上限あり)に任せる */
  private applySize(): void {
    const s = this.manualSize;
    this.host.style.width = s ? `${this.width}px` : '';
    this.host.style.height = s ? `${Math.min(s.h, window.innerHeight - EDGE_PX * 2)}px` : '';
    this.host.style.maxHeight = s ? 'none' : `${Math.min(MAX_HEIGHT_PX, window.innerHeight - EDGE_PX * 2)}px`;
  }

  private get width(): number {
    return this.manualSize ? Math.min(this.manualSize.w, window.innerWidth - EDGE_PX * 2) : WIDTH_PX;
  }

  private get defaultHeight(): number {
    return this.manualSize?.h ?? MAX_HEIGHT_PX;
  }

  private updateResetButton(): void {
    this.els.reset.hidden = !this.manualPos && !this.manualSize;
  }

  private reposition(): void {
    if (!this.isOpen || !this.target) return;
    const vh = window.innerHeight;
    this.applySize();
    const w = this.width;
    if (this.manualPos) {
      this.manualPos = this.clamp(this.manualPos);
      this.applyPosition(this.manualPos);
      return;
    }
    const vw = window.innerWidth;
    let left: number;
    let top: number;
    const native = this.cardTracker.card;
    const card = native?.isConnected ? native.getBoundingClientRect() : null;
    if (card && card.width > 0) {
      left = card.right + GAP_PX;
      top = card.top;
      if (left + w > vw - EDGE_PX) left = card.left - GAP_PX - w;
      if (left < EDGE_PX) {
        // 左右どちらにも入らない(他サイトに埋め込まれた幅の狭いチャットなど)。カードの下、無理なら上に置く
        const h = this.host.offsetHeight || this.defaultHeight;
        left = card.left;
        top = card.bottom + GAP_PX + h <= vh - EDGE_PX ? card.bottom + GAP_PX : card.top - GAP_PX - h;
      }
    } else if (this.cardTracker.hadCard) {
      // 純正カードが閉じられた後は、いまの位置に留まる
      left = parseFloat(this.host.style.left) || 0;
      top = parseFloat(this.host.style.top) || 0;
    } else {
      left = this.target.anchor.x + GAP_PX;
      if (left + w > vw - EDGE_PX) left = this.target.anchor.x - GAP_PX - w;
      top = this.target.anchor.y;
    }
    this.applyPosition(this.clamp({ x: left, y: top }));
  }

  private clamp(p: Point): Point {
    const h = this.host.offsetHeight || this.defaultHeight;
    return {
      x: Math.max(EDGE_PX, Math.min(p.x, window.innerWidth - this.width - EDGE_PX)),
      y: Math.max(EDGE_PX, Math.min(p.y, window.innerHeight - h - EDGE_PX)),
    };
  }

  private applyPosition(p: Point): void {
    this.host.style.visibility = '';
    this.host.style.left = `${Math.round(p.x)}px`;
    this.host.style.top = `${Math.round(p.y)}px`;
  }
}

function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('tw-root--theme-dark');
}

function makeOption(label: string, value: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function renderItem(m: ChatMessage, now: number, emotes: Map<string, string>, dark: boolean): HTMLElement {
  const item = document.createElement('div');
  item.className = 'item';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTime(m.ts, now);
  time.title = new Date(m.ts).toLocaleString();
  const channel = document.createElement('span');
  channel.className = 'channel';
  channel.textContent = `#${m.channel}`;
  meta.append(time, channel);
  if (m.source === 'vod' && m.vodId) {
    const a = document.createElement('a');
    a.href = vodUrl(m.vodId, m.offsetSec);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = m.offsetSec !== undefined ? `▶ VOD ${formatOffsetDisplay(m.offsetSec)}` : '▶ VOD';
    meta.append(a);
  }

  const text = document.createElement('div');
  text.className = 'text';
  renderText(text, m.text, emotes, dark);

  item.append(meta, text);
  return item;
}

/**
 * チャット内のユーザー名クリックをフックしてポップオーバーを開く。
 * Twitch 純正のビューワーカードは止めない(並べて表示する)。
 */
export function installPopover(getContext: () => PopoverContext): Popover {
  const popover = new Popover();
  document.addEventListener(
    'click',
    (e) => {
      if (!isContextAlive()) return; // 拡張の再読み込み後の孤児 content script では何もしない
      const ctx = getContext();
      if (!ctx.enabled) return;
      const path = e.composedPath();
      if (path.includes(popover.element)) return;
      const origin = path[0];
      if (!(origin instanceof Element)) return;
      const nameEl = origin.closest(SELECTORS.usernameClickTarget);
      if (!nameEl) return;
      const userHost = nameEl.closest('[data-a-user]');
      const user = userHost?.getAttribute('data-a-user')?.trim().toLowerCase();
      if (!user) return;
      const displayName = nameEl.textContent?.trim() || user;
      const color = (nameEl as HTMLElement).style?.color || undefined;
      popover.open({ user, displayName, channel: ctx.channel, color, anchor: { x: e.clientX, y: e.clientY } });
    },
    true,
  );
  return popover;
}
