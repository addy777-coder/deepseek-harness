---
description: "DSH Desktop Host 的 Electron MessagePort 传输，供维护者配置请求上限或排查启动、RPC、bundle 与 stream 投递。"
kind: "package-reference"
---

# @deepseek-ai/dsh-desktop-transport

[English](README.md) | 中文

## 概述

`dsh-desktop-transport` 让沙箱化 Electron Renderer 在没有 HTTP server、TCP 端口或浏览器 cookie 的情况下使用共享 DSH GUI。Host 为每个窗口接收一条由主进程转交的 MessagePort，并承载启动注入、一元请求、bundle 字节与拉取驱动的 stream。仅在 `desktop` profile 中选择它；浏览器认证和网络请求检查仍由 Web 载体负责。完整请求体与响应体都有上限，但会整体缓冲在内存中。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Desktop 载体 bundle 会在共享 Connection、API Gateway、客户端模块与启动 registry 就绪后挂载本插件。

### 何时选择

当 Electron Utility Process 拥有 Host，且主进程可以从每个 Renderer 转交专用端口时选择本包。不要在浏览器或普通 `dsh` 进程中挂载它：激活要求 Electron Utility Process 的 `parentPort`，缺少该通道时会失败。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-desktop-transport'
  config:
    maxBodyBytes: 314572800
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBodyBytes` | `314572800` | 接受的最大完整 Renderer 请求体字节数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-desktop-transport)是所有已接受字段的穷尽式真源。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

版本 1 协议把主进程生命周期帧与窗口传输帧分开。Utility Process 会在 ready 前依次报告 bootstrap、profile 初始化与 Loader 完全加载，主进程会严格校验每一帧，使启动超时可以指出最后上报的阶段。主进程只转交端口，不检查应用 payload。Host 校验精确键和有上限的品牌化 id，再分发启动收集、Connection Fetch handler、API Gateway stream 或不可变客户端模块产物。每条 stream 仅在收到 `stream-pull` 帧后推进，因此 Renderer 消费会提供背压；abort 与释放会取消打开的工作，并等待迭代器清理完成。

ArrayBuffer 通过结构化克隆穿过 Electron 的 MessagePortMain 端点。Electron 只允许在该端点的 transfer list 中放置 MessagePort，因此本传输不声称提供零拷贝 body 投递。

| 文件 | 职责 |
|---|---|
| [`src/protocol.ts`](src/protocol.ts) | 带版本的帧类型与品牌化 request/window id |
| [`src/index.ts`](src/index.ts) | Utility Process 父通道、就绪、连接与关闭 |
| [`src/server.ts`](src/server.ts) | 逐窗口校验、RPC/Fetch 分发、bundle 读取、stream 背压与 teardown |
| [`tests/server.spec.ts`](tests/server.spec.ts) | 非法帧、取消、背压与静止释放 |
| — | 不发布运行时不变式伴生入口；MessagePort owner 与每个 request/stream transaction 不存在可独立观察且可能分歧的状态。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Desktop 包映射](../README.zh.md)——Electron Host 集成组。
- [Desktop 载体 bundle](../../bundle/desktop-app/README.zh.md)——profile 组合与原生选择器配置项。
- [Connection](../../client/connection/README.zh.md)——与传输无关的 RPC 和 Fetch 分发。
- [客户端模块](../../client/modules/README.zh.md)——启动注入与 bundle 产物职责。
- [Desktop 架构决策](../../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.zh.md)——进程隔离与 payload 职责。

-----

<a id="model-experience"></a>
## 模型体验

无。本载体仅传输已有 GUI 与 Host 操作，不改变模型输入。

#### KV Cache 影响

无；本传输不组装或修改提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制描述 Electron 物理载体，而不是经其承载的 API。

- **仅 Windows Desktop 是随附消费方**——首版不为 macOS、Linux 或远端 Host 打包本传输。
- **body 会被克隆并整体缓冲**——Electron MessagePortMain 不传输 ArrayBuffer，每个 Fetch 响应在投递前都会完整物化。
- **一个 Host 服务全部本地窗口**——Host 崩溃会断开所有窗口；主进程等待用户显式重启，不会重放工作。
- **启动 patch 需要重启**——`desktop` profile 使用 `patchReload: startup`；Desktop 插件 transaction 会在原子替换 profile 后重启 Host。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
