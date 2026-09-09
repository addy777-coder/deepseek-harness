---
description: "浏览器与 Desktop 载体共享的 GUI profile 层，添加会话、工作区、设置、审批、终端视图与完整客户端插件名录。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-gui-app

[English](README.md) | 中文

## 概述

`dsh-gui-app` 为基于 base 的 profile 提供完整交互式 GUI Host 与 Client 组合，但不选择物理载体。随附 `web` 与 `desktop` profile 都把它放在 `dsh-base` 和各自载体 bundle 之间。它添加 Session、工作区、设置、审批、终端与客户端插件配置项，后续载体再决定字节通过认证 HTTP 还是 Electron MessagePort IPC 传输。自定义 profile 必须在本层之后添加且只添加一个兼容载体。

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

普通路径是使用随附 profile，它已经按正确顺序保留本层。

### 安装到 profile

```text
dsh plugin --profile <name> add @deepseek-ai/dsh-gui-app
dsh plugin --profile <name> remove @deepseek-ai/dsh-gui-app
```

内置 bundle 从 `dsh` 安装目录解析。reconciliation 只会激活 manifest 声明了 `dsh.bundle.patch` 的依赖；缺少 patch 声明会使 profile 层失败。请在本 bundle 前添加 `dsh-base`，并在之后添加 Web 或 Desktop 载体。

### 获得的能力

本层提供 GUI 专用提示词默认值、内存 Session 搜索设置、工作区与 controller 服务、API Remotes、Connection 核心、客户端模块 registry、客户端 runner 与完整共享 UI 名录。它还把逐 agent 工具移到 preset registry 之后，让每个 GUI Session 可以选择自己的 agent 组合。

[使用统计页](../../client/ui-usage/README.zh.md)通过[使用统计控制器](../../api/usage-controller/README.zh.md)读取整个数据目录的历史。两个载体共用其读取限制、Client 模型和设置贡献。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包是一份静态 patch 文档。它重述 base 层有意省略的 GUI 值，插入与传输无关的 Host 与 Client 配置项，禁用进程级 agent 配置项，并挂载 preset registry。载体专属 HTTP、浏览器认证、Electron 传输、原生窗口集成与目录选择器选择均留在本层之外。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 共享 GUI 值、服务、客户端名录与 agent 平面转移 |
| [`src/index.ts`](src/index.ts) | 可安装 bundle 的空包入口 |
| — | 不发布运行时不变式伴生入口；本包是静态 patch 载体，每个插入包拥有自己的运行时关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Bundle 包映射](../README.zh.md)——全部随附 profile 层。
- [app-boot profile](../../boot/app-boot/README.zh.md#profiles)——层顺序与 patch 生命周期。
- [Web 载体](../web-app/README.zh.md)——认证 HTTP 与浏览器启动。
- [Desktop 载体](../desktop-app/README.zh.md)——Electron IPC 与原生集成。
- [Desktop 架构决策](../../../.agents/notes/implemented/architecture/2026-09-03-windows-desktop-client.zh.md)——GUI 与载体分离的原因。

-----

<a id="model-experience"></a>
## 模型体验

间接影响。每个插入配置项的包拥有其提示词、工具与 Session 效果。

#### KV Cache 影响

本 bundle 自身不添加请求前缀；所选 preset 与插入包拥有缓存影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束使共享层不依赖用户如何访问它。

- **本 bundle 不是完整应用**——profile 必须在它之前放置 `dsh-base`，并在之后放置一个载体 bundle。
- **载体行为不能放在这里**——端口、cookie、协议注册与原生窗口属于所选载体。
- **patch 会替换整个配置对象**——后续 profile override 必须重述保留的每个字段。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
