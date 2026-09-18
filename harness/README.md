# Local Qwen harness

This directory contains the project-owned harness for this local path:

```text
harness -> vLLM-Metal :8000 -> Qwen/Qwen3.5-4B
```

The harness uses the OpenAI Responses API at `/v1/responses`. Bun installs the
locked dependencies; Node runs the harness because it uses `node:sqlite`.

## Configure

Run all harness commands from this directory. Copy the example only when
`.env` is absent:

```bash
cd harness
cp .env.example .env
```

The local configuration is:

```ini
OPENAI_BASE_URL=http://127.0.0.1:8000/v1
OPENAI_API_KEY=local-test-key
OPENAI_MODEL=Qwen/Qwen3.5-4B
MINI_V2_ROOT=..
MINI_V2_DB=.mini-opencode-v2-core.db
```

`MINI_V2_ROOT=..` resolves to the repository root because the harness is run
from this directory. File paths resolve relative to this root, and shell
commands start there. This setting is a working directory, not a security
sandbox. `.env`, installed dependencies, and the local SQLite files are ignored
by the repository-level `.gitignore`.

## Install and type-check

```bash
cd harness
bun install --frozen-lockfile
./node_modules/.bin/tsc --noEmit
```

The locked install should report no changes. The type-check is silent on
success.

## Start and check vLLM

In terminal 1, from the repository root:

```bash
bash serving/serve.sh
```

Wait for `Application startup complete`. In terminal 2:

```bash
curl -i http://127.0.0.1:8000/health
curl -sS http://127.0.0.1:8000/v1/models
```

The health request must return HTTP 200. The model list must contain
`Qwen/Qwen3.5-4B` and the cached revision ending in
`851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a`.

## Responses API smoke tests

Start the direct-provider harness in terminal 2:

```bash
cd harness
bun run start
```

At the harness prompt, test a plain text turn:

```text
Reply with exactly HARNESS_TEXT_OK. Do not use any tools.
```

Expected final output:

```text
HARNESS_TEXT_OK
```

Then test the complete file-reading tool loop. The marker is deliberately
absent from this prompt:

```text
Use the read tool exactly once to read harness/fixtures/read-marker.txt. Do not use bash or write. After the tool result, reply with exactly the marker from the file and nothing else.
```

Expected material output:

```text
[tool:read] {"path": "harness/fixtures/read-marker.txt"}
[tool:read] done

QWEN_READ_TOOL_MARKER_7391_ORCHID
```

Run `/events` before quitting to inspect the durable `ToolCalled`,
`ToolSettled`, and two `StepCompleted` events. Run `/quit` to exit cleanly.
The CLI is interactive; do not pipe several commands into stdin at once because
stdin can reach EOF while a model turn is still running.

## Stop the server

Press **Ctrl+C** in terminal 1. This stops vLLM and releases its Metal memory
without deleting the pinned environment or cached model.
