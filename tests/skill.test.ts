import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/config.js';

const KEYS = [
  'provider',
  'min_confidence',
  'auto_review',
  'max_revisions',
  'max_statements',
  'show_inconclusive',
  'reverse_plan_check',
];

describe('plugin manifest', () => {
  const { userConfig } = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'));

  it('declares exactly the settings the plugin reads', () => {
    expect(Object.keys(userConfig)).toEqual(Object.keys(DEFAULT_SETTINGS));
    expect(KEYS).toEqual(Object.keys(DEFAULT_SETTINGS));
  });

  it('offers max_revisions as a picker from 1 to 5', () => {
    expect(userConfig.max_revisions).toMatchObject({ type: 'string', options: ['1', '2', '3', '4', '5'], default: '2' });
  });
});

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
