import type { ReviewResult, Status, Verdict } from './review.js';
import { truncate } from './tokens.js';
import { DENY_MARKER, REPORT_MARKER } from './transcript.js';

const ORDER: Record<Status, number> = { contradicted: 0, missing: 1, reflected: 2 };

export function sortVerdicts(verdicts: readonly Verdict[]): Verdict[] {
  return [...verdicts].sort(
    (a, b) =>
      ORDER[a.status] - ORDER[b.status] ||
      (a.status === 'reflected' ? a.confidence - b.confidence : b.confidence - a.confidence),
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function yesNo(verdict: Verdict): string {
  return verdict.status === 'reflected' ? 'YES' : 'NO';
}

function noteFor(verdict: Verdict): string {
  return [
    ...(verdict.status === 'reflected' ? [] : [verdict.status]),
    ...(verdict.conclusive ? [] : ['unsure']),
  ].join(', ');
}

export function summaryLine(result: ReviewResult): string {
  const count = (status: Status): number =>
    result.verdicts.filter((verdict) => verdict.status === status).length;
  const parts = [`${count('reflected')} of ${result.verdicts.length} items reflected in the plan`];
  if (count('missing')) parts.push(`${count('missing')} missing`);
  if (count('contradicted')) parts.push(`${count('contradicted')} contradicted`);
  if (result.unclear.length) parts.push(`${result.unclear.length} not checked`);
  const unsure = result.verdicts.filter((verdict) => !verdict.conclusive).length;
  return `jev-plan-review: ${parts.join(', ')}${unsure ? ` (${unsure} unsure)` : ''}`;
}

interface Row {
  answer: string;
  confidence: number;
  kind: string;
  text: string;
  note: string;
}

function rowsOf(result: ReviewResult, showInconclusive: boolean): { rows: Row[]; hidden?: string } {
  const sure = sortVerdicts(result.verdicts)
    .filter((verdict) => showInconclusive || verdict.conclusive)
    .map((verdict) => ({ ...verdict, answer: yesNo(verdict), note: noteFor(verdict) }));
  if (showInconclusive) {
    const unclear = [...result.unclear]
      .sort((a, b) => b.confidence - a.confidence)
      .map((statement) => ({ ...statement, answer: '?', kind: 'unclear', note: 'not checked' }));
    return { rows: [...sure, ...unclear] };
  }
  const hidden = result.verdicts.length - sure.length + result.unclear.length;
  return {
    rows: sure,
    ...(hidden ? { hidden: `${hidden} inconclusive item(s) are hidden; show_inconclusive is off.` } : {}),
  };
}

const NOTHING = 'Nothing the user said needed to be reflected.';

export function renderText(
  result: ReviewResult,
  options: { maxChars?: number; note?: string; reportPath?: string; showInconclusive?: boolean } = {},
): string {
  const pointer = options.reportPath ? `; full report: ${options.reportPath}` : '';
  const maxChars = options.maxChars ?? 9000;
  const { rows, hidden } = rowsOf(result, options.showInconclusive ?? true);
  const lines = [summaryLine(result)];
  if (options.note) lines.push(options.note);
  if (hidden) lines.push(hidden);
  else if (rows.length === 0) lines.push(NOTHING);
  const reserve = 20 + pointer.length;
  let used = lines.join('\n').length;
  let shown = 0;
  for (const row of rows) {
    const line = `${row.answer.padEnd(3)} ${percent(row.confidence).padStart(4)}  ${row.kind.padEnd(11)}  ${truncate(row.text, 90)}${row.note ? `  [${row.note}]` : ''}`;
    if (used + line.length + 1 > maxChars - reserve) break;
    lines.push(line);
    used += line.length + 1;
    shown += 1;
  }
  if (shown < rows.length) lines.push(`… and ${rows.length - shown} more${pointer}`);
  return lines.join('\n');
}

function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}

export function renderMarkdown(
  result: ReviewResult,
  options: { showInconclusive?: boolean } = {},
): string {
  const { rows, hidden } = rowsOf(result, options.showInconclusive ?? true);
  const lines = [summaryLine(result), ''];
  if (rows.length > 0) {
    lines.push(
      '| # | Kind | What the user said | In the plan? | Confidence | Note |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    rows.forEach((row, index) => {
      lines.push(
        `| ${index + 1} | ${row.kind} | ${cell(truncate(row.text, 200))} | ${row.answer} | ${percent(row.confidence)} | ${row.note} |`,
      );
    });
  } else if (!hidden) lines.push(NOTHING);
  if (hidden) lines.push('', hidden);
  if (result.ignored > 0) {
    lines.push(
      '',
      `${result.ignored} statement(s) were set aside as questions, remarks, or things the user later reversed.`,
    );
  }
  return lines.join('\n');
}

export function revisionRequest(result: ReviewResult, revision: number, max: number): string {
  const open = sortVerdicts(result.verdicts).filter((verdict) => verdict.actionable);
  const lines = [
    `${DENY_MARKER} The plan does not yet reflect ${open.length} thing(s) the user said. Revise the plan for each item below, then present it again (revision ${revision} of ${max}).`,
    '',
  ];
  for (const verdict of open) {
    const lead = verdict.status === 'contradicted' ? 'The plan contradicts' : 'The plan leaves out';
    lines.push(
      `- ${lead} this ${verdict.kind} (${percent(verdict.confidence)} sure): "${truncate(verdict.text, 300)}"`,
    );
  }
  lines.push(
    '',
    'Change only what these items need. The user already said these things, so do not ask about them again unless two of them conflict with each other.',
  );
  return lines.join('\n');
}

export function claudeContext(
  result: ReviewResult,
  reportPath: string,
  options: { showInconclusive?: boolean; note?: string } = {},
): string {
  return [
    `${REPORT_MARKER} An automatic check of this plan against what the user said while it was prepared. Change the plan because of it only if the user asks.`,
    '',
    renderText(result, { maxChars: 8000, reportPath, ...options }),
    '',
    `Full report: ${reportPath}`,
  ].join('\n');
}
