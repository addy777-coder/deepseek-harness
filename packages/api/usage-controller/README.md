---
description: "Query recent session activity, exact recorded token totals, daily trends, and model shares across a Harness data directory."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-usage-controller

English | [中文](README.zh.md)

## Summary

Read usage across live and persisted sessions, including archived sessions, without starting their agents. Select the last 7 or 30 local calendar days and receive token totals, user activity, model shares, and an independent year of activity. Partial-history and missing-usage counters keep incomplete results visible; opening or refreshing a large history can require reading uncached logs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shared GUI composition mounts the Host controller and its Client entry. The generated `usage.get({ days, timeZone })` Remote accepts `7` or `30` and a valid IANA time zone; both endpoints of the returned date interval are inclusive and include today. The [usage page](../../client/ui-usage/README.md) supplies the browser's current zone.

### Configuration

Mount this plugin beside `sessions` and `sessionQuery`; the shared GUI supplies these explicit limits:

```yaml
- name: '@deepseek-ai/dsh-api-usage-controller'
  config:
    concurrentReads: 4
    cacheSize: 256
```

| Field | Default | Meaning |
|---|---|---|
| `concurrentReads` | Required; GUI selects `4` | Maximum simultaneous session observations per query; positive safe integer. |
| `cacheSize` | Required; GUI selects `256` | Maximum cached session summaries; positive safe integer. |

The [configuration catalog](../../../docs/config-catalog.md) owns the generated configuration reference. Invalid limits fail during plugin loading; an invalid range or time zone fails the query.

<a id="accounting-and-incomplete-data"></a>
### Accounting and incomplete data

Token totals include recorded conversation, subagent, and compaction usage. The [token-meter normalizer](../../llm/token-meter/README.md) accepts a consistent provider total, or derives a total only from complete disjoint input, cache-read, cache-write, and output buckets. Reasoning is an output subdivision and is not added again. Each attempt keeps its last valid sample; final-message usage replaces streaming usage for that attempt, retries count separately, and reported usage survives failure or cancellation. Tokens belong to the sample's local date and recorded provider/model pair.

Session count means distinct main sessions with a user message in the selected interval. Message count includes only their `user/message` events with `source.kind = user`; injected and subagent messages do not create activity. Active days follow the selected range. The current streak extends backward from today across all available history and is zero when today has no user message. The 365-day heatmap uses user-message counts regardless of the selected range.

Fork observations exclude inherited events while retaining inherited request headers for model attribution. A failed individual session read increments `coverage.unreadableSessions` and leaves the remaining result usable. `coverage.missingUsageAttempts` counts recorded attempts in the selected interval without an exact valid usage sample; neither counter causes token estimation. Failure to enumerate the corpus, or failure to read every session in a nonempty corpus, fails the whole query; an empty corpus returns zero statistics.

### Client lifecycle

The Client-only `ctx.usage` service exposes a bare observable `snapshot` plus `load(request)` and `refresh()`. Snapshot status is `idle`, `loading`, `ready`, or `error`; loading and failure retain the last complete result. A new selection cancels the preceding read, and superseded replies cannot publish. Refresh and connection recovery resample the browser's time zone; they start no query before an explicit load. Disposal cancels outstanding queries, stops notifications, and awaits settlement.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host obtains live-preferred observations through `sessionQuery`, folds each session into compact daily counters, and aggregates those counters into one response. Observation leases close before summaries enter the cache; the browser receives statistics rather than raw histories. Cache reuse requires matching session/provider identity, live sequence or durable revision, and time zone. Persistent revision checks detect another process's writes, and the bounded cache evicts its least recently used session summaries.

Host and Client compile in separate programs. The Host owns generated Remote methods; the Client imports their generated declarations and owns query ordering. UI subscriptions belong to the renderer. No runtime invariant companion is published: these read-derived statistics own no independent durable state to reconcile.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages define the query inputs and the presentation consuming its result.

- [Session Query](../../session-query/session-query/README.md) — live and cold history observations.
- [Token Meter](../../llm/token-meter/README.md) — exact usage normalization and session projections.
- [Usage page](../../client/ui-usage/README.md) — settings interaction and charts.
- [Usage accounting decision](../../../.agents/notes/implemented/feature/2026-09-08-usage-statistics-from-session-history.md) — authority, alternatives, and tradeoffs.

-----

<a id="model-experience"></a>
## Model Experience

None, as the controller reads recorded history and registers no prompt, tool, or session event.

#### KV Cache effect

No effect; statistics reads do not construct or send model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The result describes available recorded history, with these limits:

- Auxiliary calls without usage events, including title generation and image recognition, are absent and cannot be counted by the missing-attempt counter.
- Deleting a source session can remove usage present only in a descendant's inherited prefix; that prefix remains excluded because the log has no cross-session event identity for safe fallback deduplication.
- IANA grouping honors historical daylight-saving rules for the selected zone; it does not reconstruct the user's travel history. Separate session observations do not form a corpus-wide transaction.
- The cache bounds session count, not the number of dates within one session. Cold or evicted histories require another scan; no durable analytics index, background polling, cost calculation, or historical usage repair is provided.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
