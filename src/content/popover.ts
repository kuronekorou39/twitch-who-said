import { rpc } from '../shared/messages';
import type { ChatMessage } from '../shared/types';
import { adjustNameColor, formatDate, formatOffsetDisplay, formatTime, vodUrl } from './format';
import css from './popover.css?inline';
import { SELECTORS } from './selectors';

/** 1 ページの取得件数 */
const PAGE_SIZE = 50;
/** 絞り込み入力のデバウンス */
const FILTER_DEBOUNCE_MS = 200;
/** 純正カードのレイヤーが見つからないときに出現をポーリングで待つ時間 */
const NATIVE_CARD_WAIT_MS = 800;
/** 純正カードとの間隔・画面端との余白 */
const GAP_PX = 8;
const EDGE_PX = 4;
const WIDTH_PX = 320;
const MAX_HEIGHT_PX = 480;

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

/** 直近に選んだスコープ(ページ内で保持) */
let lastScope: Scope = 'channel';

export class Popover {
  private readonly host: HTMLElement;
  private readonly els: {
    name: HTMLElement;
    count: HTMLElement;
    scope: HTMLSelectElement;
    filter: HTMLInputElement;
    list: HTMLElement;
    sentinel: HTMLElement;
    status: HTMLElement;
    footerLeft: HTMLElement;
    footerRight: HTMLElement;
  };
  private target: PopoverTarget | null = null;
  private scope: Scope = lastScope;
  private keyword = '';
  private before: number | undefined;
  private hasMore = false;
  private loading = false;
  private requestSeq = 0;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeObservers: MutationObserver[] = [];
  private dragObservers: MutationObserver[] = [];
  private nativeCard: Element | null = null;
  private nativeWaitUntil = 0;
  private nativeWaitRaf = 0;
  private readonly sentinelObserver: IntersectionObserver;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = 'ws-popover';
    this.host.hidden = true;
    const root = this.host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];

    root.innerHTML = `
      <div class="header">
        <span class="name"></span>
        <span class="count"></span>
        <select class="scope" aria-label="表示範囲"></select>
        <button class="close" type="button" aria-label="閉じる">×</button>
      </div>
      <div class="filter"><input type="search" placeholder="絞り込み…" aria-label="絞り込み" /></div>
      <div class="list" part="list">
        <div class="status"></div>
        <div class="sentinel"></div>
      </div>
      <div class="footer"><span class="footer-left"></span><span class="footer-right"></span></div>`;
    const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
    this.els = {
      name: q('.name'),
      count: q('.count'),
      scope: q<HTMLSelectElement>('.scope'),
      filter: q<HTMLInputElement>('.filter input'),
      list: q('.list'),
      sentinel: q('.sentinel'),
      status: q('.status'),
      footerLeft: q('.footer-left'),
      footerRight: q('.footer-right'),
    };

    q('.close').addEventListener('click', () => this.close());
    this.els.scope.addEventListener('change', () => {
      this.scope = this.els.scope.value as Scope;
      lastScope = this.scope;
      void this.load(true);
    });
    this.els.filter.addEventListener('input', () => {
      if (this.filterTimer) clearTimeout(this.filterTimer);
      this.filterTimer = setTimeout(() => {
        this.keyword = this.els.filter.value.trim();
        void this.load(true);
      }, FILTER_DEBOUNCE_MS);
    });
    // ポップオーバー内の操作が Twitch 側の「外側クリック」扱いにならないよう伝播を止める
    for (const type of ['mousedown', 'pointerdown', 'click', 'keydown', 'wheel'] as const) {
      this.host.addEventListener(type, (e) => e.stopPropagation());
    }
    this.sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && this.hasMore && !this.loading) void this.load(false);
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
        if (!this.isOpen || this.nativeCard) return; // 純正カード追従中はカードの消失で閉じる
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

    const dark = document.documentElement.classList.contains('tw-root--theme-dark');
    this.els.name.textContent = target.displayName;
    this.els.name.title = target.user;
    this.els.name.style.color = adjustNameColor(target.color, dark) ?? '';
    this.els.count.textContent = '';
    this.els.footerLeft.textContent = '';
    this.els.footerRight.textContent = '';

    this.els.scope.replaceChildren();
    if (target.channel) this.els.scope.append(makeOption(`#${target.channel}`, 'channel'));
    this.els.scope.append(makeOption('全チャンネル', 'all'));
    this.scope = target.channel ? lastScope : 'all';
    this.els.scope.value = this.scope;

    this.host.hidden = false;
    this.host.style.left = `${target.anchor.x}px`;
    this.host.style.top = `${target.anchor.y}px`;
    this.trackNativeCard();
    void this.load(true);
    void this.loadStats();
  }

  close(): void {
    if (!this.isOpen) return;
    this.host.hidden = true;
    this.target = null;
    this.requestSeq++;
    this.untrackNativeCard();
    this.els.list.querySelectorAll('.item').forEach((n) => n.remove());
  }

  // ---- データ取得 ----

  private async load(reset: boolean): Promise<void> {
    const target = this.target;
    if (!target) return;
    if (reset) {
      this.before = undefined;
      this.hasMore = false;
      this.els.list.querySelectorAll('.item').forEach((n) => n.remove());
      this.els.list.scrollTop = 0;
      this.setStatus('読み込み中…');
    }
    const seq = ++this.requestSeq;
    this.loading = true;
    try {
      const res = await rpc({
        type: 'ws:query',
        user: target.user,
        channel: this.scope === 'channel' && target.channel ? target.channel : undefined,
        keyword: this.keyword || undefined,
        before: this.before,
        limit: PAGE_SIZE,
      });
      if (seq !== this.requestSeq) return; // 古い応答
      this.appendItems(res.items);
      this.hasMore = res.hasMore;
      const last = res.items.at(-1);
      if (last) this.before = last.ts;
      const total = this.els.list.querySelectorAll('.item').length;
      this.setStatus(total === 0 ? (this.keyword ? '一致するメッセージはありません' : '保存されたメッセージはありません') : '');
    } catch {
      if (seq === this.requestSeq) this.setStatus('読み込みに失敗しました');
    } finally {
      if (seq === this.requestSeq) this.loading = false;
    }
  }

  private async loadStats(): Promise<void> {
    const target = this.target;
    if (!target) return;
    const seq = this.requestSeq;
    try {
      const st = await rpc({ type: 'ws:userStats', user: target.user });
      if (seq !== this.requestSeq || this.target !== target) return;
      this.els.count.textContent = `${st.count.toLocaleString()} 件`;
      this.els.footerLeft.textContent = `全 ${st.count.toLocaleString()} 件`;
      this.els.footerRight.textContent = st.firstTs ? `初回 ${formatDate(st.firstTs)}` : '';
    } catch {
      /* 統計は表示できなくても致命的ではない */
    }
  }

  private setStatus(text: string): void {
    this.els.status.textContent = text;
    this.els.status.hidden = !text;
  }

  private appendItems(items: ChatMessage[]): void {
    if (items.length === 0) return;
    const frag = document.createDocumentFragment();
    const now = Date.now();
    for (const m of items) frag.append(renderItem(m, now));
    this.els.list.insertBefore(frag, this.els.sentinel);
  }

  // ---- 純正カードへの追従 ----

  /**
   * 純正カードの出現・差し替え・消失を追う。
   * カードは常設のレイヤー内に非同期で挿入されるため、レイヤーを監視して遅れて出ても追従する。
   * レイヤー自体が見つからないときだけ短時間ポーリングし、だめならアンカー位置に出す。
   */
  private trackNativeCard(): void {
    this.untrackNativeCard();
    const sync = () => {
      if (!this.isOpen) return;
      const card = document.querySelector(SELECTORS.viewerCard.card);
      if (card) {
        if (card !== this.nativeCard) this.attachNativeCard(card);
      } else if (this.nativeCard) {
        this.close(); // カードが閉じられた
      }
    };
    const layer = document.querySelector(SELECTORS.viewerCard.layer);
    if (layer) {
      const mo = new MutationObserver(sync);
      mo.observe(layer, { childList: true, subtree: true });
      this.nativeObservers.push(mo);
    }
    this.nativeWaitUntil = performance.now() + NATIVE_CARD_WAIT_MS;
    const tick = () => {
      sync();
      if (!this.isOpen || this.nativeCard) return;
      if (performance.now() < this.nativeWaitUntil) this.nativeWaitRaf = requestAnimationFrame(tick);
      else this.reposition(); // カードなし: アンカー位置のまま画面内に収める
    };
    tick();
  }

  private attachNativeCard(card: Element): void {
    for (const mo of this.dragObservers) mo.disconnect();
    this.dragObservers = [];
    this.nativeCard = card;
    this.reposition();
    const draggable = card.closest(SELECTORS.viewerCard.draggable);
    if (draggable) {
      const mo = new MutationObserver(() => this.reposition());
      mo.observe(draggable, { attributes: true, attributeFilter: ['style'] });
      this.dragObservers.push(mo);
    }
  }

  private untrackNativeCard(): void {
    cancelAnimationFrame(this.nativeWaitRaf);
    for (const mo of [...this.nativeObservers, ...this.dragObservers]) mo.disconnect();
    this.nativeObservers = [];
    this.dragObservers = [];
    this.nativeCard = null;
  }

  private reposition(): void {
    if (!this.isOpen || !this.target) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.host.style.maxHeight = `${Math.min(MAX_HEIGHT_PX, vh - EDGE_PX * 2)}px`;
    let left: number;
    let top: number;
    const card = this.nativeCard?.isConnected ? this.nativeCard.getBoundingClientRect() : null;
    if (card && card.width > 0) {
      left = card.right + GAP_PX;
      if (left + WIDTH_PX > vw - EDGE_PX) left = card.left - GAP_PX - WIDTH_PX;
      top = card.top;
    } else {
      left = this.target.anchor.x + GAP_PX;
      if (left + WIDTH_PX > vw - EDGE_PX) left = this.target.anchor.x - GAP_PX - WIDTH_PX;
      top = this.target.anchor.y;
    }
    const h = this.host.offsetHeight || MAX_HEIGHT_PX;
    left = Math.max(EDGE_PX, Math.min(left, vw - WIDTH_PX - EDGE_PX));
    top = Math.max(EDGE_PX, Math.min(top, vh - h - EDGE_PX));
    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(top)}px`;
  }
}

function makeOption(label: string, value: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function renderItem(m: ChatMessage, now: number): HTMLElement {
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
  text.textContent = m.text;

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
