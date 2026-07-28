# Verification: writer cache-prefix drop recommendation

Verified 2026-07-28 against `main` at `4869e83`, the same commit named by the
plan. Verdict: **DROP is the right product decision, but all three stated
pillars need correction.** The warm-state arithmetic is enough to reject the
task. The plan should not claim that the requested writer-read-interface path is
already active, or that matching wire definitions requires enabling side
effects in the writer.

## Findings

### Blockers

None. The recommendation remains sound after correcting the concerns below.

### Concerns

#### 1. The shared definitions exist, but the requested cache direction is not already done

The source confirms the important structural premise:

- `buildTopicTools` defines, in order, `list_topics`, `get_topic`,
  `list_backlinks`, `create_topic`, and `update_topic`
  (`apps/agent-api/src/tools/topics.ts:29-107`).
- The writer uses exactly `buildTopicTools` (`apps/agent-api/src/agents/writer.ts:31`).
- `buildInterfaceTools` spreads `buildTopicTools` first, then adds
  `delete_topic` and `reply` (`apps/agent-api/src/tools/topics.ts:128-172`).
- The interface spreads that result first, then research, timezone, Google, and
  attachment tools (`apps/agent-api/src/agents/interface.ts:290-317`).
- `toToolDefinitions` preserves insertion order through `Object.entries`
  (`apps/agent-api/src/agents/protocol.ts:182-190`).

A throwaway probe against these builders produced:

```text
writer:    list_topics, get_topic, list_backlinks, create_topic, update_topic
interface: list_topics, get_topic, list_backlinks, create_topic, update_topic,
           delete_topic, reply, research, set_timezone, gmail_search,
           gmail_thread, gmail_send, calendar_list_calendars,
           calendar_list_events, calendar_create_event, view_attachment
plain writer definitions == first 5 interface definitions: true
```

The interface therefore has both topic-write tools, and the five tool
definitions are the interface's exact leading definitions. The task premise that
the interface lacks writer write tools is false.

The plan's next inference is not correct for the task's stated direction. Every
agent marks only its own last tool (`apps/agent-api/src/agents/run.ts:214-217`).
The writer writes an entry ending at `update_topic`; the interface writes one
ending at `view_attachment`. Anthropic's backward search lets an **interface**
request find the earlier five-tool entry that a writer request wrote. It does
not let a later **writer** request walk forward to the interface's 16-tool
entry. The plan acknowledges this direction at
`docs/plans/writer-cache-prefix.md:215-216`, but still calls the requested work
"already done" at lines 294-296. It is not.

To make the interface warm the five-tool entry for the writer, the interface
would need a cache breakpoint at `update_topic`. Adding one exceeds the four
breakpoints used on history turns. Moving the existing tool breakpoint from
`view_attachment` to `update_topic` stays within four, an alternative the plan
does not assess, but it gives up the interface's cross-user cache entry for
tools 6 through 16. The system breakpoint may still cache those tools for an
identical interface system prompt, but users with different pinned-topic tails
would reprocess them. The live token-count probe measured that suffix at 1,812
tokens. Replacing a warm 1-hour read with a write for that suffix costs up to
`1,812 * ($6.00 - $0.30) / MTok = $0.01033` for one new system variant, more
than the `$0.00637` gross writer cold-event saving. This trade is unlikely to
pay.

**Correction:** replace "Already done" with: "The common definitions are
already ordered optimally, but the current breakpoints only permit
interface-read-writer reuse. Enabling writer-read-interface reuse needs a new or
moved interface breakpoint and has no warm-turn benefit."

#### 2. "$0.00" is correct in steady state, not as an unconditional saving

The source records are real and predate this plan:

- The 13-row turn table says it came from the Cloudflare AI Gateway and records
  the agent metadata used to classify each call
  (`docs/plans/agent-latency-investigation.md:487-505`, commit `6c4f1b8`).
- The four writer rows are at
  `docs/plans/agent-latency-investigation.md:518-521`; the recorded turn total is
  at line 532.
- The 1,626-token writer head and two later `read=1626, write=0` observations are
  in `docs/caching.md:279-292`, originally committed in `67854fc` as a production
  baseline.

The artifacts do not belong to the same wire version. The 1,626-token baseline
was captured on 2026-07-21. Commit `25540db` replaced the Vercel AI SDK wire
adapter with the direct Anthropic SDK on 2026-07-27 at 15:56 local time, before
the measured 19:51 turn. Its tool-schema serialization changed. The writer
system text stayed byte-identical through the measured turn, but that does not
make the pre-SDK token count transferable.

