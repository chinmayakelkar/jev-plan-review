import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODEL, SYSTEM_ONE_URL } from './jev.js';
export const PROVIDERS = {
    typesafe: { label: 'TypeSafe', url: SYSTEM_ONE_URL, keyVar: 'TYPESAFE_API_KEY' },
    openrouter: {
        label: 'OpenRouter',
        url: 'https://openrouter.ai/api/v1/systemone',
        keyVar: 'OPENROUTER_API_KEY',
    },
};
export const DEFAULT_SETTINGS = {
    provider: 'typesafe',
    min_confidence: 80,
    auto_review: true,
    revise: true,
    share_with_claude: true,
    model: DEFAULT_MODEL,
};
export function given(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed && !trimmed.startsWith('${') ? trimmed : undefined;
}
function toggle(key, value) {
    if (['on', 'true', 'yes'].includes(value))
        return true;
    if (['off', 'false', 'no'].includes(value))
        return false;
    throw new Error(`${key} must be on or off`);
}
export function withSetting(settings, key, raw) {
    const text = String(raw).trim();
    const value = text.toLowerCase();
    switch (key) {
        case 'provider':
            if (value !== 'typesafe' && value !== 'openrouter') {
                throw new Error('provider must be typesafe or openrouter');
            }
            return { ...settings, provider: value };
        case 'min_confidence': {
            const percent = Number(value.replace(/%$/, '') || NaN);
            if (!(percent >= 50 && percent <= 100)) {
                throw new Error('min_confidence must be a number from 50 to 100');
            }
            return { ...settings, min_confidence: percent };
        }
        case 'auto_review':
        case 'revise':
        case 'share_with_claude':
            return { ...settings, [key]: toggle(key, value) };
        case 'model':
            if (!text)
                throw new Error('model must not be empty');
            return { ...settings, model: text };
        default:
            throw new Error(`unknown setting ${key}; the settings are ${Object.keys(DEFAULT_SETTINGS).join(', ')}`);
    }
}
export function settingsPath(dataDir) {
    return join(dataDir, 'settings.json');
}
export function loadSettings(dataDir) {
    let saved;
    try {
        saved = JSON.parse(readFileSync(settingsPath(dataDir), 'utf8'));
    }
    catch {
        return DEFAULT_SETTINGS;
    }
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved))
        return DEFAULT_SETTINGS;
    let settings = DEFAULT_SETTINGS;
    for (const [key, value] of Object.entries(saved)) {
        try {
            settings = withSetting(settings, key, value);
        }
        catch {
            continue;
        }
    }
    return settings;
}
export function saveSettings(dataDir, settings) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(settingsPath(dataDir), `${JSON.stringify(settings, null, 2)}\n`);
}
export function claudeDir(env) {
    return given(env.CLAUDE_CONFIG_DIR) ?? join(homedir(), '.claude');
}
export function readSettingsEnv(env) {
    const path = join(claudeDir(env), 'settings.json');
    if (!existsSync(path))
        return {};
    try {
        const settings = JSON.parse(readFileSync(path, 'utf8'));
        return settings.env !== null && typeof settings.env === 'object' ? settings.env : {};
    }
    catch {
        return {};
    }
}
export function resolveDataDir(env, override) {
    return given(override) ?? given(env.CLAUDE_PLUGIN_DATA) ?? join(tmpdir(), 'jev-plan-review');
}
export function resolveConfig(env, settingsEnv = {}, dataDir) {
    const dir = resolveDataDir(env, dataDir);
    const settings = loadSettings(dir);
    const { url, keyVar } = PROVIDERS[settings.provider];
    const apiKey = given(env[keyVar]) ?? given(settingsEnv[keyVar]);
    return {
        ...(apiKey ? { apiKey } : {}),
        provider: settings.provider,
        baseUrl: url,
        model: settings.model,
        minConfidence: settings.min_confidence / 100,
        autoReview: settings.auto_review,
        revise: settings.revise,
        shareWithClaude: settings.share_with_claude,
        dataDir: dir,
    };
}
