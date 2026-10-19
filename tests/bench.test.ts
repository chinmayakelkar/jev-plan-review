import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { longScenario } from '../examples/bench/long.js';
import { judgePrompt, outcomeOfClaude, type ClaudeRunner } from '../examples/bench/claude.js';
import { bench } from '../examples/bench/run.js';
import { buildTranscript, loadScenarios, type Scenario } from '../examples/bench/scenario.js';
import { outcomeOfReview, score, type Outcome } from '../examples/bench/score.js';
import { planItems, type ReviewResult } from '../src/review.js';
import { toStatements, type Statement } from '../src/statements.js';
import { collectSources, readTranscript } from '../src/transcript.js';
import { fakeJev, tempDir } from './helpers.js';

const SCENARIOS = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'bench', 'scenarios');
const statement = (id: string, text: string): Statement => ({ id, source: 'prompt', text, turn: 0 });

describe('benchmark scenarios', () => {
  it('builds a transcript the plugin reads back', () => {
    const scenario: Scenario = {
      name: 'x',
      about: 'x',
      files: { 'spec.md': 'The export must be CSV.' },
      turns: [
        { assistant: 'What should we build?' },
        { user: 'Build a report exporter, see @spec.md for the rules.' },
        { file: 'spec.md' },
        { ask: { question: 'Runtime?', answer: 'Node' } },
      ],
      plan: '',
      expect: { statements: [] },
    };
    const sources = collectSources(readTranscript(buildTranscript(scenario)));
    expect(sources.map((source) => source.kind)).toEqual(['prompt', 'answer', 'document']);
    expect(sources[0].context).toBe('What should we build?');
    expect(sources[1].text).toContain('"Node"');
    expect(sources[2].text).toBe('The export must be CSV.');
  });

  it('maps a review result to outcomes', () => {
    const statements = [statement('s1', 'a one'), statement('s2', 'b two'), statement('s3', 'c three'), statement('s4', 'd four')];
    const verdict = (s: Statement, status: 'missing' | 'reflected', conclusive: boolean) => ({
      ...s,
      kind: 'requirement' as const,
      status,
      conclusive,
      confidence: 0.9,
      actionable: true,
      covered: 0.5,
      contradicted: 0,
    });
    const result: ReviewResult = {
      verdicts: [verdict(statements[0], 'missing', true), verdict(statements[1], 'reflected', false)],
      unclear: [{ ...statements[2], confidence: 0.5 }],
      statements: 4,
      ignored: 1,
      requests: 2,
      planParts: 1,
      usage: { inputTokens: 1, outputTokens: 1 },
      elapsedMs: 1,
      fromPlan: {
        items: [{ id: 'p1', text: 'Use Redis', kind: 'decision', asked: 0.1, confidence: 0.9, conclusive: true }],
        unclear: [],
        checked: 1,
        overLimit: 0,
      },
    };
    expect(outcomeOfReview(result, statements)).toEqual({
      statements: [
        { text: 'a one', actual: 'missing', conclusive: true },
        { text: 'b two', actual: 'reflected', conclusive: false },
        { text: 'c three', actual: 'unclear', conclusive: false },
        { text: 'd four', actual: 'set_aside', conclusive: true },
      ],
      flagged: [{ text: 'Use Redis', conclusive: true }],
    });
  });

  it('scores by the rules', () => {
    const scenario: Scenario = {
      name: 'x',
      about: 'x',
      turns: [],
      plan: '',
      expect: {
        statements: [
          { text: 'right', verdict: 'reflected' },
          { text: 'aside', verdict: 'set_aside' },
          { text: 'unsure', verdict: 'reflected' },
          { text: 'wrong  no', verdict: 'reflected' },
          { text: 'missed', verdict: 'missing' },
        ],
        notFromUser: ['Redis', 'Docker'],
        fromUser: ['CSV'],
      },
    };
    const outcome: Outcome = {
      statements: [
        { text: 'right', actual: 'reflected', conclusive: true },
        { text: 'aside', actual: 'set_aside', conclusive: true },
        { text: 'unsure', actual: 'reflected', conclusive: false },
        { text: 'wrong no', actual: 'contradicted', conclusive: true },
        { text: 'missed', actual: 'reflected', conclusive: true },
      ],
      flagged: [
        { text: 'Use Redis for the cache', conclusive: true },
        { text: 'Run it in Docker', conclusive: false },
        { text: 'Export as CSV', conclusive: true },
      ],
    };
    expect(score(scenario, outcome)).toEqual({
      correct: 2,
      unsure: 1,
      wrong: 2,
      wrongNo: 1,
      missedProblem: 1,
      total: 5,
      flaggedRight: 1,
      flaggedWrong: 1,
      unflaggedWrong: 1,
    });
  });
});