The source narrative also has a chronology error. It calls the turn a
measurement after four pipeline commits, but the turn occurred after `131a7f0`
and `c9b443a`, before `69452b1` at 20:06 and `00759b8` at 22:07. The latter two
could not have shipped before 19:51. Those changes covered typing duration and
the later research-transcript ceiling, so this error does not invalidate the 13
Gateway cost rows.

A live Anthropic Token Count API probe through the production gateway used the
current tool definitions, which are unchanged since `25540db`, plus the writer
system text from `00759b8^`, which is the text used by the measured turn. It
measured that post-SDK historical head at 1,952 tokens after subtracting the same
bare message. The current writer head is 1,996 tokens. These are token-count
reconstructions, not the missing cache-token split from the old Gateway row, but
they are a better version match than 1,626. The 17:51 Gateway rows do not record
cache reads and writes separately, so they do not directly prove that the writer
head was warm on that turn. The separate production baseline proves that writer
heads do reach `write=0` steady state.

Recalculation from the recorded cost rows and the plan's 1,626-token baseline:

```text
writer cost = 0.01544250 + 0.02075880 + 0.01712835 + 0.00739035
            = $0.06072000
all 13 rows = $0.21725625, rounded in the source to $0.21726
writer share = 27.9481%

one head read = 1,626 * $0.30 / 1,000,000 = $0.00048780
four reads    = $0.00195120
turn share    = 0.8981%
writer share  = 3.2134%
```

The claimed `$0.00195` and `~0.9%` correctly multiply the recorded 1,626-token
baseline, but that baseline is from the wrong wire version. Using the
version-matched 1,952-token reconstruction gives:

```text
four reads = 1,952 * 4 * $0.30 / 1,000,000 = $0.00234240
turn share = $0.00234240 / $0.21725625 = 1.078%
```

The current 1,996-token head would put the same hypothetical at `$0.00239520`,
or 1.10% of the historical turn cost. Both are deliberately impossible
free-read ceilings because sharing does not eliminate cache-read billing. The
actual marginal saving from sharing the tool prefix on a warm turn is `$0`: the
writer already reads its full head at the cache-read rate and has no head write.

The wording overreaches when generalized to all turns. On a cold writer head,
sharing a five-tool entry that the interface had just written could replace a
1-hour write for the tools segment with a read. The live token-count probe
measured that current segment at 1,118 tokens, so the gross cold-event saving is:

```text
1,118 * ($6.00 - $0.30) / 1,000,000 = $0.00637260
```

The writer system remains different and still needs its own write. With one
shared Anthropic key and a one-hour TTL refreshed on hits, the common entry can
become cold at most once per hour, or 24 times per day. Sparse traffic can make
each turn cold, but then the number of turns is low. The gross bound is about
`$0.153/day` before counting the cache loss caused by moving the interface's
breakpoint. The probe measured the 11-tool interface suffix at 1,812 tokens,
larger than the entire common segment, so reprocessing that suffix for varying
interface system prompts can erase the writer gain.

The plan also says the entire 1,626-token cold write "would not [be removed]
either" (`docs/plans/writer-cache-prefix.md:139-142`). That is too broad. The
writer-system part cannot be shared; the common tools part could be, if it is
large enough and the interface writes at that boundary.

**Correction:** say "steady-state saving is exactly `$0` on a warm turn; the
current gross cold-event saving is `$0.00637` before interface-cache tradeoffs."
Treat `$0.00195` as arithmetic for the pre-SDK baseline, not the measured turn;
the version-matched turn ceiling is about `$0.00234` or 1.08%.

#### 3. Identical tool definitions do not require granting the writer working side-effect tools

The list of 11 additional interface tools is correct:

```text
delete_topic, reply, research, set_timezone,
gmail_search, gmail_thread, gmail_send,
calendar_list_calendars, calendar_list_events, calendar_create_event,
view_attachment
```

The definitions come from `apps/agent-api/src/tools/topics.ts:128-172`,
`tools/research.ts:52`, `tools/timezone.ts:23`, `tools/google.ts:82-190`, and
`tools/attachments.ts:42`. Giving the writer their current executable adapters
would expose the capabilities named by the plan, including messaging, mail
send, calendar creation, settings mutation, topic deletion, and nested
research. That would be unsafe.

It is not required for byte-identical model-facing arrays. `toToolDefinitions`
serializes only name, description, and input schema; it does not serialize the
`execute` function (`apps/agent-api/src/agents/protocol.ts:182-190`). Restricted
writer adapters could expose the same definitions while rejecting every call.
That would avoid side effects, though it would still invite useless calls,
increase the writer's cached input on every call, and confuse the writer prompt.
More importantly, sharing the existing five-tool prefix requires only a
breakpoint at the fifth definition, not 11 more definitions.

