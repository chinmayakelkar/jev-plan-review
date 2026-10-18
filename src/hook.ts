import { existsSync, readFileSync } from 'node:fs';
import { readSettingsEnv, resolveConfig, type Config } from './config.js';
import type { JevAsker } from './jev.js';
import { claudeContext, renderMarkdown, revisionRequest } from './report.js';
import { runReview } from './run.js';
import { loadState, saveReport, saveState } from './session.js';
import { readTranscript, REPORT_MARKER } from './transcript.js';

const BROKEN_SETTINGS =
  'a plugin option could not be used, so its default was used and no plan was sent back; fix it in /config.';

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

function skipped(reason: string): HookOutput {
  return {
    systemMessage: `jev-plan-review: skipped — ${reason}`,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `${REPORT_MARKER} The automatic check of this plan was skipped: ${reason}`,
    },
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
    return skipped(`${outcome.reason}${config.settingsBroken ? `. ${BROKEN_SETTINGS}` : ''}`);
  }

  const newPlanFile =
    planFilePath !== undefined &&
    state.lastPlanFilePath !== undefined &&
    planFilePath !== state.lastPlanFilePath;
  const revisions = newPlanFile ? 0 : state.revisions;
  const max = config.maxRevisions;
  const open = outcome.result.verdicts.filter((verdict) => verdict.actionable);
  if (!config.settingsBroken && open.length > 0 && revisions < max) {
    const revision = revisions + 1;
    saveState(config.dataDir, sessionId, { ...remembered, revisions: revision });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: revisionRequest(outcome.result, revision, max),
      },
      systemMessage: `jev-plan-review: sent the plan back to Claude (revision ${revision} of ${max}), ${open.length} item(s) not reflected`,
    };
  }

  saveState(config.dataDir, sessionId, { ...remembered, revisions });
  const notes: string[] = config.settingsBroken ? [BROKEN_SETTINGS] : [];
  if (!config.settingsBroken && open.length > 0) {
    notes.push(`Still open after ${max} revisions; the plan is shown as it stands.`);
  }
  if (outcome.overLimit > 0) {
    notes.push(`${outcome.overLimit} statement(s) were over the limit and not checked.`);
  }
  const { showInconclusive } = config;
  const reportPath = saveReport(
    config.dataDir,
    sessionId,
    renderMarkdown(outcome.result, { showInconclusive }),
  );
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: claudeContext(outcome.result, reportPath, {
        showInconclusive,
        ...(notes.length ? { note: notes.join(' ') } : {}),
      }),
    },
  };
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
    output = skipped(error instanceof Error ? error.message : String(error));
  }
  if (output) process.stdout.write(JSON.stringify(output));
}
