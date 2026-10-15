import { describe, expect, it } from 'vitest';
import { abridge, estimateTokens, truncate } from '../src/tokens.js';

describe('estimateTokens', () => {
  it('counts a short word as one token and digits as half, scaled up by a quarter', () => {
    expect(estimateTokens('hello world')).toBe(3);
    expect(estimateTokens('1234')).toBe(3);
    expect(estimateTokens('')).toBe(0);
  });

  it('counts long words and symbols higher', () => {
    expect(estimateTokens('internationalisation')).toBe(5);
    expect(estimateTokens('a, b')).toBe(4);
  });
});

describe('truncate', () => {
  it('leaves short text alone and marks cut text', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('abridge', () => {
  it('keeps the head and tail of long text', () => {
    const text = `${'a'.repeat(100)}${'b'.repeat(100)}${'c'.repeat(100)}`;
    const result = abridge(text, 20, 30);
    expect(result.startsWith('a'.repeat(20))).toBe(true);
    expect(result.endsWith('c'.repeat(30))).toBe(true);
    expect(result).toContain('[… 250 chars omitted …]');
  });

  it('returns text that is already short enough', () => {
    expect(abridge('short text', 20, 30)).toBe('short text');
  });

  it('handles a zero tail', () => {
    expect(abridge('x'.repeat(200), 10, 0).endsWith('omitted …]\n')).toBe(true);
  });
});
