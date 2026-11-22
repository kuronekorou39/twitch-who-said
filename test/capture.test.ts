// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatCapture } from '../src/content/capture';
import type { ExtractedMessage } from '../src/content/extract';

const sendMessage = vi.fn();

function line(text: string, emotes?: Record<string, string>): HTMLElement {
  const el = document.createElement('div');
  el.className = 'line';
  el.textContent = text;
  if (emotes) el.dataset.emotes = JSON.stringify(emotes);
  return el;
}

const extract = (el: Element): ExtractedMessage => {
  const raw = (el as HTMLElement).dataset.emotes;
  return {
    user: 'alice',
    displayName: 'Alice',
    channel: 'ch',
    text: el.textContent ?? '',
    ts: 1,
    source: 'live',
    capturedAt: 1,
    ...(raw ? { emotes: JSON.parse(raw) as Record<string, string> } : {}),
  };
};

const texts = (call: number) => (sendMessage.mock.calls[call]![0] as { items: { text: string }[] }).items.map((m) => m.text);

function start(...lines: HTMLElement[]): ChatCapture {
  const container = document.createElement('div');
  container.append(...lines);
  const cap = new ChatCapture({ lineSelector: '.line', extract });
  cap.start(container);
  return cap;
}

beforeEach(() => {
  vi.useFakeTimers();
  sendMessage.mockReset();
  sendMessage.mockResolvedValue({ accepted: 1, skipped: 0 });
  vi.stubGlobal('chrome', { runtime: { id: 'test', sendMessage } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ChatCapture の送信', () => {
  it('デバウンス後にまとめて送り、成功した件数を数える', async () => {
    const cap = start(line('a'), line('b'));
    expect(sendMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(texts(0)).toEqual(['a', 'b']);
    expect(cap.stats.flushed).toBe(2);
  });

  it('送信に失敗したら失わず、間隔を空けて同じ行を再送する', async () => {
    sendMessage.mockRejectedValueOnce(new Error('no receiver'));
    const cap = start(line('a'));
    await vi.advanceTimersByTimeAsync(300);
    expect(cap.stats.flushed).toBe(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(texts(1)).toEqual(['a']);
    expect(cap.stats.flushed).toBe(1);
  });

  it('SW の処理失敗(応答 undefined)も再送する', async () => {
    sendMessage.mockResolvedValueOnce(undefined);
    const cap = start(line('a'));
    await vi.advanceTimersByTimeAsync(1300);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(cap.stats.flushed).toBe(1);
  });

  it('エモートは送信に成功するまで送信済みにしない', async () => {
    sendMessage.mockRejectedValueOnce(new Error('fail'));
    const emotes = { Kappa: 'https://static-cdn.jtvnw.net/x' };
    const cap = start(line('a', emotes));
    await vi.advanceTimersByTimeAsync(1300);
    expect(sendMessage.mock.calls[1]![0].emotes).toEqual(emotes);
    cap.stop();
  });

  it('拡張が無効になった後は再送しない', async () => {
    sendMessage.mockImplementationOnce(async () => {
      vi.stubGlobal('chrome', { runtime: {} });
      throw new Error('Extension context invalidated');
    });
    start(line('a'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
