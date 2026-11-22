import { SELECTORS } from './selectors';

/** 純正カードのレイヤーが見つからないときに出現をポーリングで待つ時間 */
const NATIVE_CARD_WAIT_MS = 800;

/**
 * 純正カードの出現・差し替え・消失を追う。
 * カードは常設のレイヤー内に非同期で挿入されるため、レイヤーを監視して遅れて出ても追従する。
 * レイヤー自体が見つからないときだけ短時間ポーリングし、だめなら onChange でアンカー位置に任せる。
 *
 * カードが消えても吹き出しは閉じない。ユーザーが純正カードだけ閉じた場合はその場に残り、
 * 別ユーザーをクリックした場合は Twitch が旧カードを外してから新カードを入れるので、それを待って追従し直す
 */
export class NativeCardTracker {
  private layerObservers: MutationObserver[] = [];
  private dragObservers: MutationObserver[] = [];
  private current: Element | null = null;
  private had = false;
  private waitUntil = 0;
  private waitRaf = 0;

  constructor(
    private readonly isActive: () => boolean,
    private readonly onChange: () => void,
  ) {}

  /** いま追従しているカード */
  get card(): Element | null {
    return this.current;
  }

  /** 今回の追跡で一度でもカードに追従したか。した後はカードが消えてもその場に残る */
  get hadCard(): boolean {
    return this.had;
  }

  start(): void {
    this.stop();
    const sync = () => {
      if (!this.isActive()) return;
      const card = document.querySelector(SELECTORS.viewerCard.card);
      if (!card) {
        this.detach();
        return;
      }
      if (card === this.current) return;
      // カードを失った後に追い直すのは開いた直後の差し替えだけ。後から別の用件で出たカードには付いていかない
      if (this.had && !this.current && performance.now() >= this.waitUntil) return;
      this.attach(card);
    };
    const layer = document.querySelector(SELECTORS.viewerCard.layer);
    if (layer) {
      const mo = new MutationObserver(sync);
      mo.observe(layer, { childList: true, subtree: true });
      this.layerObservers.push(mo);
    }
    this.waitUntil = performance.now() + NATIVE_CARD_WAIT_MS;
    const tick = () => {
      sync();
      if (!this.isActive() || this.current) return;
      if (performance.now() < this.waitUntil) this.waitRaf = requestAnimationFrame(tick);
      else this.onChange(); // カードなし: アンカー位置のまま画面内に収める
    };
    tick();
  }

  stop(): void {
    cancelAnimationFrame(this.waitRaf);
    for (const mo of [...this.layerObservers, ...this.dragObservers]) mo.disconnect();
    this.layerObservers = [];
    this.dragObservers = [];
    this.current = null;
    this.had = false;
  }

  private detach(): void {
    for (const mo of this.dragObservers) mo.disconnect();
    this.dragObservers = [];
    this.current = null;
  }

  private attach(card: Element): void {
    this.detach();
    this.current = card;
    this.had = true;
    this.onChange();
    const draggable = card.closest(SELECTORS.viewerCard.draggable);
    if (draggable) {
      const mo = new MutationObserver(() => this.onChange());
      mo.observe(draggable, { attributes: true, attributeFilter: ['style'] });
      this.dragObservers.push(mo);
    }
  }
}
