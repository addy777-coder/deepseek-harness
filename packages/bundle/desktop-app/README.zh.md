---
description: "共享 GUI 之上的 Windows Desktop 载体层，添加 Electron IPC、原生目录选择、内置 VPN 与 Desktop Client 集成。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-desktop-app

[English](README.md) | 中文

## 概述

`dsh-desktop-app` 把共享 GUI 组合变成 Windows 上 DSH Desktop 使用的 Host。随附 `desktop` profile 把它放在 `dsh-base` 与 `dsh-gui-app` 之后，并在启动时一次性应用用户 patch。本层添加 Electron MessagePort 传输、原生目录选择、内置 VPN 设置，以及 Desktop 标题栏、通知、偏好与插件管理呈现。Electron 应用拥有窗口、系统注册、进程关闭与打包资源。

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

请使用已安装的 DSH Desktop 应用；它会在内部通过 `dsh --profile desktop` 启动本 profile。

### 安装到 profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-desktop-app
dsh plugin --profile <name> remove @deepseek-ai/dsh-desktop-app
```

内置 bundle 从 `dsh` 安装目录解析，reconciliation 根据其 `dsh.bundle.patch` 声明激活本依赖。普通命令 shell 无法使用生成的 profile，因为传输要求 Electron Utility Process 父通道。

### 获得的能力

本载体不会打开 HTTP listener。每个 Renderer 都会获得专用 MessagePort，原生目录选择器的 Host 与 Client 配置项则保留 Windows chooser 及其取消行为。Desktop UI 配置项添加 shell 集成，但不会复制共享对话、设置、Session、审批、附件或终端实现。

[VPN 设置](../../client/ui-vpn/README.zh.md)允许用户导入 OpenVPN 配置并保存账号，供应用自有连接使用。[网络提供方](../../network/network-openvpn/README.zh.md)仅传送已配置使用 VPN 的模型提供方请求；它拥有需要认证的回环代理，保持操作系统路由与 DNS 不变。Electron 应用提供经过验证的原生分发资源与可执行文件校验和。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

静态 patch 选择传输、原生目录选择 Host 与 Client、Desktop UI，以及 VPN 提供方、控制器和设置 UI。Host 传输仅在 Loader settle 后宣告就绪。应用在每个窗口加载完成后转交端口，并在终止 Utility Process 进程树之前请求有界 Host 关闭。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | Electron 载体、原生交互与 VPN 配置项 |
| [`src/index.ts`](src/index.ts) | 可安装 bundle 的空包入口 |
| [`tests/desktop-app.spec.ts`](tests/desktop-app.spec.ts) | manifest 与原生 Host/Client 配对检查 |
| — | 不发布运行时不变式伴生入口；该静态 patch 不拥有可变状态，每个插入包拥有自己的生命周期检查。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Desktop 用户指南](../../../docs/user/guide/desktop.zh.md)——安装和操作应用。
- [共享 GUI bundle](../gui-app/README.zh.md)——本层下方与载体无关的配置项。
- [Desktop 传输](../../desktop/transport/README.zh.md)——MessagePort 协议与关闭。
- [Desktop UI](../../client/ui-desktop/README.zh.md)——标题栏、窗口、通知与设置。
- [应用网络](../../../docs/subsystems/network.zh.md)——目标所有权、凭据和连接生命周期。
- [Desktop 架构决策](../../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.zh.md)——安全与生命周期理由。

-----

<a id="model-experience"></a>
## 模型体验

间接影响。影响来自本载体选择的共享 GUI 与原生交互包。

#### KV Cache 影响

本载体不提供模型请求前缀，也不改变缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束与首个仅 Windows 应用版本一致。

- **本 bundle 要求 Electron Utility Process**——在普通 Node 中启动 `dsh --profile desktop` 会在服务客户端之前失败。
- **profile 仅在启动时应用 patch**——用户 patch 与插件变化需要通过 Desktop 拥有的 Host 重启路径生效。
- **不支持远端 Host**——载体只接受本地 Electron 主进程转交的端口。
- **原生目录选择假定本地交互式 Windows 会话**——无人值守与远端部署应使用其他载体和选择器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
