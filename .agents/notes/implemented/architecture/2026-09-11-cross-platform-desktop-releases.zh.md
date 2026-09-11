# Agent Note: 跨原生目标的 Desktop 版本发布

Status: implemented

[English](2026-09-11-cross-platform-desktop-releases.md) | 中文

## Problem

Desktop 下载需要为每个源码版本提供完整且可识别的安装文件集合。仅支持 Windows 的标签工作流无法分发 macOS 和 Linux 依赖，独立发布任务还可能在所有平台成功前公开发行版。覆盖已有版本也会让其源码提交与安装包字节的对应关系不明确。

## Decision

[Desktop 工作流](../../../../.github/workflows/desktop-publish.yml) 比较 master 推送前后的统一 DSH 版本。版本提升后启动四个原生构建：Windows x64、macOS arm64 和 x64，以及 Linux x64。版本不变时跳过构建；版本降低或 manifest 不一致时拒绝运行。手动触发默认只验证，发布需要启用 publish 输入。已有 npm 和 Python 发布序列保持独立。

一个汇总发布器拥有 `v<version>` 标签和 GitHub Releases。它校验每个安装包与更新器引用，合并两个 macOS 文件列表，并从实际发布集合生成 SHA256SUMS。发布器上传草稿，下载并验证远端字节后，才将发行版公开。已有标签必须指向所选提交；已有公开发行版必须已经包含完整且有效的文件集合，并且不可覆盖。重试可以完成同一提交的草稿。预发布保留 prerelease 标记。正式发布请求 GitHub 的 `legacy` Latest 选择，由发行版创建日期与语义版本决定。

每个构建独立安装原生依赖 closure，并打包对应 VPN 分发文件。[应用自有 VPN 决策](2026-09-09-application-owned-vpn.zh.md)仍拥有隧道隔离与凭据规则。POSIX 辅助程序通信保留 Windows JSONL 协议与关闭语义，同时接受 Node 使用的 FIFO 管道和 Unix socket。它不引入系统适配器、驱动、特权服务或网络路由更改。

macOS 使用 ad-hoc 签名，不提供 Developer ID 或公证。VPN 辅助程序在计算 manifest 摘要前完成签名，并排除后续 Desktop 签名。最终安装包校验其字节和执行权限。这些构建通过发行版页面提供手动更新，因为 ad-hoc 签名无法提供受支持 macOS 更新链所需的发布者身份。

Linux AppImage 分发使用仓库自有 AppRun，因为 builder 的默认启动器可能关闭 Chromium 沙箱。最终容器校验要求使用该启动器，并拒绝关闭沙箱的桌面启动参数。Ubuntu 24.04 CI 通过临时 AppArmor 配置，仅为解包可执行文件授予用户命名空间权限，同时保留主机全局限制。DEB 安装会提供包内配置，AppImage 安装则需要为固定路径授权。

[Desktop 架构记录](2026-09-03-windows-desktop-client.zh.md)仍拥有 Renderer 隔离、Host 生命周期与插件事务规则。[应用内更新记录](../feature/2026-09-09-desktop-in-app-update.zh.md)保留取消与整包下载决策。两者仍保持 active，因为此发布策略仅替代其平台与发布细节。

## Alternatives considered

**每次 master 推送都发布。** 这会为产品版本未变的修改生成新安装包，或要求独立的生成版本方案。显式提升统一版本能为用户提供稳定的发行标识。

**各平台独立发布。** 这能缩短首个下载出现的时间，但会公开不完整发行版，并产生冲突的更新元数据。统一汇总发布将四个原生构建结果全部作为公开发行版的前提。

**跨平台复用 node_modules 打包。** 原生模块、辅助程序和平台可选依赖随构建主机变化。原生 runner 和最终安装包 smoke 检查实际交付用户的依赖 closure。

## Consequences

发布历史将版本映射到不可覆盖的提交和完整下载集合。四个原生构建消耗更多 CI 时间，任何平台失败都会延迟发布，但不会替换上一个发行版。Windows 和 Linux 安装包没有发布者证书；macOS 用户需要手动允许并替换下载的应用。Linux 首期分发 x64 AppImage 和 DEB。

聚焦测试负责版本提升、冲突、草稿重试、缺失或被修改的资产与更新器哈希。打包后的 Electron 测试覆盖各平台 shell 和私有 Host 传输；原生 VPN 测试覆盖分帧、生命周期、准入与用户态数据包处理。离线测试不能证明真实公司 VPN 或模型访问；该验收独立进行，需要兼容测试配置与凭据。
