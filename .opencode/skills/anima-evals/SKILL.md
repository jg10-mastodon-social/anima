---
name: Archive Ànima eval
description: Archive a specific Ànima chat exchange as a negative eval case, identified by chat and timestamp
---

# Archive an Ànima eval

Use this skill when the user wants to save a real Ànima exchange as an eval case.

Ànima negative evals do **not** need an ideal response. They capture:

- the conversation context up to the user request
- the assistant response the user rejected as `badResponse`
- the user's feedback (optional, judge-only)
- a one-line `issue` and optional `desired` behavior
- a judge rubric, usually `tone`

The bad response is never included in the model context. On a future run, the model
receives the same context with the current prompt, and the judge checks whether the
failure recurs.

## Prerequisites

- The backend must be running (`vp run dev:external`, or `vp run dev:managed` for a
  managed POD).
- The browser must be logged in to Ànima.
- On login, the backend writes the session to `~/.anima/session.json` (or
  `~/.anima-dev/session.json` in development) with `0600` permissions. The CLI
  reads it automatically. Run the command inside the backend environment so it
  can see the same home directory.
- `ANIMA_SESSION_ID` overrides the file if needed.

Never write the session ID or the session file contents into a case file,
report, commit, or chat message.

## Workflow

1. **Find the chat**

   If the title is unknown, list chats:

   ```bash
   vp run evals:archive -- --list-chats
   ```

2. **Find the exchange**

   ```bash
   vp run evals:archive -- --chat "<title or URL>" --list-messages
   ```

   This prints the messages in timestamp order with previews and message IDs.
   Pick the user request that led to the bad response.

3. **Preview the exchange**

   ```bash
   vp run evals:archive -- --chat "<title or URL>" --at "<ISO timestamp or HH:mm>" --dry-run
   ```

   Use `--date YYYY-MM-DD` when `--at` only contains a time, or `--id <message-id>`
   when the user supplied a message ID. The script lists candidates instead of
   guessing if the chat or timestamp is ambiguous.

   For tone/response evals, add `--strip-tools`. Tool calls and their outputs can
   make context hundreds of thousands of characters; they are not needed to
   evaluate tone, and the script warns when context is very large.

   Show the user:
   - the request
   - the bad response
   - the next user message, if any

4. **Get the diagnosis**

   Ask what was wrong and what should have happened instead. If the user already
   said it, use their wording.

   - `--issue`: what was wrong (required)
   - `--desired`: what the response should do instead
   - `--feedback`: the user's follow-up complaint, if it is useful to the judge
   - `--rubric`: `tone`, `helpfulness`, `grounding`, `privacy`, or `custom`
   - `--tags`: optional, e.g. `tone,refusal`

   For tone failures, prefer `--rubric tone` and include the concrete behavior to
   avoid (condescension, moralizing, lecturing, excessive apology).

5. **Write the case**

   ```bash
   vp run evals:archive -- \
     --chat "<title or URL>" \
     --at "<timestamp>" \
     --issue "<what was wrong>" \
     --desired "<what should happen>" \
     --feedback "<user follow-up, optional>" \
     --tags tone \
     --strip-tools
   ```

   Use `--case-id <slug>` when the chat title is a timestamp or otherwise not
   descriptive. Default output: `evals/cases/<id>.json`.

   Show the user the saved path and a short summary. The case includes the current
   system prompt version, hash, character count, and estimated token count.

6. **Inspect the result**

   Read the generated file and confirm:

   - `context` ends with the user request
   - `badResponse` is stored separately
   - `issue` is specific
   - `checks` has a judge rubric
   - no session ID or unrelated personal data leaked into metadata

## Handling errors

- `401` / invalid session: ask the user to refresh `ANIMA_SESSION_ID`.
- Multiple chats: show the candidates and ask which one.
- Multiple messages: ask for a more precise timestamp, `--text`, or `--id`.
- No assistant response after the request: the timestamp probably points at the last
  message in the chat; ask for an earlier request.
- Existing case file: use `--force` only after confirming with the user, or choose a
  different `--id`.

## Run an eval

Prefer live mode, which runs against the backend with the real POD tools:

```bash
vp run evals:run -- --case evals/cases/<id>.json --live
```

Live mode reads the session file written on login. The backend must be running
with `EVALS=true` if it is not in development mode.

Local mode is available for quick text-only checks:

```bash
vp run evals:run -- --case evals/cases/<id>.json
```

Optional in either mode:

```bash
--model <id|alias> --judge-model <id>
```

Local mode reads provider/model configuration from `~/.anima` or
`~/.anima-dev`. If the backend runs inside proot, run the command inside proot or
set `ANIMA_STORAGE_ROOT`.

Local mode disables tools; a low helpfulness score there can reflect the missing
tool access rather than the prompt. Use live mode for grounding/helpfulness.

Results are written to `evals/results/`. Report the candidate response, the judge
scores, and whether the specific failure recurs.

## Guardrails

- Do not commit `evals/cases/*.json`; they contain personal POD data and are
  gitignored except for the synthetic example.
- Do not invent `issue` or `desired` text. Ask the user.
- Do not run the eval unless the user asks; this skill only archives cases.
