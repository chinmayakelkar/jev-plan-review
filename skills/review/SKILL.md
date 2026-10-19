---
name: review
description: Check a plan file, the latest plan-mode plan, or the plan made in this conversation against what the user said in this session, using TypeSafe's Jev model, and show a coverage table. Use only when the user asks for a Jev plan review.
argument-hint: "[path to plan file] [--since-clear]"
---

The user's arguments, if any: $ARGUMENTS

Pick the plan to check, in this order:

1. If the user gave a path, put it in double quotes after `--plan`.
2. Otherwise, if you made the plan in this conversation without plan mode, or changed it after presenting it with plan mode, pass it in: add `--plan -` and put the plan after the command as a heredoc, word for word as you last gave it to the user. Do not reword, shorten, summarise or fix it.
3. Otherwise, if you presented a plan with plan mode, leave `--plan` out; the tool finds it.
4. If you made no plan in this conversation, run nothing and tell the user there is no plan to check.

Add `--since-clear` only if the user's arguments include it.

Run it with the Bash tool, not PowerShell.

Case 1:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/cli.js" --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}" --option 'provider=${user_config.provider}' --option 'min_confidence=${user_config.min_confidence}' --option 'auto_review=${user_config.auto_review}' --option 'max_revisions=${user_config.max_revisions}' --option 'max_statements=${user_config.max_statements}' --option 'show_inconclusive=${user_config.show_inconclusive}' --option 'reverse_plan_check=${user_config.reverse_plan_check}' --plan "<path>"
```

Case 2:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/cli.js" --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}" --option 'provider=${user_config.provider}' --option 'min_confidence=${user_config.min_confidence}' --option 'auto_review=${user_config.auto_review}' --option 'max_revisions=${user_config.max_revisions}' --option 'max_statements=${user_config.max_statements}' --option 'show_inconclusive=${user_config.show_inconclusive}' --option 'reverse_plan_check=${user_config.reverse_plan_check}' --plan - <<'JEV_PLAN_END'
<the plan, word for word>
JEV_PLAN_END
```

Case 3:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/bin/cli.js" --session "${CLAUDE_SESSION_ID}" --data-dir "${CLAUDE_PLUGIN_DATA}" --option 'provider=${user_config.provider}' --option 'min_confidence=${user_config.min_confidence}' --option 'auto_review=${user_config.auto_review}' --option 'max_revisions=${user_config.max_revisions}' --option 'max_statements=${user_config.max_statements}' --option 'show_inconclusive=${user_config.show_inconclusive}' --option 'reverse_plan_check=${user_config.reverse_plan_check}'
```

Then show the command's output to the user exactly as printed, both tables included. Do not add your own judgement about the items, and do not change the plan unless the user asks you to.

If the output says the review was skipped, pass on the reason. If it says an API key is not set, pass on its instructions. Never ask the user to type or paste a key into the conversation.
