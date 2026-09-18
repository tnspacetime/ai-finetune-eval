# Playground

Sample workspace used to exercise the local harness (`read`, `write`, `bash`).

`wordcount/` is a small Python line/word/character counter. The harness built and tested it against local Qwen3.5-4B. To point the harness at that directory:

```bash
cd harness
MINI_V2_ROOT=../playground/wordcount bun run start
```
