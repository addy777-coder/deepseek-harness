---
description: "通过原生 OpenVPN 隧道访问选定的私有模型端点，不更改 Windows 路由、DNS 或网络适配器。"
kind: "package-reference"
---

# @deepseek-ai/dsh-network-openvpn

[English](README.md) | 中文

## 概述

本提供方让 Windows x64 上的应用通过自有 OpenVPN 连接访问私有模型端点。导入 VPN 配置及其引用证书，保存账户，再为模型提供方选择 VPN。隧道保持 Windows 适配器、路由和 DNS 不变。隧道不可用时，请求停止。

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

在受支持的 `dsh` profile 中，将本提供方与 settings、credentials 和本地 subprocess 提供方一起挂载。通过 [pi-ai 适配器](../../llm/llm-pi-ai/README.zh.md)配置私有模型路由；其 VPN 模式支持使用 API 密钥认证与 SSE 的 Anthropic Messages。其他模型提供方保留其直连选择。

### 原生运行时

生产 profile 将 `executablePath` 设为已打包 `dsh-vpn.exe` 的绝对 Host 路径。提供 `executableSha256`，或保留相邻的 `dsh-vpn.exe.sha256` 文件。按照[原生辅助程序](../../../native/vpn/README.zh.md)的说明分发完整资产目录，包括许可证和对应源码。源码运行默认使用仓库的 `native/vpn/dist/windows-x64/dsh-vpn.exe`；生产安装必须显式提供自己的资产路径。可执行文件或校验和缺失、摘要不匹配时，会在进程启动前拒绝连接。

### 配置与账户

通过 VPN 设置界面导入 `.ovpn` 文本及每个引用的证书或密钥文件。引用只按唯一文件名从所选文件中解析；导入器绝不打开配置文件中写出的路径。内联 PEM 材料保持不变。可执行钩子、嵌套配置文件、PKCS#12 导入、未解析引用和格式错误的输入会被拒绝。

将 VPN 用户名和密码与导入配置一起保存。提供方把配置、用户名和密码存入 `network-openvpn/profile-<id>` 凭据 grant。`network-openvpn` 设置分节只保存凭据键和 `autoConnect` 偏好。配置读取与事件不包含密码或配置内容。保存会替换配置并断开活跃隧道；准备好后单独连接。`autoConnect` 在应用启动时恢复已保存连接。

### 失败与关闭

提供方按有上限的退避重试暂时性连接失败。认证、证书、不支持的配置和原生完整性失败需要修正，不会反复连接。断开连接、替换已注册模型目的地或卸载提供方，会取消受影响的请求并等待辅助程序关闭。HTTP 重定向会被拒绝，请求绝不通过 Host 网络重试。

### 部署配置

提供方在启动辅助程序前解析以下设置。VPN 账户详情归凭据服务所有，不放入这些字段。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executablePath` | 源码树辅助程序路径 | 生产环境已打包辅助程序的绝对路径 |
| `executableSha256` | 相邻校验和文件 | 预期可执行文件 SHA-256 |
| `dshHome` | 已解析的 dsh home | 托管辅助进程的工作目录 |
| `connectTimeoutSeconds` | `60` | 连接尝试超时 |
| `shutdownGraceMs` | `5000` | 进程树终止前的 EOF 关闭宽限期 |
| `reconnectDelayMs` | `2000` | 暂时性失败的初始重试间隔 |
| `reconnectMaxDelayMs` | `30000` | 暂时性失败的最大重试间隔 |
| `maxConnections` | `16` | 并发代理流数量 |
| `headerTimeoutMs` | `5000` | CONNECT 标头截止时间 |
| `targetConnectTimeoutMs` | `30000` | 隧道目的地连接截止时间 |
| `pollIntervalMs` | `10` | 用户态 IP 栈定时器间隔 |
| `maxPendingPacketBytes` | `1048576` | 待处理隧道数据包字节上限 |
| `maxProfileBytes` | `524288` | 导入总量与展开后配置的字节上限 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

提供方通过托管 subprocess 服务启动原生 OpenVPN3/lwIP 辅助程序。一条启动 JSON 消息通过 stdin 携带配置、账户、随机代理令牌、已配置目的地与资源上限。隧道就绪后，辅助程序暴露带认证的回环 CONNECT 代理。Undici 在通过此代理发送请求时，保留原始模型 URL 与 HTTPS 校验。

每个模型消费方注册 origin 与 API 路径。HTTP 分发器针对每个请求检查该注册，并组合调用方、目的地与连接取消。目的地变化会使用当前允许列表重启辅助程序。父进程读取协议状态但不保留原生原始输出，关闭 stdin 以请求优雅退出，并在必要的终止操作后等待进程树退出。

凭据和设置变化会重新加载已保存配置。串行写入与连接意图跟踪防止较旧刷新工作覆盖之后的断开操作。不发布 invariant 伴随插件：目的地准入与辅助程序协议校验在实际执行路径上运行；原生允许列表不作为第二份可独立读取的注册表暴露。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [网络服务](../network/README.zh.md)——目的地注册、HTTP 请求与脱敏状态。
- [原生辅助程序](../../../native/vpn/README.zh.md)——构建、支持协议与源码分发。
- [pi-ai 适配器](../../llm/llm-pi-ai/README.zh.md)——模型侧 VPN 要求。
- [凭据服务](../../credentials/credentials/README.zh.md)——存储归属与记录访问。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 VPN 只传输现有模型请求，不添加内容。

#### KV Cache 影响

无。隧道保留模型请求内容，不添加会话上下文。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制定义受支持的部署。

- **仅支持 Windows x64。** 其他平台报告不支持；不提供系统 VPN 或直连网络回退。
- **一个已保存 VPN 账户。** 不支持挑战认证、受密码保护的私钥和外部 PKI。
- **只处理选定模型的 HTTP 流量。** 提供方不是系统代理；受原生辅助程序的 IP 与传输限制约束。
- **内置模型集成是 Anthropic Messages。** 其他提供方 API 与 WebSocket 传输需要独立的消费方支持。

<a id="dev-note"></a>
### 开发备注

无。
