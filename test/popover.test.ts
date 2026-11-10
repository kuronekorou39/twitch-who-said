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

beforeEach(() => {
  sendMessage.mockReset();
  sendMessage.mockImplementation(async (req: { type: string; limit?: number; keyword?: string; channel?: string }) => {
    if (req.type === 'ws:query') {
      let items = Array.from({ length: 60 }, (_, i) => msg(i, { channel: i % 3 ? 'ch1' : 'ch2' }));
      if (req.channel) items = items.filter((m) => m.channel === req.channel);
      if (req.keyword) items = items.filter((m) => m.text.includes(req.keyword!));
      return { items: items.slice(0, req.limit), hasMore: items.length > (req.limit ?? 50) };
    }
    if (req.type === 'ws:userStats') return { user: 'alice', displayName: 'Alice', count: 60, firstTs: T0 - 86_400_000, lastTs: T0 };
    return undefined;
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
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
    vi.stubGlobal('CSSStyleSheet', class { replaceSync() {} });
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
  it('open で該当ユーザーのメッセージを新しい順に描画し、統計を出す', async () => {
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: 'ch1', color: 'rgb(220, 0, 0)', anchor: { x: 10, y: 10 } });
    await flush();

    const root = p.element.shadowRoot!;
    expect(p.isOpen).toBe(true);
    expect(root.querySelector('.name')!.textContent).toBe('Alice');
    const items = [...root.querySelectorAll('.item .text')].map((e) => e.textContent);
    expect(items.length).toBe(40); // ch1 のみ(i % 3 !== 0)の 40 件
    expect(items[0]).toBe('message 1');
    expect(root.querySelector('.footer-left')!.textContent).toBe('全 60 件');
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
    select.value = 'all';
    select.dispatchEvent(new Event('change'));
    await flush();
    const last = sendMessage.mock.calls.filter((c) => c[0].type === 'ws:query').at(-1)![0];
    expect(last.channel).toBeUndefined();
    expect(root.querySelectorAll('.item').length).toBe(50);
    expect(root.querySelector('.item .text')!.textContent).toBe('message 0');
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

  it('channel が null ならスコープは全チャンネルのみ', async () => {
    const { Popover } = await import('../src/content/popover');
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 0, y: 0 } });
    await flush();
    const select = p.element.shadowRoot!.querySelector<HTMLSelectElement>('.scope')!;
    expect([...select.options].map((o) => o.value)).toEqual(['all']);
  });

  it('VOD 由来のメッセージには再生位置リンクが付く', async () => {
    sendMessage.mockImplementation(async (req: { type: string }) =>
      req.type === 'ws:query'
        ? { items: [msg(0, { source: 'vod', vodId: '999', offsetSec: 3725 })], hasMore: false }
        : { user: 'alice', displayName: 'Alice', count: 1, firstTs: T0, lastTs: T0 },
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
  it('遅れて出現したカードに追従し、カードが消えたら閉じる', async () => {
    const { Popover } = await import('../src/content/popover');
    document.body.innerHTML = `<div data-a-target="chat-user-card"></div>`;
    const layer = document.querySelector('[data-a-target="chat-user-card"]')!;
    const p = new Popover();
    p.open({ user: 'alice', displayName: 'Alice', channel: null, anchor: { x: 10, y: 20 } });
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

    card.remove();
    await flush();
    expect(p.isOpen).toBe(false);
  });
});
