# Zero Daily Cost, Caching & Usage Analysis

Analyse yesterday's production AI cost, caching and usage metrics for the zero platform and post a summary to Telegram, then close the topic.

## Context

- Cloudflare account: `4e04b64af4013414441c59014392bea0`
- Observability endpoint: `https://api.cloudflare.com/client/v4/accounts/4e04b64af4013414441c59014392bea0/workers/observability/telemetry/query`
- Auth: `$CLOUDFLARE_API_TOKEN`
- Current model: `gpt-5.6-luna` (OpenAI). Pricing from `apps/agent-api/src/agents/ai-usage.ts`: input $0.20/M, output $1.20/M, cache_read $0.02/M, cache_write $0.25/M (all writes go to the 5m bucket for OpenAI)

Events used:

| event | one per | fields |
|---|---|---|
| `cache_stats` | model call | `agent`, `step`, `input_tokens`, `cache_read_tokens`, `cache_write_tokens`, `thinking_tokens` — **no `output_tokens`** |
| `interface_completed` | interface run | tokens incl. `output_tokens`, `cache_hit_ratio`, `steps`, `duration_ms`, `searches`, `replies_count` |
| `learn_slice_completed` | learner slice | same shape plus `reason`, `model_steps` |
| `onboarding_completed` | onboarding run | same shape |
| `turn_started` | turn | `clerk_user_id`, `chat_id`, `topic_id`, `history_len` |
| `turn_messages_sent` | turn | `count` (replies delivered) |
| `schedule_fired` | schedule run | `reason`, `late_ms`, `has_conversation` |
| `web_search_completed`, `read_page_completed`, `brave_request` | tool call | research volume / Brave spend |
| `clerk_signup`, `telegram_linked`, `onboarding_started` | signup funnel | new users |
| `turn_incomplete`, `turn_reset_retrying`, `turn_delivery_recovered` | failure | reliability flags |

Caps: `limit` maxes at 1000 and truncates silently — a result of exactly 1000 rows is truncated, split the window per hour and sum.

## Steps

### 1. Pull latest

```bash
cd /home/juan/workspace/juanibiapina/zero && git pull --ff-only 2>&1 | tail -3
```

### 2. Fetch both days

`bin/obs-query <msg> <from_ms> <to_ms>` is checked into the repo and prints the
raw API response. Keep every response in one run-scoped directory so a later
step never depends on a file another run left behind.

```bash
cd /home/juan/workspace/juanibiapina/zero
RUN=$(mktemp -d -t zero-pulse-XXXXXX)
echo "run dir: $RUN"

FROM=$(date -u -d 'yesterday 00:00' +%s)000
TO=$(date -u -d 'today 00:00' +%s)000
PREV_FROM=$(date -u -d '2 days ago 00:00' +%s)000
DATE=$(date -u -d 'yesterday' +%Y-%m-%d)

for m in cache_stats interface_completed learn_slice_completed onboarding_completed \
         turn_started turn_messages_sent schedule_fired web_search_completed \
         read_page_completed brave_request clerk_signup telegram_linked \
         turn_incomplete turn_reset_retrying turn_delivery_recovered; do
  bin/obs-query $m $FROM $TO > $RUN/z_$m.json
  bin/obs-query $m $PREV_FROM $FROM > $RUN/p_$m.json
  printf "%-25s %4s (prev %s)\n" $m \
    "$(jq '.result.events.events|length' $RUN/z_$m.json)" \
    "$(jq '.result.events.events|length' $RUN/p_$m.json)"
done
```

Every later step reuses `$RUN`. If the shell that set it is gone, re-run this
block rather than guessing a path. Delete the directory once the summary is
posted: `rm -rf "$RUN"`.

If `cache_stats` is 0, note that there was no production traffic yesterday and post a brief message saying so.

### 3. Usage / analytics

