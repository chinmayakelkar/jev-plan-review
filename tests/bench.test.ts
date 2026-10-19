import { describe, expect, it } from 'vitest';
import { buildTranscript, type Scenario } from '../examples/bench/scenario.js';
import { outcomeOfReview, score, type Outcome } from '../examples/bench/score.js';
import type { ReviewResult } from '../src/review.js';
import type { Statement } from '../src/statements.js';
import { collectSources, readTranscript } from '../src/transcript.js';

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
