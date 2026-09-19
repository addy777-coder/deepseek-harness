# Agent Note: 官方应用基础与本地网络和用量扩展

Status: implemented

[English](2026-09-19-official-foundation-with-local-extensions.md) | 中文

## 问题

独立的 Desktop 载体、侧栏状态和图像准备钩子依赖不同的 Session 与应用接口。即使文本合并成功，组合它们的源码仍可能保留不兼容的假设。私有模型连接和跨会话用量统计仍需要各自受支持的消费者。

## 决策

[官方 Desktop 应用](../../../../apps/desktop/README.zh.md)、共享 Web 应用、Session 格式、模型请求生命周期、侧栏和发布家族拥有产品基础。共享清单使用官方发布版本。私有 MessagePort 载体、自定义 Desktop 发布器和更新器、侧栏分区及请求上下文图像识别器均不保留。

[网络能力](../../../../packages/network/README.zh.md)仍由各个 pi-ai 提供商显式选择启用。直连提供商保留官方 SDK 行为。VPN 提供商要求已保存的 Anthropic Messages 端点、API 密钥引用和私有 HTTP 分发；隧道请求失败时绝不回退到直连。部署独立于官方 Desktop 安装包提供原生辅助程序。

[用量控制器](../../../../packages/api/usage-controller/README.zh.md)读取当前 Session 格式。每条已结算的 Assistant 消息或尝试最多贡献一个用量样本。最终消息用量优先于其内嵌流；否则使用流中保留的上报时间。Token 归一化与官方轮次面板使用同一个函数，包括拒绝不完整或不一致的计数。未结算的流不属于持久化用量证据。

已被取代的 [Desktop 载体](../../archived/architecture/2026-09-03-windows-desktop-client.md)、[发布器](../../archived/architecture/2026-09-11-cross-platform-desktop-releases.md)、[更新器](../../archived/feature/2026-09-09-desktop-in-app-update.md)、[图像识别器](../../archived/feature/2026-09-04-text-model-image-recognition.md)、[侧栏分区](../../archived/feature/2026-09-14-sidebar-sections.md)、[Desktop 导航](../../archived/bug-fix/2026-09-19-desktop-session-navigation-and-export.md)和[过程展开](../../archived/bug-fix/2026-09-19-paged-turn-process-disclosure.md)决策保留为冻结的历史记录。[VPN 决策](2026-09-09-application-owned-vpn.zh.md)和[用量决策](../feature/2026-09-08-usage-statistics-from-session-history.zh.md)继续拥有各自独立的归属和隔离依据。

## 考虑过的替代方案

**组合两种应用载体。** 它们的 Host 传输、插件生命周期、发布分发和 Client 假设不同。一个完整载体让这些关系由同一主体负责。

**为统计或图像识别保留过时的 Session 事件。** 并行事件格式会破坏官方持久化和请求重建规则。统计适配当前记录。重新引入图像识别需要当前可记录的扩展点、对视觉路由的显式同意、完整报告，以及不改写已准备请求的持久化复用。

**删除所有本地扩展。** 这会丢弃私有端点访问和跨会话统计，而两者均可使用当前服务，无需替换应用载体。

## 后果

Desktop 签名和更新遵循官方实现；不保留自定义 GitHub 安装包发布器和 Linux Desktop 打包。原生 VPN 辅助程序仍拥有自己的平台构建、完整性验证、许可证和对应源码分发义务。实际公司 VPN 访问仍需单独进行凭据验收。

历史统计区分重试尝试，使用已存储的分界排除继承的分叉事件，并报告不可读或不完整的历史。它不恢复已移除的图像识别设置、自定义侧栏分区或私有 Desktop 传输。

Windows 路径归属夹具使用目录联接验证真实路径越界，无需修改主机权限。最终文件符号链接的拒绝保持为独立测试，Windows 拒绝创建链接时明确报告跳过；普通文件打开另行验证。
