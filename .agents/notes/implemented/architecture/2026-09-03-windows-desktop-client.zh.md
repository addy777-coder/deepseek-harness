# Agent Note: Windows Desktop client with a private Host transport

Status: implemented

[English](2026-09-03-windows-desktop-client.md) | 中文

## 问题

交互式 GUI 原本假定存在 HTTP server、浏览器导航、cookie 与单个浏览器窗口。Windows 桌面应用需要原生窗口、托盘与协议集成、专注 Session 窗口、通知和本地插件管理，同时不能给 Renderer Node 权限，也不能暴露 loopback 端口。重写对话 UI 会拆分产品行为；把 Host 放进 Electron 主进程则会让模型请求和凭据与操作系统集成处于同一进程。

## 决策

DSH Desktop 是位于 `apps/desktop` 的 Windows x64 Electron 应用。Electron 44.1.1 提供 Node 24.19，electron-builder 26.15.3 生成当前用户 NSIS 安装器与 portable zip，打包应用携带 pnpm 11.7.0 来执行 profile 插件 transaction。应用使用独立 DSH Desktop 名称与字母标记。

[打包过滤规则](../../../../apps/desktop/electron-builder.yml) 从 runtime closure 与 pnpm 中排除类型声明、源映射、编译器状态、调试符号，以及测试／示例／基准测试／GitHub 工作流目录。运行 JavaScript、原生依赖、包元数据和许可证保留为普通文件。这减少了 Windows 安装器逐文件解压与删除的工作量，同时不把子进程可执行文件或 profile 依赖目标移入归档。

### 共享 GUI 与载体层

交互式 profile 组合包含三个有序层。`dsh-base` 拥有 agent 核心，`dsh-gui-app` 拥有共享 Host controller 与完整 Client 名录，一个载体 bundle 拥有物理投递。`web` profile 选择 `dsh-web-app`，`desktop` profile 选择 `dsh-desktop-app`。Connection 拥有与传输无关的 RPC、精确 Fetch route 与逻辑 channel。Client Modules 拥有 `ClientBootRegistry`、模块图与不可变 bundle 产物；Web 适配器把它们渲染进 HTML 与 `/plugins`，Desktop 则通过 IPC 返回。

Desktop profile 使用 `patchReload: startup`。Desktop 插件变化会重启 Host，因此实时 HMR watcher 会增加不兼容的第二套替换生命周期，并要求打包 Utility Process 提供 Node loader internals。

### 进程与安全职责

Electron 主进程拥有窗口、托盘、快捷键、协议路由、通知、原生确认与 Host 生命周期。它只通过真实 `dsh --profile desktop` CLI 路径启动一个 Utility Process。每个沙箱化 Renderer 使用 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false` 与 `webSecurity: true`；preload 暴露固定 Desktop 操作，并转交一条专用 MessagePort。主进程不代理或检查模型请求、附件 body 或 API key。

版本 1 Desktop 协议校验精确帧字段与有界品牌化 request/window id。它承载启动注入表、Connection Fetch request 与 response、模块产物、拉取驱动的 API Gateway stream、abort、attach 与 shutdown。一条 `stream-pull` 最多推进一个 item，释放时会中止工作并等待迭代器清理。Electron MessagePortMain 的 transfer list 接受 MessagePort，但不接受 ArrayBuffer；二进制 body 因此双向使用结构化克隆，不声称零拷贝投递。

Renderer 导航与弹窗创建都会被拒绝。HTTP 与 HTTPS 目标交给系统浏览器打开。Client Loader 仍需要 CSP `unsafe-eval` 来物化动态投递的 Cordis 插件 factory；Desktop 页面策略不允许网络连接。

### Windows 生命周期

一个主窗口保留导航与设置。一个 Session 最多拥有一个专注任务窗口，后者隐藏侧栏与设置；关闭它会让 Host 任务继续运行。Host 启动有 120 秒 ready 预算，其中包含冷 profile reconciliation 与 Loader 完全加载；超时诊断会指出最后上报的阶段，并包含有界 Host stderr 尾部。关闭主窗口或选择托盘退出会销毁全部窗口、请求 Host 停止、等待最多五秒，再终止剩余进程树。Host 意外退出时，窗口会保留诊断页，直到用户请求重启；工作绝不会自动重放。

主窗口会恢复可见 bounds 与共享 Client 选择。任务窗口不持久化。`dsh://new` 与 `dsh://session/<base64url-session-id>` 不接受 query、fragment、提示词或路径数据。已安装构建可以拥有协议与登录后启动注册；portable 构建不能。任一聚焦窗口显示受影响 Session 时，完成通知会被抑制。

