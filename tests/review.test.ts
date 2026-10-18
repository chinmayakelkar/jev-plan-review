import { describe, expect, it } from 'vitest';
import type { JevAsker } from '../src/jev.js';
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
    expect(splitPlan(plan, 5)).toEqual(['alpha beta gamma', 'delta epsilon zeta', 'eta theta iota']);
  });

  it('breaks inside a paragraph that is too long on its own', () => {
    const parts = splitPlan('word '.repeat(100), 10);
    expect(parts.length).toBeGreaterThan(5);
    for (const part of parts) expect(estimateTokens(part)).toBeLessThanOrEqual(10);
    for (const part of splitPlan('!'.repeat(100), 10)) expect(estimateTokens(part)).toBeLessThanOrEqual(10);
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

  it('sets aside statements Jev calls about_tools', async () => {
    const statements = statementsOf('- Use Postgres for the storage layer\n- Turn the auto review off please');
    const result = await review(
      'Store data in Postgres.',
      statements,
      fakeJev({ kind: (id) => (id === 's1' ? 'about_tools' : 'requirement') }),
    );
    expect(result.verdicts.map((verdict) => verdict.id)).toEqual(['s2']);
    expect(result.unclear).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  it('shows the command beside the turn', async () => {
    const { statements } = toStatements([{ kind: 'prompt', text: 'Use Postgres for storage.', command: '/x' }]);
    const seen: Seen[] = [];
    await review('Store data in Postgres.', statements, fakeJev({}, seen));
    const { turns } = seen[0].state as { turns: { during_command?: string }[] };
    expect(turns[0].during_command).toBe('/x');
  });

  it('asks no yes/no question about a statement it could not classify', async () => {
    const statements = statementsOf(
      '- Use Postgres for the storage layer\n- Postgres maybe for the other thing\n- Thanks for all the help today',
    );
    const kinds: Record<string, string> = { s1: 'decision', s2: 'not_actionable', s3: 'not_actionable' };
    const probabilities: Record<string, Record<string, number>> = {
      s1: { decision: 0.7, requirement: 0.25, not_actionable: 0.05 },
      s2: { requirement: 0.35, constraint: 0.25, not_actionable: 0.4 },
      s3: { requirement: 0.1, not_actionable: 0.9 },
    };
    const seen: Seen[] = [];
    const result = await review(
      'Store data in Postgres.',
      statements,
      fakeJev({ kind: (id) => kinds[id], probabilities: (id) => probabilities[id] }, seen),
    );
    expect(result.verdicts.map((verdict) => verdict.id)).toEqual(['s1']);
    expect(result.unclear).toEqual([{ ...statements[1], confidence: 0.6 }]);
    expect(result.ignored).toBe(1);
    expect(seen[1].questions).toEqual(['covered_s1', 'contradicted_s1']);
  });

  it('adds up the tokens Jev reports, and counts none when it reports none', async () => {
    const reporting: JevAsker = {
      async ask(state, questions) {
        return { ...(await fakeJev().ask(state, questions)), usage: { input_tokens: 1000, output_tokens: 7 } };
      },
    };
    const statements = statementsOf('Use Postgres for the storage layer.');
    const result = await review('Store data in Postgres.', statements, reporting);
    expect(result.requests).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 14 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect((await review('Store data in Postgres.', statements, fakeJev())).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('checks a statement Jev is sure is real but torn between two kinds', async () => {
    const result = await review(
      'Store data in Postgres.',
      statementsOf('Use Postgres for the storage layer.'),
      fakeJev({
        kind: () => 'requirement',
        probabilities: () => ({ requirement: 0.5, constraint: 0.45, not_actionable: 0.05 }),
      }),
    );
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]).toMatchObject({ kind: 'requirement' });
    expect(result.unclear).toEqual([]);
  });

  it('goes by the confidence in the label when Jev gives no probabilities', async () => {
    const statements = statementsOf('- Use Postgres for the storage layer\n- Keep the tool small please');
    const result = await review(
      'Store data in Postgres.',
      statements,
      fakeJev({ kindConfidence: (id) => (id === 's1' ? 0.85 : 0.6) }),
    );
    expect(result.verdicts.map((verdict) => verdict.id)).toEqual(['s1']);
    expect(result.unclear).toEqual([{ ...statements[1], confidence: 0.6 }]);
  });

  it('leaves a statement unclear when no real kind can be named for it', async () => {
    const statements = statementsOf('Use Postgres for the storage layer.');
    const result = await review(
      'Store data in Postgres.',
      statements,
      fakeJev({ kind: () => 'not_actionable', kindConfidence: () => 0.1 }),
    );
    expect(result.verdicts).toEqual([]);
    expect(result.unclear).toEqual([{ ...statements[0], confidence: 0.9 }]);
  });

  it('uses the confidence threshold to decide what is unclear', async () => {
    const result = await review(
      'Store data in Postgres.',
      statementsOf('Use Postgres for the storage layer.'),
      fakeJev({ kindConfidence: () => 0.6 }),
      { minConfidence: 0.6 },
    );
    expect(result.verdicts).toHaveLength(1);
    expect(result.unclear).toEqual([]);
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

describe('the reverse check', () => {
  const said = statementsOf('Use Postgres for storage.');
  const plan = '- Use Postgres for storage.\n- Add a Redis cache for sessions.\n- Assume users run Node 20.\n- Run the tests.';
  const script = {
    kind: (id: string) => (id === 'p4' ? 'routine' : 'decision'),
    asked: (id: string) => ({ p1: 0.95, p2: 0.08, p3: 0.36 })[id] ?? 0.95,
  };

  it('lists only plan items the user did not ask for, marking the unsure ones', async () => {
    const result = await review(plan, said, fakeJev(script), { reverse: true });
    expect(result.fromPlan?.checked).toBe(3);
    expect(result.fromPlan?.items.map((item) => [item.text, item.conclusive])).toEqual([
      ['Add a Redis cache for sessions.', true],
      ['Assume users run Node 20.', false],
    ]);
    expect(result.fromPlan?.items[0].confidence).toBeCloseTo(0.92);
  });

  it('keeps the forward result when the reverse pass fails', async () => {
    const inner = fakeJev(script);
    const asker = {
      async ask(state: unknown, questions: Record<string, unknown>) {
        if (Object.keys(questions).some((name) => name.startsWith('asked_'))) throw new Error('rate limited');
        return inner.ask(state as never, questions as never);
      },
    };
    const result = await review(plan, said, asker, { reverse: true });
    expect(result.verdicts).toHaveLength(1);
    expect(result.fromPlan).toBeUndefined();
    expect(result.reverseError).toBe('rate limited');
  });

  it('runs only when asked to', async () => {
    const seen: Seen[] = [];
    const result = await review(plan, said, fakeJev(script, seen));
    expect(result.fromPlan).toBeUndefined();
    expect(seen.flatMap((call) => call.questions).some((name) => name.startsWith('asked_'))).toBe(false);
  });

  it('checks no more plan items than the limit and counts the rest', async () => {
    const result = await review(plan, said, fakeJev(script), { reverse: true, maxPlanItems: 2 });
    expect(result.fromPlan?.overLimit).toBe(2);
    expect(result.fromPlan?.items.map((item) => item.id)).toEqual(['p2']);
  });

  it('lists an item Jev could not place as not checked, without asking about it', async () => {
    const seen: Seen[] = [];
    const result = await review(plan, said, fakeJev({ ...script, kind: () => 'decision', kindConfidence: (id) => (id === 'p3' ? 0.6 : 0.9) }, seen), { reverse: true });
    expect(result.fromPlan?.unclear.map((item) => item.id)).toEqual(['p3']);
    expect(seen.flatMap((call) => call.questions)).not.toContain('asked_p3');
  });

  it('splits many statements over several requests and keeps the highest asked score', async () => {
    const many = statementsOf(Array.from({ length: 40 }, (_, i) => `Requirement number ${i} must hold.`).join(' '));
    const seen: Seen[] = [];
    let call = 0;
    const result = await review('- Add a Redis cache for sessions.', many, fakeJev({ asked: () => (call++ === 0 ? 0.9 : 0.1) }, seen), { reverse: true, maxPlanTokens: 200 });
    expect(seen.filter((entry) => entry.questions.includes('asked_p1')).length).toBeGreaterThan(1);
    expect(result.fromPlan?.items).toEqual([]);
  });
});
