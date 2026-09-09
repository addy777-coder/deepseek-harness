# DSH Desktop

[English](README.md) | 中文

## 概述

DSH Desktop 把共享 React/Cordis GUI 打包为 Windows x64 Electron 应用。沙箱化 Renderer 加载本地 `file://` 资源，并通过 MessagePort 连接到运行 `dsh --profile desktop` 的单个 Utility Process；不涉及 HTTP listener 或浏览器 cookie。应用复用 `%USERPROFILE%\.dsh` 中的模型、凭据、工作区与会话。首版未签名，也不包含自动更新。

## 目录

- [从 checkout 运行](#run-from-a-checkout)
- [构建 Windows 产物](#build-windows-artifacts)
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

<a id="build-windows-artifacts"></a>
## 构建 Windows 产物

在 Windows x64 上运行仓库自有打包命令：

```powershell
pnpm run package:desktop:win
```

构建固定 Electron 44.1.1、electron-builder 26.15.3 与 pnpm 11.7.0，并在 `apps\desktop\dist-electron` 下写入当前用户 NSIS 安装器和 portable zip。staging 项目位于已忽略的 `.dsh-build` 目录，避免 electron-builder 把仓库 workspace 当作待打包应用解释。

runtime staging 要求依赖已在本机缓存中。它先通过冻结锁文件的离线 pnpm 安装验证未变化的 workspace 锁文件，再离线部署相同记录，并禁用安装脚本。由于 pnpm 生成的部署锁会改变本地 workspace 路径，部署复用这次成功的供应链验证；每个 registry 包标识及完整的完整性／URL resolution 都必须与已验证的源记录相等，源锁文件并发变化时也会拒绝 staging。缓存缺失或验证失败都会停止打包。

安装后的 runtime 与 pnpm 不包含类型声明、源映射、编译器状态、调试符号，以及测试／示例／基准测试／GitHub 工作流目录。运行模块、原生二进制文件、包元数据和许可证保留为普通文件，供 Node 解析与子进程启动使用。

原生 VPN 分发文件在 `resources/vpn` 下保留其独立验证的字节、许可证和对应源码压缩包。桌面代码签名排除 `dsh-vpn.exe`，保证其 manifest 摘要有效；应用和安装器仍使用各自的常规签名策略。

-----

<a id="process-and-window-behavior"></a>
## 进程与窗口行为

一个主窗口拥有导航与设置。一个 Session 可以在一个去重后的专注任务窗口中打开；关闭该窗口不会停止任务，关闭主窗口则退出应用。主进程为冷 profile 初始化与 Loader 完全加载提供最多 120 秒；ready 超时会报告最后一个启动阶段与 Host stderr 尾部。退出时，主进程会请求 Host 停止并等待最多五秒，之后终止其进程树。Host 意外退出时，窗口会保留诊断页，直到用户选择**重启 Host**。

已安装应用注册 `dsh://new` 与 `dsh://session/<base64url-session-id>`，支持可选全局快捷键与登录后启动，并且仅在没有聚焦窗口显示对应 Session 时发布完成通知。portable 构建不注册协议，也不启用登录后启动。

-----

<a id="test-the-application"></a>
## 测试应用

```powershell
pnpm exec vitest run apps/desktop/tests packages/desktop/transport/tests
pnpm run test:desktop
```

Electron 测试会分配私有 Harness home、user-data 与工作区目录。它覆盖原生 Unicode 目录选择与取消、一元与流式 IPC、真实模型兼容 mock 回合、PowerShell 执行、审批、图片附件、任务窗口、通知、深链、插件替换与回滚、Host 手动恢复和静止退出。把 `DSH_DESKTOP_EXECUTABLE` 指向解包后的打包 executable，即可对安装资源运行同一场景。已构建 Windows checkout 会通过 `pnpm run test:snapshot` 运行 recorded-session adapter。

-----

<a id="security-notes"></a>
## 安全说明

Renderer 窗口启用 context isolation、Chromium sandbox 与 Web security，并关闭 Node integration。preload 只暴露固定操作；窗口导航与弹窗被拒绝，HTTP(S) 目标交给系统浏览器打开。主进程只转交端口并拥有操作系统集成，不读取模型请求 payload 或 API key。Cordis Client Loader 会动态物化插件 factory，因此客户端 bundle 执行目前需要 CSP `unsafe-eval`。

插件安装使用内置 pnpm 和 `--ignore-scripts` 解析单个 package spec。任何新增或变化的依赖只要声明 `preinstall`、`install`、`postinstall` 或 `prepare` 就会被拒绝。获批插件仍会在 Host 内以当前用户的本机权限执行。

<a id="dev-note"></a>
## 开发备注

无。
