/**
 * `command` namespace dictionaries: the popupSelect shell's copy plus the
 * `description.*` rows for HOST command menu rows. Host commands ship their
 * descriptions from the wire; the menu renders their localized row through
 * these keys, falling back to the wire text when a name is unknown.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'search.placeholder': '搜索…',
  'search.aria': '筛选选项',
  'status.loading': '正在加载选项…',
  'status.applying': '正在应用…',
  'status.empty': '无选项',
  'overlay.aria': '/{command} 选项',
  'listbox.aria': '/{command} 匹配项',
  'notice.imagesUnsupported': '/{command} 不接受图片附件，请先移除图片',
  'description.compact': '压缩较早的对话内容',
  'description.export': '将会话日志打包为 ZIP 压缩包下载',
  'description.feedback': '记录对本会话的反馈',
  'description.goal': '设置或查看长任务的进行目标',
  'description.permission': '切换权限预设（沙箱模式 + 审批策略）',
  'description.plan': '进入或离开计划模式',
} satisfies Record<string, string>

/** The command namespace key union. */
export type CommandKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'search.placeholder': 'Search…',
  'search.aria': 'Filter options',
  'status.loading': 'Loading options…',
  'status.applying': 'Applying…',
  'status.empty': 'No options',
  'overlay.aria': '/{command} options',
  'listbox.aria': '/{command} matches',
  'notice.imagesUnsupported': '/{command} does not accept image attachments; remove them first',
  'description.compact': 'Compact older conversation history',
  'description.export': 'Download this Session log as a ZIP archive',
  'description.feedback': 'record feedback about this session',
  'description.goal': 'set or view the goal for a long-running task',
  'description.permission': 'Switch the permission preset (sandbox mode + approval policy)',
  'description.plan': 'Enter or leave plan mode',
} satisfies Record<CommandKey, string>
