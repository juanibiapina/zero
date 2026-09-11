# Zero Weekly Cost, Caching & Usage Summary

Synthesize the past week's daily cost-log entries into a single summary and post
it to Telegram as the week's Zero Cost topic. The cron already created the
topic — do **not** call `create_telegram_topic`.

## Context

- **Log file:** `/home/juan/Sync/notes/zero/pulse/COST_LOG.md` — one `## YYYY-MM-DD`
  entry per day, newest first, written by the daily collector (`cost-cache-daily.md`).
  Each entry carries `key=value` metric lines; this job reads them, it does not
  re-query the observability API.
- Pricing and Brave-canary context live in `cost-cache-daily.md` if you need to
  sanity-check a number.

## Steps

### 1. Read the week's entries

```bash
LOG=/home/juan/Sync/notes/zero/pulse/COST_LOG.md
date -u +%Y-%m-%d
sed -n '1,120p' "$LOG"
```

The log is newest-first. Take the most recent 7 dated entries (or fewer if the
log is younger than a week). If the file is missing or has zero entries, post a
one-line note that no daily data was collected this week and stop.

### 2. Synthesize across the 7 days

Compute for the week:

- **Totals:** turns, replies, cost (sum), Brave paid `status:200` and its $, page reads, searches.
- **Averages:** distinct users/day, cost/turn (week cost ÷ week turns), hit ratio (mean of daily `hit_ratio`), median run duration.
- **Trend:** cost and turns first half vs second half of the week, and the day-over-day direction of hit ratio. Name the most expensive day and the busiest day.
- **Brave canary:** sum paid 200s for the week and its $; project the monthly run-rate and flag if it crosses the ~1,000-request/month (~$5) free-credit ceiling.
- **Recurring flags:** which `flags:` lines repeated across days (e.g. usage concentrated in one user, interface/learner cold writes). A flag on 3+ days is a pattern worth calling out; a one-off is not.
- **Reliability:** any day with a non-zero incomplete/reset/recovered.

### 3. Post to Telegram

Post to the current topic (already created by the cron). Format, ~12–15 lines:

```
📊 **Zero weekly cost — YYYY-MM-DD to YYYY-MM-DD**

Turns *T* · Replies *R* · avg *U* users/day · N days of data
Total cost *$X.XX* · avg cost/turn *$X.XXX* · avg hit *XX%*
Brave paid: *P* 200s = *$X.XX*/wk (run-rate ~N/mo, <ceiling|OVER ceiling>)
Research: *S* searches · *P* page reads

**Trend:** cost <up/down/flat> vs first half; hit ratio <up/down/flat>. Priciest day <date> ($X.XX); busiest <date> (T turns).

**Recurring flags:**
- <flag> — <N>/7 days
- ...

**Reliability:** <clean, or list the days/events>
```

If the week was clean, say so in one line instead of an empty flags list.

End with a "Close topic" button via `send_telegram_buttons` (single button:
`Close topic`). When the user taps it, call `close_telegram_topic`.

## What you can change

- Nothing. This job only reads the log and posts. Do not edit `COST_LOG.md`
  (the daily runs own it) or any repo file.
