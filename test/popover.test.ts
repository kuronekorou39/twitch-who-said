// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../src/shared/types';

// Vite の `?inline` CSS import をテストでは空文字に差し替える
vi.mock('../src/content/popover.css?inline', () => ({ default: '' }));

const T0 = Date.now();
function msg(i: number, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `id${i}`,
    user: 'alice',
    displayName: 'Alice',
    channel: 'ch1',
    text: `message ${i}`,
    ts: T0 - i * 60_000,
    source: 'live',
    capturedAt: T0,
    ...over,
  };
}

const sendMessage = vi.fn();
/** 開いた後に保存された新着(書き込み順)。添字 + 1 が連番 */
let arrived: ChatMessage[] = [];

type QueryReq = {
  type: string;
  limit?: number;
  keyword?: string;
  channel?: string;
  before?: { ts: number; id: string };
  afterSeq?: number;
};

beforeEach(() => {
  localStorage.clear(); // 位置・サイズの記憶を持ち越さない
  arrived = [];
  sendMessage.mockReset();
  sendMessage.mockImplementation(async (req: QueryReq) => {
    if (req.type === 'ws:query') {
      let items = Array.from({ length: 60 }, (_, i) => msg(i, { channel: i % 3 ? 'ch1' : 'ch2' }));
      if (req.channel) items = items.filter((m) => m.channel === req.channel);
      if (req.keyword) items = items.filter((m) => m.text.includes(req.keyword!));
      if (req.before) items = items.filter((m) => m.ts < req.before!.ts);
      const page = items.slice(0, req.limit);
      const last = page.at(-1);
      return { items: page, hasMore: items.length > (req.limit ?? 50), cursor: last ? { ts: last.ts, id: last.id } : null, seq: 0 };
    }
    if (req.type === 'ws:changes') {
      const items = arrived.slice(req.afterSeq);
      return { items, lastSeq: arrived.length, hasMore: false };
    }
    if (req.type === 'ws:count') return req.channel ? 60 - Math.ceil(60 / 3) : 60;
    if (req.type === 'ws:userStats')
      return { user: 'alice', displayName: 'Alice', count: 60, firstTs: T0 - 86_400_000, lastTs: T0, channels: ['ch1', 'ch2'] };
    return undefined;
  });
  vi.stubGlobal('chrome', { runtime: { id: 'test-extension', sendMessage } });
  // happy-dom に無い API を補う
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  if (!('adoptedStyleSheets' in Document.prototype)) {
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', { value: [], writable: true });
  }
  if (typeof CSSStyleSheet === 'undefined') {
    vi.stubGlobal(
      'CSSStyleSheet',
      class {
        replaceSync() {}
      },
    );
  }
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('Popover', () => {
  it('open で該当ユーザーのメッセージをチャット欄と同じ並び(下が最新)で描画し、統計を出す', async () => {
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: 'ch1', color: 'rgb(220, 0, 0)', anchor: { x: 10, y: 10 } });
    await flush();

    const root = p.element.shadowRoot!;
    expect(p.isOpen).toBe(true);
    expect(root.querySelector('.name')!.textContent).toBe('Alice');
    const items = [...root.querySelectorAll('.item .text')].map((e) => e.textContent);
    expect(items.length).toBe(40); // ch1 のみ(i % 3 !== 0)の 40 件
    expect(items[0]).toBe('message 59');
    expect(items.at(-1)).toBe('message 1');
    // 件数はフッタにだけ出す
    expect(root.querySelector('.footer .count')!.textContent).toBe('40 件'); // 選択中チャンネルの件数
    expect(root.querySelector('.header .count')).toBeNull();
    // 初回クエリは「このチャンネル」スコープ
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'ws:query', user: 'alice', channel: 'ch1', limit: 50 }));
  });

  it('スコープを全チャンネルに切り替えると channel なしで再クエリする', async () => {
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: 'ch1', anchor: { x: 0, y: 0 } });
    await flush();
    const root = p.element.shadowRoot!;
    const select = root.querySelector<HTMLSelectElement>('.scope')!;
    select.value = '';
    select.dispatchEvent(new Event('change'));
    await flush();
    const last = sendMessage.mock.calls.filter((c) => c[0].type === 'ws:query').at(-1)![0];
    expect(last.channel).toBeUndefined();
    const texts = [...root.querySelectorAll('.item .text')].map((e) => e.textContent);
    expect(texts.length).toBe(50);
    expect(texts[0]).toBe('message 49');
    expect(texts.at(-1)).toBe('message 0');
  });

  it('開いている間に保存された新着は最下部に足され、件数も更新される', async () => {
    vi.useFakeTimers();
    try {
      const { Popover } = await import('../src/content/popover');
      const p = new Popover();
      p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
      await vi.advanceTimersByTimeAsync(10);
      const root = p.element.shadowRoot!;
      expect(root.querySelectorAll('.item').length).toBe(50);

      // 新着なしの問い合わせでは何も変わらない
      await vi.advanceTimersByTimeAsync(2100);
      expect(root.querySelectorAll('.item').length).toBe(50);

      arrived = [msg(-1, { text: 'newer' }), msg(-2, { text: 'newest' })];
      await vi.advanceTimersByTimeAsync(2100);
      const texts = [...root.querySelectorAll('.item .text')].map((e) => e.textContent);
      expect(texts.slice(-3)).toEqual(['message 0', 'newer', 'newest']);
      const changes = sendMessage.mock.calls.filter((c) => c[0].type === 'ws:changes').map((c) => c[0]);
      expect(changes.at(-1).afterSeq).toBe(0);
      // 同じ新着を二重に足さない
      await vi.advanceTimersByTimeAsync(2100);
      expect(root.querySelectorAll('.item').length).toBe(52);
      // 統計とチャンネルの選択肢は取り直すが、選択肢は重複させない
      expect(sendMessage.mock.calls.filter((c) => c[0].type === 'ws:userStats').length).toBe(2);
      expect([...root.querySelectorAll('.scope option')].map((o) => o.textContent)).toEqual(['#ch1', '#ch2', '全チャンネル']);

      // 閉じたら問い合わせを止める
      p.close();
      const before = sendMessage.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(sendMessage.mock.calls.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('上端までスクロールすると、より古いページを上に足す', async () => {
    let onIntersect: (entries: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: typeof onIntersect) {
          onIntersect = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
    await flush();
    onIntersect([{ isIntersecting: true }]);
    await flush();
    const texts = [...p.element.shadowRoot!.querySelectorAll('.item .text')].map((e) => e.textContent);
    expect(texts.length).toBe(60);
    expect(texts[0]).toBe('message 59');
    expect(texts[9]).toBe('message 50');
    expect(texts[10]).toBe('message 49');
    expect(texts.at(-1)).toBe('message 0');
  });

  it('そのユーザーの発言がある他チャンネルも選べ、選ぶとそのチャンネルで再クエリする', async () => {
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: 'ch1', anchor: { x: 0, y: 0 } });
    await flush();
    const root = p.element.shadowRoot!;
    const select = root.querySelector<HTMLSelectElement>('.scope')!;
    // 現在のチャンネル → 他チャンネル → 全チャンネル の順。現在のチャンネルは重複させない
    expect([...select.options].map((o) => o.textContent)).toEqual(['#ch1', '#ch2', '全チャンネル']);
    // 直前のスコープを引き継ぐので、まず現在のチャンネルを明示的に選ぶ
    select.value = 'ch1';
    select.dispatchEvent(new Event('change'));
    select.value = 'ch2';
    select.dispatchEvent(new Event('change'));
    await flush();
    const last = sendMessage.mock.calls.filter((c) => c[0].type === 'ws:query').at(-1)![0];
    expect(last.channel).toBe('ch2');
    expect(root.querySelectorAll('.item').length).toBe(20);
    expect(root.querySelector('.list')!.classList.contains('single-channel')).toBe(true);

    // 他チャンネルの選択は覚えない。開き直すと現在のチャンネルに戻る
    p.close();
    p.open({ user: 'alice', displayName: 'Alice', channel: 'ch1', anchor: { x: 0, y: 0 } });
    await flush();
    expect(select.value).toBe('ch1');
  });

  it('絞り込み入力でデバウンス後に keyword 付きで再クエリする', async () => {
    vi.useFakeTimers();
    try {
      const { Popover } = await import('../src/content/popover');
      const p = new Popover();
      p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
      await vi.advanceTimersByTimeAsync(10);
      const root = p.element.shadowRoot!;
      const input = root.querySelector<HTMLInputElement>('.filter input')!;
      input.value = 'message 1';
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(300);
      const last = sendMessage.mock.calls.filter((c) => c[0].type === 'ws:query').at(-1)![0];
      expect(last.keyword).toBe('message 1');
      // 'message 1', 'message 10'..'message 19' の 11 件
      expect(root.querySelectorAll('.item').length).toBe(11);
    } finally {
      vi.useRealTimers();
    }
  });

  it('絞り込み欄は既定で隠れていて、フッタの検索ボタンで出し入れする。しまうと絞り込みも解除する', async () => {
    vi.useFakeTimers();
    try {
      const { Popover } = await import('../src/content/popover');
      const p = new Popover();
      p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
      await vi.advanceTimersByTimeAsync(10);
      const root = p.element.shadowRoot!;
      const box = root.querySelector<HTMLElement>('.filter')!;
      const toggle = root.querySelector<HTMLButtonElement>('.footer .search-toggle')!;
      const input = root.querySelector<HTMLInputElement>('.filter input')!;
      expect(box.hidden).toBe(true);
      // 一覧の下・フッタの上に出る
      expect(box.previousElementSibling!.className).toBe('list');
      expect(box.nextElementSibling!.className).toBe('footer');

      toggle.click();
      expect(box.hidden).toBe(false);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      input.value = 'message 1';
      input.dispatchEvent(new Event('input'));
      await vi.advanceTimersByTimeAsync(300);
      expect(root.querySelectorAll('.item').length).toBe(11);

      toggle.click();
      await vi.advanceTimersByTimeAsync(10);
      expect(box.hidden).toBe(true);
      expect(input.value).toBe('');
      expect(root.querySelectorAll('.item').length).toBe(50);

      // 出したまま閉じても、次に開くときは隠れている
      toggle.click();
      p.close();
      p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
      expect(box.hidden).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('channel が null なら「このチャンネル」は無く、全チャンネルが選ばれる', async () => {
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
    await flush();
    const select = p.element.shadowRoot!.querySelector<HTMLSelectElement>('.scope')!;
    expect([...select.options].map((o) => o.value)).toEqual(['ch1', 'ch2', '']);
    expect(select.value).toBe('');
  });

  it('VOD 由来のメッセージには再生位置リンクが付く', async () => {
    sendMessage.mockImplementation(async (req: { type: string }) =>
      req.type === 'ws:query'
        ? { items: [msg(0, { source: 'vod', vodId: '999', offsetSec: 3725 })], hasMore: false }
        : { user: 'alice', displayName: 'Alice', count: 1, firstTs: T0, lastTs: T0, channels: ['ch1'] },
    );
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
    await flush();
    const a = p.element.shadowRoot!.querySelector<HTMLAnchorElement>('.item .meta a')!;
    expect(a.getAttribute('href')).toBe('https://www.twitch.tv/videos/999?t=1h2m5s');
    expect(a.textContent).toBe('▶ VOD 1:02:05');
  });

  it('Esc で閉じ、close 後は再 open で中身が入れ替わる', async () => {
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
    await flush();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(p.isOpen).toBe(false);
    expect(p.element.shadowRoot!.querySelectorAll('.item').length).toBe(0);
  });
});

describe('installPopover', () => {
  it('ユーザー名クリックで data-a-user を拾って開く', async () => {
    const { installPopover } = await import('../src/content/popover');
    document.body.innerHTML = `
      <div class="chat-line__message" data-a-user="alice">
        <span class="chat-author__display-name" data-a-user="alice" style="color: rgb(0, 0, 255)">Alice</span>
        <span data-a-target="chat-line-message-body">hi</span>
      </div>`;
    const p = installPopover(() => ({ channel: 'ch1', enabled: true }));
    document.querySelector<HTMLElement>('.chat-author__display-name')!.click();
    await flush();
    expect(p.isOpen).toBe(true);
    expect(p.element.shadowRoot!.querySelector('.name')!.textContent).toBe('Alice');
  });

  it('enabled=false なら開かない', async () => {
    const { installPopover } = await import('../src/content/popover');
    document.body.innerHTML = `<span class="chat-author__display-name" data-a-user="alice">Alice</span>`;
    const p = installPopover(() => ({ channel: 'ch1', enabled: false }));
    document.querySelector<HTMLElement>('.chat-author__display-name')!.click();
    await flush();
    expect(p.isOpen).toBe(false);
  });
});

describe('純正カードへの追従', () => {
  it('遅れて出現したカードに追従し、カードだけ閉じられてもその場に残る', async () => {
    const { Popover } = await import('../src/content/popover');
    document.body.innerHTML = `<div data-a-target="chat-user-card"></div>`;
    const layer = document.querySelector('[data-a-target="chat-user-card"]')!;
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 10, y: 20 } });
    expect(p.element.style.visibility).toBe('hidden'); // 位置が決まるまで描画しない
    await flush();
    expect(p.element.style.left).toBe('10px');

    // 300ms 後にカードが挿入される(happy-dom は矩形を返さないので差し替える)
    const card = document.createElement('div');
    card.setAttribute('data-a-target', 'viewer-card');
    card.getBoundingClientRect = () => ({ x: 0, y: 100, left: 0, top: 100, right: 340, bottom: 300, width: 340, height: 200 }) as DOMRect;
    vi.stubGlobal('innerWidth', 1200);
    vi.stubGlobal('innerHeight', 800);
    layer.append(card);
    await flush();
    expect(p.element.style.left).toBe('348px');
    expect(p.element.style.top).toBe('100px');
    expect(p.element.style.visibility).toBe('');

    card.remove();
    await flush();
    expect(p.isOpen).toBe(true);
    expect(p.element.style.left).toBe('348px');
    // 純正カードと同じく、外側クリックでは閉じない
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(p.isOpen).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(p.isOpen).toBe(false);
  });

  it('開いたまま別ユーザーをクリックすると、差し替わった純正カードに追従して開き直す', async () => {
    const { Popover } = await import('../src/content/popover');
    document.body.innerHTML = `<div data-a-target="chat-user-card"></div>`;
    const layer = document.querySelector('[data-a-target="chat-user-card"]')!;
    vi.stubGlobal('innerWidth', 1200);
    vi.stubGlobal('innerHeight', 800);
    const makeCard = (top: number) => {
      const card = document.createElement('div');
      card.setAttribute('data-a-target', 'viewer-card');
      card.getBoundingClientRect = () =>
        ({ x: 0, y: top, left: 0, top, right: 340, bottom: top + 200, width: 340, height: 200 }) as DOMRect;
      return card;
    };
    const cardA = makeCard(100);
    layer.append(cardA);
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 10, y: 20 } });
    await flush();
    expect(p.element.style.top).toBe('100px');

    // 別ユーザーをクリック: この時点ではまだ旧カードが残っていて、Twitch が外してから新カードを入れる
    p.open({ user: 'bob', displayName: 'Bob', channel: null, anchor: { x: 10, y: 60 } });
    cardA.remove();
    await flush();
    expect(p.isOpen).toBe(true);
    layer.append(makeCard(300));
    await flush();
    expect(p.isOpen).toBe(true);
    expect(p.element.shadowRoot!.querySelector('.name')!.textContent).toBe('Bob');
    expect(p.element.style.top).toBe('300px');
  });

  it('カードが無いまま出したときは外側クリックで閉じる', async () => {
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 10, y: 20 } });
    await flush();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(p.isOpen).toBe(false);
  });

  it('左右に入らない狭い窓(埋め込みチャット)ではカードの下に置く', async () => {
    const { Popover } = await import('../src/content/popover');
    document.body.innerHTML = `<div data-a-target="chat-user-card"><div data-a-target="viewer-card"></div></div>`;
    const card = document.querySelector<HTMLElement>('[data-a-target="viewer-card"]')!;
    card.getBoundingClientRect = () => ({ x: 0, y: 100, left: 0, top: 100, right: 340, bottom: 300, width: 340, height: 200 }) as DOMRect;
    vi.stubGlobal('innerWidth', 400);
    vi.stubGlobal('innerHeight', 1200);
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 10, y: 120 } });
    await flush();
    expect(p.element.style.left).toBe('4px'); // 画面端の余白まで寄せる
    expect(p.element.style.top).toBe('308px'); // カードの下端 + 間隔
  });
});

