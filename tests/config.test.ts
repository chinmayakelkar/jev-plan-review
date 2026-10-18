import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  given,
  readOptions,
  readSettingsEnv,
  resolveConfig,
  withSetting,
} from '../src/config.js';
import { tempDir } from './helpers.js';

describe('given', () => {
  it('treats empty text and unsubstituted placeholders as absent', () => {
    expect(given('  value ')).toBe('value');
    expect(given('')).toBeUndefined();
    expect(given('${CLAUDE_PLUGIN_DATA}')).toBeUndefined();
    expect(given(80)).toBeUndefined();
  });
});

describe('readOptions', () => {
  it('starts from the defaults', () => {
    expect(readOptions({})).toEqual({ settings: DEFAULT_SETTINGS, problems: [] });
    expect(DEFAULT_SETTINGS).toEqual({
      provider: 'typesafe',
      min_confidence: 80,
      auto_review: true,
      max_revisions: 2,
      max_statements: 150,
      show_inconclusive: true,
      reverse_plan_check: true,
      model: 'jev-latest',
    });
  });

  it('reads the plugin options from the environment', () => {
    expect(
      readOptions({
        CLAUDE_PLUGIN_OPTION_MIN_CONFIDENCE: '90',
        CLAUDE_PLUGIN_OPTION_AUTO_REVIEW: 'false',
        CLAUDE_PLUGIN_OPTION_PROVIDER: 'openrouter',
      }),
    ).toEqual({
      settings: { ...DEFAULT_SETTINGS, min_confidence: 90, auto_review: false, provider: 'openrouter' },
      problems: [],
    });
  });

  it('falls back to the default for a bad value and says so', () => {
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_MIN_CONFIDENCE: 'abc' })).toEqual({
      settings: DEFAULT_SETTINGS,
      problems: ['min_confidence must be a number from 50 to 100; used 80'],
    });
  });

  it('treats an unsubstituted placeholder as not given', () => {
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_MODEL: '${user_config.model}' })).toEqual({
      settings: DEFAULT_SETTINGS,
      problems: [],
    });
  });
});

describe('withSetting', () => {
  it('accept plain words for values and say what is wrong with a bad one', () => {
    expect(withSetting(DEFAULT_SETTINGS, 'auto_review', 'OFF').auto_review).toBe(false);
    expect(withSetting(DEFAULT_SETTINGS, 'auto_review', 'no').auto_review).toBe(false);
    expect(withSetting(DEFAULT_SETTINGS, 'min_confidence', '90%').min_confidence).toBe(90);
    expect(withSetting(DEFAULT_SETTINGS, 'provider', 'OpenRouter').provider).toBe('openrouter');
    expect(withSetting(DEFAULT_SETTINGS, 'model', ' jev-1.13 ').model).toBe('jev-1.13');
    expect(() => withSetting(DEFAULT_SETTINGS, 'min_confidence', '49')).toThrow(
      'min_confidence must be a number from 50 to 100',
    );
    expect(() => withSetting(DEFAULT_SETTINGS, 'min_confidence', '')).toThrow(
      'min_confidence must be a number from 50 to 100',
    );
    expect(() => withSetting(DEFAULT_SETTINGS, 'auto_review', 'maybe')).toThrow('auto_review must be on or off');
    expect(() => withSetting(DEFAULT_SETTINGS, 'revise', 'off')).toThrow('unknown setting revise');
    expect(() => withSetting(DEFAULT_SETTINGS, 'share_with_claude', 'off')).toThrow('unknown setting share_with_claude');
    expect(() => withSetting(DEFAULT_SETTINGS, 'provider', 'azure')).toThrow(
      'provider must be typesafe or openrouter',
    );
    expect(withSetting(DEFAULT_SETTINGS, 'max_revisions', '25').max_revisions).toBe(25);
    for (const bad of ['0', '2.5', 'many', '']) {
      expect(() => withSetting(DEFAULT_SETTINGS, 'max_revisions', bad)).toThrow(
        'max_revisions must be a whole number, 1 or more',
      );
    }
    expect(withSetting(DEFAULT_SETTINGS, 'max_statements', '400').max_statements).toBe(400);
    expect(() => withSetting(DEFAULT_SETTINGS, 'max_statements', '0')).toThrow(
      'max_statements must be a whole number, 1 or more',
    );
    expect(withSetting(DEFAULT_SETTINGS, 'show_inconclusive', 'off').show_inconclusive).toBe(false);
    expect(withSetting(DEFAULT_SETTINGS, 'reverse_plan_check', 'off').reverse_plan_check).toBe(false);
    expect(() => withSetting(DEFAULT_SETTINGS, 'reverse_plan_check', 'maybe')).toThrow(
      'reverse_plan_check must be on or off',
    );
    expect(() => withSetting(DEFAULT_SETTINGS, 'model', ' ')).toThrow('model must not be empty');
    expect(() => withSetting(DEFAULT_SETTINGS, 'colour', 'blue')).toThrow('unknown setting colour');
  });
});

