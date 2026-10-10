import { describe, expect, it } from 'vitest';
import {
  claudeContext,
  renderMarkdown,
  renderText,
  revisionRequest,
  summaryLine,
} from '../src/report.js';
import type { ReviewResult, Verdict } from '../src/review.js';
import { DENY_MARKER, REPORT_MARKER } from '../src/transcript.js';

let next = 0;
function verdict(overrides: Partial<Verdict>): Verdict {
  next += 1;
  return {
    id: `s${next}`,
    source: 'prompt',
    text: `Statement ${next} from the user`,
    turn: 0,
    kind: 'requirement',
    kindConfidence: 0.9,
    covered: 0.9,
    contradicted: 0.05,
    status: 'reflected',
    confidence: 0.9,
    conclusive: true,
    actionable: false,
    ...overrides,
  };
}

function resultOf(verdicts: Verdict[], ignored = 0): ReviewResult {
  return { verdicts, statements: verdicts.length + ignored, ignored, requests: 2, planParts: 1 };
}

const mixed = resultOf(
  [
    verdict({ text: 'Keep the README short', status: 'reflected', confidence: 0.97 }),
    verdict({ text: 'Add a CSV export', kind: 'requirement', status: 'missing', confidence: 0.61, conclusive: false }),
    verdict({ text: 'Use Postgres | not SQLite', kind: 'decision', status: 'contradicted', confidence: 0.93, actionable: true }),
    verdict({ text: 'Support Windows paths', kind: 'constraint', status: 'missing', confidence: 0.88, actionable: true }),
  ],
  2,
);

describe('summaryLine', () => {
  it('counts items without any overall score', () => {
    expect(summaryLine(mixed)).toBe(
      'jev-plan-review: 1 of 4 items reflected in the plan, 2 missing, 1 contradicted (1 unsure)',
    );
  });

  it('leaves out the unsure count when every answer was conclusive', () => {
    expect(summaryLine(resultOf([verdict({})]))).toBe('jev-plan-review: 1 of 1 items reflected in the plan');
  });
});

describe('renderText', () => {
  it('lists problems first, each with yes or no and a confidence', () => {
    const lines = renderText(mixed).split('\n');
    expect(lines[0]).toBe(summaryLine(mixed));
    expect(lines[1]).toBe('NO   93%  decision     Use Postgres | not SQLite  [contradicted]');
    expect(lines[2]).toBe('NO   88%  constraint   Support Windows paths  [missing]');
    expect(lines[3]).toBe('NO   61%  requirement  Add a CSV export  [missing, unsure]');
    expect(lines[4]).toBe('YES  97%  requirement  Keep the README short');
  });

  it('marks a yes that Jev was not sure of, above the ones it was sure of', () => {
    const result = resultOf([
      verdict({ text: 'Use tabs for indentation', confidence: 0.97 }),
      verdict({ text: 'Keep the tool small', confidence: 0.55, conclusive: false }),
    ]);
    const lines = renderText(result).split('\n');
    expect(lines[0]).toBe('jev-plan-review: 2 of 2 items reflected in the plan (1 unsure)');
    expect(lines[1]).toBe('YES  55%  requirement  Keep the tool small  [unsure]');
    expect(lines[2]).toBe('YES  97%  requirement  Use tabs for indentation');
  });

  it('puts a note under the summary', () => {
    expect(renderText(mixed, { note: 'Still open.' }).split('\n')[1]).toBe('Still open.');
  });

  it('says so when nothing needed checking', () => {
    expect(renderText(resultOf([]))).toContain('Nothing the user said needed to be reflected.');
  });

  it('keeps the message under the limit with problems first', () => {
    const many = resultOf([
      ...Array.from({ length: 200 }, () => verdict({})),
      verdict({ text: 'The one real problem', status: 'missing', confidence: 0.9, actionable: true }),
    ]);
    const text = renderText(many, { maxChars: 1000 });
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text.split('\n')[1]).toContain('The one real problem');
    expect(text).toMatch(/… and \d+ more$/);
  });
});

describe('renderMarkdown', () => {
  it('renders one table row per item and escapes pipes', () => {
    const markdown = renderMarkdown(mixed);
    expect(markdown).toContain('| # | Kind | What the user said | In the plan? | Confidence | Note |');
    expect(markdown).toContain('| 1 | decision | Use Postgres \\| not SQLite | NO | 93% | contradicted |');
    expect(markdown).toContain('| 4 | requirement | Keep the README short | YES | 97% |  |');
    expect(markdown).toContain('2 statement(s) were set aside');
  });
});

describe('revisionRequest', () => {
  it('names only the items sure enough to act on', () => {
    const text = revisionRequest(mixed, 1, 2);
    expect(text.startsWith(DENY_MARKER)).toBe(true);
    expect(text).toContain('revision 1 of 2');
    expect(text).toContain('The plan contradicts this decision (93% sure): "Use Postgres | not SQLite"');
    expect(text).toContain('The plan leaves out this constraint (88% sure): "Support Windows paths"');
    expect(text).not.toContain('Add a CSV export');
    expect(text).not.toContain('Keep the README short');
  });
});

describe('claudeContext', () => {
  it('gives Claude the table and the report path, and leaves the deciding to the user', () => {
    const text = claudeContext(mixed, 'D:/data/reports/sess.md');
    expect(text.startsWith(REPORT_MARKER)).toBe(true);
    expect(text).toContain('Do not change the plan because of it unless the user asks');
    expect(text).toContain('NO   93%  decision     Use Postgres | not SQLite  [contradicted]');
    expect(text).toContain('Full report: D:/data/reports/sess.md');
  });

  it('stays under the hook output limit for a very long table', () => {
    const many = resultOf(Array.from({ length: 400 }, () => verdict({})));
    expect(claudeContext(many, 'D:/data/reports/sess.md').length).toBeLessThan(10_000);
  });
});
