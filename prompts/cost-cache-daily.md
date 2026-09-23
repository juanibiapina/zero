# Zero Daily Cost, Caching & Usage Collector

Analyse yesterday's production AI cost, caching and usage metrics for the zero
platform and **append one entry to the cost log**. Do **not** post to Telegram
and do **not** create or close a topic — this runs silently every day. The
weekly job (`cost-cache-weekly.md`) reads this log and reports to a topic.

## Context

- Cloudflare account: `4e04b64af4013414441c59014392bea0`
- Observability endpoint: `https://api.cloudflare.com/client/v4/accounts/4e04b64af4013414441c59014392bea0/workers/observability/telemetry/query`
- Auth: `$CLOUDFLARE_API_TOKEN`
- Current model: `gpt-6-luna` (OpenAI). Pricing from `apps/agent-api/src/agents/model-pi.ts`: input $0.10/M, output $0.50/M, cache_read $0.01/M, cache_write $0.125/M (all writes go to the 5m bucket for OpenAI; above 272K input tokens the full request is billed at 2x input/cache and 1.5x output)
- Brave search: most users are on the **free** plan (1 req/s, throttled). A per-user canary routes some users to the **paid** plan ($5 per 1,000 requests, billed on `status:200`; first ~1,000/month free). Every `brave_request` line carries a `cohort` field (`paid`｜`free`); the paid cohort's bill is its `status:200` count × $5/1000. See `docs/plans/brave-paid-canary.md` and `docs/research.md` (Search usage).
- **Log file:** `/home/juan/Sync/notes/zero/pulse/COST_LOG.md` — newest entry first, one entry per day. This is the weekly job's only input, so every field below must be present.

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
| `web_search_completed`, `read_page_completed`, `brave_request` | tool call | research volume / Brave spend; `brave_request` carries `status`, `attempt`, `cohort` (`paid`｜`free`) |
| `clerk_signup`, `telegram_linked`, `onboarding_started` | signup funnel | new users |
| `turn_incomplete`, `turn_reset_retrying`, `turn_delivery_recovered` | failure | reliability flags |

Caps: `limit` maxes at 1000 and truncates silently — a result of exactly 1000 rows is truncated, split the window per hour and sum.

## Steps

### 1. Pull latest

```bash
cd /home/juan/workspace/juanibiapina/zero && git pull --ff-only 2>&1 | tail -3
```

### 2. Fetch yesterday

`bin/obs-query <msg> <from_ms> <to_ms>` is checked into the repo and prints the
raw API response. Keep every response in one run-scoped directory so a later
step never depends on a file another run left behind.

```bash
cd /home/juan/workspace/juanibiapina/zero
RUN=$(mktemp -d -t zero-pulse-XXXXXX)
echo "run dir: $RUN"

FROM=$(date -u -d 'yesterday 00:00' +%s)000
TO=$(date -u -d 'today 00:00' +%s)000
DATE=$(date -u -d 'yesterday' +%Y-%m-%d)

for m in cache_stats interface_completed learn_slice_completed onboarding_completed \
         turn_started turn_messages_sent schedule_fired web_search_completed \
         read_page_completed brave_request clerk_signup telegram_linked \
         turn_incomplete turn_reset_retrying turn_delivery_recovered; do
  bin/obs-query $m $FROM $TO > $RUN/z_$m.json
  printf "%-25s %4s\n" $m "$(jq '.result.events.events|length' $RUN/z_$m.json)"
done
```

Every later step reuses `$RUN`. Delete the directory once the log entry is
written: `rm -rf "$RUN"`.

If `cache_stats` is 0, there was no production traffic yesterday. Still write a
log entry for the day with all metrics at 0 and `flags: no traffic`, then stop.

### 3. Usage / analytics

```bash
echo "users:         $(jq -r '[.result.events.events[].source.clerk_user_id]|unique|length' $RUN/z_turn_started.json)"
echo "conversations: $(jq -r '[.result.events.events[].source|"\(.chat_id)/\(.topic_id)"]|unique|length' $RUN/z_turn_started.json)"
echo "turns:         $(jq '.result.events.events|length' $RUN/z_turn_started.json)"
echo "replies sent:  $(jq '[.result.events.events[].source.count]|add // 0' $RUN/z_turn_messages_sent.json)"
echo "scheduled:     $(jq '.result.events.events|length' $RUN/z_schedule_fired.json) fired"
echo "per-user turns:"
jq -r '.result.events.events[].source.clerk_user_id' $RUN/z_turn_started.json | sort | uniq -c | sort -rn
```

Compute the top user's share of turns (for the concentration flag), median/p90
`duration_ms` from `interface_completed`, and count `clerk_signup` /
`telegram_linked`. Any non-zero `turn_incomplete`, `turn_reset_retrying` or
`turn_delivery_recovered` must land in the entry's `reliability` line.

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
- **Cold-prefix calls** (`cache_read_tokens == 0`): count and share of writes. `compaction` calls are cold by design; record only the interface/learner ones for the flag.

```bash
jq -r '.result.events.events[].source | [.agent, .cache_read_tokens, .cache_write_tokens] | @tsv' $RUN/z_cache_stats.json \
  | awk -F'\t' '$2==0{cold++; cw+=$3} {total++; W+=$3} END{printf "Cold calls: %d/%d (%.0f%%), cold writes: %dk tokens ($%.3f), %.0f%% of all writes\n", cold, total, cold/total*100, cw/1000, cw*0.25/1e6, cw/W*100}'
```

### 5b. Brave search spend by cohort

Split `brave_request` by `cohort` and status. The paid cohort's bill is its
`status:200` count × $5/1000. A `429` is throttling (not billed) and only appears
on the free cohort; retries show as `attempt > 0`.

```bash
jq -r '.result.events.events[].source | "\(.cohort // "free") \(.status)"' $RUN/z_brave_request.json | sort | uniq -c | sort -rn
PAID200=$(jq -r '[.result.events.events[].source | select((.cohort=="paid") and (.status==200))] | length' $RUN/z_brave_request.json)
FREE200=$(jq -r '[.result.events.events[].source | select(((.cohort//"free")=="free") and (.status==200))] | length' $RUN/z_brave_request.json)
python3 -c "print(f'paid 200s: $PAID200 -> \${$PAID200*5/1000:.4f}; free 200s: $FREE200')"
```

### 6. Append the day's entry to the log

Prepend a new entry (newest first) to
`/home/juan/Sync/notes/zero/pulse/COST_LOG.md`. Keep the exact `key=value`
shape below — the weekly job parses it. Create the file with a `# Zero Cost Log`
heading if it does not exist. Fill `flags:` with any of: hit ratio below 50%,
cost spiked >2x vs the prior entry, cost per turn above ~$0.05, many
interface/learner cold calls, any reliability event, usage concentrated in a
single user (>60% of turns), or `none`.

```
## YYYY-MM-DD

users=U convos=C turns=T replies=R schedules=S signups=N linked=N
tokens_in=I cache_read=R cache_write=W output=O thinking=Th
hit_ratio=XX.X cost=X.XXXX cost_per_turn=X.XXXX cost_per_user=X.XXXX
cold_calls=cold/total interface_learner_cold=N cold_write_k=K
searches=S page_reads=P brave_paid_200=P brave_paid_usd=X.XX brave_free_200=F
duration_median_ms=M duration_p90_ms=P
reliability: incomplete=0 reset=0 recovered=0
top_user_share=XX%
flags: <one line, or none>
```

Then delete the run dir: `rm -rf "$RUN"`. Do not send any Telegram message.
