import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  given,
  loadSettings,
  readSettingsEnv,
  resolveConfig,
  saveSettings,
  settingsPath,
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

describe('settings', () => {
  it('start from the defaults', () => {
    expect(loadSettings(tempDir())).toEqual({
      provider: 'typesafe',
      min_confidence: 80,
      auto_review: true,
      max_revisions: 2,
      max_statements: 150,
      show_inconclusive: true,
      model: 'jev-latest',
    });
  });

  it('save and load', () => {
    const dir = join(tempDir(), 'not-made-yet');
    const changed = { ...DEFAULT_SETTINGS, provider: 'openrouter' as const, auto_review: false };
    saveSettings(dir, changed);
    expect(loadSettings(dir)).toEqual(changed);
  });

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
    expect(() => withSetting(DEFAULT_SETTINGS, 'model', ' ')).toThrow('model must not be empty');
    expect(() => withSetting(DEFAULT_SETTINGS, 'colour', 'blue')).toThrow('unknown setting colour');
  });

  it('fall back to the default for a broken file or a bad value', () => {
    const dir = tempDir();
    writeFileSync(settingsPath(dir), '{');
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
    writeFileSync(settingsPath(dir), JSON.stringify({ auto_review: false, min_confidence: 'high', revise: false, share_with_claude: false }));
    expect(loadSettings(dir)).toEqual({ ...DEFAULT_SETTINGS, auto_review: false });
    writeFileSync(settingsPath(dir), '[1, 2]');
    expect(loadSettings(dir)).toEqual(DEFAULT_SETTINGS);
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
      dataDir: dir,
    });
    expect(resolveConfig({ CLAUDE_PLUGIN_DATA: dir }).dataDir).toBe(dir);
    expect(resolveConfig({}).dataDir.endsWith('jev-plan-review')).toBe(true);
  });

  it('reads the saved settings and the key of the chosen provider', () => {
    const dir = tempDir();
    saveSettings(dir, {
      ...DEFAULT_SETTINGS,
      provider: 'openrouter',
      min_confidence: 70,
      auto_review: false,
      max_statements: 40,
      show_inconclusive: false,
    });
    const env = { TYPESAFE_API_KEY: 'ts-key', OPENROUTER_API_KEY: 'or-key' };
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

describe('resolveConfig with a settings file it cannot fully read', () => {
  it('uses the defaults and says the file is broken', () => {
    const dir = tempDir();
    writeFileSync(settingsPath(dir), '{"auto_review": false,');
    expect(resolveConfig({}, {}, dir)).toMatchObject({ autoReview: true, settingsBroken: true });
    writeFileSync(settingsPath(dir), JSON.stringify({ model: {} }));
    expect(resolveConfig({}, {}, dir)).toMatchObject({
      model: 'jev-latest',
      settingsBroken: true,
    });
  });

  it('does not call a missing file or an unknown key broken', () => {
    const dir = tempDir();
    expect(resolveConfig({}, {}, dir).settingsBroken).toBeUndefined();
    writeFileSync(settingsPath(dir), JSON.stringify({ extra: 1 }));
    expect(resolveConfig({}, {}, dir)).toMatchObject({ autoReview: true });
    expect(resolveConfig({}, {}, dir).settingsBroken).toBeUndefined();
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
