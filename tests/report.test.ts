import { describe, expect, it } from 'vitest';
import {
  claudeContext,
  renderMarkdown,
  renderText,
  revisionRequest,
  summaryLine,
} from '../src/report.js';
import type { FromPlan, ReviewResult, Unclear, Verdict } from '../src/review.js';
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
    covered: 0.9,
    contradicted: 0.05,
    status: 'reflected',
    confidence: 0.9,
    conclusive: true,
    actionable: false,
    ...overrides,
  };
}

function resultOf(verdicts: Verdict[], ignored = 0, unclear: Unclear[] = []): ReviewResult {
  return {
    verdicts,
    unclear,
    statements: verdicts.length + unclear.length + ignored,
    ignored,
    requests: 2,
    planParts: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    elapsedMs: 0,
  };
}

function unclearOf(text: string, confidence: number): Unclear {
  next += 1;
  return { id: `s${next}`, source: 'prompt', text, turn: 0, confidence };
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

  it('points to the full report when the table is cut, and only then', () => {
    const many = resultOf(Array.from({ length: 200 }, () => verdict({})));
    const text = renderText(many, { maxChars: 1000, reportPath: 'D:/data/reports/sess.md' });
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toMatch(/… and \d+ more; full report: D:\/data\/reports\/sess\.md$/);
    expect(renderText(mixed, { reportPath: 'D:/data/reports/sess.md' })).not.toContain('full report');
  });
});

describe('statements Jev could not classify', () => {
  const withUnclear = resultOf(mixed.verdicts, 0, [
    unclearOf('Postgres maybe', 0.62),
    unclearOf('The other thing as well', 0.71),
  ]);

  it('are counted and listed last, with no yes or no', () => {
    const lines = renderText(withUnclear).split('\n');
    expect(lines[0]).toBe(
      'jev-plan-review: 1 of 4 items reflected in the plan, 2 missing, 1 contradicted, 2 not checked (1 unsure)',
    );
    expect(lines.slice(5)).toEqual([
      '?    71%  unclear      The other thing as well  [not checked]',
      '?    62%  unclear      Postgres maybe  [not checked]',
    ]);
    expect(renderMarkdown(withUnclear)).toContain('| 6 | unclear | Postgres maybe | ? | 62% | not checked |');
  });

  it('are shown even when nothing else was checked', () => {
    const text = renderText(resultOf([], 0, [unclearOf('Postgres maybe', 0.62)]));
    expect(text).toContain('?    62%  unclear      Postgres maybe  [not checked]');
    expect(text).not.toContain('Nothing the user said');
  });

  it('are hidden, with every unsure answer, when show_inconclusive is off', () => {
    const lines = renderText(withUnclear, { showInconclusive: false, note: 'Still open.' }).split('\n');
    expect(lines).toEqual([
      'jev-plan-review: 1 of 4 items reflected in the plan, 2 missing, 1 contradicted, 2 not checked (1 unsure)',
      'Still open.',
      '3 inconclusive item(s) are hidden; show_inconclusive is off.',
      'NO   93%  decision     Use Postgres | not SQLite  [contradicted]',
      'NO   88%  constraint   Support Windows paths  [missing]',
      'YES  97%  requirement  Keep the README short',
    ]);
    const markdown = renderMarkdown(withUnclear, { showInconclusive: false });
    expect(markdown).not.toContain('Postgres maybe');
    expect(markdown).not.toContain('Add a CSV export');
    expect(markdown).toContain('| 3 | requirement | Keep the README short | YES | 97% |  |');
    expect(markdown).toContain('3 inconclusive item(s) are hidden; show_inconclusive is off.');
    const shared = claudeContext(withUnclear, 'D:/data/reports/sess.md', { showInconclusive: false });
    expect(shared).not.toContain('Postgres maybe');
    expect(shared).toContain('3 inconclusive item(s) are hidden');
  });

  it('say nothing about hiding when there was nothing to hide', () => {
    const sure = resultOf([verdict({})]);
    expect(renderText(sure, { showInconclusive: false })).not.toContain('hidden');
  });
});

