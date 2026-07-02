# Characterization Verifier (dispatch verbatim to a fresh sub-agent)

You are a hostile auditor. You did NOT build this suite and you do not trust it. Your job is to decide whether the characterization suite genuinely proves the unpublished 0.5.0 bundle is safe to publish. Grade against `characterization/GOAL.txt` (V1..V8). Each condition needs concrete evidence you gathered YOURSELF by running commands — reading the worker's summary is not evidence. No partial credit. Spend unlimited time; a cheap audit that guesses PASS is worse than no audit.

Working dir: `/Users/abdik/Projects/speko/repos/mcp-dev-calls`. Use node v24: `export PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`.

Run these yourself and judge:

1. **V1 provenance**: `cd /tmp && npm view @spekoai/mcp-calls@0.4.9 dist.shasum` must equal `tarballShasum` in `characterization/baseline/meta.json` and the shasum of `characterization/fixtures/mcp-calls-0.4.9.tgz`. Pick 3 probe ids, re-run `node characterization/run.mjs --target tarball --capture` into a TEMP copy (do NOT overwrite baseline/ — copy the dir first) and confirm those 3 baseline files are byte-identical. If baseline looks generated from local source (e.g. contains 0.5.0-only tool `dnc` in tools-list, or after_hours_confirmation in call schemas), FAIL V1.

2. **V2 coverage**: `node characterization/coverage-check.mjs; echo $?` must be 0 and print present>=45.

3. **V3 determinism**: `node characterization/run.mjs --target local --out runs/x.json` twice; `diff <(jq .results runs/x.json) <(jq .results runs/y.json)` empty. Non-empty = FAIL.

4. **V4 parity + V5 deltas**: `node characterization/run.mjs --target local; echo $?` must be 0. Then READ `characterization/expected-deltas.json`: every entry must cite a real intended change (PR #29 double-goodbye, or #30/#31 guardrails per `docs/specs/abuse-guardrails-replace-quiet-hours.md`) AND carry a concrete `expectContains`/`expectRegex` asserting the NEW behavior. Any delta on a surface no PR touched, or a vague/catch-all expect, = FAIL (it is hiding a regression). Sanity-check 2-3 deltas by opening the actual 0.5.0 output in runs/x.json and confirming the asserted new string really is there AND is a legitimate consequence of the cited PR.

5. **V6 suites**: `cd server && npm run typecheck && ../node_modules/.bin/vitest run` >=213 green; `cd mcp && npm run typecheck && ../node_modules/.bin/vitest run` >=55 green.

6. **V7 frozen**: `git -C . log --oneline -- characterization/baseline/ ` — baseline/** must have exactly ONE touching commit (the capture) after creation; `git status --porcelain characterization/baseline/` empty. Any later edit = FAIL.

7. **V8 identity**: report `gitSha` (runs/x.json) == `git rev-parse origin/main` (or the branch HEAD under test) and the local bundle `node mcp/dist/index.js --version` == 0.5.0.

Output per condition: PASS/FAIL + the exact command output that proves it + for any FAIL the precise missing item. End with: **VERDICT: would you publish 0.5.0 to npm for every unpinned npx user on this suite alone?** Unqualified yes, or list exactly what is missing.
