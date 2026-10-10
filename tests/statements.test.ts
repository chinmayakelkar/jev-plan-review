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

  it('cuts a very long statement', () => {
    const [only] = splitText(`must ${'verylongword '.repeat(80)}`);
    expect(only.length).toBe(500);
    expect(only.endsWith('…')).toBe(true);
  });
});

describe('toStatements', () => {
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
});
