import { truncate } from './tokens.js';
import { DENY_MARKER, REPORT_MARKER } from './transcript.js';
const ORDER = { contradicted: 0, missing: 1, reflected: 2 };
export function sortVerdicts(verdicts) {
    return [...verdicts].sort((a, b) => ORDER[a.status] - ORDER[b.status] ||
        (a.status === 'reflected' ? a.confidence - b.confidence : b.confidence - a.confidence));
}
function percent(value) {
    return `${Math.round(value * 100)}%`;
}
function yesNo(verdict) {
    return verdict.status === 'reflected' ? 'YES' : 'NO';
}
function noteFor(verdict) {
    return [
        ...(verdict.status === 'reflected' ? [] : [verdict.status]),
        ...(verdict.conclusive ? [] : ['unsure']),
    ].join(', ');
}
export function summaryLine(result) {
    const count = (status) => result.verdicts.filter((verdict) => verdict.status === status).length;
    const parts = [`${count('reflected')} of ${result.verdicts.length} items reflected in the plan`];
    if (count('missing'))
        parts.push(`${count('missing')} missing`);
    if (count('contradicted'))
        parts.push(`${count('contradicted')} contradicted`);
    const unsure = result.verdicts.filter((verdict) => !verdict.conclusive).length;
    return `jev-plan-review: ${parts.join(', ')}${unsure ? ` (${unsure} unsure)` : ''}`;
}
export function renderText(result, options = {}) {
    const maxChars = options.maxChars ?? 9000;
    const lines = [summaryLine(result)];
    if (options.note)
        lines.push(options.note);
    if (result.verdicts.length === 0) {
        lines.push('Nothing the user said needed to be reflected.');
        return lines.join('\n');
    }
    const rows = sortVerdicts(result.verdicts).map((verdict) => {
        const note = noteFor(verdict);
        return `${yesNo(verdict).padEnd(3)} ${percent(verdict.confidence).padStart(4)}  ${verdict.kind.padEnd(11)}  ${truncate(verdict.text, 90)}${note ? `  [${note}]` : ''}`;
    });
    const reserve = 20;
    let used = lines.join('\n').length;
    let shown = 0;
    for (const row of rows) {
        if (used + row.length + 1 > maxChars - reserve)
            break;
        lines.push(row);
        used += row.length + 1;
        shown += 1;
    }
    if (shown < rows.length)
        lines.push(`… and ${rows.length - shown} more`);
    return lines.join('\n');
}
function cell(text) {
    return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}
export function renderMarkdown(result) {
    const lines = [summaryLine(result), ''];
    if (result.verdicts.length === 0) {
        lines.push('Nothing the user said needed to be reflected.');
    }
    else {
        lines.push('| # | Kind | What the user said | In the plan? | Confidence | Note |', '| --- | --- | --- | --- | --- | --- |');
        sortVerdicts(result.verdicts).forEach((verdict, index) => {
            lines.push(`| ${index + 1} | ${verdict.kind} | ${cell(truncate(verdict.text, 200))} | ${yesNo(verdict)} | ${percent(verdict.confidence)} | ${noteFor(verdict)} |`);
        });
    }
    if (result.ignored > 0) {
        lines.push('', `${result.ignored} statement(s) were set aside as questions, remarks, or things the user later reversed.`);
    }
    return lines.join('\n');
}
export function revisionRequest(result, revision, max) {
    const open = sortVerdicts(result.verdicts).filter((verdict) => verdict.actionable);
    const lines = [
        `${DENY_MARKER} The plan does not yet reflect ${open.length} thing(s) the user said. Revise the plan for each item below, then present it again (revision ${revision} of ${max}).`,
        '',
    ];
    for (const verdict of open) {
        const lead = verdict.status === 'contradicted' ? 'The plan contradicts' : 'The plan leaves out';
        lines.push(`- ${lead} this ${verdict.kind} (${percent(verdict.confidence)} sure): "${truncate(verdict.text, 300)}"`);
    }
    lines.push('', 'Change only what these items need. The user already said these things, so do not ask about them again unless two of them conflict with each other.');
    return lines.join('\n');
}
export function claudeContext(result, reportPath) {
    return [
        `${REPORT_MARKER} This plan was checked against what the user said while it was prepared. The report below is for the user to act on. Do not change the plan because of it unless the user asks.`,
        '',
        renderText(result, { maxChars: 8000 }),
        '',
        `Full report: ${reportPath}`,
    ].join('\n');
}
