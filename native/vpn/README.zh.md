---
description: "Windows、macOS 和 Linux 用户态 OpenVPN 辅助进程：构建、经过认证的模型传输、生命周期、限制和源码分发。"
---

# 原生 VPN 辅助进程

[English](README.md) | 中文

## 摘要

辅助进程通过 OpenVPN 隧道承载指定的模型请求，不创建网卡，也不修改系统路由或 DNS。OpenVPN3 Core 与内存中的 lwIP IPv4 协议栈交换加密隧道数据包。经过认证的本机回环 CONNECT 代理只开放父进程选定的目标。它以应用用户身份运行，不需要管理员权限、root、驱动或系统 VPN 扩展。

## 目录

- [构建与分发](#build-and-distribute)
- [进程协议](#process-protocol)
- [网络限制](#network-constraints)
- [许可证与对应源码](#licenses-and-corresponding-source)
- [延伸阅读](#further-exploration)
- [开发备注](#dev-note)

<a id="build-and-distribute"></a>
## 构建与分发

在匹配的 Windows x64、macOS arm64/x64 或 Linux x64 主机上构建，需要 PowerShell 7、Git、Node.js、CMake 和 Ninja。Windows 需要包含 Windows SDK 和 vcpkg 的 Visual Studio 2022 C++ Build Tools；`-VsDevCmdPath` 可指定安装实例，代替 `vswhere` 自动查找。macOS 需要 Xcode 命令行工具；Linux 需要 C/C++ 编译器、开发工具和 `iproute2`。POSIX 依赖构建还需要 curl、zip/unzip、tar、Perl、pkg-config 及该平台的 make/autotools。在仓库根目录运行以下命令：

```powershell
pwsh -File native/vpn/scripts/build.ps1
```

构建会获取[依赖版本固定清单](deps/pins.json)指定的修订，检查源码检出未被修改，并静态链接第三方库。Windows 还会静态链接 Microsoft C/C++ 运行库。下载内容和中间产物保存在辅助进程目录内被忽略的 `.cache/` 和 `build/<target>/` 树中。[目标 triplet](deps/triplets/)定义链接方式；[共享构建脚本](scripts/build.ps1)在打包前运行 CTest 和离线进程测试，打包后验证源码恢复。测试使用合成数据包和测试独占的本机回环监听器，不会向公司服务器发起认证。

输出目录为 `dist/<target>/`，其中 target 为 `windows-x64`、`darwin-arm64`、`darwin-x64` 或 `linux-x64`。目录包含 Windows 上的 `dsh-vpn.exe` 或 POSIX 上的 `dsh-vpn`、对应 SHA-256 文件、资源清单、许可证、已编译 OpenVPN 源码审计结果和对应源码 ZIP。清单列出其他每个资源的相对路径、SHA-256 和大小。分发方保留完整目录，并在配置应用的辅助程序路径前校验清单。打包会拒绝预期之外的非系统库导入。`-Target` 要求匹配的原生主机；`-SkipPackage` 不生成分发产物，`-Fresh` 重置目标 CMake 缓存，`-LocalDependenciesPath` 可复用已记录构建输入匹配的依赖安装目录。

macOS 打包先为辅助进程添加 ad-hoc 签名，再计算 SHA-256 和资源清单。该签名不等同于 Developer ID 签名或公证。分发方保留辅助进程字节和 POSIX 可执行权限，并验证相同摘要。发布维护者负责 macOS/Linux 构建和打包后进程验证。真实 VPN 兼容性需要在各目标上使用已保存的公司凭据显式执行[真实连接验收](tests/README.zh.md)。

依赖安装对临时下载错误最多尝试三次，重试前分别等待五秒和十秒。编译错误、永久 HTTP 错误和校验和不匹配会立即失败。原生构建可以按目标缓存下载归档及以 ABI 为键的 vcpkg 库；固定哈希和源码检查仍为必需步骤。

源码 ZIP 包含辅助进程、精确的上游源码归档、库源码归档，以及所有选定的 vcpkg port 补丁。要使用随附源码，将 ZIP 解压到新目录后运行：

```powershell
pwsh -File scripts/restore-sources.ps1
pwsh -File scripts/build.ps1
```

恢复过程验证源码哈希，并配置本地 overlay port。仍须预先安装构建工具；vcpkg 可能下载其便携式构建工具。被修改或不完整的依赖源码树会被拒绝。[恢复脚本](scripts/restore-sources.ps1)定义对应源码的目录结构。

<a id="process-protocol"></a>
## 进程协议

父进程以管道连接 stdin/stdout 来启动辅助进程，不在参数或环境变量中传递凭据。父进程发送一行 UTF-8 JSON，然后保持 stdin 打开。EOF 或后续任意 stdin 字节都会请求关闭。POSIX 接受 FIFO 和 socketpair 标准输入，拒绝普通文件和终端。辅助进程在处理连接期间每 100 毫秒检查一次管道。父进程等待其退出后才能启动替代进程。

启动消息必须包含 `profileContent`、`username`、`password`、`proxyToken`、`targets` 和下表中的运行参数。`profileContent` 是完整的内联配置：父进程在启动前解析导入的 CA、证书和密钥引用。原生辅助进程不会读取配置中的文件路径。代理令牌是每次启动生成的秘密值，长度为 32–256 字节，不能包含 CR/LF；父进程仅为经过认证的代理请求保留该令牌。

| 运行字段 | 接受范围 | 含义 |
|---|---|---|
| `connectTimeoutSeconds` | 1–300 | OpenVPN 连接时限 |
| `maxConnections` | 1–32 | 并发代理连接和隧道流数量 |
| `headerTimeoutMs` | 100–60000 | 代理请求头准入时限 |
| `targetConnectTimeoutMs` | 100–300000 | 隧道 DNS/TCP 连接时限 |
| `pollIntervalMs` | 1–1000 | lwIP 定时器轮询间隔 |
| `maxPendingPacketBytes` | 65536–8388608 | 排队等待发送的隧道数据包字节数 |

`targets` 最多包含 64 个 `{host, port}` 项，主机名与端口组合不能重复，比较主机名时不区分大小写。空列表拒绝所有目标。主机为 IPv4 地址或 DNS 名称；端口范围为 1–65535。启动输入上限为 1 MiB。CONNECT 只接受精确匹配的已配置主机和端口、HTTP/1.1，以及 `Proxy-Authorization: Bearer <proxyToken>`；请求头上限为 8192 字节。代理在 IPv4 本机回环地址的临时端口上监听。

stdout 输出包含 `event` 和 `error` 字段的 JSONL 事件。OpenVPN 事件保留事件名及真实错误标记；日志消息和事件详细内容被抑制。`profile-evaluated` 报告是否接受配置及所需认证功能。`proxy-ready` 额外包含 `port` 和 `dnsConfigured`；父进程必须等待该事件后才能转发请求。`stopped` 表示正常关闭完成，致命错误以退出码 2 结束。成功评估和正常关闭的退出码为 0。

评估启动消息只包含 `profileContent` 和 `evaluateOnly: true`。该模式验证内联配置，不需要凭据，不创建代理，也不产生网络流量。父进程在提供连接操作前检查认证要求。成功评估不代表服务器兼容或网络可达。

可导入的[真实连接验收程序](tests/live-acceptance.ts)接收已初始化的桌面测试上下文，以及明确的模型选择和请求预算。调用方仅在设置界面保存凭据并连接后运行它。程序通过正式的凭据、网络和 pi-ai 服务验证 Anthropic Messages 文本流、工具调用回放、长输出、取消、后续请求以及可选的模型发现。它仅返回计数，不含模型文本或凭据，也不修改 VPN 连接或设置。导入程序不会发出请求；公司真实环境执行与离线构建测试分开进行。

<a id="network-constraints"></a>
## 网络限制

数据通道支持每进程一个 IPv4 隧道、TCP 模型请求，以及通过最多四个 VPN 下发的 IPv4 DNS 服务器进行的 53 端口普通 UDP DNS 查询。请求客户端与模型端点之间的 HTTPS 加密保持完整，包括客户端正常执行的证书验证。流量控制限制排队字节数，并传递取消和对端关闭。主机网络仅负责连接 VPN 服务器。

不支持 IPv6 隧道、TAP/以太网模式、加密 DNS 传输、强制 DNSSEC、外部 PKI、挑战式认证或加密私钥口令提示。缺少 VPN DNS 时无法请求主机名目标，但仍可使用 IPv4 地址。辅助进程不会回退到系统 DNS 解析器或直接连接模型。服务器下发的网络更新及重连会终止当前辅助进程，让父进程启动新的 lwIP 进程。认证错误会停止连接；父进程负责重试策略。

普通本机应用没有本次启动的代理令牌就无法使用隧道。辅助进程不隔离同一操作系统用户下互不信任的进程对该用户进程内存的访问。父进程负责凭据存储、配置导入策略和目标白名单。

<a id="licenses-and-corresponding-source"></a>
## 许可证与对应源码

组合可执行文件和辅助进程原创代码使用 [GPL-3.0-only](LICENSE)。实际编译的 OpenVPN 文件包括两个 GPL-3.0-only 头文件；双许可 OpenVPN 文件选择 MPL-2.0，Windows Unicode 转换文件保留自身声明。[打包脚本](scripts/package.ps1)审计目标实际编译的 OpenVPN 包含文件列表，并拒绝缺失的必需文件或未知的许可声明。[第三方声明](THIRD-PARTY-NOTICES.txt)列出其余依赖。

每份可执行文件分发都在资源清单中包含对应源码 ZIP 和许可证资源。ZIP 包含已链接库的源码及构建材料，包括 OpenVPN 的 Asio 补丁，不含私有配置、凭据或构建工具二进制文件。Windows 上的 tap-windows6 依赖仅提供 MIT 许可的公共头文件；不会安装、使用或分发 TAP 驱动。

<a id="further-exploration"></a>
## 延伸阅读

- [原生组件](../README.zh.md)
- [辅助进程入口](src/main.cpp)
- [用户态 TCP/IP 适配器](src/lwip_stack.hpp)
- [离线进程验证](tests/helper-protocol.test.mjs)

<a id="dev-note"></a>
## 开发备注

无。
