---
description: "在桌面设置中保存公司 VPN 配置、管理应用连接，并读取不含密码的连接状态。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-vpn-controller

[English](README.md) | 中文

## 概述

保存公司 VPN 配置和账号，连接或断开应用隧道，并读取当前状态。设置命令接收文件内容和只写密码。保存成功后仍会显示连接失败信息，设置页面因此可以清除密码草稿。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [深入阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

桌面组合将此控制器与应用网络提供者一起挂载，并向 [VPN 设置页面](../../client/ui-vpn/README.zh.md)提供生成的 `vpn` Remote 命名空间。未安装网络提供者的部署会返回不支持状态，并拒绝连接命令。

### 配置

在提供 `network` 的组合中挂载控制器；它没有配置字段：

```yaml
- name: '@deepseek-ai/dsh-api-vpn-controller'
```

[配置目录](../../../docs/config-catalog.zh.md)维护生成的插件配置参考。VPN 配置内容和凭据由网络提供者管理，不属于控制器配置。

### 保存与连接控制

导入数据包含显示文件名和 UTF-8 内容。控制器拒绝未声明字段、超过 16 个引用文件以及过长的输入字符串。网络提供者在持久化前验证配置语法、证书引用、兼容性和凭据。省略配置文件或密码会保留已保存的值。

首次成功保存 VPN 时，已有的、使用 `anthropic-messages` 的 `gongsi` 提供者会通过检查修订号的设置写入选择 VPN。其他提供者协议和后续保存保留原有网络选择。如果此写入失败，已保存的账号仍然可用，响应会引导用户手动配置提供者。连接启动抛出异常时，也会返回带有脱敏失败信息的已保存结果。

较新的断开操作会阻止等待中的保存或重连随后启动连接。持久化后取消会保留已保存账号，并跳过连接启动。网络提供者负责取消活动连接和关闭隧道。

### Client 生命周期

Client 的 `vpn` 服务提供可观察快照以及读取、保存、连接和断开命令。Host 生命周期事件无需轮询即可更新快照；传输恢复会触发重新读取。新命令使等待中的读取失效，过期响应不能覆盖后续命令或事件。保存操作返回持久化是否成功，与连接是否成功无关。销毁会取消未完成调用、移除监听器、停止发布状态，并等待所有归属调用结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

Host 验证 Remote 请求，并将凭据持久化和连接资源交给网络能力。Client 仅保存脱敏视图和操作代码；设置组件持有本地密码和文件草稿。Host 与 Client 分开编译，通过生成的 Remote 声明关联类型。

此包不发布运行时不变量伴随插件：控制器没有可与网络提供者比较的独立持久化状态。可控延迟操作测试验证排序和销毁，Host 夹具通过 Loader 挂载控制器。

</details>

-----

<a id="further-exploration"></a>
## 深入阅读

以下页面说明表单、传输归属和设置写入。

- [VPN 设置页面](../../client/ui-vpn/README.zh.md) — 配置导入和本地凭据草稿。
- [网络能力](../../network/network/README.zh.md) — 模型目标和隧道生命周期。
- [用户设置](../../settings/settings/README.zh.md) — 检查修订号的提供者配置。

-----

<a id="model-experience"></a>
## 模型体验

无，此控制器不注册提示词、工具或会话事件，并将 VPN 凭据保持在模型输入之外。

#### KV 缓存影响

无影响；设置操作不会构造或发送模型请求。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

此控制器提供一份应用 VPN 配置：

- VPN 支持取决于已挂载的提供者；桌面实现要求 Windows x64。
- 提供者选择和凭据持久化分别写入。持久化后发生提供者选择失败时，需要修正该提供者的设置。
- 原生兼容性、DNS、重试、请求路由和进程清理由网络提供者负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
