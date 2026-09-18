# Playground

Sample workspace used to exercise the local harness (`read`, `write`, `bash`).

`wordcount/` is the result of one such run against local Qwen3.5-4B: a small Python line/word/character counter, tests, and a README.

## Repeat the same coding task

Start vLLM first (`bash serving/serve.sh`) and wait for `Application startup complete`.

The committed `wordcount/` folder already contains that app. To give the model the same empty workspace the original run had, use a new directory:

```bash
mkdir -p playground/wordcount-try
cd harness
MINI_V2_ROOT=../playground/wordcount-try bun run start
```

At the harness prompt, paste:

```text
Build a small Python command-line app in this directory that counts lines, words, and characters in a text file. Include tests and a README. Run it and make sure it works.
```

The model should write the program, tests, and README, then run them with `write` and `bash`. The original run needed several repair loops (`python` vs `python3`, test failures) before `python3 -m unittest test_text_count.py -v` passed. Later runs will not match that session byte-for-byte.

Pointing `MINI_V2_ROOT` at the existing `../playground/wordcount` instead reuses the already-built app.
