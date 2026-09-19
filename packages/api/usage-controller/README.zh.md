---
description: "查询一个 Harness 数据目录中的近期会话活动、精确记录的 token 总量、每日趋势与模型占比。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-usage-controller

[English](README.md) | 中文

## 概述

读取运行中与已持久化会话的使用统计，包括归档会话，无需启动其智能体。选择最近 7 天或 30 天的本地日历日期范围，即可获取 token 总量、用户活动、模型占比，以及独立的一年活动记录。历史不完整与用量缺失计数会明确标识不完整结果；打开或刷新大量历史时，可能需要读取尚未缓存的日志。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

共享 GUI 组合挂载 Host 控制器及其 Client 入口。生成的 `usage.get({ days, timeZone })` Remote 接受 `7` 或 `30` 与有效的 IANA 时区；返回的日期区间包含两端日期与今天。[使用统计页](../../client/ui-usage/README.zh.md)提供浏览器当前时区。

### 配置

将此插件与 `sessions`、`sessionQuery` 一同挂载；共享 GUI 显式提供以下限制：

```yaml
- name: '@deepseek-ai/dsh-api-usage-controller'
  config:
    concurrentReads: 4
    cacheSize: 256
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `concurrentReads` | 必填；GUI 选择 `4` | 每次查询中同时进行的会话观察上限；必须是正安全整数。 |
| `cacheSize` | 必填；GUI 选择 `256` | 缓存会话摘要的数量上限；必须是正安全整数。 |

[配置目录](../../../docs/config-catalog.zh.md)拥有生成的配置参考。无效限制会在插件加载时失败；无效范围或时区会使查询失败。

<a id="accounting-and-incomplete-data"></a>
### 统计口径与不完整数据

token 总量包含已记录的对话、子智能体和压缩用量。[token-meter 归一化函数](../../llm/token-meter/README.zh.md)接受一致的提供方总量，或仅在互不重叠的输入、缓存读取、缓存写入和输出分桶完整时计算总量。推理属于输出细分，不会再次相加。每条持久化 Assistant 消息或尝试贡献一个采样：最终消息用量优先于最后一个内嵌流采样。无效或不完整的最终计数记为缺失，不回退到更早的采样。重试分别计数，已结算的失败或取消保留其上报用量。token 按采样的本地日期及记录的提供方/模型组合归属；未结算的流不贡献 token 总量。

会话数量表示所选区间内有用户消息的不同主会话数。消息数量仅包含这些会话中 `source.kind = user` 的 `user/message` 事件；注入消息和子智能体消息不产生活动。活跃天数遵循所选范围。当前连续天数从今天向前覆盖全部可用历史；今天没有用户消息时为零。365 天热力图按用户消息数统计，不受所选范围影响。

分叉观察排除继承事件，但保留继承的请求头用于模型归属。单个会话读取失败会增加 `coverage.unreadableSessions`，其余结果仍然可用。`coverage.missingUsageAttempts` 统计所选区间内没有精确有效用量采样的已记录尝试；两个计数均不会触发 token 估算。无法枚举会话集合，或非空集合中的全部会话都无法读取时，整个查询失败；空集合返回零统计。

### Client 生命周期

仅在 Client 存在的 `ctx.usage` 服务提供裸可观察源 `snapshot`，以及 `load(request)` 和 `refresh()`。快照状态为 `idle`、`loading`、`ready` 或 `error`；加载和失败期间保留最近一次完整结果。新选择会取消上一次读取，被替代的响应无法发布。刷新和连接恢复会重新读取浏览器时区；首次显式加载之前不会发起查询。卸载会取消未完成查询、停止通知，并等待查询全部结束。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Host 通过 `sessionQuery` 获取优先使用运行中会话的观察，将每个会话折叠为紧凑的每日计数，再将计数聚合为一个响应。观察租约在摘要进入缓存前关闭；浏览器接收统计数据而非原始历史。缓存复用要求会话/提供方身份、运行中序号或持久化修订号，以及时区均匹配。持久化修订检查能够发现其他进程的写入，有界缓存会逐出最近最少使用的会话摘要。

Host 与 Client 在独立程序中编译。Host 拥有生成的 Remote 方法；Client 导入生成的声明并拥有查询顺序。UI 订阅由渲染器负责。不发布运行时不变量伴随入口：这些由读取派生的统计没有需要对账的独立持久化状态。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面定义查询输入及消费其结果的展示。

- [Session Query](../../session-query/session-query/README.zh.md)——运行中与冷态历史观察。
- [Token Meter](../../llm/token-meter/README.zh.md)——精确用量归一化与会话投影。
- [使用统计页](../../client/ui-usage/README.zh.md)——设置交互与图表。
- [用量统计决策](../../../.agents/notes/implemented/feature/2026-09-08-usage-statistics-from-session-history.zh.md)——权威来源、替代方案与取舍。

-----

<a id="model-experience"></a>
## 模型体验

无，因为控制器只读取已记录历史，不注册提示词、工具或会话事件。

#### KV Cache 影响

没有影响；统计读取不会构建或发送模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

结果描述可用的已记录历史，具有以下限制：

- 没有用量事件的辅助调用，包括标题生成和图像识别，不会计入，也无法通过缺失尝试计数反映。
- 删除源会话可能使仅存在于后代继承前缀中的用量消失；该前缀仍被排除，因为日志没有可用于安全回退去重的跨会话事件身份。
- IANA 分组遵循所选时区的历史夏令时规则，但不会还原用户的旅行历史。不同会话的观察不构成覆盖整个集合的事务。
- 缓存限制会话数量，不限制单个会话内的日期数量。冷态或被逐出的历史需要重新扫描；不提供持久分析索引、后台轮询、费用计算或历史用量修复。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
