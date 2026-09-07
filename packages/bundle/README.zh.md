---
description: "共享核心、共享 GUI、Web 与 Desktop 载体、一次性任务、ACP 与 SDK 应用表层的现成 dsh profile bundle。"
kind: "package-group"
---

# bundle/：profile 插件组合包

[English](README.md) | 中文

## 概述

本组列出 `dsh --profile` 使用的可安装 patch 层。每个包都声明 `dsh.bundle.patch`；启动器会叠放这些 patch 文档来组装具名 profile。`web` 与 `desktop` profile 会组合 `dsh-base`、`dsh-gui-app` 和一个载体，`headless`、`acp` 与 `sdk` 则直接在 base 上添加各自应用层。`sdk-minimal` 由一个 bundle 提供完整配置树。领域包也可以在本目录之外声明附加层。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`base`](base/README.zh.md) | 基于 base 的 profile 共享核心 | —（仅 patch） |
| [`gui-app`](gui-app/README.zh.md) | Web 与 Desktop 的共享交互式 GUI 组合 | 挂载 GUI Host 与 Client 配置项 |
| [`desktop-app`](desktop-app/README.zh.md) | 共享 GUI 之上的 Windows Electron 载体 | 挂载 MessagePort 与 Desktop 配置项 |
| [`acp-app`](acp-app/README.zh.md) | 基于 base 的纯自动化 ACP stdio 应用 | 挂载 ACP bridge |
| [`web-app`](web-app/README.zh.md) | 基于 base 的浏览器应用层 | 挂载 Web 配置项 |
| [`headless`](headless/README.zh.md) | 基于 base 的一次性命令行任务应用 | `headless-runner` |
| [`sdk-app`](sdk-app/README.zh.md) | 基于 base 的 SDK JSON-RPC stdio 应用 | 挂载 SDK server |
| [`sdk-minimal`](sdk-minimal/README.zh.md) | 不使用 base 或 Web 的独立极简 SDK 应用 | —（完整 patch 树） |

内置组合包从 dsh 安装目录解析；树外（out-of-tree）组合包通过 `dsh plugin --profile <name> add <package>` 安装进 profile。

<a id="related-documentation"></a>
## 相关文档

- [dsh 应用](../../apps/cli/README.zh.md)——启动 profile 的 `dsh` 命令。
- [app-boot](../boot/app-boot/README.zh.md)——profile 如何解析、分层与定制。
- [Profile 组合包设计笔记](../../.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.zh.md)——profile 与组合包的组合设计。
- [生成组合图](../../apps/cli/composition.md)——每个已发布 profile 使用的确切组合。

<a id="dev-note"></a>
## 开发备注

无。
