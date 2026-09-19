---
description: "DSH Desktop 专用 GUI 呈现：融合标题栏、原生通知、偏好设置与 profile 插件管理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-desktop

[English](README.md) | 中文

## 概述

`dsh-client-ui-desktop` 在不替换对话界面的前提下，让共享 GUI 适配 Electron。它添加 DSH Desktop 标题栏与品牌，保留主窗口导航，并把 Session 状态连接到原生通知。主窗口还会获得全局快捷键、登录后启动、事务式插件管理设置，以及驱动应用内更新生命周期的关于页面。本包要求 `apps/desktop` 提供固定 preload API，在该外壳之外会失败。

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

Desktop 载体 bundle 会挂载两侧，并在 Client Loader 启动前提供 Electron preload 全局对象。

### 何时选择

仅为 DSH Desktop 加载的窗口选择本插件。浏览器 profile 使用普通品牌与导航插件；在那里挂载本包会因缺少可信 Desktop bootstrap 或 shell API 而失败。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-client-ui-desktop'
```

本插件没有配置字段。主进程 bootstrap 提供已安装应用的版本。

### 窗口行为

主窗口保留侧栏与设置。标题栏可创建新任务；Session 链接与通知点击会在同一窗口选择对应 Session。preload 在 Client 订阅后投递导航，包括启动或重新加载期间收到的链接。完成状态转换会请求原生通知。

关于页面在下载期间保持取消操作可用，取消完成后允许再次下载。更新失败会显示主进程的诊断；preload 请求失败也会显示在页面上。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

node 半侧为空，只作为 Loader 配置项存在。Client 半侧填充共享 layout、侧栏品牌、常规设置、插件设置与关于设置 slot。它订阅已有 Session 列表，而不拥有第二份缓存：选择变化会更新主进程，running 到 settled 的边沿会请求通知。preload bridge 拥有所有操作系统修改，只暴露固定操作。

| 文件 | 职责 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | slot 注册、shell 导航 intent 与通知转换 |
| [`src/client/TitleBar.tsx`](src/client/TitleBar.tsx) | 融合 caption 内容与新建任务操作 |
| [`src/client/DesktopPreferences.tsx`](src/client/DesktopPreferences.tsx) | 快捷键与登录后启动设置 |
| [`src/client/PluginManager.tsx`](src/client/PluginManager.tsx) | 解析、审阅、应用与取消插件 transaction |
| [`src/client/AboutSection.tsx`](src/client/AboutSection.tsx) | 已安装版本、更新检查／下载／安装与发行版链接 |
| [`src/client/locales.ts`](src/client/locales.ts) | 英文与简体中文产品文案 |
| — | 不发布运行时不变式伴生入口；本插件贡献 UI slot，并从现有 Session 与 preload owner 派生全部状态。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Desktop 用户指南](../../../docs/user/guide/desktop.zh.md)——窗口、快捷键、恢复与插件工作流。
- [Desktop 载体 bundle](../../bundle/desktop-app/README.zh.md)——启用本插件的 Host 与 Client 配置项。
- [UI layout](../ui-layout/README.zh.md)——标题栏与面板 slot。
- [Desktop 传输](../../desktop/transport/README.zh.md)——Renderer 到 Host 的投递。
- [Desktop 架构决策](../../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.zh.md)——主进程权限与安全选择。

-----

<a id="model-experience"></a>
## 模型体验

无。本包呈现 Desktop 控件与已有 Session 状态，不添加模型上下文。

#### KV Cache 影响

无；标题栏、通知与设置不改变请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束使首版 Desktop 表层与 Windows 外壳保持一致。

- **通知投递依赖 Windows 设置**——应用会为已聚焦的 Session 窗口抑制通知，但不能覆盖系统通知策略。
- **便携构建不能启用登录后启动**——仅当已安装应用拥有 `dsh://` 协议注册时才提供该设置。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
