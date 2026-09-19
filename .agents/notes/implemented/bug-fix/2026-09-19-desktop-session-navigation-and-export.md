# Agent Note: Desktop Session navigation and export

Status: implemented

English | [中文](2026-09-19-desktop-session-navigation-and-export.zh.md)

## Problem

The Desktop Session-window action duplicates navigation already available in the main window and removes the sidebar and Settings from the new window. Session export also assumes that its virtual Host URL is reachable by browser HTTP, although Desktop exposes the Host only through MessagePort. The export button therefore fails before a download begins.

## Decision

DSH Desktop uses one application window. The title bar offers New task; Session links and notification clicks select the Session in the main window. The main process retains navigation received before the Client subscribes and delivers it after readiness, including during reload. Session selection uses the ordinary persisted Client store. The task-window constructor, preload operations, localized actions, and focused-layout branch are absent.

The export controller selects the installed carrier at Client activation. Web keeps its HEAD preflight and native HTTP download. An internal carrier fetches the existing Host ZIP route with GET, and Chromium saves those bytes through a local Blob URL. The controller releases that URL after the download gesture, reports fetch or archive-read errors in the dialog, and suppresses saves after disposal.

The [Desktop architecture decision](../architecture/2026-09-03-windows-desktop-client.md) retains Host ownership and sandboxing. The [Web export decision](../feature/2026-08-10-web-session-log-export.md) retains Host ZIP generation, per-session archive entries, and the exact Fetch route; its direct-URL delivery applies to Web. Neither decision is fully superseded.

## Alternatives considered

**Hide only the title-bar button.** Deep links and notification clicks would still create separate windows, retaining the extra layout, selection, and lifecycle paths. All Session navigation instead shares the main window. Separate windows would need a demonstrated workflow requiring simultaneous views before reintroduction.

**Fetch through MessagePort but download the virtual URL.** A successful preflight does not make that URL reachable by Chromium. The archive bytes must cross the same carrier before a local download can start.

**Add a Desktop HTTP listener or generate ZIPs in the Client.** A listener changes the private Host architecture, while Client compression duplicates the archive implementation and transfers uncompressed logs. The existing Host route and carrier already carry the required bytes.

## Consequences

Users switch Sessions in the main window and cannot open simultaneous independent Session windows. Desktop buffers the compressed archive in the Host carrier and Renderer before saving; memory therefore grows with ZIP size. Web retains streaming downloads. The Renderer remains sandboxed, and model history and Session formats are unchanged.

The Electron driver behind the recorded Desktop snapshot downloads and unzips the real archive, verifies recorded prompt, reply, and tool-result content, checks removal of the window action, and exercises real second-instance links, reload-time navigation, and notification selection. Controller tests cover carrier selection, archive failures, Blob URL cleanup, and disposal during a pending read.
