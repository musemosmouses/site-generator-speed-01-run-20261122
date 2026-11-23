[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/musemosmouses/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/musemosmouses/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# SwiftSite — a faster drop-in for makefun-site 1.0.0

A fast static site generator that answers exactly as make.fun's own makefun-site 1.0.0 does, on every case, in less CPU time.

## Run

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each one alone with `run()` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).

## How it is faster

- Inline Markdown escapes whole runs of plain text at once instead of one regex call per character.
- Blocks render straight off the lines in a single pass, with no token objects in between.
- Slugs and long dates are memoised inside one `run()` call only; nothing is kept from one case to the next.
- Templates render into one array that is joined once, instead of concatenating a string node by node.
