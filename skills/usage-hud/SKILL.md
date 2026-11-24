---
name: usage-hud
description: Inspect the current conversation's token usage, cache hit rate, per-turn cache misses, streaming throughput, and context window fullness using the same metrics as the Usage HUD sidecar panel.
---

# Usage HUD

Use this skill when the user asks about token consumption, cache hit rate, which turns lost the most cache, streaming speed (`tok/s`), or context window fullness for the current conversation.

## 1. Surface the side panel when helpful

If the `agy-usage-hud` plugin is enabled and running, offer a one-click pill to open the live Usage HUD auxiliary panel:

```markdown
[Usage](sidecar://agy-usage-hud/usage_hud/)
```

Only emit the pill once and only when the panel is relevant to the user's request.

## 2. Compute exact numbers consistently with Usage HUD

Read the current conversation's compact transcript at:

```text
<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl
```

Apply the exact same definitions used by the Usage HUD sidecar:

1. **Turns**: Split the sorted `transcript.jsonl` entries (ordered by `step_index`) into turns starting at each `type === "USER_INPUT"` step. Ignore leading implicit turns that contain no `PLANNER_RESPONSE` steps.
2. **Model calls (steps)**: Only `type === "PLANNER_RESPONSE"` entries count as model calls. Entries without numeric `input_tokens` still count as steps (`no usage`) but contribute no tokens.
3. **Token semantics**:
   - `input_tokens`: prompt tokens **not** served from cache.
   - `cache_read_tokens`: prompt tokens served from cache.
   - `prompt = input_tokens + cache_read_tokens` (actual prompt size sent to the model).
   - `total = input_tokens + cache_read_tokens + output_tokens`.
   - `hitRate = cache_read_tokens / (input_tokens + cache_read_tokens)` (when denominator > 0).
4. **Context window**:
   - Current context used is the `prompt` (`input_tokens + cache_read_tokens`) of the most recent metered `PLANNER_RESPONSE`.
   - Compare against `max_context_tokens` when known (otherwise note the `512k` fallback denominator).
5. **Diagnosing cache loss**:
   - For each turn, compute both cache hit rate (`cache / (input + cache)`) and uncached `input_tokens` added.
   - Highlight the turns with the lowest hit rate and/or largest uncached `input_tokens` spikes, noting any long idle wait between turns (cache TTL expiry often shows up after >5 minute gaps).
