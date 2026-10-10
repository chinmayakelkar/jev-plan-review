---
name: review
description: Check a plan file against what the user said in this session, using TypeSafe's Jev model, and show a coverage table. Use only when the user asks for a Jev plan review.
argument-hint: "[path to plan file] [--since-clear]"
---

The user's arguments, if any: $ARGUMENTS

Run this one command with the Bash tool. Put the plan path, if the user gave one, in double quotes after `--plan`. Add `--since-clear` only if the user's arguments include it. If the user gave no path, leave `--plan` out; the tool then uses the most recent plan-mode plan.

```
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/cli.js" --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}" --plan "<path>"
```

Then show the command's output to the user exactly as printed, table included. Do not add your own judgement about the items, and do not change the plan unless the user asks you to.

If the output says the review was skipped, pass on the reason. If it says an API key is not set, tell the user to run `/jev-plan-review:settings`, which explains where the key goes. Never ask the user to type or paste a key into the conversation.
