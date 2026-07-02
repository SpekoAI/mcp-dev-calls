# Characterization suite

Black-box behavioral lock for `@spekoai/mcp-calls`. Freezes what published **0.4.9** does, proves the local build changed only what PRs #29/#30/#31 intended.

```bash
export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"
node characterization/coverage-check.mjs          # V2: all required probes present
node characterization/run.mjs --target local      # the gate: parity vs baseline + justified deltas
```

- `baseline/` — frozen 0.4.9 snapshots (from the npm tarball; never edit; the only escape is `expected-deltas.json`).
- `fixtures/` — the downloaded 0.4.9 tarball + extraction (gitignored).
- `probes.mjs` — the matrix (CLI + MCP stdio tool calls, dummy key + `127.0.0.1:9` sinkhole).
- `expected-deltas.json` — each intended 0.5.0 behavior change, with a concrete `expectContains`/`expectRegex` and a PR justification.
- `GOAL.txt` / `VERIFIER.md` — the loop's rubric and the hostile-auditor prompt.

A probe "reaches the dial layer" (i.e. passed every rail) when its result normalizes to `<NETERR>` — the sinkhole connection error. That is the observable signal that a call was NOT rejected.

Re-capturing the baseline requires `--target tarball --capture` and is a deliberate, reviewed act — do not run it to make a failing target pass.