describe('resolveConfig', () => {
  it('uses defaults when nothing is set', () => {
    const dir = tempDir();
    expect(resolveConfig({}, {}, dir)).toEqual({
      provider: 'typesafe',
      baseUrl: 'https://api.typesafe.ai/v1/systemone',
      model: 'jev-latest',
      minConfidence: 0.8,
      autoReview: true,
      maxRevisions: 2,
      maxStatements: 150,
      showInconclusive: true,
      reverseCheck: true,
      dataDir: dir,
      settingsFile: '~/.claude/settings.json',
    });
    expect(resolveConfig({ CLAUDE_PLUGIN_DATA: dir }).dataDir).toBe(dir);
    expect(resolveConfig({}).dataDir.endsWith('jev-plan-review')).toBe(true);
  });

  it('reads the plugin options and the key of the chosen provider', () => {
    const dir = tempDir();
    const env = {
      TYPESAFE_API_KEY: 'ts-key',
      OPENROUTER_API_KEY: 'or-key',
      CLAUDE_PLUGIN_OPTION_PROVIDER: 'openrouter',
      CLAUDE_PLUGIN_OPTION_MIN_CONFIDENCE: '70',
      CLAUDE_PLUGIN_OPTION_AUTO_REVIEW: 'false',
      CLAUDE_PLUGIN_OPTION_MAX_STATEMENTS: '40',
      CLAUDE_PLUGIN_OPTION_SHOW_INCONCLUSIVE: 'false',
    };
    expect(resolveConfig(env, {}, dir)).toMatchObject({
      apiKey: 'or-key',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1/systemone',
      minConfidence: 0.7,
      autoReview: false,
      maxStatements: 40,
      showInconclusive: false,
    });
  });

  it('falls back to settings.json for the key', () => {
    const dir = tempDir();
    expect(resolveConfig({ TYPESAFE_API_KEY: 'from-env' }, { TYPESAFE_API_KEY: 'from-settings' }, dir).apiKey).toBe('from-env');
    expect(resolveConfig({}, { TYPESAFE_API_KEY: 'from-settings' }, dir).apiKey).toBe('from-settings');
    expect(resolveConfig({ OPENROUTER_API_KEY: 'other-provider' }, {}, dir).apiKey).toBeUndefined();
  });
});

describe('resolveConfig with a plugin option it cannot use', () => {
  it('uses the default and names what was wrong', () => {
    const options = readOptions({ CLAUDE_PLUGIN_OPTION_MAX_REVISIONS: '2.5' });
    expect(options.settings.max_revisions).toBe(2);
    expect(options.problems).toEqual(['max_revisions must be a whole number, 1 or more; used 2']);
    expect(readOptions({ CLAUDE_PLUGIN_OPTION_AUTO_REVIEW: 'maybe' }).problems).toEqual([
      'auto_review must be on or off; used on',
    ]);
  });

  it('carries the problems in the config, and none for a missing option', () => {
    const dir = tempDir();
    expect(resolveConfig({ CLAUDE_PLUGIN_OPTION_MIN_CONFIDENCE: '20' }, {}, dir).optionProblems).toEqual([
      'min_confidence must be a number from 50 to 100; used 80',
    ]);
    expect(resolveConfig({}, {}, dir).optionProblems).toBeUndefined();
  });
});

describe('resolveConfig settingsFile', () => {
  it('names the settings file in the Claude config directory', () => {
    expect(resolveConfig({ CLAUDE_CONFIG_DIR: 'D:/cfg' }, {}, tempDir()).settingsFile).toBe(join('D:/cfg', 'settings.json'));
    expect(resolveConfig({}, {}, tempDir()).settingsFile).toBe('~/.claude/settings.json');
  });
});

describe('readSettingsEnv', () => {
  it('reads env from settings.json in the Claude config directory', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { TYPESAFE_API_KEY: 'k' } }));
    expect(readSettingsEnv({ CLAUDE_CONFIG_DIR: dir })).toEqual({ TYPESAFE_API_KEY: 'k' });
  });

  it('returns nothing for a missing or broken file', () => {
    const dir = tempDir();
    expect(readSettingsEnv({ CLAUDE_CONFIG_DIR: dir })).toEqual({});
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{');
    expect(readSettingsEnv({ CLAUDE_CONFIG_DIR: dir })).toEqual({});
  });
});
