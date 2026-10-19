import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSettingsEnv, resolveConfig, type Config } from '../../src/config.js';
import type { JevAsker } from '../../src/jev.js';
import { planItems } from '../../src/review.js';
import { runReview } from '../../src/run.js';
import { toStatements } from '../../src/statements.js';
import { collectSources, readTranscript } from '../../src/transcript.js';
import { judgePrompt, outcomeOfClaude, runClaude, type ClaudeRunner } from './claude.js';
import { longScenario } from './long.js';
import { buildTranscript, loadScenarios, type Scenario } from './scenario.js';
import { outcomeOfReview, score, type Outcome, type Score } from './score.js';

const SYSTEMS = ['jev', 'sonnet'] as const;
type System = (typeof SYSTEMS)[number];
const HOOK_SECONDS = 180;

interface Run {
  system: System;
  run: number;
  score?: Score;
  outcome?: Outcome;
  failed?: string;
  raw?: string;
  seconds: number;
  requests?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

function stamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function loadConfig(maxStatements?: number): Config {
  const config = resolveConfig(process.env, readSettingsEnv(process.env));
  return maxStatements ? { ...config, maxStatements } : config;
}

async function runJev(
  scenario: Scenario,
  path: string,
  config: Config,
  run: number,
  reverse: boolean,
  asker?: JevAsker,
): Promise<Run> {
  const started = Date.now();
  const outcome = await runReview({ plan: scenario.plan, transcriptPath: path, windowStart: 0, config, asker, reverse });
  const failed = (reason: string, seconds: number): Run => ({ system: 'jev', run, failed: reason, seconds, inputTokens: 0, outputTokens: 0 });
  if (outcome.kind === 'skipped') return failed(outcome.reason, (Date.now() - started) / 1000);
  const { result } = outcome;
  if (result.reverseError) return failed(`reverse check failed: ${result.reverseError}`, result.elapsedMs / 1000);
  const statements = toStatements(collectSources(readTranscript(path)), config.maxStatements).statements;
  const mapped = outcomeOfReview(result, statements);
  return {
    system: 'jev',
    run,
    outcome: mapped,
    score: score(scenario, mapped),
    seconds: result.elapsedMs / 1000,
    requests: result.requests,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}

async function runSonnet(scenario: Scenario, path: string, config: Config, run: number, claude: ClaudeRunner): Promise<Run> {
  const { statements } = toStatements(collectSources(readTranscript(path)), config.maxStatements);
  const { items } = planItems(scenario.plan, config.maxStatements);
  try {
    const reply = await claude(judgePrompt(statements, items, scenario.plan));
    const mapped = outcomeOfClaude(reply.text, statements, items);
    return {
      system: 'sonnet',
      run,
      outcome: mapped,
      score: score(scenario, mapped),
      raw: reply.text,
      seconds: reply.ms / 1000,
      inputTokens: reply.inputTokens,
      outputTokens: reply.outputTokens,
      costUsd: reply.costUsd,
    };
  } catch (error) {
    return { system: 'sonnet', run, failed: (error as Error).message, seconds: 0, inputTokens: 0, outputTokens: 0 };
  }
}

function runFile(scenario: Scenario, run: Run): string {
  const actuals = new Map((run.outcome?.statements ?? []).map((s) => [s.text.replace(/\s+/g, ' ').trim(), s]));
  const lines = [`# ${scenario.name}, ${run.system}, run ${run.run}`, '', scenario.about, ''];
  if (run.failed) return [...lines, `Failed: ${run.failed}`, ''].join('\n');
  lines.push('| Statement | Expected | Actual | Conclusive |', '| --- | --- | --- | --- |');
  for (const { text, verdict } of scenario.expect.statements) {
    const found = actuals.get(text.replace(/\s+/g, ' ').trim());
    lines.push(`| ${text.replace(/\|/g, '\\|')} | ${verdict} | ${found?.actual ?? 'not produced'} | ${found ? (found.conclusive ? 'yes' : 'no') : ''} |`);
  }
  lines.push('', 'Plan items judged not from the user:', '');
  for (const item of run.outcome?.flagged ?? []) lines.push(`- ${item.conclusive ? '' : '(inconclusive) '}${item.text}`);
  if (!run.outcome?.flagged.length) lines.push('- none');
  lines.push('', `Expected not from the user: ${(scenario.expect.notFromUser ?? []).join('; ') || 'none'}`, '');
  if (run.raw !== undefined) lines.push('Reply as given:', '', '````', run.raw, '````', '');
  return lines.join('\n');
}

const COUNTERS = ['unsure', 'wrongNo', 'missedProblem', 'flaggedRight', 'flaggedWrong', 'unflaggedWrong'] as const;
const HEADER =
  '| Scenario | System | Runs ok | Correct | Unsure | Wrong NO | Missed problem | Flagged right | Flagged wrong | Not flagged | Seconds | Requests | Input tokens | Output tokens | Cost USD |';

function row(name: string, system: System, runs: Run[]): string {
  const ok = runs.filter((run) => run.score);
  const mean = (pick: (run: Run) => number): string =>
    ok.length ? (ok.reduce((sum, run) => sum + pick(run), 0) / ok.length).toFixed(1) : '-';
  const correct = ok.reduce((sum, run) => sum + (run.score?.correct ?? 0), 0);
  const total = ok.reduce((sum, run) => sum + (run.score?.total ?? 0), 0);
  return [
    name,
    system,
    `${ok.length}/${runs.length}`,
    total ? `${((100 * correct) / total).toFixed(0)}%` : '-',
    ...COUNTERS.map((key) => mean((run) => run.score?.[key] ?? 0)),
    mean((run) => run.seconds),
    system === 'jev' ? mean((run) => run.requests ?? 0) : '-',
    mean((run) => run.inputTokens),
    mean((run) => run.outputTokens),
    system === 'sonnet' ? (ok.length ? (ok.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) / ok.length).toFixed(3) : '-') : '-',
  ].join(' | ').replace(/^/, '| ').concat(' |');
}

export async function bench(options: {
  scenarios: Scenario[];
  runs: number;
  asker?: JevAsker;
  claude: ClaudeRunner;
  out: string;
}): Promise<string> {
  const dir = join(options.out, stamp());
  mkdirSync(dir, { recursive: true });
  const config = loadConfig();
  const all: { scenario: Scenario; runs: Run[] }[] = [];
  for (const scenario of options.scenarios) {
    const path = buildTranscript(scenario);
    const runs: Run[] = [];
    for (let run = 1; run <= options.runs; run += 1) {
      runs.push(await runJev(scenario, path, config, run, true, options.asker));
      runs.push(await runSonnet(scenario, path, config, run, options.claude));
    }
    for (const run of runs) writeFileSync(join(dir, `${scenario.name}-${run.system}-${run.run}.md`), runFile(scenario, run));
    all.push({ scenario, runs });
  }
  const separator = `|${' --- |'.repeat(HEADER.split('|').length - 2)}`;
  const lines = ['# Benchmark', '', `${options.runs} runs per scenario per system. Means per run.`, '', HEADER, separator];
  for (const { scenario, runs } of all) {
    for (const system of SYSTEMS) lines.push(row(scenario.name, system, runs.filter((run) => run.system === system)));
  }
  lines.push('', '## Totals', '', HEADER, separator);
  for (const system of SYSTEMS) {
    lines.push(row('all', system, all.flatMap(({ runs }) => runs.filter((run) => run.system === system))));
  }
  const failed = all.flatMap(({ scenario, runs }) => runs.filter((run) => run.failed).map((run) => ({ scenario, run })));
  lines.push('', '## Failed runs', '');
  for (const { scenario, run } of failed) lines.push(`- ${scenario.name}, ${run.system}, run ${run.run}: ${run.failed}`);
  if (!failed.length) lines.push('- none');
  const summary = join(dir, 'summary.md');
  writeFileSync(summary, `${lines.join('\n')}\n`);
  return summary;
}

export async function scale(options: { sizes: number[]; runs: number; asker?: JevAsker; out: string }): Promise<string> {
  const dir = join(options.out, `${stamp()}-scale`);
  mkdirSync(dir, { recursive: true });
  const lines = [
    '# Scale',
    '',
    '| Statements | Run | Seconds | Over 180 s | Requests | Input tokens | Output tokens | Correct | Skipped because |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const size of options.sizes) {
    const scenario = longScenario(size);
    const path = buildTranscript(scenario);
    const config = loadConfig(size);
    for (let run = 1; run <= options.runs; run += 1) {
      const result = await runJev(scenario, path, config, run, false, options.asker);
      writeFileSync(join(dir, `${scenario.name}-jev-${run}.md`), runFile(scenario, result));
      const correct = result.score ? `${result.score.correct}/${result.score.total}` : '-';
      lines.push(
        `| ${size} | ${run} | ${result.seconds.toFixed(1)} | ${result.seconds > HOOK_SECONDS ? 'yes' : 'no'} | ${result.requests ?? '-'} | ${result.inputTokens} | ${result.outputTokens} | ${correct} | ${result.failed ?? ''} |`,
      );
    }
  }
  const summary = join(dir, 'scale.md');
  writeFileSync(summary, `${lines.join('\n')}\n`);
  return summary;
}

async function main(argv: string[]): Promise<void> {
  const at = argv.indexOf('--out');
  const out = at >= 0 ? argv[at + 1] : undefined;
  if (!out) {
    console.error('usage: npm run bench -- --out <dir> [--scale] [scenario ...]');
    process.exit(1);
  }
  const names = argv.filter((arg, index) => !arg.startsWith('--') && index !== at + 1);
  const summary = argv.includes('--scale')
    ? await scale({ sizes: [50, 150, 300, 500], runs: 2, out })
    : await bench({
        scenarios: loadScenarios(join(dirname(fileURLToPath(import.meta.url)), 'scenarios'), names),
        runs: 2,
        claude: runClaude,
        out,
      });
  console.log(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
