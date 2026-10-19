import { PROVIDERS } from './config.js';
import { jevClient } from './jev.js';
import { pickFiles, review } from './review.js';
import { toStatements } from './statements.js';
import { collectSources, readTranscript } from './transcript.js';
export async function runReview(input) {
    const { config } = input;
    const asker = input.asker ??
        (config.apiKey
            ? jevClient({ apiKey: config.apiKey, baseUrl: config.baseUrl })
            : undefined);
    if (!asker) {
        const { label, keyVar } = PROVIDERS[config.provider];
        return {
            kind: 'skipped',
            reason: `no ${label} API key is set; add ${keyVar} to the "env" section of ${config.settingsFile ?? '~/.claude/settings.json'} and restart Claude Code`,
        };
    }
    if (!input.plan.trim())
        return { kind: 'skipped', reason: 'the plan is empty' };
    try {
        const started = Date.now();
        const sources = collectSources(readTranscript(input.transcriptPath).slice(input.windowStart));
        const documents = sources.filter((source) => source.kind === 'document');
        const picked = await pickFiles(documents, asker, config.minConfidence);
        const used = new Set(documents.filter((_, index) => picked.files[index].status === 'used'));
        const kept = sources.filter((source) => source.kind !== 'document' || used.has(source));
        const { statements, skipped } = toStatements(kept, config.maxStatements);
        if (statements.length === 0) {
            return {
                kind: 'skipped',
                reason: 'the user has said nothing to check since the last approved plan or /clear',
            };
        }
        const reviewed = await review(input.plan, statements, asker, {
            minConfidence: config.minConfidence,
            reverse: input.reverse ?? false,
            maxPlanItems: config.maxStatements,
        });
        const result = {
            ...reviewed,
            ...(picked.files.length ? { files: picked.files } : {}),
            requests: reviewed.requests + picked.requests,
            usage: {
                inputTokens: reviewed.usage.inputTokens + picked.usage.inputTokens,
                outputTokens: reviewed.usage.outputTokens + picked.usage.outputTokens,
            },
            elapsedMs: Date.now() - started,
        };
        return { kind: 'reviewed', result, overLimit: skipped };
    }
    catch (error) {
        return { kind: 'skipped', reason: error instanceof Error ? error.message : String(error) };
    }
}
