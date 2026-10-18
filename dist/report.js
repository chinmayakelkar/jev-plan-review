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
    if (result.unclear.length)
        parts.push(`${result.unclear.length} not checked`);
    const unsure = result.verdicts.filter((verdict) => !verdict.conclusive).length;
    return `jev-plan-review: ${parts.join(', ')}${unsure ? ` (${unsure} unsure)` : ''}`;
}
const FILE_GROUPS = [
    ['used', 'used'],
    ['set_aside', 'set aside'],
    ['unsure', 'unsure'],
];
function filesLine(result) {
    const groups = FILE_GROUPS.flatMap(([status, name]) => {
        const labels = (result.files ?? []).filter((file) => file.status === status).map((file) => file.label);
        return labels.length ? [`${name} ${labels.join(', ')}`] : [];
    });
    return groups.length ? [`Files: ${groups.join('; ')}`] : [];
}
function rowsOf(result, showInconclusive) {
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
export function renderText(result, options = {}) {
    const pointer = options.reportPath ? `; full report: ${options.reportPath}` : '';
    const maxChars = options.maxChars ?? 9000;
    const { rows, hidden } = rowsOf(result, options.showInconclusive ?? true);
    const lines = [summaryLine(result), ...filesLine(result)];
    if (options.note)
        lines.push(options.note);
    if (hidden)
        lines.push(hidden);
    else if (rows.length === 0)
        lines.push(NOTHING);
    const reserve = 20 + pointer.length;
    let used = lines.join('\n').length;
    let shown = 0;
    for (const row of rows) {
        const line = `${row.answer.padEnd(3)} ${percent(row.confidence).padStart(4)}  ${row.kind.padEnd(11)}  ${truncate(row.text, 90)}${row.note ? `  [${row.note}]` : ''}`;
        if (used + line.length + 1 > maxChars - reserve)
            break;
        lines.push(line);
        used += line.length + 1;
        shown += 1;
    }
    if (shown < rows.length)
        lines.push(`… and ${rows.length - shown} more${pointer}`);
    return lines.join('\n');
}
function cell(text) {
    return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
}
function fromPlanLines(fromPlan, showInconclusive) {
    const { items, unclear } = fromPlan;
    const unsure = items.filter((item) => !item.conclusive).length;
    const parts = [
        ...(unsure ? [`${unsure} unsure`] : []),
        ...(unclear.length ? [`${unclear.length} not checked`] : []),
    ];
    const lines = [
        '',
        '## In the plan, not from you',
        '',
        `jev-plan-review: ${items.length} of ${fromPlan.checked} plan items may not come from what you said${parts.length ? ` (${parts.join(', ')})` : ''}`,
    ];
    const byConfidence = (a, b) => b.confidence - a.confidence;
    const rows = [
        ...items
            .filter((item) => showInconclusive || item.conclusive)
            .sort((a, b) => Number(b.conclusive) - Number(a.conclusive) || byConfidence(a, b))
            .map((item) => ({ ...item, answer: 'NO', note: item.conclusive ? '' : 'unsure' })),
        ...(showInconclusive
            ? [...unclear]
                .sort(byConfidence)
                .map((item) => ({ ...item, answer: '?', kind: 'unclear', note: 'not checked' }))
            : []),
    ];
    const hidden = showInconclusive ? 0 : unsure + unclear.length;
    if (rows.length > 0) {
        lines.push('', 'These may well be right; they are listed for you to review.', '', '| # | Kind | In the plan | From you? | Confidence | Note |', '| --- | --- | --- | --- | --- | --- |');
        rows.forEach((row, index) => {
            lines.push(`| ${index + 1} | ${row.kind} | ${cell(truncate(row.text, 200))} | ${row.answer} | ${percent(row.confidence)} | ${row.note} |`);
        });
    }
    else if (!hidden)
        lines.push('', 'Everything the plan decides traces back to what you said.');
    if (hidden)
        lines.push('', `${hidden} inconclusive plan item(s) are hidden; show_inconclusive is off.`);
    if (fromPlan.overLimit > 0) {
        lines.push('', `${fromPlan.overLimit} plan item(s) were over the limit and not checked.`);
    }
    return lines;
}
export function renderMarkdown(result, options = {}) {
    const { rows, hidden } = rowsOf(result, options.showInconclusive ?? true);
    const lines = [summaryLine(result), ...filesLine(result), ''];
    if (rows.length > 0) {
        lines.push('| # | Kind | What the user said | In the plan? | Confidence | Note |', '| --- | --- | --- | --- | --- | --- |');
        rows.forEach((row, index) => {
            lines.push(`| ${index + 1} | ${row.kind} | ${cell(truncate(row.text, 200))} | ${row.answer} | ${percent(row.confidence)} | ${row.note} |`);
        });
    }
    else if (!hidden)
        lines.push(NOTHING);
    if (hidden)
        lines.push('', hidden);
    if (result.ignored > 0) {
        lines.push('', `${result.ignored} statement(s) were set aside as questions, remarks, things the user later reversed, or things about settings or tools.`);
    }
    if (result.reverseError) {
        lines.push('', '## In the plan, not from you', '', `The reverse check could not run: ${result.reverseError}`);
    }
    if (result.fromPlan)
        lines.push(...fromPlanLines(result.fromPlan, options.showInconclusive ?? true));
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
export function claudeContext(result, reportPath, options = {}) {
    return [
        `${REPORT_MARKER} An automatic check of this plan against what the user said while it was prepared. Change the plan because of it only if the user asks.`,
        ...(options.note ? [options.note] : []),
        '',
        renderText(result, { maxChars: 8000, reportPath, showInconclusive: options.showInconclusive }),
        '',
        `Full report: ${reportPath}`,
    ].join('\n');
}
