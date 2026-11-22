import { isNearTs } from './id';
import { emoteNames } from './render';
import type { ChatMessage, PageCursor } from './types';

export interface FeedPage {
  items: ChatMessage[];
  hasMore: boolean;
  cursor: PageCursor | null;
  seq: number;
}

export interface FeedChanges {
  items: ChatMessage[];
  lastSeq: number;
  hasMore: boolean;
}

export interface FeedOptions<C> {
  /** スクロールする一覧。子要素は sentinel(先頭)→ 行 → status(末尾)の順 */
  list: HTMLElement;
  status: HTMLElement;
  page: (before: PageCursor | undefined) => Promise<FeedPage>;
  changes: (afterSeq: number) => Promise<FeedChanges>;
  /** 描画前の非同期準備(エモートの解決など) */
  prepare: (items: ChatMessage[]) => Promise<C>;
  render: (m: ChatMessage, ctx: C) => HTMLElement;
  emptyText: () => string;
  /** 最下部からこの距離以内なら「最新を見ている」とみなす */
  stickPx: number;
  /** DOM に置く行数の上限。最新を見ている間は超えた分を上から外す(遡れば読み直せる) */
  maxRows: number;
  /** 行が増減したとき */
  onChange?: (kind: 'page' | 'live') => void;
}

const compare = (a: PageCursor, b: PageCursor) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * チャット欄と同じ並び(上が古く下が最新)の一覧。吹き出しと履歴ビューアで共用する。
 * 古い側は (ts, id) カーソルでページ送りし、新着は書き込み連番で追うので、
 * 同時刻の行・一度に多数の新着・時刻が前後して届く行を取りこぼさない
 */
export class ChatFeed<C> {
  private rows: { msg: ChatMessage; el: HTMLElement }[] = [];
  private readonly ids = new Set<string>();
  private cursor: PageCursor | undefined;
  private seq: number | undefined;
  private more = false;
  private loading = false;
  private polling = false;
  /** reload / clear のたびに増やし、古い応答を捨てる */
  private token = 0;

  constructor(private readonly o: FeedOptions<C>) {}

  get size(): number {
    return this.rows.length;
  }

  get hasMore(): boolean {
    return this.more;
  }

  get atBottom(): boolean {
    const l = this.o.list;
    return l.scrollHeight - l.scrollTop - l.clientHeight <= this.o.stickPx;
  }

  clear(): void {
    this.token++;
    for (const r of this.rows) r.el.remove();
    this.rows = [];
    this.ids.clear();
    this.cursor = this.seq = undefined;
    this.more = this.loading = false;
  }

  /** 最新ページを読み直して最下部に合わせる */
  async reload(): Promise<void> {
    this.clear();
    this.setStatus('読み込み中…');
    await this.loadPage(true);
  }

  /** より古いページを上に足す */
  async loadOlder(): Promise<void> {
    if (this.more && !this.loading) await this.loadPage(false);
  }

  private async loadPage(initial: boolean): Promise<void> {
    const token = this.token;
    this.loading = true;
    try {
      for (;;) {
        const res = await this.o.page(this.cursor);
        if (token !== this.token) return;
        if (initial) this.seq ??= res.seq;
        const ctx = await this.o.prepare(res.items);
        if (token !== this.token) return;
        this.place(res.items, ctx, initial ? 'latest' : 'older');
        this.more = res.hasMore;
        if (res.cursor) this.cursor = res.cursor;
        // 走査上限で一致なしのまま止まったら続きを読む。絞り込みが変われば token で打ち切られる
        if (res.items.length > 0 || !res.hasMore) break;
      }
      this.setStatus(this.rows.length ? '' : this.o.emptyText());
      this.o.onChange?.('page');
    } catch (e) {
      if (token !== this.token) return;
      console.error('[Who Said] load failed', e);
      this.setStatus('読み込みに失敗しました');
    } finally {
      if (token === this.token) this.loading = false;
    }
  }

