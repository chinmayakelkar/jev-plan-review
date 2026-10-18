import { describe, expect, it } from 'vitest';
import { splitText, toStatements } from '../src/statements.js';

describe('splitText', () => {
  it('splits sentences and bullets and drops fragments', () => {
    const text =
      'Build a CLI that exports reports. It must be written in Python.\n- use SQLite for storage\n- keep it under 200 lines\n\nThanks!';
    expect(splitText(text)).toEqual([
      'Build a CLI that exports reports.',
      'It must be written in Python.',
      'use SQLite for storage',
      'keep it under 200 lines',
    ]);
  });

  it('splits numbered answers written on one line and keeps their numbers', () => {
    expect(
      splitText('2) All three kinds of plans 3) User prompts and pasted documents, never CLAUDE.md'),
    ).toEqual([
      '2) All three kinds of plans',
      '3) User prompts and pasted documents, never CLAUDE.md',
    ]);
  });

  it('joins a sentence wrapped over two lines', () => {
    expect(splitText('The export must be CSV,\nnever Excel.')).toEqual([
      'The export must be CSV, never Excel.',
    ]);
  });

  it('skips fenced code and strips heading marks', () => {
    const text = '## Storage rules for the project\n```\nconst a = 1; const b = 2;\n```\nUse Postgres for storage.';
    expect(splitText(text)).toEqual(['Storage rules for the project', 'Use Postgres for storage.']);
  });

  it('keeps an abbreviation inside its sentence', () => {
    expect(splitText('Use a database, e.g. Postgres for storage. Add tests too.')).toEqual([
      'Use a database, e.g. Postgres for storage.',
      'Add tests too.',
    ]);
    expect(splitText('Compare Postgres vs. Redis for the cache.')).toEqual([
      'Compare Postgres vs. Redis for the cache.',
    ]);
    expect(splitText('Ask Dr. Smith about the U.S. Postal rules first.')).toEqual([
      'Ask Dr. Smith about the U.S. Postal rules first.',
    ]);
  });

  it('keeps a number or a bracket that follows a stop with its sentence', () => {
    expect(splitText('It takes approx. 5 seconds. That is too slow.')).toEqual([
      'It takes approx. 5 seconds.',
      'That is too slow.',
    ]);
    expect(splitText('Support CSV, JSON, etc. (see the notes). Never use Excel.')).toEqual([
      'Support CSV, JSON, etc. (see the notes).',
      'Never use Excel.',
    ]);
  });

  it('keeps a list numbered with dots on one line together', () => {
    expect(splitText('Do these: 1. Add csv export 2. Add json export')).toEqual([
      'Do these: 1. Add csv export 2. Add json export',
    ]);
    expect(splitText('Bump it to v2.0. Then update the docs.')).toEqual([
      'Bump it to v2.0.',
      'Then update the docs.',
    ]);
  });

  it('does not take an ordinary short word for an abbreviation', () => {
    expect(splitText('I said no. Use Redis.', 1)).toEqual(['I said no.', 'Use Redis.']);
    expect(splitText('Go with option A. Also keep B.', 1)).toEqual(['Go with option A.', 'Also keep B.']);
    expect(splitText('Support CSV, JSON, etc. Never use Excel.')).toEqual([
      'Support CSV, JSON, etc.',
      'Never use Excel.',
    ]);
  });

  it('cuts a very long statement', () => {
    const [only] = splitText(`must ${'verylongword '.repeat(80)}`);
    expect(only.length).toBe(500);
    expect(only.endsWith('…')).toBe(true);
  });

  it('drops bold markers so a sentence ending inside bold splits cleanly', () => {
    expect(splitText('2. **Write with the stdlib `csv` module.** It quotes commas, and a ** b stays.')).toEqual([
      '2. Write with the stdlib `csv` module.',
      'It quotes commas, and a ** b stays.',
    ]);
  });
});

describe('toStatements', () => {
  it('carries the command onto each statement', () => {
    const { statements } = toStatements([{ kind: 'prompt', text: 'Use Go. Keep it small.', command: '/x' }]);
    expect(statements.map((statement) => statement.command)).toEqual(['/x', '/x']);
  });

  it('numbers statements in order and carries context and label', () => {
    const { statements, skipped } = toStatements([
      { kind: 'prompt', text: 'Use Postgres for storage. Keep the tool small.', context: 'Which database?' },
      { kind: 'answer', text: 'Asked: "Runtime?" — the user answered: "Node"' },
      { kind: 'document', text: 'The export must be CSV.', label: 'notes.md' },
    ]);
    expect(skipped).toBe(0);
    expect(statements).toEqual([
      { id: 's1', source: 'prompt', text: 'Use Postgres for storage.', turn: 0, context: 'Which database?' },
      { id: 's2', source: 'prompt', text: 'Keep the tool small.', turn: 0, context: 'Which database?' },
      { id: 's3', source: 'answer', text: 'Asked: "Runtime?" — the user answered: "Node"', turn: 1 },
      { id: 's4', source: 'document', text: 'The export must be CSV.', turn: 2, label: 'notes.md' },
    ]);
  });

  it('keeps a short decision the user typed, but not a short fragment of a document', () => {
    const { statements } = toStatements([
      { kind: 'prompt', text: 'Use SQLite.' },
      { kind: 'plan_feedback', text: 'No Redis.' },
      { kind: 'document', text: 'Tiny bit.', label: 'a.md' },
    ]);
    expect(statements.map((statement) => statement.text)).toEqual(['Use SQLite.', 'No Redis.']);
  });

  it('keeps the user’s own words ahead of documents when over the limit', () => {
    const { statements, skipped } = toStatements(
      [
        { kind: 'document', text: '- first rule from the document\n- second rule from the document\n- third rule from the document', label: 'd.md' },
        { kind: 'prompt', text: '- first thing the user typed\n- second thing the user typed' },
      ],
      3,
    );
    expect(skipped).toBe(2);
    expect(statements.map((statement) => [statement.id, statement.text])).toEqual([
      ['s1', 'first rule from the document'],
      ['s2', 'first thing the user typed'],
      ['s3', 'second thing the user typed'],
    ]);
  });

  it('keeps the newest of the user’s own words when they alone are over the limit', () => {
    const { statements, skipped } = toStatements(
      [
        { kind: 'prompt', text: '- first thing the user typed\n- second thing the user typed' },
        { kind: 'document', text: 'A rule from the document.', label: 'd.md' },
        { kind: 'prompt', text: 'Third thing the user typed.' },
      ],
      2,
    );
    expect(skipped).toBe(2);
    expect(statements.map((statement) => [statement.id, statement.text])).toEqual([
      ['s1', 'second thing the user typed'],
      ['s2', 'Third thing the user typed.'],
    ]);
  });
});
