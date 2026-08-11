# Characterization suite

Black-box behavioral lock for `@spekoai/mcp-calls`. Freezes published **0.4.9** and requires every cumulative local change through 0.8.0 to be either byte-parity or an explicit justified delta.

```bash
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
node characterization/coverage-check.mjs          # V2: all required probes present
node characterization/run.mjs --target local      # the gate: parity vs baseline + justified deltas
```

- `baseline/` — frozen 0.4.9 snapshots (from the npm tarball; never edit; the only escape is `expected-deltas.json`).
- `fixtures/` — the downloaded 0.4.9 tarball + extraction (gitignored).
- `probes.mjs` — the matrix (CLI + MCP stdio tool calls, dummy key + `127.0.0.1:9` sinkhole).
- `expected-deltas.json` — each intended post-0.4.9 behavior change, with a concrete `expectContains`/`expectRegex` and a release/PR justification.
- `GOAL.txt` / `VERIFIER.md` — the loop's rubric and the hostile-auditor prompt.

A baseline probe "reaches the dial layer" when it normalizes to `<NETERR>`. Since PR #64, the
local build instead normalizes mutation-unsafe sinkhole failures to `outcome is unknown` plus
`Do not retry or place another call`; `expected-deltas.json` pins that safer dispatch signal.

Re-capturing the baseline requires `--target tarball --capture` and is a deliberate, reviewed act — do not run it to make a failing target pass.
