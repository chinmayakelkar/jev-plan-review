import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { runReview } from '../src/run.js';
import { fakeJev, fileAttachment, human, tempDir, writeTranscript } from './helpers.js';

function config(overrides: Partial<Config> = {}): Config {
  return {
    apiKey: 'k',
    provider: 'typesafe',
    baseUrl: 'https://jev.invalid/systemone',
    model: 'jev-latest',
    minConfidence: 0.8,
    autoReview: true,
    maxRevisions: 2,
    maxStatements: 150,
    showInconclusive: true,
    reverseCheck: true,
    dataDir: tempDir(),
    ...overrides,
  };
}

const transcript = () =>
  writeTranscript([human('Use SQLite for the storage layer.'), human('Add a CSV export command too.')]);

describe('runReview', () => {
  it('reviews the plan against what the user said', async () => {
    const outcome = await runReview({
      plan: 'Store data in SQLite. Add CSV export.',
      transcriptPath: transcript(),
      windowStart: 0,
      config: config(),
      asker: fakeJev(),
    });
    expect(outcome.kind).toBe('reviewed');
    if (outcome.kind !== 'reviewed') return;
    expect(outcome.result.verdicts.map((verdict) => verdict.text)).toEqual([
      'Use SQLite for the storage layer.',
      'Add a CSV export command too.',
    ]);
    expect(outcome.overLimit).toBe(0);
  });

  it('checks no more statements than max_statements, and says how many were left', async () => {
    const outcome = await runReview({
      plan: 'Add CSV export.',
      transcriptPath: transcript(),
      windowStart: 0,
      config: config({ maxStatements: 1 }),
      asker: fakeJev(),
    });
    expect(outcome.kind).toBe('reviewed');
    if (outcome.kind !== 'reviewed') return;
    expect(outcome.result.verdicts.map((verdict) => verdict.text)).toEqual(['Add a CSV export command too.']);
    expect(outcome.overLimit).toBe(1);
  });

  it('only looks at what was said after the window start', async () => {
    const outcome = await runReview({
      plan: 'Add CSV export.',
      transcriptPath: transcript(),
      windowStart: 1,
      config: config(),
      asker: fakeJev(),
    });
    expect(outcome.kind === 'reviewed' && outcome.result.verdicts.map((verdict) => verdict.text)).toEqual([
      'Add a CSV export command too.',
    ]);
  });

  it('skips without a key', async () => {
    const base = { plan: 'A plan.', transcriptPath: transcript(), windowStart: 0 };
    expect(await runReview({ ...base, config: config({ apiKey: undefined }) })).toEqual({
      kind: 'skipped',
      reason: 'no TypeSafe API key is set; add TYPESAFE_API_KEY to the "env" section of ~/.claude/settings.json and restart Claude Code',
    });
    expect(await runReview({ ...base, config: config({ apiKey: undefined, provider: 'openrouter' }) })).toEqual({
      kind: 'skipped',
      reason: 'no OpenRouter API key is set; add OPENROUTER_API_KEY to the "env" section of ~/.claude/settings.json and restart Claude Code',
    });
  });

  it('sends requests to the chosen provider with its key and model', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('busy', { status: 503 });
    });
    try {
      const outcome = await runReview({
        plan: 'A plan.',
        transcriptPath: transcript(),
        windowStart: 0,
        config: config({ apiKey: 'or-key', baseUrl: 'https://openrouter.ai/api/v1/systemone', model: 'jev-1.13' }),
      });
      expect(outcome).toEqual({ kind: 'skipped', reason: 'Jev request failed (503): busy' });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(calls[0].url).toBe('https://openrouter.ai/api/v1/systemone');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer or-key');
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('jev-1.13');
  });

  it('skips an empty plan and an empty window', async () => {
    const base = { transcriptPath: transcript(), config: config(), asker: fakeJev() };
    expect(await runReview({ ...base, plan: '  ', windowStart: 0 })).toEqual({
      kind: 'skipped',
      reason: 'the plan is empty',
    });
    expect(await runReview({ ...base, plan: 'A plan.', windowStart: 2 })).toEqual({
      kind: 'skipped',
      reason: 'the user has said nothing to check since the last approved plan or /clear',
    });
  });

  it('turns a Jev failure into a skip', async () => {
    const outcome = await runReview({
      plan: 'A plan.',
      transcriptPath: transcript(),
      windowStart: 0,
      config: config(),
      asker: {
        ask: async () => {
          throw new Error('Jev request failed (503): busy');
        },
      },
    });
    expect(outcome).toEqual({ kind: 'skipped', reason: 'Jev request failed (503): busy' });
  });

  it('runs the reverse check only when asked', async () => {
    const base = {
      plan: 'Store data in SQLite. Add CSV export.',
      transcriptPath: transcript(),
      windowStart: 0,
      asker: fakeJev(),
    };
    const off = await runReview({ ...base, config: config() });
    const on = await runReview({ ...base, config: config(), reverse: true });
    const capped = await runReview({ ...base, config: config({ maxStatements: 1 }), reverse: true });
    if (off.kind !== 'reviewed' || on.kind !== 'reviewed' || capped.kind !== 'reviewed') throw new Error('skipped');
    expect(off.result.fromPlan).toBeUndefined();
    expect(on.result.fromPlan).toBeDefined();
    expect(capped.result.fromPlan?.overLimit).toBe(on.result.fromPlan!.checked - 1);
  });
});

describe('runReview and mentioned files', () => {
  const withFiles = () =>
    writeTranscript([
      human('Follow @spec.md and look at @README.md'),
      fileAttachment('spec.md', 'The export must be CSV.'),
      fileAttachment('README.md', 'This project prints reports.'),
    ]);

  it('checks only statements from files Jev accepts', async () => {
    const outcome = await runReview({
      plan: 'Export as CSV.',
      transcriptPath: withFiles(),
      windowStart: 0,
      config: config(),
      asker: fakeJev({ file: (id) => (id === 'f1' ? 0.95 : 0.1) }),
    });
    if (outcome.kind !== 'reviewed') throw new Error(outcome.reason);
    const texts = outcome.result.verdicts.map((verdict) => verdict.text);
    expect(texts).toContain('The export must be CSV.');
    expect(texts).not.toContain('This project prints reports.');
    expect(outcome.result.files).toEqual([
      { label: 'spec.md', status: 'used', confidence: 0.95 },
      { label: 'README.md', status: 'set_aside', confidence: 0.1 },
    ]);
  });

  it('counts the file question as a request and leaves files out when none was mentioned', async () => {
    const run = (transcriptPath: string) =>
      runReview({
        plan: 'Export as CSV.',
        transcriptPath,
        windowStart: 0,
        config: config({ reverseCheck: false }),
        asker: fakeJev({ file: () => 0.1 }),
      });
    const mentioned = await run(withFiles());
    const plain = await run(writeTranscript([human('Follow @spec.md and look at @README.md')]));
    if (mentioned.kind !== 'reviewed' || plain.kind !== 'reviewed') throw new Error('skipped');
    expect(mentioned.result.requests).toBe(plain.result.requests + 1);
    expect(plain.result.files).toBeUndefined();
  });
});
