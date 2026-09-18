# Local serving runtime

Qwen3.5-4B loads on the Metal GPU and serves a localhost API. Chat, single-tool,
and parallel-tool smoke tests passed.

Verified on 2026-09-04: M4 Max, macOS 26.6.2; one-time GPU checks, `vllm --version`,
offline locked sync, and dependency compatibility check all passed.

Requires Apple Silicon and macOS 15+. Run from the repository root:

```bash
uv sync --project serving --locked
uv run --project serving --locked vllm --version
```

`uv` manages Python 3.12.12 and the isolated `serving/.venv` environment.

## Model and server

The original BF16 model is already downloaded into Hugging Face's shared cache,
outside this repository. To reproduce the download on another machine:

```bash
uv run --project serving --locked hf download Qwen/Qwen3.5-4B \
  --revision 851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a
```

The script resolves the exact cached revision in `config.yaml` and passes its
local path to vLLM, preventing the Metal loader from resolving a different
revision. Hugging Face offline mode is enabled; vLLM usage reporting is disabled.

- API base: `http://127.0.0.1:8000/v1`; model: `Qwen/Qwen3.5-4B`.
- Startup settings: text-only BF16, 32K context, one active request, 2,048-token
  prefill batches, memory-budget fraction 0.30, prefix caching off.
- Thinking enabled; `qwen3` reasoning parser and `qwen3_coder` tool-call parser.
- Uses vLLM generation defaults; evaluation requests must specify their sampling
  settings and output-token limits. Benchmark settings are not frozen yet.

Check from a second terminal:

```bash
curl -i http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/v1/models
```

Verified on 2026-09-04: health HTTP 200 and the expected model/revision listed.
Startup checks passed; the response-level smoke tests are recorded below.

## Pinned packages

- vLLM core: `0.28.0+cpu`, the official macOS ARM64 wheel.
- vLLM-Metal: `0.28.0`, the official macOS ARM64 wheel.
- MLX: `0.32.0`, pinned by the plugin for native binary compatibility.
- MLX-LM: commit `254d153fdeb6f150edd4fc5a54f9828638481fa8`, as required by the plugin.
- Remaining dependency versions and wheel hashes: `uv.lock`.

These are the matching prebuilt wheels used by the upstream stable installer,
declared directly in `pyproject.toml` so we can use a project-local environment
and lockfile. The core wheel's `+cpu` label does not mean CPU-only inference:
the Metal plugin supplies Apple GPU execution. MLX-LM is packaged from its
pinned Git revision; the vLLM core and Metal native extensions are prebuilt.

