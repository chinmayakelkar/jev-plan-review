import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  claudeDir,
  DEFAULT_SETTINGS,
  given,
  OPTION_PREFIX,
  optionNote,
  readSettingsEnv,
  resolveConfig,
  type Env,
} from './config.js';
import type { JevAsker } from './jev.js';
import { renderMarkdown } from './report.js';
import { runReview } from './run.js';
import { loadState, saveReport } from './session.js';
import { latestPlanModePlan, readTranscript } from './transcript.js';

const USAGE =
  'usage: node cli.js --session <id> [--plan <file>] [--since-clear] [--option <name>=<value>]... [--data-dir <dir>]';
const VALUE_FLAGS = ['session', 'plan', 'data-dir'];

interface Args {
  values: Map<string, string>;
  options: string[];
  sinceClear: boolean;
  positional: string[];
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { values: new Map(), options: [], sinceClear: false, positional: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--since-clear') args.sinceClear = true;
    else if (arg === '--option') {
      args.options.push(argv[index + 1] ?? '');
      index += 1;
    } else if (arg.startsWith('--') && VALUE_FLAGS.includes(arg.slice(2))) {
      args.values.set(arg.slice(2), argv[index + 1] ?? '');
      index += 1;
    } else if (!arg.startsWith('--')) args.positional.push(arg);
  }
  return args;
}

export function findTranscript(claudeDirPath: string, sessionId: string): string | undefined {
  const projects = join(claudeDirPath, 'projects');
  if (!existsSync(projects)) return undefined;
  for (const entry of readdirSync(projects)) {
    const candidate = join(projects, entry, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unreadable(error: unknown): { code: number; output: string } {
  return { code: 1, output: `Could not read the plan: ${messageOf(error)}` };
}

export async function runCli(
  argv: readonly string[],
  env: Env,
  asker?: JevAsker,
  readStdin: () => string = () => readFileSync(0, 'utf8'),
): Promise<{ code: number; output: string }> {
  const args = parseArgs(argv);
  const sessionId = given(args.values.get('session'));
  if (!sessionId) return { code: 1, output: USAGE };

  const withOptions: Env = { ...env };
  for (const pair of args.options) {
    const split = pair.indexOf('=');
    const name = pair.slice(0, split < 0 ? undefined : split).trim();
    if (!Object.hasOwn(DEFAULT_SETTINGS, name)) {
      return {
        code: 1,
        output: `unknown option ${name}; the options are ${Object.keys(DEFAULT_SETTINGS).join(', ')}`,
      };
    }
    withOptions[OPTION_PREFIX + name.toUpperCase()] = split < 0 ? '' : pair.slice(split + 1);
  }
  const config = resolveConfig(withOptions, readSettingsEnv(env), args.values.get('data-dir'));

  const state = loadState(config.dataDir, sessionId);
  const transcriptPath = findTranscript(claudeDir(env), sessionId);
  if (!transcriptPath) return { code: 1, output: `No transcript found for session ${sessionId}` };

  const planArg = given(args.values.get('plan')) ?? given(args.positional[0]);
  let plan: string | undefined;
  let label: string;
  if (planArg === '-') {
    try {
      plan = readStdin();
    } catch (error) {
      return unreadable(error);
    }
    label = 'the plan Claude passed in';
  } else if (planArg) {
    if (!existsSync(planArg)) return { code: 1, output: `Plan file not found: ${planArg}` };
    try {
      plan = readFileSync(planArg, 'utf8');
    } catch (error) {
      return unreadable(error);
    }
    label = planArg;
  } else {
    plan = latestPlanModePlan(readTranscript(transcriptPath).slice(state.clearLine));
    label = 'the latest plan-mode plan';
  }
  if (plan === undefined) {
    return {
      code: 1,
      output: 'No plan found: no path was given, no plan was passed in, and no plan-mode plan was made in this session.',
    };
  }
  const problems = config.optionProblems ?? [];
  const checked = `Plan checked: ${label}${problems.length ? `\njev-plan-review: ${optionNote(problems)}.` : ''}`;

  const outcome = await runReview({
    plan,
    transcriptPath,
    windowStart: args.sinceClear ? state.clearLine : Math.max(state.clearLine, state.approvedLine),
    config,
    reverse: config.reverseCheck,
    ...(asker ? { asker } : {}),
  });

  if (outcome.kind === 'skipped') {
    const hint =
      !args.sinceClear && state.approvedLine > state.clearLine
        ? '\nA plan was approved earlier in this session. Add --since-clear to check against everything said since the last /clear.'
        : '';
    return { code: 0, output: `${checked}\njev-plan-review: skipped — ${outcome.reason}${hint}` };
  }

  const overLimit =
    outcome.overLimit > 0
      ? `\n\n${outcome.overLimit} statement(s) were over the limit and not checked.`
      : '';
  const markdown = `${checked}\n${renderMarkdown(outcome.result, { showInconclusive: config.showInconclusive })}${overLimit}`;
  try {
    return { code: 0, output: `${markdown}\nFull report: ${saveReport(config.dataDir, sessionId, markdown)}` };
  } catch (error) {
    return { code: 0, output: `${markdown}\nThe report could not be saved: ${messageOf(error)}` };
  }
}

export async function main(): Promise<void> {
  const { code, output } = await runCli(process.argv.slice(2), process.env);
  process.stdout.write(`${output}\n`);
  process.exitCode = code;
}