```bash
echo "users:         $(jq -r '[.result.events.events[].source.clerk_user_id]|unique|length' $RUN/z_turn_started.json)"
echo "conversations: $(jq -r '[.result.events.events[].source|"\(.chat_id)/\(.topic_id)"]|unique|length' $RUN/z_turn_started.json)"
echo "turns:         $(jq '.result.events.events|length' $RUN/z_turn_started.json)"
echo "replies sent:  $(jq '[.result.events.events[].source.count]|add // 0' $RUN/z_turn_messages_sent.json)"
echo "scheduled:     $(jq '.result.events.events|length' $RUN/z_schedule_fired.json) fired"
echo "per-user turns:"
jq -r '.result.events.events[].source.clerk_user_id' $RUN/z_turn_started.json | sort | uniq -c | sort -rn
echo "hourly turns:"
jq -r '.result.events.events[].timestamp' $RUN/z_turn_started.json | awk '{print strftime("%H", $1/1000, 1)}' | sort | uniq -c
```

Also compute: median/p90 `duration_ms` from `interface_completed`, mean `steps` per run, searches per turn, and how many turns came from schedules vs. real user messages.

New users: count `clerk_signup` and `telegram_linked`. Reliability: any non-zero `turn_incomplete`, `turn_reset_retrying` or `turn_delivery_recovered` is worth a line.

### 4. Aggregate tokens by agent

```bash
jq -r '.result.events.events[].source | [.agent,.input_tokens,.cache_read_tokens,.cache_write_tokens,.thinking_tokens] | @tsv' $RUN/z_cache_stats.json \
  | awk -F'\t' '
    {c[$1]++; i[$1]+=$2; r[$1]+=$3; w[$1]+=$4; t[$1]+=$5; C++; I+=$2; R+=$3; W+=$4; T+=$5}
    END {
      for(a in i) printf "%-12s calls=%-5d in=%-8d read=%-8d write=%-8d think=%d\n", a, c[a], i[a], r[a], w[a], t[a]
      printf "%-12s calls=%-5d in=%-8d read=%-8d write=%-8d think=%d\n", "TOTAL", C, I, R, W, T
    }'
```

Output tokens are **not** on `cache_stats`; sum them from the `*_completed` events:

```bash
for f in interface_completed learn_slice_completed onboarding_completed; do
  jq -r --arg n $f '"\($n) out=\([.result.events.events[].source.output_tokens]|add // 0)"' $RUN/z_$f.json
done
```

### 5. Compute cost and cache metrics

- **Hit ratio**: `cache_read / (cache_read + cache_write + input)` as a percentage
- **Total cost**: `input*0.20/1e6 + cache_read*0.02/1e6 + cache_write*0.25/1e6 + output*1.20/1e6`
- **Cost per turn** and **cost per user**, using the counts from step 3
- **Cold-prefix calls** (`cache_read_tokens == 0`): count and share of writes. `compaction` calls are cold by design; call out only the interface/learner ones.

```bash
jq -r '.result.events.events[].source | [.agent, .cache_read_tokens, .cache_write_tokens] | @tsv' $RUN/z_cache_stats.json \
  | awk -F'\t' '$2==0{cold++; cw+=$3} {total++; W+=$3} END{printf "Cold calls: %d/%d (%.0f%%), cold writes: %dk tokens ($%.3f), %.0f%% of all writes\n", cold, total, cold/total*100, cw/1000, cw*0.25/1e6, cw/W*100}'
```

Repeat steps 4–5 against the `$RUN/p_*.json` files for the previous day's comparison line.

### 6. Post summary to Telegram

Post a compact message with:
- Date, users, conversations, turns, replies
- Token table per agent + total (code block)
- Hit ratio, total cost, cost per turn, cost per user
- Cold-prefix anomaly count
- Research volume (searches, page reads, Brave 200s)
- One-line comparison to the previous day for users, turns, hit ratio and cost
- One observation or flag if anything looks wrong: hit ratio below 50%, cost spiked >2x, cost per turn above ~$0.05, many cold calls, any reliability event, or usage concentrated in a single user

Keep it under 25 lines. Use a code block for the table.

Then send a "Close topic" button:

```
send_telegram_buttons with one button: "Close topic"
```

When the user taps "Close topic", call `close_telegram_topic`.
