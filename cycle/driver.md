# Cycle Driver — /loop prompt

Use this as the `prompt` argument to `/loop` (dynamic pacing, no fixed
interval). The driver reads this, advances the loop by one
step, and schedules the next wake-up.

---

You are the **orchestrator** of pccx-lab's self-evolution loop. One
step per invocation. Never run more than one step per wake-up.

## State file

`cycle/STATE.json` — keys:
```json
{ "round": <int>, "phase": "judge" | "research" | "plan" | "impl" | "review" }
```

If missing, initialise `{ "round": 1, "phase": "judge" }`.

## Step table

| phase     | what to do this tick                                                                             | next phase |
|-----------|--------------------------------------------------------------------------------------------------|------------|
| judge     | spawn Agent with `cycle/agents/judge.md`; wait; write `round_NNN/judge_report.md`                 | research   |
| research  | spawn Agent with `cycle/agents/research.md` + the judge report                                    | plan       |
| plan      | spawn Agent with `cycle/agents/planner.md` + both prior artefacts                                 | impl       |
| impl      | spawn Agents with `implementer_ui/core/docs.md` **in parallel** per ticket owner                  | review     |
| review    | append a one-line round summary to `cycle/ROUNDS.md`; increment `round`; set phase back to judge  | judge      |

After each step, update `STATE.json` and call `ScheduleWakeup` with
`delaySeconds` 60-270 (keep cache warm) if the previous spawn returned
fast, else 1200-1800. Pass this file back as the prompt.

## Halt conditions

- `cycle/HALT` file exists → stop looping (user's explicit stop switch;
  `touch cycle/HALT` from the shell at any time).
- Budget: after round **50**, pause and ask the user to unblock. This
  is the effective-infinite cap; the user approved unbounded evolution
  on 2026-04-20 so long as the system emits a heartbeat and can be
  halted cleanly.
- Heartbeat: at the end of every **10th** round (10, 20, 30, 40),
  emit a `PushNotification` summarising the prior 10 rounds' grade
  trajectory + tickets landed. This gives the user a chance to
  `touch cycle/HALT` if the loop has stopped producing value.
- If the last impl step produced zero commits for two rounds, halt —
  the loop has stalled. Do NOT silently retry.
- If three consecutive Judge reports carry the same top-item, the
  loop is spinning; halt and escalate so the user can re-seed the
  backlog.

## Guardrails

- Never commit without running the implementer's build/test command.
- Never push to remote — only local commits.
- If any spawned agent trips the bot-attribution hook, escalate to
  the user rather than bypassing.
