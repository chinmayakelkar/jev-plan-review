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
    return typeof value === 'number' && Number.isFinite(value);
}
export function noulAnswer(answers, name) {
    const { noul } = answerObject(answers, name);
    if (!isProbability(noul))
        throw new Error(`Invalid Jev answer for ${name}`);
    return noul;
}
export function choiceAnswer(answers, name, allowed) {
    const { choice, confidence, probabilities } = answerObject(answers, name);
    if (typeof choice !== 'string' || !allowed.includes(choice)) {
        throw new Error(`Invalid Jev answer for ${name}`);
    }
    if (isProbability(confidence))
        return { choice, confidence };
    const fallback = probabilities !== null && typeof probabilities === 'object'
        ? probabilities[choice]
        : undefined;
    if (!isProbability(fallback))
        throw new Error(`Invalid Jev answer for ${name}`);
    return { choice, confidence: fallback };
}
export function jevClient(options) {
    const fetcher = options.fetch ?? fetch;
    return {
        async ask(state, questions) {
            const response = await fetcher(options.baseUrl ?? SYSTEM_ONE_URL, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${options.apiKey}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ model: options.model ?? DEFAULT_MODEL, state, questions }),
                signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
            });
            return parseJevResponse(response.status, response.ok, await response.text());
        },
    };
}
