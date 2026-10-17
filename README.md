# jev-plan-review

A Claude Code plugin that checks a plan against what you said while it was
being prepared. Every requirement, constraint, assumption and decision you
stated is put to TypeSafe's Jev model with two questions: does the plan
reflect it, and does the plan conflict with it. You get a compact table with a
yes/no and a confidence score for each item.

## What and why

While a plan takes shape you make many small calls: "use Postgres", "never
touch the generated folder", "CSV, not Excel". The finished plan is long, and
reading all of it to confirm each call was captured is slow.

It runs in two ways:

- **A hook on plan mode.** When Claude is about to show you a plan, the hook
  checks it first and sends it back to Claude to fix anything Jev is sure is
  missing or contradicted. Claude gets the table; the approval screen does
  not show it.
- **A command.** `/jev-plan-review:review <file>` checks any plan file and
  shows you the table. It never changes the plan.

```
jev-plan-review: 3 of 5 items reflected in the plan, 1 missing, 1 contradicted (1 unsure)
NO   93%  constraint   It must be written in Python.  [contradicted]
NO   88%  requirement  Add a CSV export command.  [missing]
YES  62%  preference   Keep the tool small.  [unsure]
YES  91%  requirement  Build a command line tool that exports reports.
YES  97%  decision     Actually, use Postgres instead of SQLite.
```

Each row is answered on its own. An answer Jev gave with less confidence than
your threshold is marked `unsure`.

## How it works

1. **Collect.** The plugin reads the session transcript and gathers what you
   said: your prompts, your `AskUserQuestion` answers, the feedback you gave
   when you rejected a plan, text you pasted, and files you mentioned with
   `@`. It never uses `CLAUDE.md` or files Claude chose to read. Only what
   came after the last `/clear` and the last approved plan counts.
2. **Split.** Each source is broken into short statements, one per bullet,
   numbered item or sentence. Claude's message just before your reply is
   kept beside it as context only, so a short answer still makes sense; it
   is never an item.
3. **Classify.** Jev sorts each statement: requirement, constraint, decision,
   assumption, preference, superseded, or not actionable. The chances it gives
   the five real kinds are added up. At your confidence threshold or above,
   the statement goes on. Below 50% it is set aside, as a question, thanks, or
   something you later reversed. In between it is *unclear*: it is listed as
   `not checked` and no further question is asked about it.
4. **Verify.** For each item that went on, Jev answers two `noul` questions with
   the plan in front of it: the plan reflects this, and the plan conflicts
   with this. A plan too long for one request is checked in parts.
5. **Decide.** Conflict at 50% or more means *contradicted*. Otherwise reflect
   at 50% or more means *yes*. Otherwise *no*, with confidence of one minus
   the reflect score. An answer below your confidence threshold is marked
   *unsure*.
6. **Revise (hook only).** Items Jev is sure are missing or contradicted are
   sent back to Claude to fix, at most twice unless you change
   `max_revisions`. Unsure items are never sent back. The count resets when
   you approve a plan, run `/clear`, or Claude starts a new plan file. After
   the last revision the plan is let through with the open items marked.
7. **Report.** The hook gives Claude the table when it lets a plan through,
   and the plan waits for you as usual. To see the table, ask Claude what
   the review found. The command shows you the table directly. Either way,
   the full report is saved to `reports/` in the plugin's data folder.

Requests are paced under TypeSafe's rate limits and retried twice when the
service is busy. If the key is missing, Jev fails, or an answer is malformed,
the hook tells Claude the check was skipped and lets the plan through. It
never blocks because of its own trouble.

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

A key set in your shell works too. Never paste the key into a conversation;
transcripts are saved to disk.

Then add this repository as a marketplace and install the plugin:

```sh
claude plugin marketplace add chinmayakelkar/jev-plan-review
claude plugin install jev-plan-review@jev-plan-review
```

Restart Claude Code or run `/reload-plugins`. The plugin starts with the
defaults below. If you use OpenRouter, run `/jev-plan-review:settings` once
and choose it.

To try it from a checkout without installing:

```sh
claude --plugin-dir /path/to/jev-plan-review
```

## Usage

Plan mode needs nothing: every plan is reviewed before you see it. To check
a plan file yourself:

```
/jev-plan-review:review docs/plan.md
/jev-plan-review:review docs/plan.md --since-clear
/jev-plan-review:review
```

With no path, it checks the most recent plan-mode plan. By default it uses
what you said since the last approved plan; `--since-clear` goes back to the
last `/clear`, which is what you want when checking a plan you already
approved.

## Settings

Run `/jev-plan-review:settings` at any time. It shows the current values,
tells you whether your key was found, and offers each setting as a choice.
You can also name the change directly:

```
/jev-plan-review:settings
/jev-plan-review:settings min_confidence 90
/jev-plan-review:settings provider openrouter
```

| Setting | Default | Description |
| --- | --- | --- |
| `provider` | `typesafe` | `typesafe` or `openrouter`. Decides where requests go and which key is used. |
| `min_confidence` | `80` | Percent, 50–100. An answer below this is marked `unsure` and is never sent back to Claude. |
| `auto_review` | `on` | Review every plan-mode plan before it is shown, and send it back to Claude when needed. When off, only the review command runs a check. |
| `max_revisions` | `2` | How many times the hook may send one plan back. Any whole number from 1 up. |
| `max_statements` | `150` | How many statements one review may check. Any whole number from 1 up. More statements mean more Jev questions and a longer wait. |
| `show_inconclusive` | `on` | Show the rows Jev was unsure of: `unsure` answers and `not checked` statements. When off they are left out of the table and the saved report, and one line says how many were hidden. |
| `model` | `jev-latest` | Jev model name. |

A change takes effect at once. Settings cannot be changed while plan mode
is on; leave plan mode with Shift+Tab first. The settings are kept in `settings.json` in the
plugin's data folder; the settings command prints the path. The API key is
never stored there.

## Limitations

- A confidence score is not a proof. The table tells you where to look; you
  still decide.
- The approval screen does not show anything from the hook: not the table,
  and not a note that the review was skipped. Ask Claude what the review
  found, and run `/jev-plan-review:settings` to check that your API key is
  found.
- Statements are split at bullets, numbered items and sentence ends; code
  blocks are skipped. An odd abbreviation or initial can split a sentence
  wrongly, and a statement that needs its neighbours may be judged poorly.
- At most `max_statements` statements are checked per review. When there
  are more, your own words are kept ahead of attached documents, and your
  newest words ahead of your oldest.
- A conversation too long to classify in one request is not reviewed.
- Plans made by subagents are not reviewed.
- The hook has 180 seconds; a review that takes longer does not finish.
- Images are not read.
- The transcript file layout is not a published Claude Code contract; a
  Claude Code update can break collection.
- Token sizes are estimates from character counts, not a tokenizer.

## Development

```sh
npm install
npm run verify           # typecheck, test, build
npm run validate:plugin  # claude plugin validate
npm run live             # real request through TypeSafe; needs TYPESAFE_API_KEY
npm run live -- openrouter   # the same through OpenRouter; needs OPENROUTER_API_KEY
```

`dist/` is committed; rebuild before committing changes to `src/`. The unit
tests use a fake Jev and never go on the network. `npm run live` is the real
network check.

## Credits and license

MIT. The Jev client and the token estimate are adapted from
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction),
also MIT.
