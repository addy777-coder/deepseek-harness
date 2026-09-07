# Agent Note: Global usage statistics Settings page

Status: implemented

English | [中文](2026-08-17-global-usage-statistics-settings-page.zh.md)

## Problem

The Web client needs one Settings view that answers cross-session questions: recent activity, message and Session counts, model-token totals, active days, a current streak, a year of calendar activity, daily trends, and model share. The existing conversation stats strip deliberately answers a different question for one Session. Building the global view from browser-fetched histories would expose raw logs across the wire, inherit paging behavior, and duplicate Session-event accounting in presentation code.

The statistics also need one rule for forks, calendar dates, and incomplete model requests. Without an explicit owner, the global total can double-count inherited fork history, disagree silently with durable per-session token accounting, or classify one timestamp differently between Host and browser.

## Decision

`@deepseek-ai/dsh-usage-stats` owns a point-in-time `usageStats/read` Remote over authoritative Session logs, and `@deepseek-ai/dsh-client-ui-usage-stats` owns the read-only `settings.section` presentation. The Web bundle mounts both packages and the existing `api-remotes` facade explicitly mounts the generated Remote contribution.

Each read combines the materialized persistence list with current live Sessions. Live state wins before and after each cold inspection, inspections run sequentially, and the request `AbortSignal` reaches all persistence work. The service returns precomputed 7-day and 30-day dense ranges plus one independent dense 365-day activity series. The browser supplies its current `Date#getTimezoneOffset()` value, and the Host uses that one fixed offset for event dates and today.

Message activity includes human `user/message` events and all final `assistant/message` events. Token totals use the final assistant message's disjoint input, cache-read, cache-write, and output fields; reasoning is not added again. The recorded model id owns attribution. A fork skips its `SessionHeader.seedLength` prefix so inherited requests are counted at their source Session rather than once per descendant.

This accounting does not replace the [projected token-usage decision](../architecture/2026-07-29-projected-token-usage-and-request-context.md). The per-session `token-meter` projection remains the canonical durable billing view and retains a usage chunk from a request that later fails. The global dashboard requires a final assistant message so it can attribute stable date and model facts; chunk-only failed or cancelled usage is absent and the package README states that difference.

The Settings contribution registers as `usage-stats` at order `30`. It reads only when mounted, switches between the two precomputed ranges without another Remote call, keeps the 365-day heatmap independent from that switch, and preserves the last successful snapshot when refresh fails. CSS Modules and existing semantic theme tokens own the six metric cards, heatmap, stacked daily-token bars, model donut, responsive layout, focus visibility, reduced motion, and accessible text equivalents.

## Alternatives considered

**Aggregate Session histories in the browser.** Rejected because it requires cross-session raw-log transport, repeats event semantics in a React package, and makes correctness depend on history paging.

**Maintain a durable global counter or analytics index.** Rejected because no current consumer needs background freshness or query latency sufficient to justify another persistence format, migration, writer lifecycle, and recovery path. An on-demand scan keeps the Session log authoritative.

**Aggregate only `sessionStats` and `token-meter` projections.** Rejected because those per-session projections do not preserve the calendar-day and per-model series the page needs. Extending them would add durable projection state and backfill work while the read still needs to visit every Session.

**Count every event in every fork log.** Rejected because fork seeds are copied history, not additional user messages or provider requests. Skipping the inherited prefix avoids systematic multiplication; deleted source Sessions remain a documented undercount because the current log format has no cross-Session event identity for safe fallback deduplication.

## Consequences

The feature adds no Session event, database schema, background worker, cache, model input, or provider request. Every open or refresh performs work proportional to the available Session logs, with sequential cold I/O. A large history can therefore delay the page, but it creates no idle cost and cancellation stops the scan.

Calendar grouping follows the browser's current fixed offset and cannot reconstruct historical daylight-saving or travel-related timezone changes. Global totals can differ from the per-session token strip for failed requests by design. Unit suites pin aggregation, cancellation, Loader composition, slot lifecycle, failure handling, range switching, and accessible chart data; the assembled Web browser scenario pins cold multi-session aggregation and the Settings presentation through the shipped bundle.
