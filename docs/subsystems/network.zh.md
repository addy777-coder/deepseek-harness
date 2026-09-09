# 应用网络

[English](network.md) | 中文

[网络能力](../../packages/network/README.zh.md)通过应用自有隧道传送指定模型请求。[OpenVPN 提供方](../../packages/network/network-openvpn/README.zh.md)实现隧道，[VPN 控制器](../../packages/api/vpn-controller/README.zh.md)和 [pi-ai 适配器](../../packages/llm/llm-pi-ai/README.zh.md)使用该能力。配置与连接事件均不进入模型上下文。

## 目标所有权

### NetworkTargetId

带品牌类型的标识符归注册目标的消费方所有。注册返回清理函数，用于取消其请求并撤回目标。注册变化时，提供方刷新辅助进程的允许列表。重复标识符会导致注册失败。

### NetworkTarget

目标包含绝对 HTTP 或 HTTPS API 根地址，不得带有 URL 凭据、查询参数或片段。请求必须保持其源与路径前缀；重定向会失败。原生 CONNECT 代理另行限制主机和端口，并要求使用每次辅助进程启动时随机生成的凭据。

## 本地配置

### SaveVpnRequest

保存请求携带可选的导入配置、选中的引用文件、用户名、可选的替换密码和启动偏好。省略配置或密码会保留已保存值。导入器内联用户选择的证书，不会根据配置中的路径打开 Host 文件。验证和取消检查均先于持久化提交。

### VpnSettingsView

视图公开平台支持情况、配置文件名、用户名、密码是否已配置、启动偏好、连接状态和经清理的错误码，不包含配置文本或密码。`network-openvpn` 设置命名空间仅保存凭据记录键与启动偏好；提供方在同名凭据作用域下拥有包含完整配置与账号数据的 `grant`。

## 连接生命周期

提供方发布 `unconfigured`、`disconnected`、`connecting`、`connected`、`reconnecting` 或 `error`。自动启动使用已保存凭据。网络故障采用有上限的指数延迟重连；认证和不支持的配置错误停止重试。主动断开会取消待执行的连接意图。目标已注销、隧道已断开或服务缺失时，指定模型请求失败，不会退回直连。

辅助进程通过私有 stdin 管道接收启动消息。Host 卸载时关闭管道并等待进程树退出；Host 异常退出后，父进程管道断开也会停止辅助进程。该实现不创建系统网卡，也不应用操作系统路由或 DNS 设置。[原生分发文档](../../native/vpn/README.zh.md)定义协议与平台限制。

[应用自有 VPN 决策](../../.agents/notes/implemented/architecture/2026-09-09-application-owned-vpn.zh.md)记录提供方隔离、凭据所有权与对应源码要求。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxnetwork--networkservice-abstract-seam"></a>

### `ctx.network` — `NetworkService` (abstract seam)

Application-owned tunnel service. Consumers register configured model destinations through effects. Requests fail when the tunnel is unavailable; implementations must never retry them through host networking.

```ts cordis-catalog
/** Read local VPN state without exposing credentials.
 * @returns redacted configuration and current connection state.
 */
abstract get(): Promise<VpnSettingsView>

/**
 * Validate an import and commit its credential reference and startup preference.
 * @param request - local profile files and credentials; passwords are write-only.
 * @param signal - cancels validation before the durable commit.
 * @returns settlement after persistence; connection is a separate operation.
 */
abstract save(request: SaveVpnRequest, signal?: AbortSignal): Promise<void>

/** Start a connection with the saved profile and credentials.
 * @returns settlement after connection succeeds or its redacted failure is published.
 */
abstract connect(): Promise<void>

/** Cancel pending connection intent and stop the current tunnel.
 * @returns settlement after all owned requests and the helper process have stopped.
 */
abstract disconnect(): Promise<void>

/**
 * Allow one configured model destination until its consumer unloads.
 * @param id - consumer-owned destination identifier.
 * @param target - absolute API root; credentials and fragments are rejected.
 * @returns an idempotent disposer that revokes this registration and its active requests.
 */
abstract registerTarget(id: NetworkTargetId, target: NetworkTarget): () => void

/**
 * Fetch through the owned tunnel while preserving response streaming and cancellation.
 * @param id - an active registered destination.
 * @param input - HTTP request URL under the registered API root.
 * @param init - Fetch options; redirects never escape the registered destination.
 * @returns a streaming response, or a sanitized failure without direct fallback.
 */
abstract fetch(id: NetworkTargetId, input: RequestInfo | URL, init?: RequestInit): Promise<Response>
```

Source: [`packages/network/network/src/index.ts`](../../packages/network/network/src/index.ts)

<a id="ctxvpncontroller--vpncontroller"></a>

### `ctx.vpnController` — `VpnController`

Exposes password-free VPN status and write-only configuration commands.

```ts cordis-catalog
/**
 * Read the application's current VPN status.
 * @param signal - cancels a read before it starts.
 * @returns redacted VPN state, including unsupported deployments.
 */
@Remote async get(signal?: AbortSignal): Promise<VpnSettingsView>

/**
 * Save validated credentials and start the tunnel; the existing company provider opts into VPN on first configuration.
 * @param request - imported files and write-only password.
 * @param signal - cancels profile validation before persistence.
 * @returns redacted state after the connection attempt; connection failures remain visible in its failure field.
 */
@Remote async saveAndConnect(request: SaveVpnRequest, signal: AbortSignal): Promise<VpnSettingsView>

/**
 * Replace the current tunnel with a fresh connection attempt.
 * @param signal - prevents connection startup if cancelled before replacement finishes.
 * @returns redacted state after the attempt settles.
 */
@Remote async connect(signal?: AbortSignal): Promise<VpnSettingsView>

/**
 * Cancel pending connection intent and stop the active tunnel.
 * @param signal - cancels before shutdown starts; an accepted shutdown always finishes.
 * @returns redacted state after all owned tunnel resources have stopped.
 */
@Remote async disconnect(signal?: AbortSignal): Promise<VpnSettingsView>
```

Source: [`packages/api/vpn-controller/src/index.ts`](../../packages/api/vpn-controller/src/index.ts)

<a id="network-events"></a>

### `network/*` events

<a id="networkchanged--emit"></a>

#### `network/changed` — emit

Redacted VPN state after the provider commits a configuration or lifecycle change.

```ts cordis-catalog
/**
 * Redacted VPN state after the provider commits a configuration or lifecycle change.
 * @mode emit
 * @param view - password-free local configuration and connection state.
 */
'network/changed'(view: VpnSettingsView): void
```

Source: [`packages/network/network/src/types.ts`](../../packages/network/network/src/types.ts)
<!-- END GENERATED cordis-surface -->
