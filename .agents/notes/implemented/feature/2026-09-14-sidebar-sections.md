# Agent Note: Durable Sidebar Sections

Status: implemented

English | [中文](2026-09-14-sidebar-sections.zh.md)

## Problem

Project grouping alone cannot organize work spanning several directories, and moving a conversation for navigation must not change where its tools execute. Browser-local placement also gives different pages conflicting project lists.

## Decision

The Workspace registry owns single-level custom sections in its version 3 domain. Sections store ordered project and independent Session identities separately; projects precede Sessions. Each identity has at most one explicit section placement. Session placement does not rewrite its Workspace account, working directory, archive membership, or log.

Section edits use the registry write queue and one global write. A durable layout revision covers both default project order and custom sections, including rollback. Baselines, layout increments, and command receipts carry that revision together. The Client accepts newer revisions and fences replies across replacement baselines. A deletion becomes visible at the record deletion commit; preparatory recovery markers cannot publish a removed project.

The grouped sidebar commits only valid drops and cancels Escape or outside releases. Menu actions support moving and reordering without dragging. A rejected save retains the committed layout and exposes Retry. Independent Session order is manual; folding remains browser-local. Flat browsing and search show each Session once.

[Workspace Sidebar Order and Folding](2026-08-11-workspace-sidebar-order-and-folding.md) retains the Workspace folding and per-account activity-order decisions. This note owns grouped-view drop cancellation and committed section/layout delivery.

## Alternatives considered

**Move the Session to another Workspace.** Navigation would change tool execution assumptions and break the canonical-directory accounting rule.

**Persist sections in browser storage.** Other pages and restarted browsers could not recover the same organization.

**Save source removal and destination insertion separately.** A failure between writes could lose placement or expose duplicate entries.

**Commit the last hover marker on drag end.** Cancelling a cross-section drag could still move a project or conversation.

## Consequences

- Deleting a section appends its projects to the default area and restores independent Sessions to their existing Workspace or Ungrouped. Deleting a project retains independently placed Sessions.
- Earlier Workspace domain versions fail explicitly. No migration or automatic data clearing is supplied.
- Section controls add no model instructions or Session events.

## Testing

Registry tests cover ordering, unique placement, invalid anchors, failed writes, competing edits, restart recovery, and version rejection. Controller/model tests cover complete layout delivery, stale receipts, and reconnect fencing. Component tests exercise creation, folding, movement, cancellation, retries, and unique flat/search results. The keyless Web scenario drives two isolated browser contexts and a Host restart, renders a recorded Session, and verifies its persisted events before opening it.
