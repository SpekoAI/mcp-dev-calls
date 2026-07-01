# Voice on the CLI — `speko audio`

`@spekoai/mcp-calls` is **cli + mcp in one binary**. Alongside the MCP server (for coding
agents) and the calling tools, it does **text-to-speech** and **speech-to-text** right in your
terminal — modeled on [`vercel-labs/ai-cli`](https://github.com/vercel-labs/ai-cli)'s
`ai audio speak` / `ai audio transcribe`, but powered by **Speko's provider router**: you don't
name a model, Speko benchmarks the providers, auto-routes to the best one, and prints which won.

## Setup

```bash
export SPEKO_API_KEY=sk_...          # get one at https://platform.speko.dev
# or run the wizard: npx @spekoai/mcp-calls login
```

Everything below also works via `npx @spekoai/mcp-calls <...>` without installing.

## `speak` — text to speech

```bash
speko audio speak "call you in five"                 # save <id>.wav in cwd + play it
speko audio speak "hola, ¿cómo estás?" --lang es-MX  # any language (BCP-47)
echo "ship it" | speko audio speak                   # text from stdin
speko audio speak "welcome" -o welcome.mp3 --no-play # write a specific file, don't play
speko audio speak "hi" --json                        # metadata to stdout, file still written
```

| flag | what it does | SDK field |
|------|--------------|-----------|
| `--optimize-for latency\|balanced\|accuracy\|cost` | bias the router (Speko's edge) | `optimizeFor` |
| `--voice <id>` | specific voice (see `voices`) | `voice` |
| `--provider <p>` | pin a provider (router still ranks within it) | `constraints.allowedProviders.tts` |
| `--model <name>` | pin an upstream model, e.g. `eleven_turbo_v2_5` | `model` |
| `--speed <n>` | speech rate | `speed` |
| `--lang <code>` | BCP-47 language, default `en` | `language` |
| `-o, --output <path>` | file path, or a dir (auto-named `<id>.<ext>`) | — |
| `--format wav\|mp3` | override the container extension | — |
| `--no-play` | don't auto-play (interactive only) | — |
| `--json` / `-q, --quiet` | JSON metadata / silence the status line | — |

**Output rules** (predictable artifacts, like ai-cli):
- interactive terminal → writes `<id>.<ext>` (dir via `SPEKO_OUTPUT_DIR`) **and plays it**
- piped (`| something`) → raw audio bytes to **stdout**, nothing else
- `-o file` → that path; `-o dir/` → `dir/<id>.<ext>`
- after each run, `via <provider>:<model> · failover N` prints to **stderr**

## `transcribe` — speech to text

```bash
speko audio transcribe recording.wav                 # transcript → stdout
speko audio transcribe https://…/clip.mp3            # from a URL
cat call.wav | speko audio transcribe --lang es-MX   # from stdin
speko audio transcribe rec.wav --keywords "Speko,LiveKit,Telnyx"  # bias proper nouns
speko audio transcribe rec.wav --json                # {text, provider, confidence, ...}
```

| flag | what it does | SDK field |
|------|--------------|-----------|
| `--lang <code>` | BCP-47 language, default `en` | `language` |
| `--keywords a,b,c` | domain keywords to bias the STT | `keywords` |
| `--content-type <mime>` | override (needed for stdin without a filename) | `contentType` |
| `--optimize-for …` / `--provider <p>` | routing preference / pin | `optimizeFor` / `constraints.allowedProviders.stt` |
| `-o <path>` / `--format txt\|md` / `--json` / `-q` | persist / format / JSON / quiet | — |

Input can be a **file path**, an **http(s)/file:// URL**, or **piped stdin**. The transcript always
goes to **stdout** (pipe-clean); provider/model/confidence to **stderr**.

## `voices` — the catalog

```bash
speko voices                          # or: speko models
speko voices --provider cartesia
speko voices --json
```
Lists the providers + models the router can pick from (navai, xai, elevenlabs, cartesia, openai,
inworld, alibaba, …). ElevenLabs voices are account-scoped — pass `--voice <id>` for those.

## Compose (mirrors ai-cli)

```bash
speko audio speak "read this back" | speko audio transcribe
```

## How it connects (no SDK changes)

Each command is a thin wrapper over the already-installed `@spekoai/sdk`:
`speak → speko.synthesize()`, `transcribe → speko.transcribe()`, `voices → speko.voices.list()`.
The CLI is a pure **consumer** of the SDK; the SDK talks to Speko's benchmark-router, which picks
the provider and fails over automatically. Bare `speko` in a terminal prints this command list;
when an MCP host launches it (piped, non-TTY stdin) it runs the stdio MCP server.

## Exit codes

`0` success · `1` runtime failure (no key, provider error) · `2` bad usage (unknown flag, no input).
