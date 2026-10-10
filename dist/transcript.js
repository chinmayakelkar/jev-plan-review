import { existsSync, readFileSync } from 'node:fs';
export const DENY_MARKER = '[jev-plan-review]';
export const REPORT_MARKER = '[jev-plan-review report]';
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const COMMAND = /<command-(?:name|message)>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const NOISE = /^(?:<local-command-|\[Request interrupted)/;
const USER_SAID = /the user said:\s*/i;
const INSTRUCTION_FILE = /(?:^|\/)claude(?:\.local)?\.md$/;
const MENTION = /(?:^|\s)@(?:"([^"]+)"|(\S+))/g;
export function readTranscript(path) {
    if (!existsSync(path))
        return [];
    const records = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            records.push(parsed !== null && typeof parsed === 'object' ? parsed : {});
        }
        catch {
            records.push({});
        }
    }
    return records;
}
function normalise(path) {
    return path.replace(/\\/g, '/').toLowerCase();
}
function textOf(content) {
    if (typeof content === 'string')
        return content;
    if (!Array.isArray(content))
        return '';
    return content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}
function answerSources(result) {
    if (result === null || typeof result !== 'object')
        return [];
    const { answers, annotations } = result;
    if (answers === null || typeof answers !== 'object')
        return [];
    const notes = (annotations !== null && typeof annotations === 'object' ? annotations : {});
    const sources = [];
    for (const [question, answer] of Object.entries(answers)) {
        if (typeof answer !== 'string' || !answer.trim())
            continue;
        const note = notes[question]?.notes;
        const suffix = typeof note === 'string' && note.trim() ? ` (note: ${note.trim()})` : '';
        sources.push({
            kind: 'answer',
            text: `Asked: "${question}" — the user answered: "${answer.trim()}"${suffix}`,
        });
    }
    return sources;
}
function mentionedPaths(prompts) {
    const found = [];
    for (const prompt of prompts) {
        for (const match of prompt.matchAll(MENTION)) {
            const raw = match[1] ?? (match[2] ?? '').replace(/[.,;:!?)"]+$/, '');
            const path = normalise(raw).replace(/^\.\//, '');
            if (path)
                found.push(path);
        }
    }
    return found;
}
function isMentioned(paths, mentioned) {
    return mentioned.some((mention) => paths.some((path) => path === mention || path.endsWith(`/${mention}`)));
}
export function collectSources(records) {
    const sources = [];
    const documents = [];
    const toolNames = new Map();
    let lastAssistant = '';
    const addPrompt = (raw) => {
        let text = raw.replace(REMINDER, '').trim();
        if (COMMAND.test(text))
            text = (COMMAND_ARGS.exec(text)?.[1] ?? '').trim();
        if (!text || NOISE.test(text) || text.includes(REPORT_MARKER))
            return;
        if (sources.some((source) => source.kind === 'prompt' && source.text === text))
            return;
        sources.push({ kind: 'prompt', text, ...(lastAssistant ? { context: lastAssistant } : {}) });
    };
    for (const record of records) {
        if (record.isSidechain)
            continue;
        const content = record.message?.content;
        if (record.type === 'assistant' && Array.isArray(content)) {
            const text = textOf(content).trim();
            if (text)
                lastAssistant = text;
            for (const block of content) {
                if (block.type === 'tool_use' && block.id && block.name)
                    toolNames.set(block.id, block.name);
            }
        }
        else if (record.type === 'user') {
            const results = Array.isArray(content)
                ? content.filter((block) => block.type === 'tool_result')
                : [];
            if (results.length === 0) {
                if (!record.isMeta && (record.origin?.kind ?? 'human') === 'human')
                    addPrompt(textOf(content));
                continue;
            }
            for (const block of results) {
                const tool = toolNames.get(block.tool_use_id ?? '');
                if (tool === 'AskUserQuestion')
                    sources.push(...answerSources(record.toolUseResult));
                else if (tool === 'ExitPlanMode' && block.is_error) {
                    const text = textOf(block.content).replace(REMINDER, '');
                    const said = USER_SAID.exec(text);
                    if (!said || text.includes(DENY_MARKER))
                        continue;
                    const feedback = text.slice(said.index + said[0].length).split(REPORT_MARKER)[0].trim();
                    if (feedback)
                        sources.push({ kind: 'plan_feedback', text: feedback });
                }
            }
        }
        else if (record.type === 'attachment') {
            const attachment = record.attachment;
            if (attachment?.type === 'queued_command' &&
                attachment.origin?.kind === 'human' &&
                typeof attachment.prompt === 'string') {
                addPrompt(attachment.prompt);
            }
            else if (attachment?.type === 'file' &&
                attachment.filename &&
                attachment.content?.type === 'text' &&
                typeof attachment.content.file?.content === 'string' &&
                !INSTRUCTION_FILE.test(normalise(attachment.filename))) {
                documents.push({
                    path: attachment.filename,
                    ...(attachment.displayPath ? { displayPath: attachment.displayPath } : {}),
                    text: attachment.content.file.content,
                });
            }
        }
    }
    const mentioned = mentionedPaths(sources.filter((source) => source.kind === 'prompt').map((source) => source.text));
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
