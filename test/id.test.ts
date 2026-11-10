import { describe, expect, it } from 'vitest';
import { hashIdInput, isNearTs, messageHashId, nearTsRange } from '../src/shared/id';

describe('messageHashId', () => {
  it('同一入力で安定し、20 文字の 16 進', async () => {
    const a = await messageHashId('ch', 'user', 'hello', 1_700_000_000_000);
    const b = await messageHashId('ch', 'user', 'hello', 1_700_000_000_000);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{20}$/);
  });

  it('ts が同じ秒に丸まれば同一', async () => {
    const a = await messageHashId('ch', 'user', 'hello', 1_700_000_000_000);
    const b = await messageHashId('ch', 'user', 'hello', 1_700_000_000_400);
    expect(a).toBe(b);
  });

  it('ts が別の秒なら異なる', async () => {
    const a = await messageHashId('ch', 'user', 'hello', 1_700_000_000_000);
    const b = await messageHashId('ch', 'user', 'hello', 1_700_000_001_000);
    expect(a).not.toBe(b);
  });

  it('channel / user / text のいずれかが違えば異なる', async () => {
    const base = await messageHashId('ch', 'user', 'hello', 0);
    expect(await messageHashId('ch2', 'user', 'hello', 0)).not.toBe(base);
    expect(await messageHashId('ch', 'user2', 'hello', 0)).not.toBe(base);
    expect(await messageHashId('ch', 'user', 'hello!', 0)).not.toBe(base);
  });

  it('入力は改行区切りで曖昧さがない', () => {
    expect(hashIdInput('a', 'b', 'c', 1500)).toBe('a\nb\nc\n2');
  });
});

describe('isNearTs', () => {
  const T = 1_700_000_000_000; // ちょうど分の境界ではない任意の時刻
  const minute = Math.floor(T / 60_000) * 60_000;
  it('精密な時刻同士は ±10 秒', () => {
    expect(isNearTs({ ts: T }, { ts: T + 10_000 })).toBe(true);
    expect(isNearTs({ ts: T }, { ts: T + 10_001 })).toBe(false);
  });
  it('分単位の概算は、その 1 分間に入る精密な時刻と同一(前後 10 秒の余裕つき)', () => {
    const approx = { ts: minute, approxTs: true as const };
    expect(isNearTs(approx, { ts: minute + 45_000 })).toBe(true);
    expect(isNearTs({ ts: minute + 45_000 }, approx)).toBe(true); // 向きは問わない
    expect(isNearTs(approx, { ts: minute - 10_000 })).toBe(true);
    expect(isNearTs(approx, { ts: minute + 69_999 })).toBe(true);
    expect(isNearTs(approx, { ts: minute + 70_000 })).toBe(false);
    expect(isNearTs(approx, { ts: minute - 10_001 })).toBe(false);
  });
  it('概算同士は同じ分だけ', () => {
    const a = { ts: minute, approxTs: true as const };
    expect(isNearTs(a, { ts: minute, approxTs: true })).toBe(true);
    expect(isNearTs(a, { ts: minute + 60_000, approxTs: true })).toBe(false);
  });
  it('nearTsRange は isNearTs の相手を漏らさない', () => {
    const [lo, hi] = nearTsRange({ ts: T });
    expect(isNearTs({ ts: T }, { ts: lo - 1, approxTs: true })).toBe(false);
    expect(isNearTs({ ts: T }, { ts: hi + 1 })).toBe(false);
    const [alo, ahi] = nearTsRange({ ts: minute, approxTs: true });
    expect(alo).toBe(minute - 10_000);
    expect(ahi).toBe(minute + 70_000);
  });
});
