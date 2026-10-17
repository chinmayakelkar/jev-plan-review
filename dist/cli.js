import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeDir, given, loadSettings, PROVIDERS, readSettingsEnv, resolveConfig, resolveDataDir, saveSettings, settingsPath, withSetting, } from './config.js';
import { renderMarkdown } from './report.js';
import { runReview } from './run.js';
import { loadState } from './session.js';
const USAGE = [
    'usage: node cli.js --session <id> [--plan <file>] [--since-clear] [--data-dir <dir>]',
    '       node cli.js settings [--set <name>=<value>]... [--data-dir <dir>]',
].join('\n');
const VALUE_FLAGS = ['session', 'plan', 'data-dir'];
const SETTING_HELP = {
    provider: 'typesafe or openrouter: where Jev requests are sent',
    min_confidence: '50 to 100: answers below this are marked unsure and are never sent back to Claude',
    auto_review: 'on or off: review every plan-mode plan before it is shown',
    max_revisions: '1 or more: how many times one plan may be sent back',
    max_statements: '1 or more: how many statements one review may check',
    show_inconclusive: 'on or off: show items Jev was unsure of',
    model: 'the Jev model name',
};
function parseArgs(argv) {
    const args = { values: new Map(), sets: [], sinceClear: false, positional: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--since-clear')
            args.sinceClear = true;
        else if (arg === '--set') {
            args.sets.push(argv[index + 1] ?? '');
            index += 1;
        }
        else if (arg.startsWith('--') && VALUE_FLAGS.includes(arg.slice(2))) {
            args.values.set(arg.slice(2), argv[index + 1] ?? '');
            index += 1;
        }
        else if (!arg.startsWith('--'))
            args.positional.push(arg);
    }
    return args;
}
export function findTranscript(claudeDirPath, sessionId) {
    const projects = join(claudeDirPath, 'projects');
    if (!existsSync(projects))
        return undefined;
    for (const entry of readdirSync(projects)) {
        const candidate = join(projects, entry, `${sessionId}.jsonl`);
        if (existsSync(candidate))
            return candidate;
    }
    return undefined;
}
function showSettings(dataDir, env) {
    const settings = loadSettings(dataDir);
    const { label, keyVar } = PROVIDERS[settings.provider];
    const hasKey = Boolean(given(env[keyVar]) ?? given(readSettingsEnv(env)[keyVar]));
    const rows = Object.keys(SETTING_HELP).map((key) => {
        const value = settings[key];
        const shown = typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value);
        return `  ${key.padEnd(18)} ${shown.padEnd(12)} ${SETTING_HELP[key]}`;
    });
    return [
        'jev-plan-review settings',
        ...rows,
        hasKey
            ? `${label} API key: ${keyVar} is set.`
            : `${label} API key: ${keyVar} is not set. Add it to the "env" section of ${join(claudeDir(env), 'settings.json')} and restart Claude Code. Do not paste the key into the chat.`,
        `Saved in ${settingsPath(dataDir)}`,
    ].join('\n');
}
function runSettings(args, env) {
    const dataDir = resolveDataDir(env, args.values.get('data-dir'));
    if (args.sets.length > 0) {
        let settings = loadSettings(dataDir);
        try {
            for (const pair of args.sets) {
                const split = pair.indexOf('=');
                if (split < 1)
                    throw new Error(`expected <name>=<value>, got "${pair}"`);
                settings = withSetting(settings, pair.slice(0, split).trim(), pair.slice(split + 1));
            }
        }
        catch (error) {
            return {
                code: 1,
                output: `Nothing was changed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        saveSettings(dataDir, settings);
    }
    return { code: 0, output: showSettings(dataDir, env) };
}
export async function runCli(argv, env, asker) {
    const args = parseArgs(argv);
    if (args.positional[0] === 'settings')
        return runSettings(args, env);
    const sessionId = given(args.values.get('session'));
    if (!sessionId)
        return { code: 1, output: USAGE };
    const config = resolveConfig(env, readSettingsEnv(env), args.values.get('data-dir'));
    const state = loadState(config.dataDir, sessionId);
    const planPath = given(args.values.get('plan')) ?? given(args.positional[0]) ?? state.lastPlanFilePath;
    if (!planPath) {
        return { code: 1, output: `No plan file given, and no plan-mode plan was seen in this session.\n${USAGE}` };
    }
    if (!existsSync(planPath))
        return { code: 1, output: `Plan file not found: ${planPath}` };
    const transcriptPath = findTranscript(claudeDir(env), sessionId);
    if (!transcriptPath)
        return { code: 1, output: `No transcript found for session ${sessionId}` };
    const outcome = await runReview({
        plan: readFileSync(planPath, 'utf8'),
        transcriptPath,
        windowStart: args.sinceClear ? state.clearLine : Math.max(state.clearLine, state.approvedLine),
        config,
        ...(asker ? { asker } : {}),
    });
    if (outcome.kind === 'skipped') {
        const hint = !args.sinceClear && state.approvedLine > state.clearLine
            ? '\nA plan was approved earlier in this session. Add --since-clear to check against everything said since the last /clear.'
            : '';
        return { code: 0, output: `jev-plan-review: skipped — ${outcome.reason}${hint}` };
    }
    const overLimit = outcome.overLimit > 0
        ? `\n\n${outcome.overLimit} statement(s) were over the limit and not checked.`
        : '';
    return { code: 0, output: `${renderMarkdown(outcome.result, { showInconclusive: config.showInconclusive })}${overLimit}` };
}
export async function main() {
    const { code, output } = await runCli(process.argv.slice(2), process.env);
    process.stdout.write(`${output}\n`);
    process.exitCode = code;
}
