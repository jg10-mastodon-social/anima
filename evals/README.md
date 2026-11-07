# Evals

Golden cases for evaluating Ànima's assistant behavior.

The first workflow is **archiving negative cases**: exchanges where the assistant
behaved badly. A negative case does not need an ideal response. It stores the
request context, the rejected response, the user's diagnosis, and the acceptance
criteria for future runs.

## Archive a case

Start the backend and log in to the app, then set the session ID:

```bash
export ANIMA_SESSION_ID="$(...)" # localStorage["anima:sessionId"]
```

List chats:

```bash
vp run evals:archive -- --list-chats
```

List the messages in a chat:

```bash
vp run evals:archive -- --chat "Trip planning" --list-messages
```

Preview an exchange:

```bash
vp run evals:archive -- --chat "Trip planning" --at "2026-11-07T15:42" --dry-run
```

Save it:

```bash
vp run evals:archive -- \
  --chat "Trip planning" \
  --at "2026-11-07T15:42" \
  --issue "Condescending and lectured me about privacy" \
  --desired "Answer directly and stay warm" \
  --tags tone \
  --strip-tools
```

`--strip-tools` keeps only text parts, omitting tool calls and their outputs.
Without it, a long chat can produce a case with hundreds of thousands of
characters. Use it for tone/response evals; keep tool parts only when the eval is
about tool use.

If the user complained afterwards, include that message for the judge:

```bash
--feedback "Why are you talking to me like that?"
```

The session ID can also be stored in `~/.anima-dev/session.json` as
`{ "sessionId": "..." }`.

## Run a case

Local mode (tools disabled):

```bash
vp run evals:run -- --case evals/cases/<id>.json
```

Live mode (real POD tools through the backend):

```bash
vp run evals:run -- --case evals/cases/<id>.json --live
```

Optionally choose the model and judge:

```bash
vp run evals:run -- --case evals/cases/<id>.json --live --model D4F --judge-model D4F
```

Local mode reads provider/model configuration from `~/.anima` or
`~/.anima-dev`. If the backend runs inside proot, run the command inside proot or
set `ANIMA_STORAGE_ROOT`.

On login, the backend writes the session to `~/.anima/session.json` (or
`~/.anima-dev/session.json` in development) with `0600` permissions. Live mode
reads it automatically; run the command in the same environment as the backend.
`ANIMA_SESSION_ID` overrides it if needed. Start the backend with `EVALS=true` if
it is not in development mode.

The production backend does not watch files, so restart it after changing the
system prompt (`packages/core/src/prompts/system.ts`) or any code.

Results are written to `evals/results/`.

Local mode is text-only and is useful for tone/scope/grounding checks; live mode
uses the actual POD tools, so helpfulness and grounding are evaluated against the
real data.

## Case format

See `cases/example-negative.json`.

- `context`: messages up to and including the user request
- `badResponse`: the rejected assistant response, never sent to the model
- `feedback`: optional user follow-up, judge-only
- `issue`: what was wrong
- `desired`: what should happen instead
- `checks`: deterministic checks and/or an LLM judge rubric
  - `finishReason`: require the agent loop to finish with `stop`
  - `maxSteps`: require the run to stay within a step budget
  - `hasFinalText`: require a non-empty final answer
  - archived negative cases default to `finishReason: stop` and `hasFinalText`
- `run`: recorded with each result (`steps`, `maxSteps`, `finishReason`, `toolCalls`, `finalTextLength`)
- `prompt`: version, hash, chars, and estimated tokens of the system prompt at
  capture time

`evals/cases/*.json` is gitignored because it can contain personal POD data.
`example-negative.json` is synthetic and committed. Writing a case inside the
repository but outside `evals/cases/` is refused, so a custom `--out` cannot
create an untracked file that is easy to commit by accident.

## Next steps

The next layer is a runner that replays a case with the current prompt and
evaluates the new response. Until then, this directory only archives cases.
