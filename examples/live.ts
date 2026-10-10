import { PROVIDERS } from '../src/config.js';
import { jevClient } from '../src/jev.js';
import { renderMarkdown } from '../src/report.js';
import { review } from '../src/review.js';
import { toStatements } from '../src/statements.js';

const { label, url, keyVar } = PROVIDERS[process.argv[2] === 'openrouter' ? 'openrouter' : 'typesafe'];
const apiKey = process.env[keyVar];
if (!apiKey) {
  console.error(`Set ${keyVar} to run the live check through ${label}.`);
  process.exit(1);
}

const { statements } = toStatements([
  {
    kind: 'prompt',
    text: 'Build a command line tool that exports reports. It must be written in Python. Use SQLite for storage.',
  },
  {
    kind: 'prompt',
    text: 'Actually, use Postgres instead of SQLite. Thanks for the help so far!',
    context: 'I will plan for SQLite storage. Anything else before I write the plan?',
  },
]);

const plan = [
  '# Plan',
  '1. Create a Node.js command line tool with a single entry file.',
  '2. Store report data in Postgres.',
  '3. Add an `export` command that writes reports as CSV.',
].join('\n\n');

const result = await review(plan, statements, jevClient({ apiKey, baseUrl: url }));
console.log(renderMarkdown(result));
console.log(`\n${label}: ${result.requests} request(s), ${result.planParts} plan part(s)`);
