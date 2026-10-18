---
name: settings
description: Show or change the jev-plan-review settings, which are the Jev provider (TypeSafe or OpenRouter), the confidence threshold, automatic review and how many times one plan may be sent back, the statement limit, showing unsure items, and listing what the plan decided that you never said. Use only when the user asks to see or change jev-plan-review settings.
argument-hint: "[name value]..."
disable-model-invocation: true
---

The user's arguments, if any: $ARGUMENTS

1. Show the current settings by running this with the Bash tool:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/dist/bin/cli.js" settings --data-dir "${CLAUDE_PLUGIN_DATA}"
   ```

2. If the user's arguments already say what to change, for example `min_confidence 90` or `provider openrouter`, go to step 4 with those changes.

3. Otherwise ask with the AskUserQuestion tool. In every question, put the current value first and add "(current)" to its label. Ask these three in one call:
   - Provider: TypeSafe, OpenRouter
   - Confidence threshold: 70, 80, 90. The user may type any number from 50 to 100.
   - Automatic review of plan-mode plans, which sends a plan back to Claude when items are missing or contradicted: On, Off

   Then ask these four in a second call:
   - How many times one plan may be sent back: 1, 2, 3, 5. The user may type any whole number from 1 up.
   - Show items Jev was unsure of in the report: On, Off
   - How many statements one review may check: 75, 150, 300, 500. The user may type any whole number from 1 up.
   - List what the plan decided that you never said (command only): On, Off

4. If plan mode is on, change nothing. Tell the user to leave plan mode with Shift+Tab and run the command again. Otherwise apply only the values that differ from the current ones, all in one command, with one `--set` for each:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/dist/bin/cli.js" settings --data-dir "${CLAUDE_PLUGIN_DATA}" --set provider=openrouter --set min_confidence=85
   ```

   The names are `provider` (typesafe or openrouter), `min_confidence` (50 to 100), `auto_review`, `show_inconclusive`, `reverse_plan_check` (each on or off), `max_revisions`, `max_statements` (each a whole number, 1 or more), and `model`. If nothing differs, run nothing.

5. Show the last command's output to the user as printed. Changes take effect at once. If the output says an API key is not set, pass on its instructions.

Never ask the user to type or paste an API key into the conversation, and never write a key into any file yourself. The key belongs in the user's environment, which they set on their own.
