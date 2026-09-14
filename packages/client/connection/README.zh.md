---
description: "面向 Remote RPC、事件流恢复与精确 Fetch 路由的载体无关 GUI Connection，以及 Web profile 使用的认证 HTTP 适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

## 概述

本包承载 GUI 到 Host 的 Remote 调用、精确 Fetch 响应与 connection generation，但不选择 HTTP 或 Electron IPC。Host 插件拥有 RPC、Fetch route 与逻辑 channel registry，物理载体会适配这些 handler。Client 插件挂载 `ctx.connection`，其中包含通用 RPC carrier、当前 generation 信息、可观察恢复状态、立即重连命令，以及单一 generation source 注册点。`./web` 适配器添加浏览器 cookie、Host/Origin 检查与 HTTP route，而不把这些关注点放入共享核心。

## 目录

- [使用本包](#use-this-package)
- [Web 认证与请求信任](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Client 通过 `ctx.connection.rpc` 调用逻辑 channel。Web 页面使用 HTTP POST 与 API Gateway 的 `/api/remote.mux` WebSocket；DSH Desktop 通过 MessagePort 提供 Fetch 与 stream hook，并在页面保持 `file://` 时使用虚拟 `http://dsh.internal` origin。Host 核心组合共享 `/api` RPC 分发、Session 日志下载等精确 `GET`/`HEAD` route 与普通逻辑 channel。载体选择如何暴露这些 handler；未认领请求返回 404。

-----

### 独立浏览器夹具

仅供浏览器开发的夹具模拟 Workspace 布局基线、带版本的更新和分区命令。项目与 Session 的归类保存在内存中，重新创建夹具时会重置；持久组织结构由 Host Workspace 注册表拥有。

<a id="browser-authentication-and-request-trust"></a>
## Web 认证与请求信任

每个 Web RPC 方法和 WebSocket stream 都要求同一个浏览器会话，不存在按方法区分的 loopback 层。每次 Web 适配器激活都会生成随机启动令牌。`dsh-web-app` 打印并打开带 `?token=...` 的普通根 URL；`frontend-static` 把根路径和 index 请求交给 `ctx.webConnection.authorizeIndex`，后者只在 `GET /` 接受该令牌，写入绑定 authority 的签名 cookie，再重定向到干净的 `/`。缺失、过期、畸形或 authority 不匹配的 cookie 会在 RPC 分发前得到 401。静态资源保持公开。HTTP 载体不在根路径交换之外接受 query token，也不接受 Authorization header token。Desktop 不挂载本适配器，也不使用 cookie。

cookie 签名密钥是 `ctx.credentials` 中由 `client-connection/browser-session` 拥有的 grant 记录。本地提供方把它持久化到 `$DSH_HOME/.credentials.yaml`；`BrowserAuth` 在 Connection 激活期间加载或创建该记录，并把密钥留在内存中，因此请求认证同步执行。删除或替换该记录会在下一次 Connection 激活时生效。cookie 携带绝对签发与过期区间，`cookieMaxAgeDays` 默认设为 30 天，并在确定性名称与签名 payload 中同时绑定规范化 hostname 和 port。它是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`；随附服务器使用 loopback HTTP，因此刻意不设置 `Secure`。

认证之前，每个请求仍经过 `src/api-request-trust.ts`。其 `Host` 必须是 loopback，或与 `trustedHosts` 条目匹配：带端口的 `host:port` 精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化。若附带 `Origin`，它必须等于该 Host；`sec-fetch-site: cross-site` 一律拒绝。畸形配置 authority 会让插件加载失败。这些检查防御 DNS rebinding 与跨站浏览器请求，绝不建立身份。Host/Origin 校验失败返回 403；Host 可信但未认证的请求返回 401。`dsh web --host 0.0.0.0` 仍不受支持。决策记录：[浏览器请求信任](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)与[浏览器令牌认证](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)。

<a id="connection-generation"></a>
## Connection generation

API Gateway Client 把内部 `$events` logical stream 注册为唯一 generation source，与有无 `$on` 订阅无关。Host 在 API Remotes source factory 同步挂好所有增量 listener 后，先发送唯一 `{ type: 'ready', clientId, host: { home } }` 项，再发送事件。`ConnectionController` 仅在收到该 ready 项后发布 generation 并调用 `onConnected`，因此 baseline 不会跑在增量 listener 前面。

`$events` 结束、返回 Remote stream error、收到非 ready 首项或畸形事件项，都会使当前 generation 失效。浏览器报告网络可用时，Controller 发布 `connecting`，并在 500ms、1s、2s、4s、8s 与 10s 上限内采用 50%–100% 抖动重试。它记录每次尝试、要求 Gateway 替换物理 WebSocket，再重开 `$events`；10s 档失败后发布终态 `disconnected`。`ctx.connection.reconnect()` 会中断活动工作、重置序列，并立即开始 retry 1。浏览器 `offline` 会中断活动工作、发布 `disconnected` 并暂停自动尝试；下一次 `online` 转换会重置序列并从 500ms 档开始。ready 项会发布 `connected`。Gateway mux 每次收到请求只做一次物理连接尝试，不再运行另一套重试调度。[连接恢复决策](../../../.agents/notes/implemented/feature/2026-08-28-web-connection-recovery-control.zh.md)规定重试节奏和手动恢复行为。

<a id="model-experience"></a>
## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **Web `/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；其他载体拥有自己的 body 上限。
- **浏览器 cookie 不带 `Secure`**：随附载体是 loopback HTTP；若部署经明文网络暴露同一 authority，bearer cookie 可能在传输中泄露。
- **没有 logout 操作**：清除浏览器 cookie 会结束单个浏览器会话；删除 owner 凭据记录并重启 `dsh` 会撤销全部会话。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。registry 只有一个 owner，贡献按 effect 限定；浏览器会话验证会在 Web 适配器激活时读取 credential，record commit-event 生命周期由 credentials 伴生入口负责。stream、重连与 rpcId 往返纪律由行为测试覆盖，Web route 注册／释放对称性由 webserver 伴生入口审计。
