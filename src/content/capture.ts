import { fireAndForget } from '../shared/messages';
import type { IngestItem } from '../shared/types';

/** デバウンス時間(ms)。これを超えて新着がなければフラッシュ */
const FLUSH_DEBOUNCE_MS = 300;
/** この件数に達したら即フラッシュ */
const FLUSH_BATCH_SIZE = 50;
/** 送信待ちキューの上限。超えたら古い順に捨てる */
const QUEUE_CAP = 1000;

export interface CaptureStats {
  seen: number;
  extracted: number;
  flushed: number;
}

export interface CaptureOptions {
  /** メッセージ行のセレクタ。追加ノード自身か、その子孫に一致したものを行とみなす */
  lineSelector: string;
  /** 1 行 → IngestItem。失敗は null */
  extract: (line: Element) => IngestItem | null;
}

/**
 * チャットコンテナを監視し、メッセージ行を抽出してキューに積み、まとめて SW へ送る。
 * 1 行あたりの処理は DOM 読み取りとキュー追加のみ(N-1)。ライブ / VOD 共通。
 */
export class ChatCapture {
  private observer: MutationObserver | null = null;
  private queue: IngestItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly stats: CaptureStats = { seen: 0, extracted: 0, flushed: 0 };

  constructor(private readonly opts: CaptureOptions) {}

  /** 監視開始。includeExisting なら既に表示されている行も 1 度だけ取り込む */
  start(container: Element, { includeExisting = true } = {}): void {
    this.stop();
    this.observer = new MutationObserver((records) => {
      for (const rec of records) this.handleAdded(rec.addedNodes);
    });
    this.observer.observe(container, { childList: true, subtree: false });
    if (includeExisting) this.handleAdded(container.children);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.flush();
  }

  private handleAdded(nodes: Iterable<Node>): void {
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      // 行はラッパー要素に包まれて追加されることがある。ラッパー自身が行の場合も扱う
      const line = el.matches(this.opts.lineSelector) ? el : el.querySelector(this.opts.lineSelector);
      if (!line) continue;
      this.stats.seen++;
      const item = this.opts.extract(line);
      if (!item) continue;
      this.stats.extracted++;
      this.enqueue(item);
    }
  }

  private enqueue(item: IngestItem): void {
    this.queue.push(item);
    if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP);
    if (this.queue.length >= FLUSH_BATCH_SIZE) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), FLUSH_DEBOUNCE_MS);
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const items = this.queue;
    this.queue = [];
    this.stats.flushed += items.length;
    fireAndForget({ type: 'ws:ingest', items });
  }
}
