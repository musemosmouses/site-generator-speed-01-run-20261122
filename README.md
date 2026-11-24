[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/musemosmouses/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/musemosmouses/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# SwiftSite v2 — a faster drop-in for makefun-site 1.0.0

A fast static site generator that answers exactly as make.fun's own makefun-site 1.0.0 does, on every case, in less CPU time. Pure JavaScript: the competition forbids WebAssembly, native addons and prebuilt binaries, so there is no WASM here.

## Run

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each one alone with `run()` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).

## How it is faster

- Inline Markdown is found with one regex scan instead of a per-character JavaScript loop, and renders into one shared array instead of a fresh array per nesting.
- Blocks are walked by index without splitting the body into lines, and each line is classified by its first character before any regex runs.
- Words are counted with an ASCII fast path instead of a twelve-condition chain per character.
- Template loops reuse one scope frame per loop instead of allocating a scope object per item.
- Slugs and long dates are memoised inside one `run()` call only; nothing is kept from one case to the next.
