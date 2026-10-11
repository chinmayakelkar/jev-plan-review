# jev-plan-review

A Claude Code plugin that checks a plan against what you said while it was
being prepared. Every requirement, constraint, assumption and decision you
stated is put to TypeSafe's Jev model with two questions: does the plan
reflect it, and does the plan conflict with it. You get a compact table with a
yes/no and a confidence score for each item.

## What and why

While a plan takes shape you make many small calls: "use Postgres", "never
touch the generated folder", "CSV, not Excel". The finished plan is long, and
reading all of it to confirm each call was captured is slow. This plugin does
that reading for you and shows where to look.

It runs in two places and does the same thing in both:

- **A hook on plan mode.** When Claude is about to show you a plan, the hook
  checks it first.
- **A command.** `/jev-plan-review:review <file>` checks any plan file.

```
jev-plan-review: 3 of 5 items reflected in the plan, 1 missing, 1 contradicted (1 unsure)
NO   93%  constraint   It must be written in Python.  [contradicted]
NO   88%  requirement  Add a CSV export command.  [missing]
YES  62%  preference   Keep the tool small.  [unsure]
YES  91%  requirement  Build a command line tool that exports reports.
YES  97%  decision     Actually, use Postgres instead of SQLite.
```

Each row is answered on its own. There is no overall score. An answer Jev
gave with less confidence than your threshold is marked `unsure`.

Jev can be reached through TypeSafe or through OpenRouter. You choose, and you
can change your mind at any time with `/jev-plan-review:settings`.

## How it works

1. **Collect.** The plugin reads the session transcript and gathers what you
   said: your prompts, your `AskUserQuestion` answers, the feedback you gave
   when you rejected a plan, text you pasted, and files you mentioned with
   `@`. It never uses `CLAUDE.md`, files Claude chose to read, or Claude's own
   words. Only what came after the last `/clear` and the last approved plan
   counts.
2. **Split.** Each source is broken into short statements, one per bullet,
   numbered item or sentence. The assistant's message just before your reply is
   kept beside it as context, so a short answer still makes sense.
3. **Classify.** Jev sorts each statement: requirement, constraint, decision,
   assumption, preference, superseded, or not actionable. Statements you later
   reversed, and questions or thanks, are set aside.
4. **Verify.** For each remaining item Jev answers two `noul` questions with
   the plan in front of it: the plan reflects this, and the plan conflicts
   with this. A plan too long for one request is checked in parts.
5. **Decide.** Conflict at 50% or more means *contradicted*. Otherwise reflect
   at 50% or more means *yes*. Otherwise *no*, with confidence of one minus
   the reflect score. An answer below your confidence threshold is marked
   *unsure*.
6. **Revise, if you left that on.** Items Jev is sure are missing or
   contradicted are sent back to Claude to fix, at most twice unless you
   change `max_revisions`. Unsure items are never sent back. The count
   belongs to the plan: it starts again only when you approve a plan, type
   `/clear`, or Claude starts a new plan file. After that many tries the
   plugin still reviews the plan, but only reports.
7. **Report.** The table is shown next to the plan, and the plan waits for
   you as usual. Claude is given the same table, with a note that it is yours
   to act on, so you can say "fix the missing ones" and be understood. The
   full report is also saved to a file.

If the key is missing, Jev fails, or an answer is malformed, the hook shows a
one-line note and lets the plan through. It never blocks because of its own
trouble.

## Install

You need Node.js 18 or newer and an API key from TypeSafe or OpenRouter.

Put the key in the `env` section of `~/.claude/settings.json`, where both the
hook and the commands can read it. Use the name that matches your provider:

```json
{ "env": { "TYPESAFE_API_KEY": "<your key>" } }
```

```json
{ "env": { "OPENROUTER_API_KEY": "<your key>" } }
```

Please do not paste a key into a Claude Code conversation. Anything typed
there is saved in the session transcript.

Then add this repository as a marketplace and install the plugin:

```sh
claude plugin marketplace add <path or owner/repo of this repository>
claude plugin install jev-plan-review@jev-plan-review
```

Restart Claude Code or run `/reload-plugins`. The plugin starts with the
defaults below. If you use OpenRouter, run `/jev-plan-review:settings` once
and choose it.

To try it from a checkout without installing:

```sh
claude --plugin-dir /path/to/jev-plan-review
```

## Settings

Run `/jev-plan-review:settings` at any time. It shows the current values,
tells you whether your key was found, and offers each setting as a choice.
You can also name the change directly:

```
/jev-plan-review:settings
/jev-plan-review:settings revise off
/jev-plan-review:settings provider openrouter
```

| Setting | Default | Description |
| --- | --- | --- |
| `provider` | `typesafe` | `typesafe` or `openrouter`. Decides where requests go and which key is used. |
| `min_confidence` | `80` | Percent, 50–100. An answer below this is marked `unsure`, and revise leaves it alone. |
| `auto_review` | `on` | Review every plan-mode plan before it is shown. When off, only the review command runs a check. |
| `revise` | `on` | Send a plan back to Claude when items are missing or contradicted. When off, the plugin only reports and you decide what to do. |
| `max_revisions` | `2` | How many times revise may send one plan back. Any whole number from 1 up. Each one costs another revision by Claude and another Jev review before you see the plan. |
| `share_with_claude` | `on` | Give Claude the same table you see. |
| `model` | `jev-latest` | Jev model name. Both providers accept it. |

A change takes effect at once. The settings are kept in `settings.json` in the
plugin's data folder; the settings command prints the path. The API key is
never stored there.

## The review command

```
/jev-plan-review:review docs/plan.md
/jev-plan-review:review docs/plan.md --since-clear
/jev-plan-review:review
```

With no path, it checks the most recent plan-mode plan. By default it uses
what you said since the last approved plan; `--since-clear` goes back to the
last `/clear`, which is what you want when checking a plan you already
approved.

## Limitations

- A confidence score is not a proof. The table tells you where to look; you
  still decide.
- Statements are split by simple rules. Text inside fenced code blocks is
  skipped, and a sentence that only makes sense with its neighbours may be
  judged poorly.
- At most 150 statements are checked per review. Your own words are kept
  ahead of attached documents when there are more.
- Images are not read.
- The transcript file layout is not a published Claude Code contract. All of
  the reading is in `src/transcript.ts`, so a change there is a small fix.
- Token sizes are estimates from character counts, not a tokenizer.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build            # dist/ is committed; rebuild before committing src changes
npm run validate:plugin  # claude plugin validate
npm run live             # real request through TypeSafe; needs TYPESAFE_API_KEY
npm run live -- openrouter   # the same through OpenRouter; needs OPENROUTER_API_KEY
```

The unit tests use a fake Jev and never go on the network. `npm run live` is
the real network check.

## Credits and license

MIT. The Jev client and the token estimate are adapted from
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction),
also MIT.