describe('エモート表示・チャンネル名・ドラッグ', () => {
  it('既知のエモートは画像、未知はテキストのまま', async () => {
    sendMessage.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'ws:query') return { items: [msg(0, { text: 'gg :Kappa: and :Nope: :Kappa:' })], hasMore: false };
      if (req.type === 'ws:emotes') return { Kappa: 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/light/1.0' };
      return { user: 'alice', displayName: 'Alice', count: 1, firstTs: T0, lastTs: T0, channels: ['ch1'] };
    });
    document.documentElement.classList.add('tw-root--theme-dark');
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
    await flush();
    const text = p.element.shadowRoot!.querySelector('.item .text')!;
    const imgs = [...text.querySelectorAll('img.emote')];
    expect(imgs.length).toBe(2);
    expect(imgs[0]!.getAttribute('alt')).toBe('Kappa');
    // 表示時のテーマ(dark)に合わせる
    expect(imgs[0]!.getAttribute('src')).toBe('https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0');
    expect(text.textContent).toBe('gg  and :Nope: ');
    document.documentElement.classList.remove('tw-root--theme-dark');
    const names = sendMessage.mock.calls.find((c) => c[0].type === 'ws:emotes')![0].names;
    expect([...names].sort()).toEqual(['Kappa', 'Nope']);
  });

  it('「このチャンネル」スコープではチャンネル名を隠すクラスが付く', async () => {
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: 'ch1', anchor: { x: 0, y: 0 } });
    await flush();
    const root = p.element.shadowRoot!;
    const list = root.querySelector('.list')!;
    const select = root.querySelector<HTMLSelectElement>('.scope')!;
    // 直前のスコープを引き継ぐので、明示的に切り替えて確認する
    select.value = 'ch1';
    select.dispatchEvent(new Event('change'));
    expect(list.classList.contains('single-channel')).toBe(true);
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(list.classList.contains('single-channel')).toBe(false);
  });

  it('ヘッダのドラッグで移動し、位置を記憶し、ダブルクリックで戻す', async () => {
    vi.stubGlobal('innerWidth', 1200);
    vi.stubGlobal('innerHeight', 800);
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 100, y: 100 } });
    await flush();
    const header = p.element.shadowRoot!.querySelector<HTMLElement>('.header')!;
    const ev = (type: string, x: number, y: number) =>
      header.dispatchEvent(Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }), { pointerId: 1 }));
    ev('pointerdown', 150, 110);
    ev('pointermove', 350, 210);
    ev('pointerup', 350, 210);
    expect(p.element.style.left).toBe('300px');
    expect(p.element.style.top).toBe('200px');
    expect(JSON.parse(localStorage.getItem('ws-popover-position')!)).toEqual({ x: 300, y: 200 });

    // 再 open しても記憶した位置に出る
    p.close();
    p.open({ user: 'bob', displayName: 'Bob', channel: null, anchor: { x: 10, y: 10 } });
    await flush();
    expect(p.element.style.left).toBe('300px');

    header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(localStorage.getItem('ws-popover-position')).toBeNull();
    expect(p.element.style.left).toBe('18px'); // アンカー(10) + GAP(8)
  });

  it('右下のつまみでサイズを変え、記憶し、↺ で位置ともども戻す', async () => {
    vi.stubGlobal('innerWidth', 1200);
    vi.stubGlobal('innerHeight', 800);
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 100, y: 100 } });
    await flush();
    const root = p.element.shadowRoot!;
    const grip = root.querySelector<HTMLElement>('.grip')!;
    const reset = root.querySelector<HTMLButtonElement>('.reset')!;
    expect(reset.hidden).toBe(true);
    const ev = (type: string, x: number, y: number) =>
      grip.dispatchEvent(
        Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }), { pointerId: 1 }),
      );
    ev('pointerdown', 400, 600);
    ev('pointermove', 500, 550);
    ev('pointerup', 500, 550);
    // happy-dom はレイアウトしないので、元のサイズは既定値(280 x 480)から測る
    expect(p.element.style.width).toBe('380px');
    expect(p.element.style.height).toBe('430px');
    expect(JSON.parse(localStorage.getItem('ws-popover-size')!)).toEqual({ w: 380, h: 430 });
    expect(reset.hidden).toBe(false);

    // 下限より小さくはならない
    ev('pointerdown', 0, 0);
    ev('pointermove', -1000, -1000);
    ev('pointerup', -1000, -1000);
    expect(p.element.style.width).toBe('220px');
    expect(p.element.style.height).toBe('160px');

    // 再 open しても記憶したサイズで出る
    p.close();
    p.open({ user: 'bob', displayName: 'Bob', channel: null, anchor: { x: 10, y: 10 } });
    await flush();
    expect(p.element.style.width).toBe('220px');

    reset.click();
    expect(p.element.style.width).toBe('');
    expect(p.element.style.height).toBe('');
    expect(localStorage.getItem('ws-popover-size')).toBeNull();
    expect(reset.hidden).toBe(true);
  });
});
