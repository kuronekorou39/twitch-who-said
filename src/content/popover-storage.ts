/** ドラッグで動かした位置・変えたサイズの保存(端末ごとの好みなので localStorage) */
const POSITION_STORAGE_KEY = 'ws-popover-position';
const SIZE_STORAGE_KEY = 'ws-popover-size';

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export function loadPosition(): Point | null {
  const p = loadJson<Partial<Point>>(POSITION_STORAGE_KEY);
  return typeof p?.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
}

export function loadSize(): Size | null {
  const s = loadJson<Partial<Size>>(SIZE_STORAGE_KEY);
  return typeof s?.w === 'number' && typeof s.h === 'number' ? { w: s.w, h: s.h } : null;
}

export function savePosition(p: Point | null): void {
  saveJson(POSITION_STORAGE_KEY, p);
}

export function saveSize(s: Size | null): void {
  saveJson(SIZE_STORAGE_KEY, s);
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    /* localStorage が使えない環境では位置・サイズを覚えないだけ */
  }
}
