# Usage HUD (`agy-usage-hud`)

Read-only side panel plugin for Google Antigravity. Shows what the open
conversation actually cost: tokens, cache hit rate, streaming throughput, and
how full the context window is — at three levels: conversation (**L1**), turn
(**L2**), and individual model call (**L3**, click or press Enter/Space on a
turn to expand).

![Usage HUD logo](assets/logo.svg)

## Data sources

Everything is read locally from this machine; nothing is uploaded:

| Source | Purpose |
| --- | --- |
| `<appData>/brain/<conv>/.system_generated/logs/transcript.jsonl` | Every step; `PLANNER_RESPONSE` carries `model`, `input_tokens`, `cache_read_tokens`, `output_tokens`, `created_at` |
| `<appData>/conversations/<conv>.db` (`gen_metadata`) | `max_context_tokens` and `estimated_tokens_used` per model call (best effort) |
| `<appData>/conversations/<conv>.db` (`steps`, `step_type = 15`) | Fallback timing for each model call, plus thinking/response output token split |
| Language server `GetCascadeTrajectory` | `streamingDuration`, `timeToFirstToken`, and thinking/response token split per model call |

`<appData>` is derived from `ANTIGRAVITY_EXECUTABLE_DATA_DIR` rather than
hard-coded: the sidecar walks up from its own data directory to the owning app
data directory (and falls back to scanning `~/.gemini/*` outside the app), so
the plugin works across `antigravity`, `antigravity-cli`, and future product
directories.

**Token semantics:** `input_tokens` is the uncached prompt portion and
`cache_read_tokens` is the cached portion, so the total prompt sent to the model
is `input + cache_read`.

## Context window

`max_context_tokens` is read from the conversation's `gen_metadata` table.

**Every failure path falls back to 512,000.** If `node:sqlite` is unavailable,
the database is absent, the protobuf blob fails to parse, or the schema changes,
the denominator falls back to `~512.0k` directly in the context row (a `~`
prefix indicates an estimated or unaligned window, with details in the tooltip
and `context.alignmentReason` in `/api/usage`).

## Reading the HUD

- **L1 (Conversation summary)** — `turns` / `steps`, `input` / `cache`,
  `output` / `tps`, `total` / `hit`, followed by current context usage and fill
  bar. `total = input + cache + output`, `hit = cache / (input + cache)`.
- **L2 (Turns)** — one row per turn: `17:23 24 steps +7.0m` — start clock, step
  count, and wait since the previous turn.
- **L3 (Model calls)** — expand a turn to see one row per model call:
  `#24 gemini-4-neon-high 409.4k +43s` — 1-based position inside the turn, model
  name, prompt size, and wait since the previous call.

The turn list header shows `TURNS` on the left and `<N> total` on the right.
`#n` on a step is its 1-based position **inside its turn**, not the transcript's
global `step_index`.

### Colour semantics

Two values carry semantic colour:

- **Wait duration** (at the end of a row's title): green `< 1m`, amber `< 5m`,
  red `>= 5m`. When timing data is available, waits are measured from the
  previous call's completion (`created_at + timeToFirstToken + streamingDuration`,
  or `viewableAt` in the SQLite fallback) so the prior call's own generation
  time is excluded; without timing data it falls back to creation-to-creation
  intervals prefixed with `~` (e.g. `~+7.0m`, `gapBasis: 'created_at'`).
  The first turn and its first step have nothing before them, so they show no wait.
- **Cache hit rate** (right-hand column): green `>= 80%`, amber `>= 50%`, red
  `< 50%`.

### Throughput (`tok/s`)

Every rate is reported in `tok/s`, measures **streaming only**, and is
**weighted** across every level (total streamed response tokens divided by total
streaming time, never an unweighted mean of per-step rates):

| Level | Numerator | Denominator |
| --- | --- | --- |
| Step | That call's response tokens | Its streaming time |
| Turn | Turn's streamed response tokens | Sum of those streaming times |
| Conversation | All streamed response tokens | Sum of all streaming times |

- **Response tokens, not total output.** `output_tokens` includes thinking
  tokens, which finish before the first visible token. Charging thinking tokens
  to the streaming span double-counts time, so the numerator uses
  `responseOutputTokens` whenever available.
- **Streaming time, not wall-clock call time.** The language server's
  `generatorMetadata` reports `streamingDuration` and `timeToFirstToken`
  separately. When the language server cannot be reached — or only covers a
  subset of calls — the `steps` table (`createdAt` to `viewableAt`) serves as a
  per-call fallback for unmatched calls. Turn and conversation `tok/s` never mix
  the two methodologies: whenever `generator` samples exist, aggregated `tok/s`
  is computed strictly from `generator` samples (`tpsSource: 'generator'`);
  SQLite-only estimates are prefixed with `~` (`tpsSource: 'steps'`).
- **Minimum streaming duration (`200 ms`).** Calls whose streaming window is
  under `200 ms` show their token counts without a throughput figure, since a
  handful of tokens over tens of milliseconds does not reflect sustained speed.
- **Older transcripts.** Builds that record `PLANNER_RESPONSE` without token
  usage fields are still counted and listed as `no usage`; nothing is invented.

## Install

Install directly from GitHub with the Antigravity CLI:

```bash
agy plugin install https://github.com/AzedL/agy-usage-hud
```

> **Upgrading on Windows:** While the plugin is enabled, the running sidecar
> holds a directory lock on `sidecars/usage_hud`. Disable the plugin first (in
> **Customizations -> Installed** or via `agy plugin disable agy-usage-hud`),
> re-run `agy plugin install`, then re-enable it.

Or build a minimal bundle locally (excluding tests and scripts) and install it:

```bash
npm run build
agy plugin install dist/agy-usage-hud
```

Or copy `dist/agy-usage-hud/` into `~/.gemini/config/plugins/agy-usage-hud/`
(keep the directory name `agy-usage-hud` so `sidecar://` links resolve cleanly)
and enable it in **Customizations -> Installed**.

Open the panel from the auxiliary side pane's `+` menu or via
`sidecar://agy-usage-hud/usage_hud/`.

## Development

Requires Node.js >= 22 (zero runtime or dev npm dependencies).

```bash
npm run check     # Syntax, manifest, asset, and skill checks
npm test          # Run unit and integration tests (node:test)
npm run build     # Package clean plugin bundle to dist/agy-usage-hud/
npm run verify    # Run check + test + build
```

### Project layout

```text
agy-usage-hud/
├── plugin.json                     # Antigravity plugin manifest
├── assets/logo.svg                 # Adaptive 128x128 logo
├── skills/usage-hud/SKILL.md       # Companion skill for chat prompts
├── sidecars/usage_hud/
│   ├── sidecar.json                # Sidecar manifest
│   ├── main.mjs                    # SidecarApp HTTP server & snapshot cache
│   ├── lib/
│   │   ├── cache.mjs               # Bounded LRU snapshot cache & LS retry backoff
│   │   ├── protobuf.mjs            # BigInt-safe protobuf wire walker
│   │   ├── sources.mjs             # Transcript, SQLite, and LS RPC adapters
│   │   └── usage.mjs               # Pure turn/step aggregation & summary
│   └── web/
│       ├── index.html              # Side panel shell & boot watchdog
│       ├── format.js               # Pure formatting & contrast helpers
│       ├── app.js                  # DOM renderer, polling & theme sync
│       ├── styles.css              # Layout & theme-variable styles
│       └── scrollbars.css          # Theme-adaptive scrollbar styles
├── scripts/
│   ├── check.mjs                   # Static verification script
│   └── build.mjs                   # Distributable bundle builder
└── tests/                          # node:test suites
```
