import { truncate } from './tokens.js';
export const MAX_STATEMENT_CHARS = 500;
const FENCE = /^\s*```/;
const HEADING = /^\s*#+\s+/;
const DASH_BULLET = /^\s*[-*+•]\s+/;
const LIST_START = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const INLINE_NUMBER = /\s+(?=\d+\)\s)/;
const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
const ABBREVIATION = /(?:^|[\s(["'])(?:(?:[a-z]\.){2,}|\d+\.|(?:eg|ie|vs|cf|viz|ex|approx|incl|excl|mr|mrs|ms|dr|prof)\.)$/i;
// The segmenter knows no abbreviations or list numbers, so a piece that ends on one is joined to the next.
function sentences(text) {
    const found = [];
    let held = '';
    for (const { segment } of SENTENCES.segment(text)) {
        held += segment;
        if (ABBREVIATION.test(held.trimEnd()))
            continue;
        found.push(held);
        held = '';
    }
    if (held)
        found.push(held);
    return found;
}
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
function isMeaningful(text, minWords) {
    return (text.match(/[A-Za-z]{2,}/g) ?? []).length >= minWords;
}
export function splitText(text, minWords = 3) {
    const units = [];
    for (const paragraph of paragraphs(text)) {
        for (const numbered of paragraph.split(INLINE_NUMBER)) {
            for (const sentence of sentences(numbered)) {
                const unit = sentence.trim();
                if (isMeaningful(unit, minWords))
                    units.push(truncate(unit, MAX_STATEMENT_CHARS));
            }
        }
    }
    return units;
}
export function toStatements(sources, max = 150) {
    const all = [];
    sources.forEach((source, turn) => {
        const texts = source.kind === 'answer'
            ? [truncate(source.text, MAX_STATEMENT_CHARS)]
            : splitText(source.text, source.kind === 'document' ? 3 : 1);
        for (const text of texts) {
            all.push({
                source: source.kind,
                text,
                turn,
                ...(source.context ? { context: source.context } : {}),
                ...(source.label ? { label: source.label } : {}),
                ...(source.command ? { command: source.command } : {}),
            });
        }
    });
    const own = all.filter((statement) => statement.source !== 'document');
    const documents = all.filter((statement) => statement.source === 'document');
    const newest = own.slice(-max);
    const kept = new Set([...newest, ...documents.slice(0, max - newest.length)]);
    const statements = all
        .filter((statement) => kept.has(statement))
        .map((statement, index) => ({ id: `s${index + 1}`, ...statement }));
    return { statements, skipped: all.length - statements.length };
}
