import { describe, expect, it } from 'vitest';
import {
  choiceAnswer,
  jevClient,
  noulAnswer,
  parseJevResponse,
  SYSTEM_ONE_URL,
} from '../src/jev.js';

function fakeFetch(status: number, body: string, calls: { url: string; init: RequestInit }[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
}

describe('jevClient', () => {
  it('posts the state and questions with the bearer key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = jevClient({
      apiKey: 'k',
      fetch: fakeFetch(200, JSON.stringify({ answers: { q: { noul: 0.7 } } }), calls),
    });
    const response = await client.ask({ plan: 'p' }, { q: { type: 'noul', instructions: 'i' } });

    expect(noulAnswer(response.answers, 'q')).toBe(0.7);
    expect(calls[0].url).toBe(SYSTEM_ONE_URL);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      model: 'jev-latest',
      state: { plan: 'p' },
      questions: { q: { type: 'noul', instructions: 'i' } },
    });
  });

  it('throws on an HTTP error', async () => {
    const client = jevClient({ apiKey: 'k', fetch: fakeFetch(401, 'nope') });
    await expect(client.ask('s', {})).rejects.toThrow('Jev request failed (401): nope');
  });
});

describe('parseJevResponse', () => {
  it('rejects malformed JSON and a body without answers', () => {
    expect(() => parseJevResponse(200, true, '{')).toThrow('Jev returned malformed JSON');
    expect(() => parseJevResponse(200, true, '{"ok":true}')).toThrow('Jev response is missing answers');
  });
});

describe('noulAnswer', () => {
  it('throws when the answer is absent or not a number', () => {
    expect(() => noulAnswer({}, 'q')).toThrow('Invalid Jev answer for q');
    expect(() => noulAnswer({ q: { noul: 'high' } }, 'q')).toThrow('Invalid Jev answer for q');
  });
});

describe('noulAnswer with a score outside 0 to 1', () => {
  it('throws', () => {
    expect(() => noulAnswer({ q: { noul: 95 } }, 'q')).toThrow('Invalid Jev answer for q');
    expect(() => noulAnswer({ q: { noul: -3 } }, 'q')).toThrow('Invalid Jev answer for q');
  });
});

describe('choiceAnswer', () => {
  const allowed = ['decision', 'requirement'];

  it('returns the choice and its confidence', () => {
    expect(choiceAnswer({ q: { choice: 'decision', confidence: 0.8 } }, 'q', allowed)).toEqual({
      choice: 'decision',
      confidence: 0.8,
    });
  });

  it('falls back to the probability of the chosen option', () => {
    const answers = { q: { choice: 'decision', probabilities: { decision: 0.6, requirement: 0.4 } } };
    expect(choiceAnswer(answers, 'q', allowed).confidence).toBe(0.6);
  });

  it('throws on a choice that was not offered or has no confidence', () => {
    expect(() => choiceAnswer({ q: { choice: 'other', confidence: 1 } }, 'q', allowed)).toThrow(
      'Invalid Jev answer for q',
    );
    expect(() => choiceAnswer({ q: { choice: 'decision' } }, 'q', allowed)).toThrow(
      'Invalid Jev answer for q',
    );
  });
});
