/** Fixed Electron IPC channel names; no generic dispatch channel is exposed. */
export const channels = {
  bootstrap: 'dsh-desktop/bootstrap',
  hostPort: 'dsh-desktop/host-port',
  hostFailure: 'dsh-desktop/host-failure',
  intent: 'dsh-desktop/intent',
  newTask: 'dsh-desktop/new-task',
  notify: 'dsh-desktop/notify',
  openMain: 'dsh-desktop/open-main',
  openSession: 'dsh-desktop/open-session',
  pluginApply: 'dsh-desktop/plugin-apply',
  pluginCancel: 'dsh-desktop/plugin-cancel',
  pluginList: 'dsh-desktop/plugin-list',
  pluginStage: 'dsh-desktop/plugin-stage',
  preferencesGet: 'dsh-desktop/preferences-get',
  preferencesSet: 'dsh-desktop/preferences-set',
  reportSelection: 'dsh-desktop/report-selection',
  restartHost: 'dsh-desktop/restart-host',
} as const
