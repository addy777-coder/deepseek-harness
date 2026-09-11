# 使用 DSH Desktop

[English](desktop.md) | 中文

DSH Desktop 是 Windows x64、macOS Apple Silicon/Intel 和 Linux x64 应用，与 Web UI 共用会话、工作区、模型与设置。它从本地文件加载 GUI，并连接到私有 Host 进程，不会打开本地 HTTP 端口。

## 前提条件

- Windows 10/11 x64、Apple Silicon 或 Intel 上的 macOS，或具有桌面会话的 Ubuntu 24.04 x64
- DeepSeek 兼容 API endpoint 与凭据
- 希望 agent 使用的工作区目录

这些安装包没有发布者证书。Windows SmartScreen 可能显示未知发布者警告。macOS 使用 ad-hoc 签名，未经过 Apple 公证；若 Gatekeeper 阻止下载的应用，可在**系统设置 → 隐私与安全性**中允许该应用。

## 安装或使用便携构建

在 [GitHub Releases](https://github.com/addy777-coder/deepseek-harness/releases) 中选择版本及对应系统和 CPU 的文件。Latest 表示最新正式版；alpha、beta 和 rc 版本标记为 Pre-release。每个发行版都提供用于检查下载文件的 SHA256SUMS。

- 运行 `DSH-Desktop-<version>-win-x64.exe` 执行当前用户安装。安装器会注册 `dsh://` 链接，之后可以启用登录后启动。
- 解压 `DSH-Desktop-<version>-win-x64.zip` 使用 portable 构建。它不会注册 `dsh://`，也不能启用登录后启动。

- macOS 打开 `DSH-Desktop-<version>-mac-<arch>.dmg`，将 DSH Desktop 复制到 Applications；Apple Silicon 选择 `arm64`，Intel 选择 `x64`。对应 ZIP 包含同一应用。
- Linux 为 `DSH-Desktop-<version>-linux-x64.AppImage` 添加执行权限后启动，或通过系统包管理器安装对应 DEB。AppImage 需要 FUSE 支持，以及用于目录选择的 zenity 或 kdialog；DEB 声明 zenity 依赖。桌面集成使用 X11 或 XWayland。

Ubuntu 24.04 的 DEB 安装会配置 Chromium 沙箱需要的 AppArmor 权限。AppImage 需要管理员为固定安装路径授权用户命名空间；没有该权限时会拒绝启动。请使用不带版本号的固定文件名，例如 `dsh-desktop.AppImage`，让更新保留该路径。不要使用 `--no-sandbox` 绕过此要求。

移除应用时会保留 Harness home：Windows 使用 `%USERPROFILE%\.dsh`，macOS/Linux 使用 `~/.dsh`。该目录存放共享模型设置、凭据、profile、工作区与会话。

## 开始任务

打开 DSH Desktop，确认测试声明并选择工作区。如果共享 Harness home 尚未保存 API key，请打开**设置 → 模型**进行保存。像使用 Web UI 一样在输入框中输入任务。

主窗口保留工作区与 Session 导航。选择**在新窗口打开当前会话**可创建不带侧栏与设置的专注任务窗口。同一 Session 会复用已有任务窗口；关闭该窗口不会停止工作。关闭主窗口会退出 DSH Desktop 并关闭所有任务窗口。

## Desktop 集成

打开**设置 → 常规 → Desktop 集成**可修改或禁用默认 `Ctrl+Shift+Space` 快捷键。该快捷键会聚焦主窗口并打开新任务视图。冲突会显示在设置中，但不会阻止应用运行。

已注册协议处理的 Windows 或 macOS 安装构建可以启用登录后启动；Linux 不提供该设置。托盘菜单可以显示主窗口、打开新任务或退出。仅当没有聚焦的 DSH Desktop 窗口显示对应 Session 时，才会出现完成或失败通知；选择通知会打开其任务窗口。

支持的链接有意保持严格：

```text
dsh://new
dsh://session/<base64url-session-id>
```

DSH Desktop 会拒绝 query string、fragment、提示词、磁盘路径与其他全部 route。

## 更新 DSH Desktop

Windows 和受支持的 Linux 安装包使用 GitHub Releases feed 更新。macOS 安装包需要从发行版页面手动下载并替换。打开**设置 → 关于与更新**，选择**检查更新**，选择**下载更新**，下载完成后选择**安装并重启**。安装前需要原生确认；安装会先关闭 DSH Desktop，再以新版本重新打开。

Windows 便携 ZIP 构建没有自己的安装目标，执行该流程时会安装当前用户应用。关于页面也提供发行版页面链接，以便手动下载。

## 恢复 Host

Host 意外退出时，窗口会保留并显示诊断。阅读错误后选择**重启 Host**。DSH Desktop 会启动新 Host 并重载全部窗口；它不会自动重放任务，因此请先检查 Session，再决定是否继续。

应用正常退出时，会给 Host 最多五秒来取消工作、flush 状态并释放子进程。如果关闭仍未 settle，应用会终止剩余进程树。

## 管理 profile 插件

打开**设置 → 插件 → 管理**。输入一个 pnpm package spec：registry package、Git spec、URL 或绝对本地路径。不要包含 pnpm 参数；整个输入框是一个 package 参数。

DSH Desktop 使用 pnpm 11.7.0 在临时 profile 中解析候选，并且不执行安装脚本。新增或变化的依赖只要声明 `preinstall`、`install`、`postinstall` 或 `prepare` 就会被拒绝。应用前请审阅最终名称、版本、integrity 或 commit、bundle patch 与 Client bundle 状态。

应用操作需要原生确认，因为运行时插件代码与 Host 拥有相同本机权限。应用会停止 Host、替换完整 profile、启动候选并重载全部窗口。候选未达到 ready 时，DSH Desktop 会恢复旧 profile、重新启动并重载窗口。取消、下载失败或校验失败都不会改变 live profile。

## 当前限制

- 不包含 Windows/Linux ARM64、Linux RPM 包与远端 Host。
- 不包含账号登录、发布者签名、Apple 公证或插件市场搜索。
- 首版无法安装依赖安装脚本的插件。
- 应用重启后不会恢复任务窗口。

## 继续

- [配置模型](./providers.zh.md)
- [使用 Web UI](./index.zh.md)
- [开发和打包插件](../develop/basic/publish.zh.md)
- [Desktop 应用参考](../../../apps/desktop/README.zh.md)