Electron Utility Process 的 `process.execPath` 指向 `electron.exe`。内部 Windows ACL 与原生对话框 Node helper 因此只在其 runner 环境中接收 `ELECTRON_RUN_AS_NODE=1`。ACL runner 会在启动用户命令前删除它，所以 Electron Node mode 绝不会泄漏进 agent shell 环境。

### Profile 插件 transaction

插件设置页接受一个 pnpm package spec，并把它放在 `--` 之后；它不接受 package-manager flag。解析在私有临时 profile 中以 `--ignore-scripts` 进行。manager 比较旧版与候选依赖 closure，并拒绝每个声明 `preinstall`、`install`、`postinstall` 或 `prepare` 的新增或变化包。它会校验 bundle patch 路径，以及 inserted row 引用的 Client 声明与已构建导出，再显示解析版本、integrity 或 commit 与校验状态。

应用操作要求原生警告，因为运行时插件代码拥有 Host 的本机权限。manager 会为 profile 自有文件计算 fingerprint、停止 Host、在同一卷上重命名旧版与候选 profile 目录，再启动候选。ready 失败会恢复备份、重新启动旧 Host 并重载全部窗口。取消、解析失败、脚本拒绝、陈旧 transaction 检测与校验失败都不会改变 live profile。CLI 与 Desktop 使用同一个纯 bundle reconciliation 函数。

### 验证

单元覆盖拥有帧校验、关联、abort、stream 背压、深链、bounds、快捷键冲突、插件脚本拒绝、Client row 校验、陈旧 transaction、profile 替换与回滚。真实 Electron 场景使用私有 Harness home、user-data 与工作区根；它证明 Host 没有 TCP listener，并覆盖一元与流式 IPC、模型与 PowerShell 工具回合、审批、图片附件、主／任务同步、通知抑制与点击路由、第二实例深链去重、真实本地插件安装、启动失败回滚、Host 手动恢复与静止退出。Windows snapshot 适配器通过同一 Electron 与 MessagePort 路径回放已提交 PowerShell Session。Pull Request 的 Windows CI 会构建打包布局、运行该 Electron 场景，并在 Electron Node ABI 下加载 node-pty、Koffi 与 Sharp；可信 real-API 工作流会运行其简短的 DeepSeek live 模式。

## 已考虑的替代方案

**携带完整 npm 包内容。** 类型声明和调试产物有助于开发，但会使安装和升级增加数千次文件系统操作。Desktop 安装器只携带运行所需内容；源码 workspace 和包 staging 树保留开发文件。

**Desktop 使用 loopback HTTP。** 这可以直接复用 Web routing，但会保留端口分配、Host/Origin 与 cookie 状态，以及自有本地窗口不需要的网络可达攻击面。

**在 Electron 主进程中运行 Host。** 这会减少一个进程，但会让操作系统权限读取模型 payload 与凭据，并使 Host 故障在没有诊断外壳的情况下带走全部窗口。

**构建独立 Desktop 对话 UI。** 这可以只针对一个外壳优化，但会复制 Session、审批、附件、终端、设置与插件生态，并让 Web 与 Desktop 行为发生漂移。

**保留实时 patch HMR。** 实时 HMR 对浏览器开发 server 有用，但 Desktop 插件替换已经要求 Host 重启与原子 profile transaction。同时运行两套生命周期会增加打包 Node loader 要求与回滚复杂度。

**允许依赖安装脚本。** 这会接纳更多 npm 包，但预览无法安全解释或撤销任意脚本副作用。首版会在批准前拒绝这些 closure。

## 后果

应用与 Web 共享用户数据和 GUI 行为，同时让 Renderer 保持沙箱化，并让主进程远离模型流量。与载体无关的 registry 使未来本地载体无需再次分叉 API 或 UI。代价是大型且仅 Windows 的 Electron 产物、仅启动时应用的 Desktop patch、结构化克隆二进制 body、动态 loader 的 CSP 例外，以及拒绝依赖安装脚本的插件。代码签名、自动更新、远端 Host、账号登录与非 Windows 包仍不属于首版。
