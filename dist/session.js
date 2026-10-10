import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
function fileFor(dataDir, folder, sessionId, extension) {
    return join(dataDir, folder, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.${extension}`);
}
function statePath(dataDir, sessionId) {
    return fileFor(dataDir, 'sessions', sessionId, 'json');
}
export function loadState(dataDir, sessionId) {
    const empty = { clearLine: 0, approvedLine: 0, revisions: 0 };
    try {
        const saved = JSON.parse(readFileSync(statePath(dataDir, sessionId), 'utf8'));
        return { ...empty, ...saved };
    }
    catch {
        return empty;
    }
}
export function saveState(dataDir, sessionId, state) {
    const path = statePath(dataDir, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
}
export function saveReport(dataDir, sessionId, markdown) {
    const path = fileFor(dataDir, 'reports', sessionId, 'md');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${markdown}\n`);
    return path;
}