**Correction:** retain the safety warning for reusing the current executable
adapters, but do not present it as a necessary consequence of matching wire
definitions or of sharing the five-tool prefix. The stronger rejection is cost:
adding 11 schemas makes every warm writer call read more tokens while the writer
system still diverges.

#### 4. R2 was grounded, and a live probe now resolves it for current `main`

The repo previously recorded 1,626 tokens only for writer tools plus writer
system (`docs/caching.md:279-292`). A repo-wide search found no separate token
count for the five tool definitions, so the plan was right to record R2.

Production uses `claude-sonnet-4-6`
(`apps/agent-api/wrangler.jsonc:43`), and `createModelFactory` sends that
configured id to Anthropic (`apps/agent-api/src/agents/model.ts:118-141`).
Anthropic's current prompt-caching documentation lists a 1,024-token minimum for
Claude Sonnet 4.6 and says shorter marked prefixes are processed without caching
and without an error.

For this verification, the Anthropic Token Count API was called through Zero's
production AI Gateway with the tool definitions built from current source and
the same one-token message in each request. Results:

```text
bare request                                  8 tokens
bare + 5 writer tools                     1,126 tokens
5-tool delta                              1,118 tokens
bare + current writer system                886 tokens
bare + 5 tools + current writer system    2,004 tokens
current static-head delta                 1,996 tokens
bare + 16 interface tools                 2,938 tokens
16-tool delta                             2,930 tokens
interface suffix beyond the first 5       1,812 tokens
```

The current five-tool prefix is 94 tokens above Sonnet 4.6's minimum. The R2
failure mode does not apply to current `main`; the tools-only entry is
cacheable. This is a token-count result, not cache telemetry, so it does not
prove that a particular production interface call read a writer-written entry.
It does remove the minimum-length uncertainty.

**Correction:** keep R2 as the reason measurement was required, then record the
1,118-token result and mark the current minimum-length risk resolved.

Sources:

- Anthropic, Prompt caching:
  <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Repository model configuration and production baselines cited above.

### Nits

#### 5. "Byte-identical" and the lookback distance need tighter wording

Before cache markers, the five writer definitions are byte-identical to the
first five interface definitions. The literal request arrays are not: `markLastTool`
adds `cache_control` to writer tool 5 and interface tool 16. Anthropic's cache
search still matches the content prefix because cache-control markers designate
write/check positions rather than changing the cumulative content hash. The
official growing-conversation example depends on this behavior.

Also, interface tool 5 is 11 earlier blocks than tool 16, but Anthropic counts
the breakpoint itself as the first checked position. A scan from tool 16 through
tool 5 checks 12 positions, still within the 20-position limit. Neither issue
changes feasibility.

## Anthropic lookback verification

The plan's description of the cache contract is otherwise correct. Anthropic's
live documentation states:

- prefixes are cumulative in `tools`, then `system`, then `messages` order;
- a breakpoint writes one entry at its cumulative prefix;
- on a miss, a request checks earlier block positions for entries written by
  prior requests;
- each breakpoint checks at most 20 positions, including itself;
- tools, system blocks, and message content blocks are cacheable.

The lookup is across requests, not confined to one request or one message
array. Different later system prompts and message arrays do not affect a hash
ending at tool 5 because they occur after that prefix. Therefore an interface
request can find a writer-written five-tool entry despite different system and
message content, assuming the five-tool prefix reaches 1,024 tokens and remains
within lookback. It can share only those first five tool definitions. It cannot
share either system prompt or any messages: the interface and writer system
texts differ (`apps/agent-api/src/agents/prompts.ts:73-138` and `:241-302`), and
the cumulative hash diverges at the next block.

The documentation does not make the lookup bidirectional. A writer breakpoint
at tool 5 cannot find a cache entry ending at interface tool 16, because tool 16
is later in the prefix. This is the directional defect in finding 1.

## Verdict

**DROP the implementation task.** The corrected reasons are:

1. In the verified warm steady state, prefix sharing saves exactly `$0`; the
   writer already reads its whole head at 0.1x and has no head write. The target
   turn's separate cache split was not captured, so do not label it directly.
2. The only possible gain is a 1,118-token fraction of a global cold write,
   worth `$0.00637` per cold event and `$0` after the writer head is warm. The
   segment clears the 1,024-token minimum, but the gross gain is small.
3. The current direction does not satisfy the task. Reversing it consumes a
   scarce interface breakpoint or moves the existing tool breakpoint away from
   the interface's larger 16-tool cross-user prefix.
4. Full 16-tool alignment is worse in steady state because it adds 11 schemas to
   every writer cache read while the writer system remains unshareable. Safe
   deny adapters can prevent side effects, but they cannot fix that arithmetic.

Do not use "already done" or safety as independent load-bearing reasons. Use the
warm-state cost and breakpoint trade instead. No code change is warranted.
