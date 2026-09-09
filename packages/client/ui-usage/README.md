---
description: "View recent usage in Settings with activity cards, a calendar heatmap, daily token trends, and model shares."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-usage

English | [中文](README.zh.md)

## Summary

Open Settings → Usage statistics to inspect activity and recorded model usage across the current Harness data directory. The page compares the last 7 or 30 days and keeps a separate 365-day activity heatmap. Web and Desktop use the same localized page, with explicit empty, loading, incomplete-data, and retry states.

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

The shared GUI composition mounts this presentation plugin beside the [usage controller](../../api/usage-controller/README.md), locale service, and settings shell. It has no configuration fields; custom compositions include its Host loader row:

```yaml
- name: '@deepseek-ai/dsh-client-ui-usage'
```

The first opening selects 30 days. Opening the page, choosing 7/30 days, pressing Refresh, and connection recovery request current statistics; the controller preserves the selected range across page remounts. Dates use the browser's current IANA time zone and include today. A failed refresh leaves the last result visible with a stale-data message and Retry action.

### Reading the charts

The six cards show exact recorded tokens, active main sessions, user messages, active days, the current activity streak, and the most-used provider/model pair. The [controller's accounting rules](../../api/usage-controller/README.md#accounting-and-incomplete-data) define those counts and missing-data disclosures. The footer shows the result's time zone and update time.

The heatmap always covers 365 days, with stronger color for more user messages. It uses one tab stop; arrow keys choose a neighboring date, and Home/End select the first/last date. Focus and pointer hover reveal the same date/count text.

Daily bars and the model donut share colors for the five largest provider/model totals and one Other group. The model list retains every recorded pair and its exact count; an expandable table exposes daily token, message, and session counts. Chart marks also provide focus, hover, and accessible text labels. The page follows the existing light/dark theme and reduces the card grid to two columns in narrow containers.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Client entry contributes `settings.section` id `usage` at order `40` and binds its English/Chinese dictionary. Its injection supplies the controller's bare observable and query callbacks; Slots creates the React subscription hook. Components derive SVG charts from one returned snapshot and do not own Remote requests, session history, or query races. CSS Modules consume shared semantic theme colors.

No runtime invariant companion is published. Slots owns registration conflicts and disposal; the controller owns query state, and this package retains no independent business state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These owners define the page's data and extension points.

- [Usage controller](../../api/usage-controller/README.md) — accounting, query lifecycle, and data limits.
- [Settings shell](../ui-settings-general/README.md) — settings navigation and page mounting.
- [Slots](../../../docs/subsystems/slots.md) — contribution and subscription ownership.

-----

<a id="model-experience"></a>
## Model Experience

None, as the page renders recorded usage and registers no prompt, tool, or session event.

#### KV Cache effect

No effect; viewing or refreshing statistics makes no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The page provides one directory-wide view:

- No cost estimate, workspace filter, export, custom date range, or background polling is provided.
- Missing auxiliary usage and deleted-source fork history follow the controller's documented limits; the page does not estimate them.
- Chart colors are assigned by rank within the selected result. The same pair can change color after a range change or refresh changes its rank.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
