import { describe, expect, it } from 'vitest';
import { decide, pack, review, splitPlan, type Item } from '../src/review.js';
import { toStatements } from '../src/statements.js';
import { estimateTokens } from '../src/tokens.js';
import { fakeJev, type Seen } from './helpers.js';

function statementsOf(text: string, context?: string) {
  return toStatements([{ kind: 'prompt', text, ...(context ? { context } : {}) }]).statements;
}

const item: Item = {
  id: 's1',
  source: 'prompt',
  text: 'Use Postgres for storage.',
  turn: 0,
  kind: 'decision',
  kindConfidence: 0.9,
};

describe('decide', () => {
  it('says yes with the reflect score as confidence', () => {
    expect(decide(item, { covered: 0.9, contradicted: 0.1 }, 0.8)).toMatchObject({
      status: 'reflected',
      confidence: 0.9,
      conclusive: true,
      actionable: false,
    });
  });

  it('treats a yes below the minimum as not conclusive', () => {
    expect(decide(item, { covered: 0.55, contradicted: 0.1 }, 0.8)).toMatchObject({
      status: 'reflected',
      confidence: 0.55,
      conclusive: false,
      actionable: false,
    });
  });

  it('says no with one minus the reflect score, and acts only when sure enough', () => {
    const sure = decide(item, { covered: 0.1, contradicted: 0.1 }, 0.8);
    expect(sure.status).toBe('missing');
    expect(sure.confidence).toBeCloseTo(0.9);
    expect(sure.conclusive).toBe(true);
    expect(sure.actionable).toBe(true);

    const unsure = decide(item, { covered: 0.35, contradicted: 0.1 }, 0.8);
    expect(unsure.status).toBe('missing');
    expect(unsure.confidence).toBeCloseTo(0.65);
    expect(unsure.conclusive).toBe(false);
    expect(unsure.actionable).toBe(false);
  });

  it('lets a conflict win over a reflect score', () => {
    expect(decide(item, { covered: 0.9, contradicted: 0.92 }, 0.8)).toMatchObject({
      status: 'contradicted',
      confidence: 0.92,
      actionable: true,
    });
    expect(decide(item, { covered: 0.2, contradicted: 0.6 }, 0.8)).toMatchObject({
      status: 'contradicted',
      conclusive: false,
      actionable: false,
    });
  });
});

describe('pack', () => {
  it('fills batches up to the budget', () => {
    expect(pack([1, 2, 3, 4, 5], () => 10, 25)).toEqual([[1, 2], [3, 4], [5]]);
    expect(pack([], () => 10, 25)).toEqual([]);
  });

  it('refuses an item that can never fit', () => {
    expect(() => pack([1], () => 30, 25)).toThrow('only 25 are free');
  });
});

describe('splitPlan', () => {
  it('keeps a plan that fits in one part', () => {
    expect(splitPlan('alpha\n\nbeta', 1000)).toEqual(['alpha\n\nbeta']);
  });

  it('breaks between paragraphs when over the budget', () => {
    const plan = 'alpha beta gamma\n\ndelta epsilon zeta\n\neta theta iota';
    expect(splitPlan(plan, 4)).toEqual(['alpha beta gamma', 'delta epsilon zeta', 'eta theta iota']);
  });

  it('breaks inside a paragraph that is too long on its own', () => {
    const parts = splitPlan('word '.repeat(100), 10);
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) expect(estimateTokens(part)).toBeLessThanOrEqual(10);
  });
});

