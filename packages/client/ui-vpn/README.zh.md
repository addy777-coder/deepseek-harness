---
description: "导入 OpenVPN 配置及引用证书，保存 VPN 凭据，并管理桌面应用访问内网模型的连接。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-vpn

[English](README.md) | 中文

## 概述

在桌面设置中配置公司 VPN，保存账号后开始连接。导入 OpenVPN 配置及其引用证书，选择启动时自动连接，并查看连接失败信息。表单将密码草稿保存在本地，并在 Host 确认持久化后清除。

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

在桌面应用中打开**设置 → VPN**。此页面需要 [VPN 控制器](../../api/vpn-controller/README.zh.md)、语言服务和设置渲染器。不支持的主机会显示 Windows x64 要求并禁用配置操作。

### 配置连接

选择 `.ovpn` 文件，并添加其中引用的 CA、证书或密钥文件。文件名必须与引用匹配。输入 VPN 用户名和密码，选择是否在启动时自动连接，然后点击**保存并连接**。状态会显示连接是否已建立或失败。

密码留空会保留已保存的密码。保存成功会清除所选文件和密码草稿，即使连接启动失败也会清除。替换引用文件时必须同时重新选择配置文件。连接状态更新会保留未保存的表单编辑。

使用**断开**停止活动连接或等待中的 Host 命令。**重新连接**使用已保存的设置；表单存在编辑时，此操作不可用。**刷新**重新读取当前状态。仅选择使用 VPN 的模型提供者通过内网连接访问服务。

### 配置

此插件没有配置字段。桌面组合挂载不执行操作的 Host 入口；Client 通过包声明的控制器、语言和渲染器依赖注册设置区域。[配置目录](../../../docs/config-catalog.zh.md)维护生成的插件配置参考。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

渲染器订阅控制器的公开快照。表单仅在保存时读取浏览器选择的文件，并发送显示文件名及其内容，不发送浏览器路径。密码在保存完成前保留于组件状态；控制器不会返回已保存的密码。页面显示本地化操作代码，并忽略原生异常消息。

中英文词典、设置注册和快照订阅跟随所属插件或组件的生命周期。此包不发布运行时不变量伴随插件：页面拥有临时表单状态，没有需要核对的独立持久化状态。组件测试为未配置、已连接和失败状态记录本地 HTML 期望输出。

</details>

-----

<a id="further-exploration"></a>
## 深入阅读

以下页面说明设置命令及其网络资源。

- [VPN 控制器](../../api/vpn-controller/README.zh.md) — 持久化结果和操作排序。
- [网络能力](../../network/network/README.zh.md) — 已注册模型目标和隧道归属。
- [设置渲染器](../ui-settings/README.zh.md) — 容纳此页面的设置区域。

-----

<a id="model-experience"></a>
## 模型体验

无，此设置页面不注册提示词、工具或会话事件，也不会将 VPN 凭据加入模型输入。

#### KV 缓存影响

无影响；编辑表单不会构造或发送模型请求。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

此页面管理一份已保存的 VPN 配置：

- 桌面 VPN 实现要求 Windows x64 和兼容的公司配置。
- 页面不能接管外部 OpenVPN 客户端的活动连接，也不能恢复其密码。
- 关闭页面会丢弃未保存的草稿；已持久化的连接资源仍由网络提供者管理。
- 配置验证、凭据存储、启动恢复和模型路由由 Host 提供。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
