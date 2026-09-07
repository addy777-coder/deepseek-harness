---
description: "Windows Electron 客户端的 Desktop Host 集成包，包括带版本的 MessagePort 传输与生命周期适配器。"
kind: "package-group"
---

# desktop/ — Electron Host 集成

[English](README.md) | 中文

## 概述

`desktop/` 组在不打开 HTTP listener 的前提下，把共享 GUI Host 连接到 Windows Electron 应用。其传输为每个窗口接收独立 MessagePort，并承载启动数据、RPC、Fetch 响应、stream 与客户端 bundle。Electron 主进程不接触模型请求和凭据。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`transport/`](transport/README.zh.md) | 把 Electron MessagePort 连接到共享 GUI 服务 | — |

-----

<a id="related-documentation"></a>
## 相关文档

- [Desktop 用户指南](../../docs/user/guide/desktop.zh.md)——安装、启动、恢复与管理插件。
- [Desktop 载体 bundle](../bundle/desktop-app/README.zh.md)——启用传输的 profile 配置项。
- [客户端模块子系统](../../docs/subsystems/client-modules.zh.md)——与传输无关的启动数据和 bundle 产物。
- [Desktop 架构决策](../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.zh.md)——进程与安全职责。

<a id="dev-note"></a>
## 开发备注

无。
