# Agent Note: Usage statistics from session history

Status: implemented

English | [中文](2026-09-08-usage-statistics-from-session-history.zh.md)

## Problem

Users need cross-session activity and model usage in Settings, including persisted and archived conversations. A per-session conversation strip cannot answer daily or per-model questions across the data directory. Fetching every raw history into the browser would duplicate event accounting and make statistics depend on UI pagination.

Fork inheritance, retried or interrupted requests, and local calendar dates require one explicit accounting owner. Otherwise copied history multiplies usage, failed requests lose reported tokens, and a fixed current UTC offset misclassifies historical daylight-saving dates.

## Decision

The [usage controller](../../../../packages/api/usage-controller/README.md) owns Host aggregation and a separate React-free Client model. Its generated `usage.get` Remote reads live-preferred `sessionQuery` observations without attaching agents or transporting raw histories. The [Web composition](../../../../packages/bundle/web-app/README.md) selects four concurrent reads and a 256-session summary cache; the required plugin Config fields let deployments change both limits. Cache reuse checks observation identity, sequence or durable revision, and time zone. There is no durable analytics index.

Exact totals reuse the official token-meter normalization. Each settled `assistant/message` or `assistant/attempt` contributes at most one sample from final message usage or its embedded stream. Final usage is authoritative even when invalid; incomplete counts remain missing instead of being replaced by an earlier sample. Retries remain separate, and failed or cancelled attempts retain their settled usage. Recorded compaction and subagent usage contributes to tokens, while only main-session user messages contribute to activity. Provider/model pairs own attribution; inherited request headers remain available when inherited events are excluded. This preserves the [token-accounting decision](../architecture/2026-07-29-projected-token-usage-and-request-context.md) without deriving calendar series from its per-session cumulative projection.

The viewer supplies a current IANA time zone. Host aggregation applies that zone's historical rules, includes today in the selected 7/30-day range, and independently computes 365 activity dates and an unrestricted current streak. Unknown or incomplete usage stays unestimated, and unreadable sessions produce an explicit partial result. A corpus enumeration failure or an entirely unreadable nonempty corpus rejects the query; an empty corpus returns zero statistics.

The [usage page](../../../../packages/client/ui-usage/README.md) shares one settings contribution between Web and Desktop. Its six cards, heatmap, daily bars, and model donut read the controller's observable through Slots. Queries run on opening, range selection, manual refresh, and connection recovery after the first load. Superseded reads are cancelled; failures retain the last result with an explicit stale state. The controller awaits outstanding work on disposal. Theme tokens, localized dictionaries, keyboard navigation, and accessible text keep presentation concerns in the UI package.

## Alternatives considered

**Aggregate histories in the browser.** Raw cross-session log transport exposes unnecessary conversation data, repeats event semantics in presentation code, and couples completeness to pagination.

**Maintain a durable global counter or analytics index.** No current consumer needs background freshness or query latency that justifies another persistence format, writer lifecycle, and recovery path. Bounded in-memory summaries reduce repeated reads while keeping the session log authoritative.

**Aggregate only `sessionStats` and `token-meter` projections.** Their per-session totals lack the calendar-day and per-model facts required by the page. Extending those projections adds backfill and retained state while every session still needs inspection.

**Count every inherited fork event.** A copied prefix is neither a new user action nor another provider request. Excluding inherited events prevents multiplication across multiple fork levels; it deliberately accepts an undercount when the source history is deleted because no cross-session event identity supports safe fallback deduplication.

**Use final assistant messages and the current fixed UTC offset.** Final-only accounting loses reported failed or cancelled usage, and one fixed offset cannot represent historical daylight-saving changes. Request headers plus valid samples provide recorded attribution without requiring a successful final message; IANA zones provide historical date rules without storing user travel history.

## Consequences

The feature changes no session event or persistence format and creates no model input or provider request. Cache misses require work proportional to the inspected logs, so large histories can delay the page; the cache limits retained session count rather than individual history length. Individual observations are consistent, but the combined result is not a transaction across all sessions. Deleting history changes the statistics, and auxiliary calls without recorded usage remain outside both exact totals and the missing-attempt count.

The focused aggregation tests cover exact totals, retries, incomplete usage, compaction, child exclusion from activity, inherited histories, calendar dates, and streaks. Client tests cover lazy reads, stale-result suppression, time-zone refresh, failure retention, reconnection, subscriber containment, and quiescent disposal. [Repository testing policy](../../../../docs/testing.md) additionally requires assembled Web evidence; unit results alone do not establish browser or real-model behavior.
