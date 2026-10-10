import { truncate } from './tokens.js';
export const MAX_STATEMENT_CHARS = 500;
const FENCE = /^\s*```/;
const HEADING = /^\s*#+\s+/;
const DASH_BULLET = /^\s*[-*+•]\s+/;
const LIST_START = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const INLINE_NUMBER = /\s+(?=\d+\)\s)/;
const SENTENCE_END = /(?<=[.!?])\s+(?=[A-Z0-9"'([])/;
function paragraphs(text) {
    const found = [];
    let current = '';
    let fenced = false;
    const flush = () => {
        if (current.trim())
            found.push(current.trim());
        current = '';
    };
    for (const line of text.split(/\r?\n/)) {
        if (FENCE.test(line)) {
            fenced = !fenced;
            flush();
            continue;
        }
        if (fenced)
            continue;
        if (!line.trim()) {
            flush();
            continue;
        }
        const heading = HEADING.test(line);
        if (heading || LIST_START.test(line))
            flush();
        const cleaned = line.replace(HEADING, '').replace(DASH_BULLET, '').trim();
        current += current ? ` ${cleaned}` : cleaned;
        if (heading)
            flush();
    }
    flush();
    return found;
}
function isMeaningful(text) {
    return (text.match(/[A-Za-z]{2,}/g) ?? []).length >= 3;
}
export function splitText(text) {
    const units = [];
    for (const paragraph of paragraphs(text)) {
        for (const numbered of paragraph.split(INLINE_NUMBER)) {
            for (const sentence of numbered.split(SENTENCE_END)) {
                const unit = sentence.trim();
                if (isMeaningful(unit))
                    units.push(truncate(unit, MAX_STATEMENT_CHARS));
            }
        }
    }
    return units;
}
export function toStatements(sources, max = 150) {
    const all = [];
    sources.forEach((source, turn) => {
        const texts = source.kind === 'answer' ? [truncate(source.text, MAX_STATEMENT_CHARS)] : splitText(source.text);
        for (const text of texts) {
            all.push({
                source: source.kind,
                text,
                turn,
                ...(source.context ? { context: source.context } : {}),
                ...(source.label ? { label: source.label } : {}),
            });
        }
    });
    const own = all.filter((statement) => statement.source !== 'document');
    const documents = all.filter((statement) => statement.source === 'document');
    const kept = new Set([...own, ...documents].slice(0, max));
    const statements = all
        .filter((statement) => kept.has(statement))
        .map((statement, index) => ({ id: `s${index + 1}`, ...statement }));
    return { statements, skipped: all.length - statements.length };
}
