const { spawn } = require('node:child_process');
const path = require('node:path');
const worker = path.resolve('packages/host/directory-picker-native/lib/worker.cjs');
const child = spawn(process.execPath, [worker], {
  env: { ...process.env, DSH_DIALOG_TITLE: 'Probe' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  windowsHide: true,
});
let sawShowing = false;
child.on('message', (m) => {
  console.log('MESSAGE:', JSON.stringify(m));
  if (m && m.kind === 'showing') { sawShowing = true; }
  if (m && (m.kind === 'done' || m.kind === 'error')) { console.log('terminal post received, closing via WM_CLOSE simulation not available; will wait then kill'); }
});
child.on('error', (e) => console.log('CHILD ERROR:', e.message));
child.on('exit', (code, sig) => console.log('EXIT code=' + code + ' sig=' + sig + (sawShowing ? ' (showing seen)' : ' (no showing seen)')));
setTimeout(() => {
  if (!child.exitCode && !child.killed) {
    console.log('worker still alive after 8s -> likely blocked in Show() with the dialog open');
    child.kill();
  }
}, 8000);
