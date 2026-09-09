---
description: "network 包组：应用自有的模型连接与原生 OpenVPN 提供方。"
kind: "package-group"
---

# network/ — 私有模型连接

[English](README.md) | 中文

## 概述

本包组让已配置的模型提供方使用应用自有的 VPN 连接。服务定义目的地注册与可取消的 HTTP 请求；OpenVPN 提供方负责隧道与本地设置。模型适配器决定每个提供方是否使用此连接。隧道不更改电脑的路由或 DNS。

## 目录

- [包列表](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包列表

消费方集成使用服务定义，受支持的本地隧道使用提供方。

| 包 | 职责 |
|---|---|
| [`network`](network/README.zh.md) | 目的地注册、HTTP 分发与 VPN 配置的 Service Definition |
| [`network-openvpn`](network-openvpn/README.zh.md) | 使用原生 OpenVPN 辅助程序的 Windows x64 提供方 |

<a id="related-documentation"></a>
## 相关文档

- [网络子系统](../../docs/subsystems/network.zh.md)——服务与提供方组合。
- [pi-ai 模型适配器](../llm/llm-pi-ai/README.zh.md)——按提供方选择直连或 VPN。
- [原生辅助程序](../../native/vpn/README.zh.md)——构建、进程协议、网络限制与分发。
- [能力接缝](../../docs/capability-seams.zh.md)——Service Definition、Service Provider 与 Consumer 职责。

<a id="dev-note"></a>
## 开发备注

无。
