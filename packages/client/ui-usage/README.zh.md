---
description: "在设置中通过活动卡片、日历热力图、每日 token 趋势与模型占比查看近期使用情况。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-usage

[English](README.md) | 中文

## 概述

打开“设置 → 使用统计”，查看当前 Harness 数据目录中的活动与已记录模型用量。页面支持最近 7 天或 30 天，并保留独立的 365 天活动热力图。Web 与桌面端共用同一个本地化页面，明确展示空状态、加载状态、数据不完整提示与重试状态。

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

共享 GUI 组合将此展示插件与[使用统计控制器](../../api/usage-controller/README.zh.md)、区域语言服务和设置外壳一同挂载。此插件没有配置字段；自定义组合包含其 Host 加载行：

```yaml
- name: '@deepseek-ai/dsh-client-ui-usage'
```

首次打开时选择 30 天。打开页面、选择 7/30 天、点击“刷新”以及连接恢复时，都会请求当前统计；控制器在页面重新挂载后保留所选范围。日期使用浏览器当前的 IANA 时区，并包含今天。刷新失败时保留上一次结果，同时显示数据过期提示与“重试”操作。

### 阅读图表

六张卡片展示精确记录的 token、活跃主会话、用户消息、活跃天数、当前连续活跃天数，以及使用最多的提供方/模型组合。[控制器的统计口径](../../api/usage-controller/README.zh.md#accounting-and-incomplete-data)定义这些计数和缺失数据说明。页脚显示结果的时区与更新时间。

热力图始终覆盖 365 天，用户消息越多，颜色越深。图表只有一个 Tab 停靠点；方向键选择相邻日期，Home/End 选择首日/末日。焦点与鼠标悬停显示相同的日期和计数文本。

每日柱状图与模型环图为用量最高的五个提供方/模型组合及一个“其他”分组共用颜色。模型列表保留每个已记录组合及其精确数量；可展开表格展示每日 token、消息与会话数量。图表标记同时提供焦点、悬停和无障碍文本标签。页面遵循现有浅色/深色主题，并在窄容器中将卡片网格改为两列。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client 入口以 `usage` 为 id、`40` 为顺序贡献 `settings.section`，并绑定中英文词典。注入内容提供控制器的裸可观察源与查询回调；Slots 创建 React 订阅钩子。组件从一个返回快照派生 SVG 图表，不拥有 Remote 请求、会话历史或查询竞争。CSS Modules 消费共享语义主题颜色。

不发布运行时不变量伴随入口。Slots 拥有注册冲突检测与卸载；控制器拥有查询状态，此包不保留独立业务状态。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下拥有方定义页面数据与扩展点。

- [使用统计控制器](../../api/usage-controller/README.zh.md)——统计口径、查询生命周期与数据限制。
- [设置外壳](../ui-settings-general/README.zh.md)——设置导航与页面挂载。
- [Slots](../../../docs/subsystems/slots.zh.md)——贡献与订阅归属。

-----

<a id="model-experience"></a>
## 模型体验

无，因为页面只展示已记录用量，不注册提示词、工具或会话事件。

#### KV Cache 影响

没有影响；查看或刷新统计不会发起模型请求。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

页面提供覆盖整个数据目录的单一视图：

- 不提供费用估算、工作区筛选、导出、自定义日期范围或后台轮询。
- 缺失辅助用量与已删除源会话的分叉历史遵循控制器文档中的限制；页面不会估算这些数据。
- 图表颜色按所选结果内的排名分配。范围切换或刷新改变排名后，同一个组合的颜色可能变化。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
