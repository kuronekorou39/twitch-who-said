import { isContextAlive, rpc } from '../shared/messages';
import type { IngestItem } from '../shared/types';
import type { ExtractedMessage } from './extract';

/** デバウンス時間(ms)。これを超えて新着がなければフラッシュ */
const FLUSH_DEBOUNCE_MS = 300;
/** この件数に達したら即フラッシュ */
const FLUSH_BATCH_SIZE = 50;
/** 送信待ちキューの上限。超えたら古い順に捨てる */
const QUEUE_CAP = 1000;
/** 送信に失敗したときの再送間隔(倍々に伸ばす) */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;

/** Twitch がログイン中に設定する `login` cookie から自分の login 名を読む(excludeSelf 用) */
export function readSelfLogin(cookie: string = document.cookie): string | undefined {
  const m = /(?:^|;\s*)login=([^;]+)/.exec(cookie);
  if (!m) return undefined;
  try {
    const v = decodeURIComponent(m[1]!).trim().toLowerCase();
    return /^[a-z0-9_]{1,25}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export interface CaptureStats {
  seen: number;
  extracted: number;
  flushed: number;
}

export interface CaptureOptions {
  /** メッセージ行のセレクタ。追加ノード自身か、その子孫に一致したものを行とみなす */
  lineSelector: string;
  /** 1 行 → メッセージ。existing は監視開始時に既に表示されていた行。失敗は null */
  extract: (line: Element, existing: boolean) => ExtractedMessage | null;
}

/**
 * チャットコンテナを監視し、メッセージ行を抽出してキューに積み、まとめて SW へ送る。
 * 1 行あたりの処理は DOM 読み取りとキュー追加のみ(N-1)。ライブ / VOD 共通。
 */
export class ChatCapture {
  private observer: MutationObserver | null = null;
  private queue: IngestItem[] = [];
  /** 次のフラッシュで送るエモート(このページでまだ送っていないものだけ) */
  private pendingEmotes: Record<string, string> = {};
  private readonly sentEmotes = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 応答待ちの送信数 */
  private inflight = 0;
  /** 0 以外なら再送待ち。次に失敗したときの待ち時間の元になる */
  private retryMs = 0;
  readonly stats: CaptureStats = { seen: 0, extracted: 0, flushed: 0 };

  constructor(private readonly opts: CaptureOptions) {}

  /** 監視開始。includeExisting なら既に表示されている行も 1 度だけ取り込む */
  start(container: Element, { includeExisting = true } = {}): void {
    this.stop();
    this.observer = new MutationObserver((records) => {
      for (const rec of records) this.handleAdded(rec.addedNodes, false);
    });
    this.observer.observe(container, { childList: true, subtree: false });
    if (includeExisting) this.handleAdded(container.children, true);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.flush(true);
  }

  private handleAdded(nodes: Iterable<Node>, existing: boolean): void {
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      // 行はラッパー要素に包まれて追加されることがある。ラッパー自身が行の場合も扱う
      const line = el.matches(this.opts.lineSelector) ? el : el.querySelector(this.opts.lineSelector);
      if (!line) continue;
      this.stats.seen++;
      const extracted = this.opts.extract(line, existing);
      if (!extracted) continue;
      this.stats.extracted++;
      const { emotes, ...item } = extracted;
      if (emotes) {
        for (const [name, url] of Object.entries(emotes)) {
          if (!this.sentEmotes.has(name)) this.pendingEmotes[name] = url;
        }
      }
      this.enqueue(item);
    }
  }

  private enqueue(item: IngestItem): void {
    this.queue.push(item);
    if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP);
    // 再送待ちの間は件数で急かさない(タイマーに任せる)
    if (this.queue.length >= FLUSH_BATCH_SIZE && this.retryMs === 0) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS);
    }
  }

  /**
   * キューを SW へ送る。失敗したら先頭に戻して間隔を空けて再送する(取り込みは冪等なので二重送信は無害)。
   * 通常は同時に 1 つだけ送り、force(ページ離脱・監視停止)のときは応答待ちでも送る
   */
  flush(force = false): void {
    if (this.inflight > 0 && !force) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    const sentEmotes = this.pendingEmotes;
    this.pendingEmotes = {};
    const emotes = Object.keys(sentEmotes).length ? sentEmotes : undefined;
    this.inflight++;
    // SW の処理が失敗すると応答は undefined になる
    void rpc({ type: 'ws:ingest', items, self: readSelfLogin(), emotes })
      .then(
        (res) => res !== undefined,
        () => false,
      )
      .then((ok) => {
        this.inflight--;
        if (ok) {
          this.stats.flushed += items.length;
          for (const name of Object.keys(sentEmotes)) this.sentEmotes.add(name);
          this.retryMs = 0;
          if (this.queue.length > 0) this.flush();
        } else if (isContextAlive()) {
          this.requeue(items, sentEmotes);
        }
      });
  }

  private requeue(items: IngestItem[], emotes: Record<string, string>): void {
    this.queue = [...items, ...this.queue].slice(-QUEUE_CAP);
    this.pendingEmotes = { ...emotes, ...this.pendingEmotes };
    this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : RETRY_MIN_MS, RETRY_MAX_MS);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.retryMs);
  }
}
