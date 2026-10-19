import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PlanItem } from '../../src/review.js';
import type { Statement } from '../../src/statements.js';
import { abridge } from '../../src/tokens.js';
import { tempDir } from '../../tests/helpers.js';
import type { Actual, Outcome } from './score.js';

export type ClaudeRunner = (
  prompt: string,
) => Promise<{ text: string; ms: number; inputTokens: number; outputTokens: number; costUsd: number }>;

// Copied from src/review.ts so the baseline stays fixed when the plugin's wording changes.
const CRITERIA: Record<string, string> = {
  requirement: 'Something the user wants built or delivered',
  constraint: 'A limit or rule the work must respect',
  decision: 'A choice the user made between alternatives, including answers to questions',
  assumption: 'Something the user stated as true that the plan should rely on',
  preference: 'A softer wish about style, naming, tooling or approach',
  superseded:
    'A later statement by the user reverses or replaces this one. A statement that itself changes an earlier one is not superseded',
  not_actionable: 'A question, thanks, process remark or background with nothing for a plan to reflect',
  about_tools:
    'An instruction or answer about Claude Code, this plugin or the assistant itself, such as their settings, commands or permissions, not about the work being planned',
};
const PLAN_CRITERIA: Record<string, string> = {
  requirement: 'Something the plan says will be built or delivered',
  constraint: 'A limit or rule the plan says the work will respect',
  decision: 'A choice the plan makes between alternatives, such as a tool, library, format, design or scope',
  assumption: 'Something the plan takes as true without showing it',
  routine: 'A mechanical step any competent engineer would take, such as reading code, running tests, building, formatting or committing',
  not_actionable: 'A heading, summary, context or restatement with nothing decided',
};
const SET_ASIDE = new Set(['superseded', 'not_actionable', 'about_tools']);
const CONTEXT_CHARS = 800;
const THRESHOLD = 80;

const JUDGE_SYSTEM =
  'You check an implementation plan against what the user said while it was prepared. Answer only from the input you are given. Reply with one JSON object only.';

function claudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const exe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return process.platform === 'win32' && existsSync(exe) ? exe : 'claude';
}

export const runClaude: ClaudeRunner = (prompt) =>
  new Promise((resolve, reject) => {
    const args = ['-p', '--model', 'sonnet', '--output-format', 'json', '--tools', '', '--setting-sources', '',
      '--disable-slash-commands', '--no-session-persistence', '--system-prompt', JUDGE_SYSTEM];
    const child = spawn(claudeBin(), args, { cwd: tempDir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const reply = JSON.parse(out) as {
          result?: string;
          is_error?: boolean;
          duration_ms?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
          total_cost_usd?: number;
        };
        if (reply.is_error) throw new Error(reply.result ?? 'claude reported an error');
        resolve({
          text: reply.result ?? '',
          ms: reply.duration_ms ?? 0,
          inputTokens: reply.usage?.input_tokens ?? 0,
          outputTokens: reply.usage?.output_tokens ?? 0,
          costUsd: reply.total_cost_usd ?? 0,
        });
      } catch (error) {
        reject(new Error(`claude exited ${code}: ${(error as Error).message} ${err.slice(0, 300)}`.trim()));
      }
    });
    child.stdin.end(prompt);
  });

function turnsOf(statements: readonly Statement[]): object[] {
  const turns = new Map<number, Record<string, unknown> & { statements: object[] }>();
  for (const statement of statements) {
    let turn = turns.get(statement.turn);
    if (!turn) {
      turn = { source: statement.source, statements: [] };
      if (statement.context) {
        const head = Math.floor(CONTEXT_CHARS / 4);
        turn.said_before_by_assistant = abridge(statement.context, head, CONTEXT_CHARS - head);
      }
      if (statement.label) turn.from_document = statement.label;
      if (statement.command) turn.during_command = statement.command;
      turns.set(statement.turn, turn);
    }
    turn.statements.push({ id: statement.id, text: statement.text });
  }
  return [...turns.values()];
}

export function judgePrompt(statements: Statement[], items: PlanItem[], plan: string): string {
  const input = { turns: turnsOf(statements), plan, plan_items: items };
  return [
    'A user and a coding assistant prepared an implementation plan. `turns` lists, oldest first, what the user said, split into numbered statements. `said_before_by_assistant` only explains what the user was replying to; it is never a statement. A turn with `from_document` holds rules from a file the user gave as something the plan must follow; those count as the user\'s own. `plan_items` lists items from the plan.',
    '',
    'For each statement id:',
    `- kind: one of ${Object.entries(CRITERIA).map(([name, text]) => `${name} (${text})`).join('; ')}. Judge it as the user meant it.`,
    '- verdict: "reflected" when the plan reflects the statement: someone following the plan would end up honouring it, whether the plan says so directly or through its steps; "contradicted" when the plan conflicts with it: following the plan would go against what the user said; otherwise "missing".',
    '- confidence: 0 to 100, how sure you are of the verdict.',
    '',
    `For each plan item id, first judge its kind (${Object.entries(PLAN_CRITERIA).map(([name, text]) => `${name}: ${text}`).join('; ')}). Leave out items that are routine or not_actionable. For the rest:`,
    '- from_user: true when the user asked for, agreed to, or stated the item, directly or through a file they gave. An item that restates or carries out something the user said counts. A choice the plan made on its own, however sensible, does not count.',
    '- confidence: 0 to 100, how sure you are.',
    '',
    'Input:',
    JSON.stringify(input, null, 2),
    '',
    'Reply with one JSON object only:',
    '{"statements": {"<id>": {"kind": "<one of requirement|constraint|decision|assumption|preference|superseded|not_actionable|about_tools>", "verdict": "reflected|missing|contradicted", "confidence": <0-100>}},',
    ' "plan_items": {"<id>": {"from_user": true|false, "confidence": <0-100>}}}',
  ].join('\n');
}

interface Reply {
  statements?: Record<string, { kind?: string; verdict?: string; confidence?: number }>;
  plan_items?: Record<string, { from_user?: boolean; confidence?: number }>;
}

function parse(text: string): Reply | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return undefined;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Reply) : undefined;
  } catch {
    return undefined;
  }
}

const VERDICTS = new Set(['reflected', 'missing', 'contradicted']);

export function outcomeOfClaude(text: string, statements: Statement[], items: PlanItem[]): Outcome {
  const reply = parse(text);
  if (!reply) {
    return { statements: statements.map(({ text }) => ({ text, actual: 'unclear', conclusive: false })), flagged: [] };
  }
  return {
    statements: statements.map(({ id, text }) => {
      const answer = reply.statements?.[id];
      if (!answer || SET_ASIDE.has(answer.kind ?? '')) return { text, actual: 'set_aside' as Actual, conclusive: true };
      if (!VERDICTS.has(answer.verdict ?? '')) return { text, actual: 'unclear' as Actual, conclusive: false };
      return { text, actual: answer.verdict as Actual, conclusive: (answer.confidence ?? 0) >= THRESHOLD };
    }),
    flagged: items.flatMap(({ id, text }) => {
      const answer = reply.plan_items?.[id];
      return answer?.from_user === false ? [{ text, conclusive: (answer.confidence ?? 0) >= THRESHOLD }] : [];
    }),
  };
}
