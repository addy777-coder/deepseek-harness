# Agent Note: Desktop Session 导航与导出

Status: implemented

[English](2026-09-19-desktop-session-navigation-and-export.md) | 中文

## 问题

Desktop 的 Session 窗口操作重复了主窗口已有的导航功能，同时从新窗口移除了侧栏与设置。Session 导出还假定浏览器 HTTP 能访问虚拟 Host URL，但 Desktop 仅通过 MessagePort 暴露 Host。因此，导出按钮会在下载开始前失败。

## 决策

DSH Desktop 使用一个应用窗口。标题栏提供新建任务；Session 链接与通知点击会在主窗口选择对应 Session。主进程保留 Client 订阅前收到的导航，并在就绪后投递，包括重新加载期间的导航。Session 选择使用普通的持久化 Client 存储。任务窗口构造函数、preload 操作、本地化操作文案与专注布局分支均不存在。

导出控制器在 Client 激活时选择已安装载体。Web 保留 HEAD 预检与原生 HTTP 下载。内部载体通过 GET 获取现有 Host ZIP 路由，Chromium 使用本地 Blob URL 保存这些字节。控制器在下载操作后释放该 URL，在弹窗中报告请求或归档读取错误，并在释放后禁止保存。

[Desktop 架构决策](../architecture/2026-09-03-windows-desktop-client.zh.md)保留 Host 所有权与沙箱机制。[Web 导出决策](../feature/2026-08-10-web-session-log-export.zh.md)保留 Host ZIP 生成、按 Session 分隔的归档条目与精确 Fetch 路由；其中直接 URL 投递适用于 Web。这两个决策均未被完全取代。

## 考虑过的替代方案

**只隐藏标题栏按钮。** 深链与通知点击仍会创建独立窗口，保留额外的布局、选择与生命周期路径。所有 Session 导航改为共享主窗口。重新引入独立窗口前，需要证明存在必须同时查看多个会话的工作流。

**通过 MessagePort 请求，但下载虚拟 URL。** 预检成功不会让 Chromium 能够访问该 URL。归档字节必须先经过同一载体，才能开始本地下载。

**添加 Desktop HTTP listener 或在 Client 生成 ZIP。** listener 会改变私有 Host 架构，Client 压缩则会重复归档实现并传输未压缩日志。现有 Host 路由与载体已经能够传递所需字节。

## 影响

用户在主窗口切换 Session，不能同时打开独立 Session 窗口。Desktop 在保存前于 Host 载体与 Renderer 中缓冲压缩归档，因此内存占用随 ZIP 大小增长。Web 保留流式下载。Renderer 仍处于沙箱内，模型历史与 Session 格式不变。

录制式 Desktop 快照使用的 Electron 驱动会下载并解压真实归档，验证录制的提示词、回复与工具结果内容，检查窗口操作已移除，并覆盖真实第二实例链接、重新加载期间的导航与通知选择。控制器测试覆盖载体选择、归档失败、Blob URL 清理与读取期间的释放。
