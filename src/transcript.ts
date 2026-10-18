import { existsSync, readFileSync } from 'node:fs';

export const DENY_MARKER = '[jev-plan-review]';
export const REPORT_MARKER = '[jev-plan-review report]';

export type SourceKind = 'prompt' | 'answer' | 'plan_feedback' | 'document';

export interface Source {
  kind: SourceKind;
  text: string;
  context?: string;
  label?: string;
}

interface Block {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  input?: { plan?: unknown; planFilePath?: unknown };
}

export interface TranscriptRecord {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  origin?: { kind?: string };
  message?: { content?: string | Block[] };
  toolUseResult?: unknown;
  attachment?: {
    type?: string;
    filename?: string;
    displayPath?: string;
    prompt?: string;
    planFilePath?: string;
    isSubAgent?: boolean;
    origin?: { kind?: string };
    content?: { type?: string; file?: { content?: string } };
  };
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const COMMAND = /<command-(?:name|message)>/;
const OWN_COMMAND = /<command-name>\/jev-plan-review:/;
const COMMAND_ARGS =/<command-args>([\s\S]*?)<\/command-args>/;
const NOISE =
  /^(?:<local-command-|<bash-(?:input|stdout|stderr)>|<task-notification>|\[Request interrupted)/;
const USER_SAID = /the user said:\s*/i;
const INSTRUCTION_FILE = /(?:^|\/)claude(?:\.local)?\.md$/;
const MENTION = /(?:^|\s)@(?:"([^"]+)"|(\S+))/g;

export function readTranscript(path: string): TranscriptRecord[] {
  if (!existsSync(path)) return [];
  const records: TranscriptRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      records.push(parsed !== null && typeof parsed === 'object' ? (parsed as TranscriptRecord) : {});
    } catch {
      records.push({});
    }
  }
  return records;
}

function normalise(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Block[])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function answerSources(result: unknown): Source[] {
  if (result === null || typeof result !== 'object') return [];
  const { answers, annotations } = result as { answers?: unknown; annotations?: unknown };
  if (answers === null || typeof answers !== 'object') return [];
  const notes = (annotations !== null && typeof annotations === 'object' ? annotations : {}) as Record<
    string,
    { notes?: unknown } | undefined
  >;
  const sources: Source[] = [];
  for (const [question, answer] of Object.entries(answers as Record<string, unknown>)) {
    if (typeof answer !== 'string' || !answer.trim()) continue;
    const note = notes[question]?.notes;
    const suffix = typeof note === 'string' && note.trim() ? ` (note: ${note.trim()})` : '';
    sources.push({
      kind: 'answer',
      text: `Asked: "${question}" — the user answered: "${answer.trim()}"${suffix}`,
    });
  }
  return sources;
}

function mentionedPaths(prompts: readonly string[]): string[] {
  const found: string[] = [];
  for (const prompt of prompts) {
    for (const match of prompt.matchAll(MENTION)) {
      const raw = match[1] ?? (match[2] ?? '').replace(/[.,;:!?)"]+$/, '');
      const path = normalise(raw).replace(/^\.\//, '');
      if (path) found.push(path);
    }
  }
  return found;
}

function isMentioned(paths: readonly string[], mentioned: readonly string[]): boolean {
  return mentioned.some((mention) =>
    paths.some((path) => path === mention || path.endsWith(`/${mention}`)),
  );
}

export function latestPlanModePlan(records: readonly TranscriptRecord[]): string | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.isSidechain) continue;
    const attachment = record.attachment;
    if (record.type === 'attachment' && attachment?.type === 'plan_mode' && !attachment.isSubAgent) {
      const { planFilePath } = attachment;
      if (typeof planFilePath === 'string' && existsSync(planFilePath)) return readFileSync(planFilePath, 'utf8');
      continue;
    }
    const content = record.message?.content;
    if (record.type !== 'assistant' || !Array.isArray(content)) continue;
    for (let at = content.length - 1; at >= 0; at -= 1) {
      const block = content[at];
      if (block.type !== 'tool_use' || block.name !== 'ExitPlanMode') continue;
      const { plan, planFilePath } = block.input ?? {};
      if (typeof planFilePath === 'string' && existsSync(planFilePath)) return readFileSync(planFilePath, 'utf8');
      if (typeof plan === 'string' && plan.trim()) return plan;
    }
  }
  return undefined;
}

export function collectSources(records: readonly TranscriptRecord[]): Source[] {
  const sources: Source[] = [];
  const documents: { path: string; displayPath?: string; text: string }[] = [];
  const toolNames = new Map<string, string>();
  let lastAssistant = '';

  const addPrompt = (raw: string): void => {
    let text = raw.replace(REMINDER, '').trim();
    if (OWN_COMMAND.test(text)) return;
    if (COMMAND.test(text)) text = (COMMAND_ARGS.exec(text)?.[1] ?? '').trim();
    if (!text || NOISE.test(text) || text.includes(REPORT_MARKER)) return;
    if (sources.some((source) => source.kind === 'prompt' && source.text === text)) return;
    sources.push({ kind: 'prompt', text, ...(lastAssistant ? { context: lastAssistant } : {}) });
  };

  for (const record of records) {
    if (record.isSidechain) continue;
    const content = record.message?.content;

    if (record.type === 'assistant' && Array.isArray(content)) {
      const text = textOf(content).trim();
      if (text) lastAssistant = text;
      for (const block of content) {
        if (block.type === 'tool_use' && block.id && block.name) toolNames.set(block.id, block.name);
      }
    } else if (record.type === 'user') {
      const results = Array.isArray(content)
        ? content.filter((block) => block.type === 'tool_result')
        : [];
      if (results.length === 0) {
        const written = record.isMeta || record.isCompactSummary || record.isVisibleInTranscriptOnly;
        if (!written && (record.origin?.kind ?? 'human') === 'human') addPrompt(textOf(content));
        continue;
      }
      for (const block of results) {
        const tool = toolNames.get(block.tool_use_id ?? '');
        if (tool === 'AskUserQuestion') sources.push(...answerSources(record.toolUseResult));
        else if (tool === 'ExitPlanMode' && block.is_error) {
          const text = textOf(block.content).replace(REMINDER, '');
          const said = USER_SAID.exec(text);
          if (!said || text.includes(DENY_MARKER)) continue;
          const feedback = text.slice(said.index + said[0].length).split(REPORT_MARKER)[0].trim();
          if (feedback) sources.push({ kind: 'plan_feedback', text: feedback });
        }
      }
    } else if (record.type === 'attachment') {
      const attachment = record.attachment;
      if (
        attachment?.type === 'queued_command' &&
        attachment.origin?.kind === 'human' &&
        typeof attachment.prompt === 'string'
      ) {
        addPrompt(attachment.prompt);
      } else if (
        attachment?.type === 'file' &&
        attachment.filename &&
        attachment.content?.type === 'text' &&
        typeof attachment.content.file?.content === 'string' &&
        !INSTRUCTION_FILE.test(normalise(attachment.filename))
      ) {
        documents.push({
          path: attachment.filename,
          ...(attachment.displayPath ? { displayPath: attachment.displayPath } : {}),
          text: attachment.content.file.content,
        });
      }
    }
  }

  const mentioned = mentionedPaths(
    sources.filter((source) => source.kind === 'prompt').map((source) => source.text),
  );
  for (const document of documents) {
    const paths = [document.path, document.displayPath ?? ''].filter(Boolean).map(normalise);
    if (isMentioned(paths, mentioned)) {
      sources.push({
        kind: 'document',
        text: document.text,
        label: document.displayPath ?? document.path,
      });
    }
  }
  return sources;
}
