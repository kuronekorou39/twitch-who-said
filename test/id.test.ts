import { describe, expect, it } from 'vitest';
import { hashIdInput, messageHashId } from '../src/shared/id';

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
