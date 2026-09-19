# Agent Note: DSH Desktop 应用内更新

Status: implemented
Archived: 2026-09-19

[English](2026-09-09-desktop-in-app-update.md) | 中文

## Problem

DSH Desktop 首个发布版只提供安装包与 zip 产物，没有任何更新机制（[architecture note](../architecture/2026-09-03-windows-desktop-client.zh.md)）。用户需要手动浏览 releases 页面、下载下一个安装包并重新安装。Desktop 主进程需要在设置里提供第一流的更新流程。

## Decision

在 Desktop 主进程中引入 electron-updater 6.8.9，并新增一个 **About**（关于）设置页面来承载更新生命周期。页面检查 feed、把安装包下载进 updater 缓存（带可取消的字节级进度显示），并在原生确认后安装；页面上同时展示已安装版本与 feed 的最新版本/说明。

feed 使用 `addy777-coder/deepseek-harness` 的 GitHub Releases，在 `electron-builder.yml` 中声明，打包后生成 `resources/app-update.yml`。[原生发布决策](../architecture/2026-09-11-cross-platform-desktop-releases.zh.md)负责版本触发构建、完整产物校验、不可覆盖的 `v<version>` 发行版与重试。

两个 feed 事实决定了设计：

- electron-updater 的 GitHub provider 用 `semver.valid` 扫描 release tag。`dsh-v*` tag 永远不合法 semver，会被跳过，因此 tagged `dsh-v0.1.2-alpha.5` 的 release 永远不可能被提供给更新器。发布器因此按版本创建独立的 `v<version>` release，npm 序列则继续使用 `dsh-v*` tag。
- 发布器保留各平台通道元数据：`latest.yml`、`latest-mac.yml` 与 `latest-linux.yml`。GitHub prerelease 标记区分预发布；两个 macOS 架构共享经过校验的合并文件列表。

在用户打开 Settings 之前更新器刻意不可见：没有应用内提示，没有托盘广告。检查只从 About 页面发起，因此常规运行期间没有任何 release 流量。

## State machine and seams

`apps/desktop/src/main/updater.ts` 拥有自己的 `DesktopUpdater` 状态机（`idle`、`checking`、`available`、`up-to-date`、`downloading`、`downloaded`、`installing`、`error`、`unsupported`），检查与下载单飞（single-flight），进度增量更新，单次检查有 30 秒上限，且只在提交点转换状态。所有 electron-updater 与 Electron 交互都在 `DesktopUpdaterRuntime` seam 之后；生产实现是 `updater-runtime.ts`，它还负责连接 dev-feed 覆盖：`DSH_DESKTOP_UPDATE_FEED` 通过 userData 下的 `dev-app-update.yml`（`forceDevUpdateConfig`、`updateConfigPath`）把非打包构建指向一个 generic feed。e2e 场景用该覆盖，针对本地 HTTP fixture 服务器，它提供 `latest.yml` 与匹配 sha512 的假安装器。

Renderer 通过固定的 preload 操作（`checkForUpdate`、`downloadUpdate`、`installUpdate`、`cancelUpdate`、`getUpdateState`、`openReleases`）加一条推送通道拿到状态；About 页面通过 inject `hooks` compartment 渲染它，除这份快照外没有任何状态穿越 wire。

每次下载拥有一个新的取消令牌。[固定版本的 `builder-util-runtime@9.7.0` 补丁](../../../../patches/builder-util-runtime@9.7.0.patch) 会中止当前 HTTP 请求、销毁下载管线，并等待请求和文件写入流关闭后才结束取消操作。仅拒绝 Promise 会让传输和写入流继续活动；等待清理完成可避免它们干扰重试。下载结束时释放令牌与进度监听器，重试使用新的令牌。

关于页面独立跟踪取消请求与进行中的下载，因此下载的持续时间不会禁用取消操作。主进程通过状态快照报告更新失败，页面也会报告 preload 请求拒绝。

## Alternatives considered

- **Web UI 的 About 页面**曾先被考虑，后被否决：更新属于打包的 Desktop 构建，Web UI 没有安装器权威。
- **`electron-builder --publish always`** 可以自行创建 GitHub release，但它的 tag 语法（只有 `v<version>`）与 draft-by-default 行为让 tag 与 release 元数据落在仓库显式发布流程之外；工作流显式拥有 release 创建、prerelease 标记与重试。
- **差分下载**需要 release feed 未发布的 blockmap，其 Range 请求也绕过了已打补丁的 HTTP 取消路径。运行时设置 `disableDifferentialDownload = true`，下载完整安装器；启用差分下载必须发布 blockmap，并确保取消操作在重试前关闭停滞的 Range 请求与文件写入流。
- **便携 zip 更新**会安装当前用户应用，而不是原地替换 zip；该限制写在 About 页面文案与用户指南中。

## Consequences

Windows 和受支持 Linux 分发格式在设置内检查与下载，经原生确认后请求安装。macOS ad-hoc 构建立即显示手动更新状态。主进程不会在普通退出时自动安装。安装等待 Electron 关闭事件或更新器错误，并释放两种监听器；30 秒内均未到达则报告错误。

Windows Electron 场景通过关于页面验证 feed 错误提示和下载取消／重试，使用私有更新缓存，并让服务器响应保持打开直到取消。[HTTP 回归](../../../../apps/desktop/tests/updater-http.spec.ts) 验证响应头到达前、响应体传输中和重定向后的取消清理，以及连接中断和校验和失败时的清理。组件测试覆盖中英文错误提示和下载进行中的取消操作。运行时回归使用 electron-updater 的真实取消令牌，验证第二次下载成功以及监听器清理。

- 首个稳定版发布之前，稳定通道无法解析 `/releases/latest`；此前稳定版检查会报告明确的 feed 错误。
- 未签名安装器仍按未签名策略运行；About 页面不能绕过 SmartScreen。
- Desktop `v*` 标签与 npm `dsh-v*` 标签具有独立发布工作流。