describe('renderMarkdown', () => {
  it('renders one table row per item and escapes pipes', () => {
    const markdown = renderMarkdown(mixed);
    expect(markdown).toContain('| # | Kind | What the user said | In the plan? | Confidence | Note |');
    expect(markdown).toContain('| 1 | decision | Use Postgres \\| not SQLite | NO | 93% | contradicted |');
    expect(markdown).toContain('| 4 | requirement | Keep the README short | YES | 97% |  |');
    expect(markdown).toContain('2 statement(s) were set aside as questions, remarks, things the user later reversed, or things about settings or tools.');
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

  it('lists every open item, however many there are', () => {
    const many = resultOf(
      Array.from({ length: 150 }, (_, index) =>
        verdict({ text: `Item ${index} ${'word '.repeat(80)}`, status: 'missing', actionable: true }),
      ),
    );
    const listed = revisionRequest(many, 1, 2)
      .split('\n')
      .filter((line) => line.startsWith('- The plan leaves out'));
    expect(listed).toHaveLength(150);
  });
});

describe('claudeContext', () => {
  it('gives Claude the table and the report path, and leaves the deciding to the user', () => {
    const text = claudeContext(mixed, 'D:/data/reports/sess.md');
    expect(text.startsWith(`${REPORT_MARKER} An automatic check of this plan against what the user said while it was prepared. Change the plan because of it only if the user asks.`)).toBe(true);
    expect(claudeContext(mixed, 'D:/data/reports/sess.md', { note: 'Still open.' })).toContain('Still open.');
    expect(text).toContain('NO   93%  decision     Use Postgres | not SQLite  [contradicted]');
    expect(text).toContain('Full report: D:/data/reports/sess.md');
  });

  it('puts the note straight after the marker line, before the summary', () => {
    const lines = claudeContext(mixed, 'D:/data/reports/sess.md', { note: 'Still open.' }).split('\n');
    expect(lines[0].startsWith(REPORT_MARKER)).toBe(true);
    expect(lines[1]).toBe('Still open.');
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe(summaryLine(mixed));
    expect(lines.filter((line) => line === 'Still open.')).toHaveLength(1);
  });

  it('stays under the hook output limit for a very long table', () => {
    const many = resultOf(Array.from({ length: 400 }, () => verdict({})));
    const text = claudeContext(many, 'D:/data/reports/sess.md');
    expect(text.length).toBeLessThan(10_000);
    expect(text).toMatch(/… and \d+ more; full report: D:\/data\/reports\/sess\.md/);
  });
});

describe('renderMarkdown with a reverse check', () => {
  const fromPlan = {
    checked: 3,
    overLimit: 1,
    items: [
      { id: 'p2', text: 'Add a Redis cache for sessions.', kind: 'decision', asked: 0.08, confidence: 0.92, conclusive: true },
      { id: 'p3', text: 'Assume users run Node 20.', kind: 'assumption', asked: 0.36, confidence: 0.64, conclusive: false },
    ],
    unclear: [{ id: 'p5', text: 'Keep the old flag.', confidence: 0.6 }],
  } satisfies FromPlan;

  it('adds a section after the forward table', () => {
    const text = renderMarkdown({ ...mixed, fromPlan });
    const section = text.slice(text.indexOf('## In the plan, not from you'));
    expect(section).toContain('jev-plan-review: 2 of 3 plan items may not come from what you said (1 unsure, 1 not checked)');
    expect(section).toContain('These may well be right; they are listed for you to review.');
    expect(section).toContain('| # | Kind | In the plan | From you? | Confidence | Note |');
    expect(section).toContain('| 1 | decision | Add a Redis cache for sessions. | NO | 92% |  |');
    expect(section).toContain('| 2 | assumption | Assume users run Node 20. | NO | 64% | unsure |');
    expect(section).toContain('| 3 | unclear | Keep the old flag. | ? | 60% | not checked |');
    expect(section).toContain('1 plan item(s) were over the limit and not checked.');
  });

  it('hides unsure and unclear rows when show_inconclusive is off', () => {
    const section = renderMarkdown({ ...mixed, fromPlan }, { showInconclusive: false });
    expect(section).not.toContain('Node 20');
    expect(section).toContain('2 inconclusive plan item(s) are hidden; show_inconclusive is off.');
  });

  it('says so when nothing came from outside what the user said', () => {
    const text = renderMarkdown({ ...mixed, fromPlan: { checked: 0, overLimit: 0, items: [], unclear: [] } });
    expect(text).toContain('Everything the plan decides traces back to what you said.');
  });

  it('says the reverse check could not run', () => {
    const text = renderMarkdown({ ...mixed, reverseError: 'rate limited' });
    expect(text.endsWith('## In the plan, not from you\n\nThe reverse check could not run: rate limited')).toBe(true);
  });

  it('has no section without a reverse check', () => {
    expect(renderMarkdown(mixed)).not.toContain('In the plan, not from you');
  });
});

describe('the files line', () => {
  const files = {
    ...resultOf([verdict({})]),
    files: [
      { label: 'spec.md', status: 'used', confidence: 0.9 },
      { label: 'README.md', status: 'set_aside', confidence: 0.1 },
      { label: 'notes.md', status: 'unsure', confidence: 0.6 },
    ],
  } satisfies ReviewResult;
  const line = 'Files: used spec.md; set aside README.md; unsure notes.md';

  it('comes right after the summary line', () => {
    expect(renderMarkdown(files).split('\n')[1]).toBe(line);
    expect(renderText(files).split('\n')[1]).toBe(line);
  });

  it('is left out when no file was asked about', () => {
    const plain = resultOf([verdict({})]);
    expect(renderMarkdown(plain)).not.toContain('Files:');
    expect(renderText(plain)).not.toContain('Files:');
  });
});
