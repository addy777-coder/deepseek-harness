# Agent Note: 指定模型提供方的应用自有 VPN

Status: implemented

[English](2026-09-09-application-owned-vpn.md) | 中文

## Problem

公司模型端点可能要求 OpenVPN 访问，而其他模型提供方和本地应用仍使用普通网络。要求独立 VPN 客户端会让应用可用性依赖另一个进程的配置与连接生命周期。由应用启动该客户端的系统隧道，仍会改变整台电脑的路由，并且可能需要提升权限。

## Decision

[网络能力](../../../../packages/network/README.zh.md)拥有已配置的 HTTP 目标与连接状态。[OpenVPN 提供方](../../../../packages/network/network-openvpn/README.zh.md)运行独立原生辅助进程，将 OpenVPN3 Core 与内存中的 lwIP 协议栈组合。Windows 网络负责到达 VPN 服务器；辅助进程在隧道内传输模型 TCP 连接与 VPN 提供的 DNS。它不创建操作系统适配器，也不修改系统路由或 DNS 设置。

辅助进程提供使用临时端口的回环 CONNECT 代理。每次启动都具有随机认证令牌和明确的主机/端口允许列表。每个消费方拥有带品牌类型的目标注册及其清理函数。Host 进一步将 HTTP 请求限制在已注册的源与 API 路径前缀内，拒绝重定向，并在目标撤回时取消请求。原始端点 URL 保持不变，保留端点 TLS 验证与协议标头。隧道断开或网络服务缺失时，指定请求失败，不回退到直连。

[pi-ai 提供方配置](../../../../packages/llm/llm-pi-ai/README.zh.md)通过 `network: direct | vpn` 选择网络，与 SSE/WebSocket 传输无关。VPN 配置必须明确指定 Anthropic Messages 端点与 Harness 管理的 API 密钥凭据。适配器向真实 pi-ai SDK 传入私有 fetch 实现；全局 fetch、代理环境变量与无关提供方保留各自的网络行为。提供方原生 OAuth 或环境认证不会绕过选定路由发出辅助请求。[提供方路由](2026-07-14-provider-routed-llm-adapters.zh.md)继续独立拥有模型身份与回放元数据。

[VPN 设置控制器](../../../../packages/api/vpn-controller/README.zh.md)接受导入的配置内容和选中的引用文件。导入不会根据配置中的路径读取文件，原生评估会在持久化之前拒绝不支持的认证方式。提供方遵循[凭据记录所有权](2026-08-13-credential-records-and-authorization-flows.zh.md)，将完整配置与账号保存为 `network-openvpn/profile-<id>` 下的不透明 `grant`。普通设置仅包含该记录的键与启动偏好。状态查询和 `network/changed` 通知公开密码是否存在的标志与脱敏错误码，不公开密码或配置文本。

应用拥有连接、重连、取消与进程树清理。私有 stdin 管道传递启动凭据，并将辅助进程绑定到 Host 的生命周期。主动断开会取消重连意图；认证错误会停止重试。[Desktop bundle](../../../../packages/bundle/desktop-app/README.zh.md)选择提供方、控制器与设置 UI。Electron 应用提供原生产物，并验证其清单和可执行文件校验和。

[原生分发目录](../../../../native/vpn/README.zh.md)包含 GPL-3.0-only 辅助进程、许可证声明以及已链接可执行文件的对应源码 ZIP。Desktop 打包一并保留这些资源。子进程使协议与生命周期保持明确，但不会免除辅助进程的源码分发义务。

Desktop [运行时暂存](../../../../scripts/stage-desktop-runtime.ts)先通过冻结锁文件的离线安装验证根锁文件，再由 pnpm 在离线部署中转换 workspace 路径。两项操作均禁用生命周期脚本，并保留存储完整性校验。[解析结果校验](../../../../scripts/desktop-runtime-lock.ts)要求每个 registry 包标识及完整 `resolution` 记录（包括 `integrity` 与 `tarball`）都与已验证的源锁文件完全一致。源锁文件并发变化，或 registry 解析记录新增、删除、变更时，暂存都会被拒绝。部署信任已验证的锁文件，因为 legacy hoisted 路径可能重新解析版本范围并选择未验证版本，而现代路径的元数据重复校验可能在离线模式下仍进行网络解析。

## Alternatives considered

**启动已安装的系统 OpenVPN 客户端或服务。** 这能减少原生实现工作，但保留了需要权限、影响整台电脑的路由，以及外部客户端的配置和生命周期，无法提供应用自有的模型连接。

**设置进程级代理或替换全局 fetch。** 这可能让无关提供方和应用请求进入隧道，而 SDK 辅助请求仍可能选择其他传输方式。逐提供方向 SDK 注入实现，为消费方提供明确的 HTTP 路径。

**将模型 URL 改写到本地网关。** 这会增加协议转发，并改变 SDK 观察到的 URL。CONNECT 保留端点 URL 与端到端 TLS 验证。

**允许任意 VPN 发现草稿。** 未保存的端点会绕过已配置目标允许列表。VPN 发现要求提供方、端点和协议均与已保存配置匹配；直连草稿保留[以命名空间为键的发现流程](2026-08-04-draft-provider-endpoint-interrogation.zh.md)。

## Consequences

公司模型请求可以使用应用自有连接，普通网络流量保留原有路由。该功能增加原生构建、凭据所有方和独立管理的辅助进程生命周期。受支持部署限定为 Windows x64、IPv4、TCP、VPN 提供的普通 UDP DNS 与 Anthropic Messages；原生和提供方 README 负责详细限制。

VPN 配置与连接状态不增加模型输入、会话事件或请求前缀。现有模型消息仍可通过普通会话记录重建，因此传输选择不需要修改 agent-loop 或 SDK 转录。

## Verification

确定性的提供方与 UI 测试覆盖目标所有权、私有 SDK fetch、Anthropic 文本/工具流、模型发现、取消，以及拒绝未保存的 VPN 目标。原生包装层和导入测试覆盖管道分帧、脱敏、完整性检查、格式错误的配置与有界进程树清理。原生辅助进程的离线测试覆盖 CONNECT 准入和用户态网络。

通过用户态原型发往公司的 HTTP 请求已成功。该观察不能证明 HTTPS 行为或完整的 Desktop/pi-ai 验收；生产[实网验收程序](../../../../native/vpn/tests/live-acceptance.ts)负责真实模型流式输出、工具回放、长输出、取消及后续请求验证。本记录尚未验证它在公司环境中的执行结果。
