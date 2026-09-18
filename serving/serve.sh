#!/usr/bin/env bash
set -euo pipefail

serving_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export HF_HUB_OFFLINE=1
export VLLM_NO_USAGE_STATS=1
export VLLM_MLX_DEVICE=gpu
export VLLM_METAL_MEMORY_FRACTION=auto

# Pass the pinned local snapshot: the Metal text loader does not forward revision.
model_path="$(uv run --project "$serving_dir" --locked python -c '
import sys
import yaml
from huggingface_hub import snapshot_download

with open(sys.argv[1]) as f:
    config = yaml.safe_load(f)
print(snapshot_download(config["model"], revision=config["revision"], local_files_only=True))
' "$serving_dir/config.yaml")"

exec uv run --project "$serving_dir" --locked vllm serve "$model_path" \
  --config "$serving_dir/config.yaml"
