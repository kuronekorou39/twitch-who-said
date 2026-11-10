import { fireAndForget } from '../shared/messages';
import type { IngestItem } from '../shared/types';
import { extractLiveMessage } from './extract';
import { SELECTORS } from './selectors';

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

/**
 * チャットコンテナを監視し、メッセージ行を抽出してキューに積み、まとめて SW へ送る。
 * 1 行あたりの処理は DOM 読み取りとキュー追加のみ(N-1)。
 */
export class LiveCapture {
  private observer: MutationObserver | null = null;
  private queue: IngestItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly stats: CaptureStats = { seen: 0, extracted: 0, flushed: 0 };

  constructor(private readonly channel: string) {}

  start(container: Element): void {
    this.stop();
    this.observer = new MutationObserver((records) => this.onMutations(records));
    this.observer.observe(container, { childList: true, subtree: false });
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.flush();
  }

  private onMutations(records: MutationRecord[]): void {
    const sel = SELECTORS.live;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        // 行はラッパー div に包まれて追加される。ラッパー自身が行の場合も扱う
        const line = el.matches(sel.chatLine) ? el : el.querySelector(sel.chatLine);
        if (!line) continue;
        this.stats.seen++;
        const item = extractLiveMessage(line, { channel: this.channel }, sel);
        if (!item) continue;
        this.stats.extracted++;
        this.enqueue(item);
      }
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
