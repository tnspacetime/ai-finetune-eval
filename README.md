# Local Qwen + harness

Run [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B) on Apple Silicon and talk to it with a local coding harness:

```text
harness → vLLM-Metal :8000 → Qwen/Qwen3.5-4B
```

Requires Apple Silicon and macOS 15+. Verified on an M4 Max with 64GB. The model weights stay in Hugging Face's cache; this repo pins the runtime and the agent.

## 1. Serve the model

From the repository root, with [uv](https://docs.astral.sh/uv/):

```bash
uv sync --project serving --locked
uv run --project serving --locked hf download Qwen/Qwen3.5-4B \
  --revision 851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a
bash serving/serve.sh
```

Wait for `Application startup complete`. Then, in another terminal:

```bash
curl -i http://127.0.0.1:8000/health
curl -sS http://127.0.0.1:8000/v1/models
```

Details, smoke tests, and pinned package versions: [serving/README.md](serving/README.md).

## 2. Run the harness

With [Bun](https://bun.sh/) and Node 22:

```bash
cd harness
cp .env.example .env
bun install --frozen-lockfile
bun run start
```

The harness talks to `http://127.0.0.1:8000/v1`. It can `read`, `write`, and run `bash` in this repository. That is a working directory, not a sandbox.

Details and the two check prompts: [harness/README.md](harness/README.md).
