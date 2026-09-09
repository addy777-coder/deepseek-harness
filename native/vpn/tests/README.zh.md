---
description: "离线原生 VPN 检查，以及通过受支持的 dsh 启动器显式运行公司模型真实连接验收。"
---

# VPN 验收测试

[English](README.md) | 中文

[辅助进程构建](../scripts/build.ps1)会运行原生数据包/CONNECT 测试、离线进程检查和源码包恢复验证，不需要公司凭据。单独的真实连接测试通过正式的凭据、网络和 pi-ai 服务验证已保存的公司提供商。

## 真实连接运行

在桌面设置中保存 VPN 配置和账号，将公司提供商设为使用 VPN 和 Anthropic Messages，并保存其模型凭据。启动独立测试前，先断开桌面 VPN。测试管理自己的隧道，不修改外部 OpenVPN 客户端；存在活动的外部 OpenVPN 进程或竞争的辅助进程时，验收会失败。

检查[测试补丁](live-acceptance.patch.yml)。它选择提供商 `gongsi` 和已保存的默认模型；如果公司模型不同，请将 `model` 替换为已保存公司模型的精确 id。补丁仅包含可执行文件路径、提供商/模型、请求预算和报告路径。它读取常规 Harness 主目录和凭据服务；请使用与桌面相同的 Harness 主目录。

在仓库根目录使用 PowerShell 7 运行外层验收脚本：

```powershell
& native/vpn/tests/run-live-acceptance.ps1
```

脚本在启动任何 Harness 插件之前记录 Windows 路由、DNS 和网卡，发现活动的外部 OpenVPN 进程或已有辅助进程时拒绝运行，然后通过 `node --import tsx/esm apps/cli/src/bin.ts --profile headless --patch native/vpn/tests/live-acceptance.patch.yml` 启动测试。子进程继承选定的 Harness 主目录。`-ReportPath` 指定新的主机报告文件；`-RunTimeoutSeconds` 限制整个运行时长（默认 1800），`-ShutdownGraceMs` 限制启动器终止等待时间（默认 10000）。运行超时时，脚本仅终止自己启动的进程树。

测试禁用普通 headless 任务解析器和执行器，等待 `appReady`，连接原生提供商，然后验证文本流、工具调用回放、长输出、取消、后续请求和模型发现。仅当公司端点不实现模型列表时，才设置 `checkDiscovery: false`；报告会将该项标为未请求。

测试比较模型请求前后的网络快照，断开自己管理的隧道，确认没有辅助进程残留，然后请求 `appExit`。外层脚本将最终网络状态与启动前的基线比较，覆盖自动连接过程，并再次检查外部 VPN 进程和辅助进程退出情况。直接调用 CLI（命令行界面）适合诊断，但不能提供该启动前基线。

脚本默认在辅助进程被忽略的 `.cache/` 目录中写入主机报告及同目录下的 `.fixture.json` 报告。stdout 给出主机报告路径及通过/失败结果。报告仅包含计数和固定失败代码，不含凭据、端点地址、模型文本或原始网络快照。启动器 stdout/stderr 仅保留在内存中，不会打印或保存。现有报告文件不会被覆盖。

退出码 0 表示所有请求的检查都已通过。连接、模型、清理或报告写入失败时，以退出码 1 结束。认证失败需要修正已保存的凭据；测试不修改账号或重试策略。公司真实环境运行是显式验收步骤，不属于离线构建。

## 离线测试检查

以下命令在不激活插件的情况下检查组合，并使用内存服务测试真实连接测试程序：

```powershell
node --import tsx/esm apps/cli/src/bin.ts --profile headless --dump-config --patch native/vpn/tests/live-acceptance.patch.yml
node --import tsx/esm --test native/vpn/tests/live-acceptance-plugin.test.mjs
& native/vpn/tests/run-live-acceptance.test.ps1
```

已初始化的桌面测试上下文也可以调用可导入的[验收程序](live-acceptance.ts)。[插件](live-acceptance-plugin.ts)负责围绕该程序管理启动就绪、连接、网络快照、报告和关闭。
