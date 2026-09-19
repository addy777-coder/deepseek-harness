# Agent Note: Paged Turn process disclosure

Status: implemented
Archived: 2026-09-19

English | [中文](2026-09-19-paged-turn-process-disclosure.zh.md)

## Problem

Long sessions open with a tail page, so requiring complete session history for process folding leaves completed thinking and Tool rows expanded until the user loads every earlier page. A loaded Turn can already supply a closed state and a finalized answer independently of those earlier pages. Counts from a partial window also cannot describe the whole Turn reliably.

## Decision

Compact mode folds each eligible closed Turn independently of the session's Load earlier state. Its finalized answer remains visible, and one muted elapsed-time label with a disclosure arrow opens the preceding process rows and final-Step reasoning. The label uses the logged `turn/start` and `turn/end` times through the shared localized duration formatter. If either timestamp is unavailable, the label is `Thought for a while`; the Client does not estimate a duration from the first loaded event. Loading earlier pages retains a manual expansion for the same Turn and answer Step.

This decision supersedes only the complete-history requirement and count-based label in [Web Turn process folding](../feature/2026-08-14-web-turn-process-folding.md). That note retains ownership of membership, live-Turn visibility, missing-answer behavior, focus preservation, browser-find recovery, and shared viewing state. [Stable Turn-process ordering](2026-08-26-stable-turn-process-order.md) continues to govern row placement. These independent rules keep both earlier notes active.

## Alternatives considered

**Load every page before folding.** Rejected because opening a long session would require fetching and rendering its entire history to show a compact answer.

**Use the first loaded timestamp as the start.** Rejected because a page can begin midway through a Turn and would understate its duration.

**Keep count-based summaries for partial Turns.** Rejected because the visible count could imply a complete total while preceding calls or replies remain unloaded. The duration label depends only on the two logged endpoints and has an explicit unavailable state.

## Consequences

Closed process content starts compact in paged sessions, and manual expansion remains available without loading earlier history. A duration can appear when a prepend supplies the missing Turn start without changing the expansion state. Component tests cover timed and untimed partial history, newly prepended Turns, final-answer visibility, and manual expansion; recorded-session browser snapshots cover the localized duration disclosure and its expanded content.
