import { expect, test } from 'vitest';
import { deriveSeed, hash32, mulberry32 } from '../../src/core/rng';

test('mulberry32 is deterministic', () => {
  const a = mulberry32(5);
  const b = mulberry32(5);
  for (let i = 0; i < 100; i++) expect(a()).toBe(b());
});
test('mulberry32 values are in [0,1)', () => {
  const a = mulberry32(9);
  for (let i = 0; i < 1000; i++) {
    const v = a();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  }
});
test('deriveSeed differs by label', () => {
  expect(deriveSeed(1, 'a')).not.toBe(deriveSeed(1, 'b'));
});
test('hash32 is deterministic and order sensitive', () => {
  expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3));
  expect(hash32(1, 2)).not.toBe(hash32(2, 1));
});
