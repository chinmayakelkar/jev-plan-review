import type { ReviewResult } from '../../src/review.js';
import type { Statement } from '../../src/statements.js';
import type { Scenario } from './scenario.js';

export type Actual = 'reflected' | 'missing' | 'contradicted' | 'unclear' | 'set_aside';

export interface Outcome {
  statements: { text: string; actual: Actual; conclusive: boolean }[];
  flagged: { text: string; conclusive: boolean }[];
}

export interface Score {
  correct: number;
  unsure: number;
  wrong: number;
  wrongNo: number;
  missedProblem: number;
  total: number;
  flaggedRight: number;
  flaggedWrong: number;
  unflaggedWrong: number;
}

export function outcomeOfReview(result: ReviewResult, statements: Statement[]): Outcome {
  const verdicts = new Map(result.verdicts.map((verdict) => [verdict.id, verdict]));
  const unclear = new Set(result.unclear.map((statement) => statement.id));
  return {
    statements: statements.map(({ id, text }) => {
      const verdict = verdicts.get(id);
      if (verdict) return { text, actual: verdict.status, conclusive: verdict.conclusive };
      return unclear.has(id) ? { text, actual: 'unclear', conclusive: false } : { text, actual: 'set_aside', conclusive: true };
    }),
    flagged: (result.fromPlan?.items ?? []).map(({ text, conclusive }) => ({ text, conclusive })),
  };
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function score(scenario: Scenario, outcome: Outcome): Score {
  const actuals = new Map(outcome.statements.map((statement) => [collapse(statement.text), statement]));
  const result: Score = {
    correct: 0,
    unsure: 0,
    wrong: 0,
    wrongNo: 0,
    missedProblem: 0,
    total: scenario.expect.statements.length,
    flaggedRight: 0,
    flaggedWrong: 0,
    unflaggedWrong: 0,
  };
  for (const { text, verdict } of scenario.expect.statements) {
    const found = actuals.get(collapse(text)) ?? { actual: 'set_aside' as const, conclusive: true };
    const problem = verdict === 'missing' || verdict === 'contradicted';
    if (found.actual === verdict && (found.conclusive || verdict === 'set_aside')) result.correct += 1;
    else if (found.actual === 'unclear' || !found.conclusive) result.unsure += 1;
    else result.wrong += 1;
    const saysNo = found.conclusive && (found.actual === 'missing' || found.actual === 'contradicted');
    if (saysNo && !problem) result.wrongNo += 1;
    if (problem && found.conclusive && (found.actual === 'reflected' || found.actual === 'set_aside')) {
      result.missedProblem += 1;
    }
  }
  const conclusive = outcome.flagged.filter((item) => item.conclusive);
  const flagged = (part: string): boolean => conclusive.some((item) => item.text.includes(part));
  for (const part of scenario.expect.notFromUser ?? []) {
    if (flagged(part)) result.flaggedRight += 1;
    else result.unflaggedWrong += 1;
  }
  result.flaggedWrong = (scenario.expect.fromUser ?? []).filter(flagged).length;
  return result;
}
