import { truncate } from './tokens.js';
import type { Source, SourceKind } from './transcript.js';

export const MAX_STATEMENT_CHARS = 500;

export interface Statement {
  id: string;
  source: SourceKind;
  text: string;
  turn: number;
  context?: string;
  label?: string;
}

const FENCE = /^\s*```/;
const HEADING = /^\s*#+\s+/;
const DASH_BULLET = /^\s*[-*+•]\s+/;
const LIST_START = /^\s*(?:[-*+•]|\d+[.)])\s+/;
const INLINE_NUMBER = /\s+(?=\d+\)\s)/;
const SENTENCES = new Intl.Segmenter('en', { granularity: 'sentence' });
const ABBREVIATION =
  /(?:^|[\s(["'])(?:(?:[a-z]\.){2,}|\d+\.|(?:eg|ie|vs|cf|viz|ex|approx|incl|excl|mr|mrs|ms|dr|prof)\.)$/i;

// The segmenter knows no abbreviations or list numbers, so a piece that ends on one is joined to the next.
function sentences(text: string): string[] {
  const found: string[] = [];
  let held = '';
  for (const { segment } of SENTENCES.segment(text)) {
    held += segment;
    if (ABBREVIATION.test(held.trimEnd())) continue;
    found.push(held);
    held = '';
  }
  if (held) found.push(held);
  return found;
}

function paragraphs(text: string): string[] {
  const found: string[] = [];
  let current = '';
  let fenced = false;
  const flush = (): void => {
    if (current.trim()) found.push(current.trim());
    current = '';
  };
  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      flush();
      continue;
    }
    if (fenced) continue;
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = HEADING.test(line);
    if (heading || LIST_START.test(line)) flush();
    const cleaned = line.replace(HEADING, '').replace(DASH_BULLET, '').trim();
    current += current ? ` ${cleaned}` : cleaned;
    if (heading) flush();
  }
  flush();
  return found;
}

function isMeaningful(text: string, minWords: number): boolean {
  return (text.match(/[A-Za-z]{2,}/g) ?? []).length >= minWords;
}

export function splitText(text: string, minWords = 3): string[] {
  const units: string[] = [];
  for (const paragraph of paragraphs(text)) {
    for (const numbered of paragraph.split(INLINE_NUMBER)) {
      for (const sentence of sentences(numbered)) {
        const unit = sentence.trim();
        if (isMeaningful(unit, minWords)) units.push(truncate(unit, MAX_STATEMENT_CHARS));
      }
    }
  }
  return units;
}

export function toStatements(
  sources: readonly Source[],
  max = 150,
): { statements: Statement[]; skipped: number } {
  const all: Omit<Statement, 'id'>[] = [];
  sources.forEach((source, turn) => {
    const texts =
      source.kind === 'answer'
        ? [truncate(source.text, MAX_STATEMENT_CHARS)]
        : splitText(source.text, source.kind === 'document' ? 3 : 1);
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
  const newest = own.slice(-max);
  const kept = new Set([...newest, ...documents.slice(0, max - newest.length)]);
  const statements = all
    .filter((statement) => kept.has(statement))
    .map((statement, index) => ({ id: `s${index + 1}`, ...statement }));
  return { statements, skipped: all.length - statements.length };
}
