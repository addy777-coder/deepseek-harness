# 在 Windows 上使用 DSH Desktop

[English](desktop.md) | 中文

DSH Desktop 是 Windows x64 应用，与 Web UI 共用会话、工作区、模型与设置。它从本地文件加载 GUI，并连接到私有 Host 进程，不会打开本地 HTTP 端口。

## 前提条件

- x64 版 Windows 10 或 Windows 11
- DeepSeek 兼容 API endpoint 与凭据
- 希望 agent 使用的工作区目录

首版未签名。Windows SmartScreen 可能会对内部安装产物显示未知发布者警告。

## 安装或使用便携构建

使用以下两种发布产物之一：

- 运行 `DSH-Desktop-<version>-win-x64.exe` 执行当前用户安装。安装器会注册 `dsh://` 链接，之后可以启用登录后启动。
- 解压 `DSH-Desktop-<version>-win-x64.zip` 使用 portable 构建。它不会注册 `dsh://`，也不能启用登录后启动。

移除应用时，两种变体都会保留 `%USERPROFILE%\.dsh`。该目录存放共享模型设置、凭据、profile、工作区与会话。

## 开始任务

打开 DSH Desktop，确认测试声明并选择工作区。如果共享 Harness home 尚未保存 API key，请打开**设置 → 模型**进行保存。像使用 Web UI 一样在输入框中输入任务。

主窗口保留工作区与 Session 导航。选择**在新窗口打开当前会话**可创建不带侧栏与设置的专注任务窗口。同一 Session 会复用已有任务窗口；关闭该窗口不会停止工作。关闭主窗口会退出 DSH Desktop 并关闭所有任务窗口。

## Desktop 集成

打开**设置 → 常规 → Desktop 集成**可修改或禁用默认 `Ctrl+Shift+Space` 快捷键。该快捷键会聚焦主窗口并打开新任务视图。冲突会显示在设置中，但不会阻止应用运行。

已安装构建可以启用登录 Windows 后启动。托盘菜单可以显示主窗口、打开新任务或退出。仅当没有聚焦的 DSH Desktop 窗口显示对应 Session 时，才会出现完成或失败通知；选择通知会打开其任务窗口。

支持的链接有意保持严格：

```text
dsh://new
dsh://session/<base64url-session-id>
```

DSH Desktop 会拒绝 query string、fragment、提示词、磁盘路径与其他全部 route。

## 恢复 Host

Host 意外退出时，窗口会保留并显示诊断。阅读错误后选择**重启 Host**。DSH Desktop 会启动新 Host 并重载全部窗口；它不会自动重放任务，因此请先检查 Session，再决定是否继续。

应用正常退出时，会给 Host 最多五秒来取消工作、flush 状态并释放子进程。如果关闭仍未 settle，应用会终止剩余进程树。

## 管理 profile 插件

打开**设置 → 插件 → 管理**。输入一个 pnpm package spec：registry package、Git spec、URL 或绝对本地路径。不要包含 pnpm 参数；整个输入框是一个 package 参数。

DSH Desktop 使用 pnpm 11.7.0 在临时 profile 中解析候选，并且不执行安装脚本。新增或变化的依赖只要声明 `preinstall`、`install`、`postinstall` 或 `prepare` 就会被拒绝。应用前请审阅最终名称、版本、integrity 或 commit、bundle patch 与 Client bundle 状态。

应用操作需要原生确认，因为运行时插件代码与 Host 拥有相同本机权限。应用会停止 Host、替换完整 profile、启动候选并重载全部窗口。候选未达到 ready 时，DSH Desktop 会恢复旧 profile、重新启动并重载窗口。取消、下载失败或校验失败都不会改变 live profile。

## 当前限制

- 仅支持 Windows x64；不包含 macOS、Linux 与远端 Host。
- 不包含账号登录、代码签名、自动更新或插件市场搜索。
- 首版无法安装依赖安装脚本的插件。
- 应用重启后不会恢复任务窗口。

## 继续

- [配置模型](./providers.zh.md)
- [使用 Web UI](./index.zh.md)
- [开发和打包插件](../develop/basic/publish.zh.md)
- [Desktop 应用参考](../../../apps/desktop/README.zh.md)