describe('review', () => {
  it('sets aside superseded and non-actionable statements', async () => {
    const statements = statementsOf(
      '- Use SQLite for the storage layer\n- Actually use Postgres for storage instead\n- Thanks for all the help today',
    );
    const kinds: Record<string, string> = { s1: 'superseded', s2: 'decision', s3: 'not_actionable' };
    const result = await review(
      'Store data in Postgres.',
      statements,
      fakeJev({ kind: (id) => kinds[id] ?? 'requirement' }),
    );
    expect(result.verdicts.map((verdict) => [verdict.id, verdict.kind, verdict.status])).toEqual([
      ['s2', 'decision', 'reflected'],
    ]);
    expect(result.statements).toBe(3);
    expect(result.ignored).toBe(2);
  });

  it('answers each item on its own with Jev’s confidence', async () => {
    const statements = statementsOf(
      '- The tool must be written in Python\n- Add a CSV export command\n- Keep the README short and plain\n- Use tabs for indentation everywhere',
    );
    const covered: Record<string, number> = { s1: 0.9, s2: 0.1, s3: 0.35, s4: 0.9 };
    const result = await review(
      'A Node.js tool.',
      statements,
      fakeJev({
        covered: (id) => covered[id] ?? 0,
        contradicted: (id) => (id === 's1' ? 0.92 : 0.02),
      }),
    );
    const byId = Object.fromEntries(result.verdicts.map((verdict) => [verdict.id, verdict]));
    expect(byId.s1).toMatchObject({ status: 'contradicted', confidence: 0.92, actionable: true });
    expect(byId.s2).toMatchObject({ status: 'missing', actionable: true });
    expect(byId.s3).toMatchObject({ status: 'missing', actionable: false });
    expect(byId.s4).toMatchObject({ status: 'reflected', confidence: 0.9, actionable: false });
  });

  it('gives Jev the plan and statements, with the assistant text as context only', async () => {
    const seen: Seen[] = [];
    await review(
      'Store data in Postgres.',
      statementsOf('Use Postgres for the storage.', 'Which database should it use?'),
      fakeJev({ kind: () => 'decision' }, seen),
    );
    expect(seen).toHaveLength(2);

    const classify = seen[0].state as { turns: { said_before_by_assistant?: string; statements: unknown[] }[] };
    expect(seen[0].questions).toEqual(['kind_s1']);
    expect(classify.turns[0].said_before_by_assistant).toBe('Which database should it use?');
    expect(classify.turns[0].statements).toEqual([{ id: 's1', text: 'Use Postgres for the storage.' }]);

    const verify = seen[1].state as { plan: string; turns: { statements: unknown[] }[] };
    expect(seen[1].questions).toEqual(['covered_s1', 'contradicted_s1']);
    expect(verify.plan).toBe('Store data in Postgres.');
    expect(verify.turns[0].statements).toEqual([
      { id: 's1', text: 'Use Postgres for the storage.', kind: 'decision' },
    ]);
  });

  it('counts an item as reflected when any part of a long plan reflects it', async () => {
    const filler = Array.from({ length: 6 }, (_, index) => `Filler paragraph number ${index} about setup.`);
    const plan = [...filler, 'Store all data in Postgres.', ...filler].join('\n\n');
    const result = await review(
      plan,
      statementsOf('Use Postgres for the storage.'),
      fakeJev({ covered: (_id, part) => (part.includes('Postgres') ? 0.9 : 0.1) }),
      { maxPlanTokens: 20 },
    );
    expect(result.planParts).toBeGreaterThan(2);
    expect(result.verdicts[0]).toMatchObject({ status: 'reflected', covered: 0.9 });
  });

  it('splits questions across requests when they do not fit one', async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `- Requirement number ${index} must hold`);
    const result = await review('A plan.', statementsOf(lines.join('\n')), fakeJev(), {
      maxRequestTokens: 2000,
    });
    expect(result.verdicts).toHaveLength(30);
    expect(result.requests).toBeGreaterThan(2);
  });

  it('fails loudly on a malformed answer', async () => {
    const broken = { ask: async () => ({ answers: {} }) };
    await expect(review('A plan.', statementsOf('Use Postgres for the storage.'), broken)).rejects.toThrow(
      'Invalid Jev answer for kind_s1',
    );
  });

  it('makes no request when there is nothing to check', async () => {
    const seen: Seen[] = [];
    const result = await review('A plan.', [], fakeJev({}, seen));
    expect(result).toMatchObject({ verdicts: [], requests: 0 });
    expect(seen).toEqual([]);
  });
});
