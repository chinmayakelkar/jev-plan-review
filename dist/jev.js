import { estimateTokens } from './tokens.js';
export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
export function parseJevResponse(status, ok, text) {
    if (!ok)
        throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        throw new Error('Jev returned malformed JSON');
    }
    if (parsed === null ||
        typeof parsed !== 'object' ||
        !('answers' in parsed) ||
        parsed.answers === null ||
        typeof parsed.answers !== 'object') {
        throw new Error('Jev response is missing answers');
    }
    return parsed;
}
function answerObject(answers, name) {
    const answer = answers[name];
    if (answer === null || typeof answer !== 'object') {
        throw new Error(`Invalid Jev answer for ${name}`);
    }
    return answer;
}
function isProbability(value) {
    return typeof value === 'number' && value >= 0 && value <= 1;
}
export function noulAnswer(answers, name) {
    const { noul } = answerObject(answers, name);
    if (!isProbability(noul))
        throw new Error(`Invalid Jev answer for ${name}`);
    return noul;
}
export function choiceAnswer(answers, name, allowed) {
    const answer = answerObject(answers, name);
    const { choice } = answer;
    if (typeof choice !== 'string' || !allowed.includes(choice)) {
        throw new Error(`Invalid Jev answer for ${name}`);
    }
    const given = answer.probabilities !== null && typeof answer.probabilities === 'object'
        ? answer.probabilities
        : {};
    const probabilities = {};
    for (const option of allowed) {
        const value = given[option];
        if (isProbability(value))
            probabilities[option] = value;
    }
    const confidence = isProbability(answer.confidence) ? answer.confidence : probabilities[choice];
    if (confidence === undefined)
        throw new Error(`Invalid Jev answer for ${name}`);
    return { choice, confidence, probabilities };
}
// TypeSafe allows 100K input tokens and 80 requests per second; these leave a margin.
const TOKENS_PER_SECOND = 80_000;
const REQUESTS_PER_SECOND = 60;
const RETRIES = 2;
const BUSY = new Set([429, 529]);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function pacer() {
    const sent = [];
    let queue = Promise.resolve();
    return (tokens) => {
        queue = queue.then(async () => {
            for (;;) {
                const now = Date.now();
                while (sent.length > 0 && now - sent[0].at >= 1000)
                    sent.shift();
                const used = sent.reduce((sum, entry) => sum + entry.tokens, 0);
                if (sent.length === 0 || (sent.length < REQUESTS_PER_SECOND && used + tokens <= TOKENS_PER_SECOND)) {
                    sent.push({ at: now, tokens });
                    return;
                }
                await wait(sent[0].at + 1000 - now);
            }
        });
        return queue;
    };
}
function retryDelay(headers, attempt) {
    const ms = Number(headers.get('retry-after-ms') ?? NaN);
    const seconds = Number(headers.get('retry-after') ?? NaN);
    const asked = Number.isFinite(ms) ? ms : Number.isFinite(seconds) ? seconds * 1000 : 500 * 2 ** attempt;
    return Math.min(Math.max(asked, 0), 10_000);
}
export function jevClient(options) {
    const fetcher = options.fetch ?? fetch;
    const slot = pacer();
    return {
        async ask(state, questions) {
            const body = JSON.stringify({ model: options.model ?? DEFAULT_MODEL, state, questions });
            for (let attempt = 0;; attempt += 1) {
                await slot(estimateTokens(body));
                const response = await fetcher(options.baseUrl ?? SYSTEM_ONE_URL, {
                    method: 'POST',
                    headers: {
                        authorization: `Bearer ${options.apiKey}`,
                        'content-type': 'application/json',
                    },
                    body,
                    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
                });
                if (BUSY.has(response.status) && attempt < RETRIES) {
                    await response.body?.cancel();
                    await wait(retryDelay(response.headers, attempt));
                    continue;
                }
                return parseJevResponse(response.status, response.ok, await response.text());
            }
        },
    };
}