Sources: [upstream installation instructions](https://github.com/vllm-project/vllm-metal/blob/v0.28.0/docs/installation.md),
[matching vLLM release](https://github.com/vllm-project/vllm-metal/blob/v0.28.0/.github/vllm-release-tag.commit).

## Start server and run smoke tests

**Start — terminal 1:**

```bash
bash serving/serve.sh
```

Wait for `Application startup complete`. Keep this terminal open; **Ctrl+C**
stops the server and releases its memory without deleting the model files.

### Chat smoke test — terminal 2

```bash
curl --fail-with-body -sS --max-time 180 http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3.5-4B",
    "messages": [
      {"role": "user", "content": "What is 2 + 2? Answer briefly."}
    ],
    "max_tokens": 1024
  }'
```

Captured output (formatted with whitespace only; generated IDs and timestamps vary):

```json
{
  "id": "chatcmpl-8eb498c08eba0dbc",
  "object": "chat.completion",
  "created": 1788550428,
  "model": "Qwen/Qwen3.5-4B",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "\n\n4",
        "refusal": null,
        "annotations": null,
        "audio": null,
        "function_call": null,
        "reasoning": "Thinking Process:\n\n1.  **Analyze the Request:** The user is asking for the sum of 2 + 2 and requesting a brief answer.\n\n2.  **Calculate the Result:** 2 + 2 = 4.\n\n3.  **Formulate the Output:** Keep it concise as requested.\n    *   Draft 1: 2 plus 2 is 4.\n    *   Draft 2: The answer is 4.\n    *   Draft 3: 4.\n\n4.  **Select the Best Output:** \"4\" is the most brief and direct. \"The answer is 4\" is also good. Let's go with \"4\". Or slightly more natural for text. \"4.\"\n\n5.  **Final Decision:** \"4\" is clear and brief.\n\n6.  **Review Constraints:** \"Answer briefly.\"\n\n7.  **Final Output Generation:** 4.cw\n"
      },
      "logprobs": null,
      "finish_reason": "stop",
      "stop_reason": null,
      "token_ids": null,
      "routed_experts": null
    }
  ],
  "service_tier": null,
  "system_fingerprint": "vllm-0.28.0-18e06de1",
  "usage": {
    "prompt_tokens": 21,
    "total_tokens": 223,
    "completion_tokens": 202,
    "prompt_tokens_details": null,
    "completion_tokens_details": {
      "reasoning_tokens": 198
    }
  },
  "prompt_logprobs": null,
  "prompt_token_ids": null,
  "prompt_text": null,
  "kv_transfer_params": null,
  "ec_transfer_params": null,
  "metrics": null
}
```

**Result: passed.** `message.content` was `4`, `finish_reason` was `stop`,
and reasoning was returned separately.

## Single-tool-call smoke test

Start the server in terminal 1 using the command above, then run this in terminal 2:

```bash
curl --fail-with-body -sS --max-time 180 http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3.5-4B",
    "messages": [
      {"role": "user", "content": "What is the current weather in Toronto?"}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "City name"}
          },
          "required": ["city"],
          "additionalProperties": false
        }
      }
    }],
    "tool_choice": "auto",
    "max_tokens": 1024
  }'
```

Captured output (formatted with whitespace only; generated IDs and timestamps vary):

```json
{
  "id": "chatcmpl-8b3b6843352fc710",
  "object": "chat.completion",
  "created": 1788550440,
  "model": "Qwen/Qwen3.5-4B",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "refusal": null,
        "annotations": null,
        "audio": null,
        "function_call": null,
        "tool_calls": [
          {
            "id": "chatcmpl-tool-8145efa8a8ee8004",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\": \"Toronto\"}"
            }
          }
        ],
        "reasoning": "The user is asking about the current weather in Toronto. I have a function called \"get_weather\" that can retrieve weather information for a city. I need to call this function with \"Toronto\" as the city parameter.\n"
      },
      "logprobs": null,
      "finish_reason": "tool_calls",
      "stop_reason": null,
      "token_ids": null,
      "routed_experts": null
    }
  ],
  "service_tier": null,
  "system_fingerprint": "vllm-0.28.0-18e06de1",
  "usage": {
    "prompt_tokens": 289,
    "total_tokens": 362,
    "completion_tokens": 73,
    "prompt_tokens_details": null,
    "completion_tokens_details": {
      "reasoning_tokens": 45
    }
  },
  "prompt_logprobs": null,
  "prompt_token_ids": null,
  "prompt_text": null,
  "kv_transfer_params": null,
  "ec_transfer_params": null,
  "metrics": null
}
```

**Result: passed.** Exactly one `get_weather` call was returned; its arguments
parsed as `{"city":"Toronto"}`. A null `message.content` is normal for a
tool-call response.

## Parallel-tool-call smoke test

Run in terminal 2 while the server is running:

```bash
curl --fail-with-body -sS --max-time 180 http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen/Qwen3.5-4B",
    "messages": [
      {"role": "user", "content": "What is the current weather in Toronto and Tokyo?"}
    ],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string", "description": "City name"}
          },
          "required": ["city"],
          "additionalProperties": false
        }
      }
    }],
    "tool_choice": "auto",
    "max_tokens": 1024
  }'
```

Captured output (formatted with whitespace only; generated IDs and timestamps vary):

```json
{
  "id": "chatcmpl-9bf39ee413f7a8a4",
  "object": "chat.completion",
  "created": 1788550451,
  "model": "Qwen/Qwen3.5-4B",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "refusal": null,
        "annotations": null,
        "audio": null,
        "function_call": null,
        "tool_calls": [
          {
            "id": "chatcmpl-tool-b857eaac51a18b02",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\": \"Toronto\"}"
            }
          },
          {
            "id": "chatcmpl-tool-a8eb68200c0ec099",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"city\": \"Tokyo\"}"
            }
          }
        ],
        "reasoning": "The user is asking for the current weather in two cities: Toronto and Tokyo. I need to use the get_weather function for each city. Let me check the function parameters - it requires a \"city\" parameter and I should use the exact city names provided by the user.\n\nI'll make two function calls - one for Toronto and one for Tokyo.\n"
      },
      "logprobs": null,
      "finish_reason": "tool_calls",
      "stop_reason": null,
      "token_ids": null,
      "routed_experts": null
    }
  ],
  "service_tier": null,
  "system_fingerprint": "vllm-0.28.0-18e06de1",
  "usage": {
    "prompt_tokens": 291,
    "total_tokens": 418,
    "completion_tokens": 127,
    "prompt_tokens_details": null,
    "completion_tokens_details": {
      "reasoning_tokens": 72
    }
  },
  "prompt_logprobs": null,
  "prompt_token_ids": null,
  "prompt_text": null,
  "kv_transfer_params": null,
  "ec_transfer_params": null,
  "metrics": null
}
```

**Result: passed.** The one response contained two separate `get_weather`
calls, with arguments that parsed as `{"city":"Toronto"}` and
`{"city":"Tokyo"}`.

These are interface smoke tests only. They do not execute a weather service and
are not BFCL benchmark scores.

## Per-request timing metrics smoke test

Verified on 2026-09-12 after enabling `enable-per-request-metrics` in
`config.yaml`. Input:

```json
{
  "model": "Qwen/Qwen3.5-4B",
  "messages": [{"role": "user", "content": "Reply exactly: OK"}],
  "temperature": 0,
  "top_p": 1,
  "seed": 0,
  "max_tokens": 16,
  "chat_template_kwargs": {"enable_thinking": false}
}
```

Captured output, shortened to the generated message, token usage, and timing
fields:

```json
{
  "model": "Qwen/Qwen3.5-4B",
  "choices": [{
    "message": {"role": "assistant", "content": "OK", "reasoning": null},
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 16,
    "completion_tokens": 2,
    "total_tokens": 18,
    "completion_tokens_details": {"reasoning_tokens": 0}
  },
  "metrics": {
    "time_to_first_token_ms": 368.7910409644246,
    "generation_time_ms": 22.05954201053828,
    "queue_time_ms": 0.017042038962244987,
    "mean_itl_ms": 22.05954201053828,
    "tokens_per_second": 5.117044945352214
  }
}
```

**Result: passed.** vLLM returned all five per-request timing fields. This was a
single non-streaming connectivity check, not a benchmark result.
