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
the denominator falls back to `512k` and the summary card displays
`window: fallback 512k`.

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
  red `>= 5m`. The first turn and its first step have nothing before them, so
  they show no wait.
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
  separately. When the language server cannot be reached (e.g. standalone runs),
  the `steps` table (`createdAt` to `viewableAt`) serves as a coarse fallback
  that includes first-token wait; `timingSource` in `/api/usage` reports which
  source was used (`generator` or `steps`).
- **Minimum streaming duration (`200 ms`).** Calls whose streaming window is
  under `200 ms` show their token counts without a throughput figure, since a
  handful of tokens over tens of milliseconds does not reflect sustained speed.
- **Older transcripts.** Builds that record `PLANNER_RESPONSE` without token
  usage fields are still counted and listed as `no usage`; nothing is invented.

## Install

```bash
agy plugin validate . --strict
agy plugin install .
```

Or copy this directory into `~/.gemini/config/plugins/agy-usage-hud/` (keep the
directory name `agy-usage-hud` so `sidecar://` links resolve cleanly) and enable
it in **Customizations -> Installed**.

Open the panel from the auxiliary side pane's `+` menu or via
`sidecar://agy-usage-hud/usage_hud/`.
