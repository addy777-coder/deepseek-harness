---
description: "注册私有模型目的地，并通过应用自有的 VPN 服务发送可取消的 HTTP 请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-network

[English](README.md) | 中文

## 概述

模型适配器使用本服务通过应用自有的 VPN 发送请求。消费方注册已配置的 API 根地址，并确保每个 HTTP 请求位于已注册目的地之下。VPN 服务缺失或未连接时，请求失败。配置界面可以读取脱敏状态、保存导入的配置，并连接或断开隧道。

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

在受支持的 `dsh` profile 中挂载 [network-openvpn](../network-openvpn/README.zh.md) 之类的提供方。本包声明 `ctx.network`，自身不建立隧道，也没有插件配置字段。

### 模型消费方

通过 `ctx.effect()` 注册 API 根地址，并保留返回的释放函数。带品牌类型的 `NetworkTargetId` 标识此注册；`fetch()` 只接受位于目的地 origin 与路径下的 URL。释放注册会撤销访问并取消其活跃请求。选择直连的消费方不注册目的地，也不调用此服务。

[pi-ai 适配器](../../llm/llm-pi-ai/README.zh.md)提供内置模型消费方。其 VPN 模式支持 Anthropic Messages HTTP 流式请求，要求已保存端点与显式 API 密钥引用。提供方 URL 保持不变。

### 配置消费方

`get()` 返回脱敏配置与连接状态。`save()` 接收配置内容、所选引用文件内容、登录名、只写密码与启动偏好；保存和连接是独立操作。`disconnect()` 在所属请求和辅助进程停止后完成。`network/changed` 事件携带相同的脱敏状态字段。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

服务把模型目的地与 VPN 认证分开。模型消费方拥有 API 根地址与请求取消；提供方拥有连接状态、凭据、进程生命周期与 HTTP 分发。请求 API 绝不允许回退到直连网络。提供方必须保留响应流，并在目的地注册或连接被撤销时停止请求。

根入口声明抽象服务与品牌标识构造函数。`./types` 入口为其他编译面导出共享请求、状态、目的地和事件声明。不发布 invariant 伴随插件：本定义不拥有具体连接状态或可独立观测的数据；目的地和生命周期检查由提供方执行。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [OpenVPN 提供方](../network-openvpn/README.zh.md)——支持平台、导入、凭据与重连行为。
- [Network 包地图](../README.zh.md)——本能力中的包。
- [模型设置](../../client/ui-settings-models/README.zh.md)——提供方连接选择器。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本服务只选择 HTTP 目的地并暴露脱敏的本地状态。

#### KV Cache 影响

无。服务只改变 HTTP 路由，不添加或改写模型输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制描述本服务支持的用法。

- **必须挂载提供方。** Service Definition 不实现隧道或直连网络。
- **HTTP 请求必须注册。** WebSocket 客户端与任意目的地发现不属于此 API。
- **状态属于本地运行时。** 它不是模型消息或持久会话事件。

<a id="dev-note"></a>
### 开发备注

无。
