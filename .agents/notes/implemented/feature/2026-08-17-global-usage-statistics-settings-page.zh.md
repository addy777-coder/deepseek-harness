# Agent Note: 全局使用统计设置页

Status: implemented

[English](2026-08-17-global-usage-statistics-settings-page.md) | 中文

## 问题

Web 客户端需要一个设置视图来回答跨 Session 问题：近期活动、消息与 Session 数量、模型 token 总量、活跃天数、当前连续活跃天数、一整年的日历活动、按日趋势与模型占比。现有对话统计条刻意回答单个 Session 的另一类问题。如果浏览器获取各会话历史后自行构建全局视图，就会通过协议传输原始日志、继承分页行为，并在展示代码中重复实现 Session 事件记账逻辑。

统计功能还需要统一规定 fork、日历日期与未完整结束的模型请求如何处理。如果没有明确拥有方，全局总量可能重复统计 fork 继承历史、与持久的逐会话 token 记账无提示地出现差异，或者让 Host 与浏览器把同一时间戳归入不同日期。

## 决策

`@deepseek-ai/dsh-usage-stats` 拥有基于权威 Session 日志、表示调用当下的 `usageStats/read` Remote；`@deepseek-ai/dsh-client-ui-usage-stats` 拥有只读 `settings.section` 展示。Web 组合包挂载这两个包，现有 `api-remotes` 外观显式挂载生成的 Remote 贡献。

每次读取都会合并已持久化会话列表与当前 live Session。每次冷检查前后均以 live 状态为准，检查按顺序执行，请求的 `AbortSignal` 会传递到全部持久化工作。服务返回预先计算的 7 天与 30 天稠密范围，以及一组独立的 365 天稠密活动序列。浏览器提供当前 `Date#getTimezoneOffset()` 值，Host 使用这一个固定偏移量计算事件日期与“今天”。

消息活动包含人类 `user/message` 事件和所有最终 `assistant/message` 事件。token 总量使用最终 assistant 消息中互不重叠的输入、缓存读取、缓存写入与输出字段；推理 token 不会再次相加。日志记录的模型 id 决定归属。fork 会跳过 `SessionHeader.seedLength` 前缀，使继承请求只在源 Session 计数，而不会在每个后代中重复计数。

该记账方式不会取代[投影 token 用量决策](../architecture/2026-07-29-projected-token-usage-and-request-context.zh.md)。逐会话 `token-meter` 投影仍是权威的持久计费视图，并会保留后来失败的请求所产生的 usage chunk。全局面板需要最终 assistant 消息来归属稳定的日期和模型信息，因此不包含仅存在于 chunk 中的失败或取消请求用量；包 README 会明确说明这项差异。

设置贡献以 `usage-stats`、顺序 `30` 注册。组件只在挂载时读取，切换两个预计算范围时不会再次调用 Remote，365 天热力图也不受该切换影响；刷新失败时仍保留最近一次成功快照。CSS Modules 与现有语义主题 token 共同负责 6 张指标卡、热力图、按日堆叠 token 柱、模型环图、响应式布局、焦点可见性、减少动态效果，以及无障碍文本等价内容。

## 考虑过的替代方案

**在浏览器中聚合 Session 历史。** 不予采纳，因为该方案要求跨 Session 传输原始日志，在 React 包中重复实现事件语义，并使正确性依赖历史分页。

**维护持久的全局计数器或分析索引。** 不予采纳，因为当前没有消费方需要足以证明新增持久化格式、迁移、写入生命周期与恢复路径合理的后台新鲜度或查询延迟。按需扫描可以继续以 Session 日志为真源。

**只聚合 `sessionStats` 与 `token-meter` 投影。** 不予采纳，因为这些逐会话投影不保留页面所需的日历日期和逐模型序列。扩展它们会新增持久投影状态与回填工作，而读取仍需访问每个 Session。

**统计每个 fork 日志中的全部事件。** 不予采纳，因为 fork 种子是复制的历史，不是新增的人类消息或提供方请求。跳过继承前缀可以避免系统性倍增；删除源 Session 后仍会出现已记录的少算，因为当前日志格式没有可用于安全回退去重的跨 Session 事件身份。

## 后果

该功能不新增 Session 事件、数据库 schema、后台 worker、缓存、模型输入或提供方请求。每次打开或刷新都会执行与可用 Session 日志规模成正比的工作，并顺序进行冷 I/O。因此，大规模历史可能延迟页面展示，但不会产生空闲期开销，取消请求也会停止扫描。

日历分组遵循浏览器当前的固定偏移量，无法还原历史夏令时变化或旅行导致的时区变化。全局总量与逐会话 token 统计条针对失败请求刻意采用不同口径。单元测试覆盖聚合、取消、Loader 组合、slot 生命周期、失败处理、范围切换与无障碍图表数据；组装后的 Web 浏览器场景通过随产品交付的组合，覆盖冷态多 Session 聚合与设置展示。
