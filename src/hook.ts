import { existsSync, readFileSync } from 'node:fs';
import { readSettingsEnv, resolveConfig, type Config } from './config.js';
import type { JevAsker } from './jev.js';
import { claudeContext, renderMarkdown, renderText, revisionRequest } from './report.js';
import { runReview } from './run.js';
import { loadState, saveReport, saveState } from './session.js';
import { readTranscript } from './transcript.js';

export const MAX_REVISIONS = 2;

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  source?: string;
  agent_id?: string;
  tool_input?: { plan?: string; planFilePath?: string };
}

export interface HookOutput {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: 'PreToolUse';
    permissionDecision?: 'deny';
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

function planText(input: HookInput): string {
  const plan = input.tool_input?.plan;
  if (plan?.trim()) return plan;
  const path = input.tool_input?.planFilePath;
  return path && existsSync(path) ? readFileSync(path, 'utf8') : '';
}

export async function handleHook(
  input: HookInput,
  config: Config,
  asker?: JevAsker,
): Promise<HookOutput | undefined> {
  const { session_id: sessionId, transcript_path: transcriptPath } = input;
  if (!sessionId || !transcriptPath || input.agent_id) return undefined;
  const state = loadState(config.dataDir, sessionId);

  if (input.hook_event_name === 'SessionStart') {
    if (input.source === 'clear') {
      saveState(config.dataDir, sessionId, {
        clearLine: readTranscript(transcriptPath).length,
        approvedLine: 0,
        revisions: 0,
      });
    }
    return undefined;
  }

  if (input.hook_event_name === 'PostToolUse') {
    saveState(config.dataDir, sessionId, {
      ...state,
      approvedLine: readTranscript(transcriptPath).length,
      revisions: 0,
    });
    return undefined;
  }

  if (input.hook_event_name !== 'PreToolUse') return undefined;

  const planFilePath = input.tool_input?.planFilePath;
  const remembered = { ...state, ...(planFilePath ? { lastPlanFilePath: planFilePath } : {}) };
  if (!config.autoReview) {
    saveState(config.dataDir, sessionId, remembered);
    return undefined;
  }
  const outcome = await runReview({
    plan: planText(input),
    transcriptPath,
    windowStart: Math.max(state.clearLine, state.approvedLine),
    config,
    ...(asker ? { asker } : {}),
  });

  if (outcome.kind === 'skipped') {
    saveState(config.dataDir, sessionId, remembered);
    return { systemMessage: `jev-plan-review: skipped — ${outcome.reason}` };
  }

  const open = outcome.result.verdicts.filter((verdict) => verdict.actionable);
  if (config.revise && open.length > 0 && state.revisions < MAX_REVISIONS) {
    const revision = state.revisions + 1;
    saveState(config.dataDir, sessionId, { ...remembered, revisions: revision });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: revisionRequest(outcome.result, revision, MAX_REVISIONS),
      },
      systemMessage: `jev-plan-review: sent the plan back to Claude (revision ${revision} of ${MAX_REVISIONS}), ${open.length} item(s) not reflected`,
    };
  }

  saveState(config.dataDir, sessionId, { ...remembered, revisions: 0 });
  const notes: string[] = [];
  if (config.revise && open.length > 0) {
    notes.push(`Still open after ${MAX_REVISIONS} revisions; the plan is shown as it stands.`);
  }
  if (outcome.overLimit > 0) {
    notes.push(`${outcome.overLimit} statement(s) were over the limit and not checked.`);
  }
  const reportPath = saveReport(config.dataDir, sessionId, renderMarkdown(outcome.result));
  const output: HookOutput = {
    systemMessage: renderText(outcome.result, notes.length ? { note: notes.join(' ') } : {}),
  };
  if (config.shareWithClaude) {
    output.hookSpecificOutput = {
      hookEventName: 'PreToolUse',
      additionalContext: claudeContext(outcome.result, reportPath),
    };
  }
  return output;
}

export async function main(): Promise<void> {
  let output: HookOutput | undefined;
  try {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    const input = JSON.parse(raw) as HookInput;
    output = await handleHook(input, resolveConfig(process.env, readSettingsEnv(process.env)));
  } catch (error) {
    output = {
      systemMessage: `jev-plan-review: skipped — ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (output) process.stdout.write(JSON.stringify(output));
}
