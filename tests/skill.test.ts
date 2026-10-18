import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const KEYS = [
  'provider',
  'min_confidence',
  'auto_review',
  'max_revisions',
  'max_statements',
  'show_inconclusive',
  'reverse_plan_check',
  'model',
];

describe('review skill', () => {
  const skill = readFileSync(new URL('../skills/review/SKILL.md', import.meta.url), 'utf8');

  it('single-quotes every plugin option in all three commands', () => {
    for (const key of KEYS) {
      expect(skill.split(`--option '${key}=\${user_config.${key}}'`)).toHaveLength(4);
    }
  });

  it('has no other user_config placeholder, such as a double-quoted one', () => {
    expect(skill.split('${user_config.')).toHaveLength(KEYS.length * 3 + 1);
  });
});