  /** 前回の確認以降に書き込まれた行を、時刻の位置に足す */
  async poll(): Promise<void> {
    if (this.loading || this.polling || this.seq === undefined || this.o.list.ownerDocument.hidden) return;
    const token = this.token;
    this.polling = true;
    let added = false;
    try {
      let hasMore: boolean;
      do {
        // 遡って読んでいる間は上限を超えて増やさない。最下部に戻れば続きから拾う
        if (this.rows.length >= this.o.maxRows && !this.atBottom) break;
        const res = await this.o.changes(this.seq!);
        if (token !== this.token) return;
        const fresh = res.items.filter((m) => !this.ids.has(m.id) && !this.isBeyondLoaded(m));
        if (fresh.length > 0) {
          const ctx = await this.o.prepare(fresh);
          if (token !== this.token) return;
          for (const m of fresh) this.dropReplaced(m);
          this.place(fresh, ctx, 'newer');
          added = true;
        }
        this.seq = res.lastSeq;
        hasMore = res.hasMore;
      } while (hasMore);
      if (added) {
        this.setStatus('');
        this.o.onChange?.('live');
      }
    } catch {
      /* 次回の問い合わせで拾う */
    } finally {
      this.polling = false;
    }
  }

  /** まだ読み込んでいない古い範囲の行。ここで足すと順序が飛ぶので、遡ったときのページに任せる */
  private isBeyondLoaded(m: ChatMessage): boolean {
    return this.more && !!this.cursor && compare(m, this.cursor) < 0;
  }

  /** DB 側で分単位の概算行が精密な時刻の行に置き換わったら、表示からも古いほうを外す */
  private dropReplaced(m: ChatMessage): void {
    if (m.approxTs) return;
    const i = this.rows.findIndex(
      ({ msg: r }) => r.approxTs && r.user === m.user && r.channel === m.channel && r.text === m.text && isNearTs(r, m),
    );
    if (i < 0) return;
    const [row] = this.rows.splice(i, 1);
    row!.el.remove();
    this.ids.delete(row!.msg.id);
  }

  private place(items: ChatMessage[], ctx: C, where: 'latest' | 'older' | 'newer'): void {
    if (items.length === 0) return;
    const list = this.o.list;
    const stick = where === 'latest' || (where === 'newer' && this.atBottom);
    const prevHeight = list.scrollHeight;
    const prevTop = list.scrollTop;
    for (const m of [...items].sort(compare)) {
      if (this.ids.has(m.id)) continue;
      this.ids.add(m.id);
      const el = this.o.render(m, ctx);
      const at = this.insertionIndex(m);
      list.insertBefore(el, this.rows[at]?.el ?? this.o.status);
      this.rows.splice(at, 0, { msg: m, el });
    }
    if (where === 'older') {
      list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
    } else if (stick) {
      this.trim();
      list.scrollTop = list.scrollHeight;
    }
  }

  private insertionIndex(m: ChatMessage): number {
    let lo = 0;
    let hi = this.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compare(this.rows[mid]!.msg, m) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private trim(): void {
    const excess = this.rows.length - this.o.maxRows;
    if (excess <= 0) return;
    for (const r of this.rows.splice(0, excess)) {
      r.el.remove();
      this.ids.delete(r.msg.id);
    }
    const { ts, id } = this.rows[0]!.msg;
    this.cursor = { ts, id };
    this.more = true;
  }

  private setStatus(text: string): void {
    this.o.status.textContent = text;
    this.o.status.hidden = !text;
  }
}

/** 本文の `:name:` を URL に解決する関数を作る。解決結果は覚え、失敗したものは次回また問い合わせる */
export function createEmoteResolver(
  fetchUrls: (names: string[]) => Promise<Record<string, string> | undefined>,
): (items: ChatMessage[]) => Promise<Map<string, string>> {
  const cache = new Map<string, string | null>();
  return async (items) => {
    const unknown = new Set<string>();
    for (const m of items) for (const n of emoteNames(m.text)) if (!cache.has(n)) unknown.add(n);
    if (unknown.size > 0) {
      try {
        const found = (await fetchUrls([...unknown])) ?? {};
        for (const n of unknown) cache.set(n, found[n] ?? null);
      } catch {
        /* 取れなければテキストのまま表示 */
      }
    }
    const out = new Map<string, string>();
    for (const [n, url] of cache) if (url) out.set(n, url);
    return out;
  };
}
