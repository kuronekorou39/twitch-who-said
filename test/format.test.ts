import { describe, expect, it } from 'vitest';
import {
  adjustNameColor,
  formatOffset,
  formatOffsetDisplay,
  formatTime,
  luminance,
  parseColor,
  vodUrl,
} from '../src/content/format';

describe('formatTime', () => {
  const now = new Date(2026, 10, 10, 21, 0).getTime(); // 2026-11-10 21:00 ローカル
  it('同日は時刻のみ', () => {
    expect(formatTime(new Date(2026, 10, 10, 9, 5).getTime(), now)).toBe('09:05');
  });
  it('同年は MM/DD HH:MM', () => {
    expect(formatTime(new Date(2026, 0, 3, 23, 59).getTime(), now)).toBe('01/03 23:59');
  });
  it('別年は YYYY/MM/DD HH:MM', () => {
    expect(formatTime(new Date(2025, 11, 31, 0, 0).getTime(), now)).toBe('2025/12/31 00:00');
  });
});

describe('offset / vod url', () => {
  it('1h23m45s 形式', () => {
    expect(formatOffset(3600 + 23 * 60 + 45)).toBe('1h23m45s');
    expect(formatOffset(65)).toBe('1m5s');
  });
  it('表示用 h:mm:ss', () => {
    expect(formatOffsetDisplay(3600 + 23 * 60 + 5)).toBe('1:23:05');
    expect(formatOffsetDisplay(65)).toBe('1:05');
  });
  it('VOD URL', () => {
    expect(vodUrl('123', 5025)).toBe('https://www.twitch.tv/videos/123?t=1h23m45s');
    expect(vodUrl('123')).toBe('https://www.twitch.tv/videos/123');
  });
});

describe('color', () => {
  it('parseColor は #rgb / #rrggbb / rgb()', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('#1E90FF')).toEqual([30, 144, 255]);
    expect(parseColor('rgb(220, 0, 0)')).toEqual([220, 0, 0]);
    expect(parseColor('rgba(1,2,3,0.5)')).toEqual([1, 2, 3]);
    expect(parseColor('red')).toBeNull();
    expect(parseColor(undefined)).toBeNull();
  });
  it('luminance の両端', () => {
    expect(luminance([0, 0, 0])).toBe(0);
    expect(luminance([255, 255, 255])).toBeCloseTo(1);
  });
  it('ダークテーマで暗い色は明るくなる', () => {
    const adjusted = parseColor(adjustNameColor('#000080', true))!;
    expect(luminance(adjusted)).toBeGreaterThan(luminance([0, 0, 128]));
  });
  it('ライトテーマで明るい色は暗くなる', () => {
    const adjusted = parseColor(adjustNameColor('#ffff00', false))!;
    expect(luminance(adjusted)).toBeLessThan(luminance([255, 255, 0]));
  });
  it('十分読める色はそのまま', () => {
    expect(adjustNameColor('rgb(220, 0, 0)', true)).toBe('rgb(220, 0, 0)');
  });
  it('解析できない色は undefined', () => {
    expect(adjustNameColor('inherit', true)).toBeUndefined();
  });
});
