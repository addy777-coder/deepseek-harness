# DSH Desktop

[English](README.md) | 中文

## 概述

DSH Desktop 将共享 React/Cordis GUI 打包为 Windows x64、macOS x64/arm64 和 Linux x64 应用。沙箱化 Renderer 加载本地 `file://` 资源，并通过 MessagePort 连接到运行 `dsh --profile desktop` 的单个 Utility Process；不涉及 HTTP listener 或浏览器 cookie。应用复用用户 `.dsh` 目录中的模型、凭据、工作区与会话。安装包按版本发布到 GitHub Releases；macOS ad-hoc 构建需要手动更新。

## 目录

- [从 checkout 运行](#run-from-a-checkout)
- [构建桌面产物](#build-desktop-artifacts)
- [自动发布](#automatic-releases)
- [进程与窗口行为](#process-and-window-behavior)
- [测试应用](#test-the-application)
- [安全说明](#security-notes)
- [开发备注](#dev-note)

-----

<a id="run-from-a-checkout"></a>
## 从 checkout 运行

构建 Host 与 Client 包、暂存已安装 runtime closure、构建 Electron 资源，再启动应用：

```powershell
pnpm run build:lib:host
pnpm run build:lib:client
pnpm --filter @deepseek-ai/dsh-desktop run stage:runtime
pnpm run build:desktop
pnpm --filter @deepseek-ai/dsh-desktop start
```

源码应用仍通过 `dsh` 入口启动 Host。测试已暂存安装 closure 时把 `DSH_DESKTOP_RUNTIME_DIR` 设为 `.dsh-build\desktop-runtime`；省略它则使用源码 CLI bootstrap。

-----

<a id="build-desktop-artifacts"></a>
## 构建桌面产物

在目标操作系统和 CPU 上构建；以下命令打包 Windows x64：

```powershell
pnpm run build:official
pwsh -File native/vpn/scripts/build.ps1
pnpm --filter @deepseek-ai/dsh-desktop run stage:runtime
pnpm --filter @deepseek-ai/dsh-desktop run stage:app
node apps/desktop/node_modules/electron-builder/out/cli/cli.js --projectDir .dsh-build/desktop-app --publish never --win nsis zip --x64
```

构建固定 Electron 44.1.1、electron-builder 26.15.3 与 pnpm 11.7.0。产物位于 `apps/desktop/dist-electron`；staging 项目使用已忽略的 `.dsh-build` 目录。macOS 将最后一条命令的目标替换为 `--mac dmg zip --arm64` 或 `--mac dmg zip --x64`。Linux 使用 `--linux AppImage deb --x64`，并在 runtime staging 前安装 musl-tools、运行 `pnpm --dir native/landlock-run run build:native`。每个目标独立安装依赖 closure，不支持复制其他 CPU 或操作系统的 node_modules。

Linux 包保持 Chromium 沙箱启用。AppImage 使用仓库的 [AppRun](assets/linux/AppRun)，最终容器检查会拒绝关闭沙箱的启动选项。Ubuntu 24.04 GUI CI 为精确的解包可执行文件加载临时 AppArmor 用户命名空间配置，并在结束后删除；用户安装要求见 [Desktop 指南](../../docs/user/guide/desktop.zh.md)。

runtime staging 要求依赖已在本机缓存中。pnpm 11.7 的锁文件策略缓存不足以完成校验时，即使指定 `--offline`，仍需要访问 registry。它先通过冻结锁文件的离线 pnpm 安装验证未变化的 workspace 锁文件，再离线部署相同记录，并禁用安装脚本。由于 pnpm 生成的部署锁会改变本地 workspace 路径，部署复用这次成功的供应链验证；每个 registry 包标识及完整的完整性／URL resolution 都必须与已验证的源记录相等，源锁文件并发变化时也会拒绝 staging。缓存缺失或验证失败都会停止打包。

安装后的 runtime 与 pnpm 不包含类型声明、源映射、编译器状态、调试符号，以及测试／示例／基准测试／GitHub 工作流目录。运行模块、原生二进制文件、包元数据和许可证保留为普通文件，供 Node 解析与子进程启动使用。

原生 VPN 分发文件在 `resources/vpn` 下保留已验证字节、许可证和对应源码压缩包，并按目标平台与 CPU 选择辅助程序。macOS 在计算 manifest 前为其进行 ad-hoc 签名，Desktop 签名排除该文件以防再次改写。打包会校验最终辅助程序字节和原生运行文件权限。

-----

<a id="automatic-releases"></a>
## 自动发布

[Desktop 安装包工作流](../../.github/workflows/desktop-publish.yml) 比较 master 推送前后的根版本号。使用 `pnpm release:dsh <version>` 更新整个 DSH 版本族，将 manifest 和锁文件一起提交。版本不变时跳过发布；版本降低或包版本不一致时失败。手动运行默认只验证；选择 `publish` 才会发布或重试所选提交。

四个原生构建生成 Windows EXE/ZIP、macOS arm64 和 x64 DMG/ZIP，以及 Linux x64 AppImage/DEB。只有构建全部成功才进入汇总发布。发布器校验安装包哈希和平台 feed，合并两个 macOS feed 条目，向草稿上传安装包和 SHA256SUMS，验证上传字节后发布 `v<version>`。预发布版本保留 GitHub prerelease 标记；正式版请求 GitHub 的 `legacy` Latest 选择，由发行版创建日期与语义版本决定。已发布版本不可覆盖，标签指向其他提交时拒绝运行。

下载与应用内 feed 使用 [addy777-coder/deepseek-harness](https://github.com/addy777-coder/deepseek-harness/releases)。发布使用仓库 GITHUB_TOKEN，仅发布任务拥有 contents 写入权限；npm 和 PyPI 发布独立进行。

-----

<a id="process-and-window-behavior"></a>
## 进程与窗口行为

一个主窗口拥有导航与设置。一个 Session 可以在一个去重后的专注任务窗口中打开；关闭该窗口不会停止任务，关闭主窗口则退出应用。主进程为冷 profile 初始化与 Loader 完全加载提供最多 120 秒；ready 超时会报告最后一个启动阶段与 Host stderr 尾部。退出时，主进程会请求 Host 停止并等待最多五秒，之后终止其进程树。Host 意外退出时，窗口会保留诊断页，直到用户选择**重启 Host**。

安装应用会在包格式支持桌面集成时注册 `dsh://new` 和 `dsh://session/<base64url-session-id>`。Windows/macOS 在协议注册生效时支持登录后启动；Linux 将该偏好显示为不可用。全局快捷键和完成通知通过原生桌面会话工作；Windows 便携 ZIP 不注册协议。

Windows 和受支持 Linux 格式的设置**关于**页面检查 GitHub Releases feed，显示完整安装包下载进度，并在原生确认后安装。macOS ad-hoc 构建提供发行版页面以便手动安装。取消操作会关闭 HTTP 请求和缓存文件写入流，随后才能再次下载；错误会保持可见，正常退出应用不会安装更新。

feed 配置来自 `electron-builder.yml` 的 publish 部分（resources 中的 `app-update.yml`）。非打包构建仅在设置 `DSH_DESKTOP_UPDATE_FEED` 时检查 generic feed；Electron 场景使用该覆盖对接本地 fixture 服务器。[更新器决策](../../.agents/notes/implemented/feature/2026-09-09-desktop-in-app-update.zh.md) 说明了 `builder-util-runtime@9.7.0` 取消补丁和整包下载策略。

POSIX 关闭会在请求正常退出前捕获后代，只终止 PID 与启动身份匹配的进程，并等待独立命令组停止后才重启 Host。超时错误会指出幸存进程。

-----

<a id="test-the-application"></a>
## 测试应用

```powershell
pnpm exec vitest run apps/desktop/tests packages/desktop/transport/tests
pnpm run test:desktop
```

Electron 测试会分配私有 Harness home、user-data、更新缓存与工作区目录，覆盖 IPC、模型兼容 mock 回合、平台 shell 执行、审批、附件、窗口、通知、深链、插件替换与回滚，以及静止后的 Host 恢复。Windows 还自动操作原生目录对话框；Windows/Linux 覆盖更新取消和重试，macOS 验证手动更新。将 `DSH_DESKTOP_EXECUTABLE` 指向解包后的应用文件。`DSH_DESKTOP_REPLAY=1` 选择已提交的平台 shell 会话；Windows snapshot adapter 属于 `pnpm run test:snapshot`。

-----

<a id="security-notes"></a>
## 安全说明

Renderer 窗口启用 context isolation、Chromium sandbox 与 Web security，并关闭 Node integration。preload 只暴露固定操作；窗口导航与弹窗被拒绝，HTTP(S) 目标交给系统浏览器打开。主进程只转交端口并拥有操作系统集成，不读取模型请求 payload 或 API key。Cordis Client Loader 会动态物化插件 factory，因此客户端 bundle 执行目前需要 CSP `unsafe-eval`。

插件安装使用内置 pnpm 和 `--ignore-scripts` 解析单个 package spec。任何新增或变化的依赖只要声明 `preinstall`、`install`、`postinstall` 或 `prepare` 就会被拒绝。获批插件仍会在 Host 内以当前用户的本机权限执行。

<a id="dev-note"></a>
## 开发备注

无。