describe('sonnet baseline', () => {
  const statements = [
    statement('s1', 'Use Python for the tool.'),
    statement('s2', 'Export to CSV.'),
    statement('s3', 'Add a dry run flag.'),
  ];
  const items = [
    { id: 'p1', text: 'Write the tool in Python.' },
    { id: 'p2', text: 'Cache results in Redis.' },
  ];
  const plan = '- Write the tool in Python.\n- Cache results in Redis.';

  it('asks Sonnet about every statement and plan item', () => {
    const prompt = judgePrompt(statements, items, plan);
    for (const { id, text } of [...statements, ...items]) {
      expect(prompt).toContain(id);
      expect(prompt).toContain(text);
    }
    expect(prompt).toContain(JSON.stringify(plan));
  });

  it("reads Sonnet's verdicts", () => {
    const answer = {
      statements: {
        s1: { kind: 'superseded', verdict: 'missing', confidence: 95 },
        s2: { kind: 'requirement', verdict: 'missing', confidence: 70 },
      },
      plan_items: { p1: { from_user: true, confidence: 90 }, p2: { from_user: false, confidence: 85 } },
    };
    const reply = `Here is my answer:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\nDone.`;
    expect(outcomeOfClaude(reply, statements, items)).toEqual({
      statements: [
        { text: 'Use Python for the tool.', actual: 'set_aside', conclusive: true },
        { text: 'Export to CSV.', actual: 'missing', conclusive: false },
        { text: 'Add a dry run flag.', actual: 'set_aside', conclusive: true },
      ],
      flagged: [{ text: 'Cache results in Redis.', conclusive: true }],
    });
  });

  it('treats an unreadable reply as unsure', () => {
    const outcome = outcomeOfClaude('Sorry, I cannot help.', statements, items);
    expect(outcome.statements.map((s) => s.actual)).toEqual(['unclear', 'unclear', 'unclear']);
    expect(outcome.flagged).toEqual([]);
  });
});

describe('benchmark runner', () => {
  it('writes a summary for each system', async () => {
    const scenario: Scenario = {
      name: 'tiny',
      about: 'one requirement',
      turns: [{ user: 'Export the report to CSV.' }],
      plan: '- Write a CSV exporter for the report.',
      expect: { statements: [{ text: 'Export the report to CSV.', verdict: 'reflected' }] },
    };
    const claude: ClaudeRunner = async () => ({
      text: JSON.stringify({ statements: { s1: { kind: 'requirement', verdict: 'reflected', confidence: 90 } } }),
      ms: 1000,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.01,
    });
    const summary = await bench({ scenarios: [scenario], runs: 2, asker: fakeJev(), claude, out: tempDir() });
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain('tiny');
    expect(text).toMatch(/\| tiny \| jev \|/);
    expect(text).toMatch(/\| tiny \| sonnet \|/);
    expect(existsSync(join(dirname(summary), 'tiny-jev-1.md'))).toBe(true);
  });
});

describe('benchmark answer keys', () => {
  const scenarios = [...loadScenarios(SCENARIOS), longScenario(50)];
  const produced = (s: Scenario): string[] =>
    toStatements(collectSources(readTranscript(buildTranscript(s))), 1000).statements.map((x) => x.text);

  it('has the ten scenario files and the long one', () => {
    expect(scenarios.length).toBe(11);
  });

  it.each(scenarios.map((s) => [s.name, s] as const))('every key statement in %s is one the splitter produces', (_, s) => {
    const texts = produced(s);
    expect(s.expect.statements.map((x) => x.text).sort()).toEqual([...texts].sort());
  });

  it.each(scenarios.map((s) => [s.name, s] as const))('every plan item key in %s matches exactly one plan item', (_, s) => {
    const { items } = planItems(s.plan, 1000);
    for (const part of [...(s.expect.notFromUser ?? []), ...(s.expect.fromUser ?? [])]) {
      expect(items.filter((item) => item.text.includes(part)).map((item) => item.text), part).toHaveLength(1);
    }
  });

  it('long scenarios are stable', () => {
    expect(longScenario(150)).toEqual(longScenario(150));
    expect(longScenario(150).expect.statements).toHaveLength(150);
  });
});
