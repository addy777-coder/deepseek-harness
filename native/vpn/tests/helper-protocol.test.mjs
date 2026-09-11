/** Offline helper protocol tests. Remote traffic is restricted to an owned loopback listener. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rootCertificates } from 'node:tls';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const platform = process.platform === 'win32' ? 'windows' : process.platform;
const binary = process.argv[2] ?? join(root, 'build', `${platform}-${process.arch}`, process.platform === 'win32' ? 'dsh-vpn.exe' : 'dsh-vpn');
if (process.argv.length > 3) throw new Error('Usage: node helper-protocol.test.mjs [executable]');
const active = new Set();
const canary = `protocol-canary-${randomUUID()}`;
const fakeUsername = `${canary}-username`;
const fakePassword = `${canary}-password`;
const fakeProxyToken = `${canary}-proxy-token`;
const outputLimit = 1024 * 1024;
const guardMs = 20000;
let scratch;
let checks = 0;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((accept, reject) => {
    resolvePromise = accept;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description}: deadline exceeded`)), guardMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function launch(stdin = 'pipe') {
  const child = spawn(binary, [], { stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
  const completion = deferred();
  const record = { child, stdout: '', stderr: '', overflow: false, completion: completion.promise };
  active.add(record);
  child.once('error', () => completion.reject(new Error('Helper process could not start')));
  child.once('close', (code, signal) => {
    active.delete(record);
    completion.resolve({ code, signal });
  });
  for (const channel of ['stdout', 'stderr']) {
    child[channel].setEncoding('utf8');
    child[channel].on('data', (chunk) => {
      if (record[channel].length + chunk.length > outputLimit) {
        record.overflow = true;
        child.kill();
      } else {
        record[channel] += chunk;
      }
    });
  }
  if (child.stdin) {
    // Early bootstrap rejection can close the pipe before the test finishes its
    // oversized write. Child completion determines the outcome in that case.
    child.stdin.on('error', () => {});
  }
  return record;
}

function events(record) {
  require(!record.overflow, 'Helper output exceeded the test capture bound');
  require(!record.stdout.includes(canary) && !record.stderr.includes(canary),
    'Helper output exposed bootstrap input');
  require(record.stderr === '', 'Helper wrote unexpected stderr output');
  let parsed;
  try {
    parsed = record.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    throw new Error('Helper emitted malformed JSON events');
  }
  for (const event of parsed) {
    require(event && typeof event === 'object' && typeof event.event === 'string',
      'Helper event has invalid fields');
    const allowed = event.event === 'profile-evaluated'
      ? ['event', 'error', 'accepted', 'requiresUserPassword', 'requiresChallenge',
        'requiresPrivateKeyPassword', 'requiresExternalPki', 'externalReferenceCount']
      : ['event', 'error'];
    require(Object.keys(event).every((key) => allowed.includes(key)),
      'Helper event included an unexpected data field');
    require(typeof event.error === 'boolean', 'Helper status must declare whether it is an error');
  }
  return parsed;
}

async function completed(record, expectedCode, description) {
  const exit = await bounded(record.completion, description);
  require(exit.signal === null, `${description}: helper was terminated by a signal`);
  require(exit.code === expectedCode, `${description}: unexpected exit code`);
  return events(record);
}

async function rejectBootstrap(input, expectedEvent, description, stdin = 'pipe') {
  const record = launch(stdin);
  if (record.child.stdin) record.child.stdin.end(input);
  const output = await completed(record, 2, description);
  require(output.at(-1)?.event === expectedEvent, `${description}: wrong rejection event`);
  require(output.at(-1)?.error === true, `${description}: rejection must be marked as an error`);
  ++checks;
}

async function evaluate(profile, description) {
  const record = launch();
  record.child.stdin.end(JSON.stringify({ profileContent: profile, evaluateOnly: true,
    ignoredCanary: canary }) + '\n');
  const output = await completed(record, 0, description);
  require(output.length === 1 && output[0].event === 'profile-evaluated' && output[0].accepted,
    `${description}: profile was not accepted in evaluateOnly mode`);
  ++checks;
}

async function evaluateFifo(profile) {
  // Windows has no POSIX FIFO; the ordinary child stdio case covers named pipes there.
  if (process.platform === 'win32') return;
  const path = join(scratch, 'bootstrap.fifo');
  await command('mkfifo', [path]);
  const pipe = await open(path, constants.O_RDWR);
  try {
    const record = launch(pipe.fd);
    await pipe.write(JSON.stringify({ profileContent: profile, evaluateOnly: true }) + '\n');
    const output = await completed(record, 0, 'FIFO bootstrap');
    require(output.length === 1 && output[0].event === 'profile-evaluated' && output[0].accepted,
      'FIFO bootstrap: profile was not accepted');
    ++checks;
  } finally { await pipe.close(); }
}

async function listener() {
  const server = createServer();
  const connections = new Set();
  const transportReady = deferred();
  let acceptedConnections = 0;
  server.on('connection', (socket) => {
    ++acceptedConnections;
    const closed = deferred();
    const peer = { socket, closed: closed.promise };
    connections.add(peer);
    socket.once('close', () => { connections.delete(peer); closed.resolve(); });
    socket.on('error', () => {});
    socket.once('data', (bytes) => {
      if (bytes.length) transportReady.resolve(peer);
    });
  });
  await bounded(new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, accept);
  }), 'Loopback listener startup');
  const address = server.address();
  require(address && typeof address !== 'string', 'Loopback listener has no assigned port');
  return {
    port: address.port,
    get acceptedConnections() { return acceptedConnections; },
    transportReady: transportReady.promise,
    async dispose() {
      for (const peer of connections) peer.socket.destroy();
      await bounded(new Promise((accept, reject) => server.close((error) => error ? reject(error) : accept())),
        'Loopback listener shutdown');
    },
  };
}

function bootstrap(profile) {
  return {
    profileContent: profile,
    username: fakeUsername,
    password: fakePassword,
    proxyToken: fakeProxyToken,
    targets: [{ host: 'model.invalid', port: 443 }],
    connectTimeoutSeconds: 30,
    maxConnections: 16,
    headerTimeoutMs: 5000,
    targetConnectTimeoutMs: 30000,
    pollIntervalMs: 10,
    maxPendingPacketBytes: 1048576,
  };
}

async function lifecycle(profile, endpoint, mode) {
  const record = launch();
  const input = bootstrap(profile);
  if (mode === 'control-bytes') input.targets = [];
  record.child.stdin.write(JSON.stringify(input) + '\n');
  const peer = await bounded(Promise.race([
    endpoint.transportReady,
    record.completion.then(() => { throw new Error(`${mode}: helper exited before transport readiness`); }),
  ]), `${mode}: loopback transport readiness`);
  if (mode === 'stdin-eof') record.child.stdin.end();
  else record.child.stdin.write('shutdown\n');
  const output = await completed(record, 0, mode);
  require(output.some((event) => event.event === 'profile-evaluated' && event.accepted),
    `${mode}: helper did not accept the synthetic profile`);
  require(output.at(-1)?.event === 'stopped', `${mode}: helper did not report orderly stop`);
  await bounded(peer.closed, `${mode}: peer socket closure`);
  require(record.child.exitCode === 0, `${mode}: helper process remains active`);
  ++checks;
}

async function command(commandName, args) {
  const child = spawn(commandName, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let failed = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', () => { failed = true; });
  const result = new Promise((accept, reject) => {
    child.once('error', () => reject(new Error('Read-only network snapshot command failed')));
    child.once('close', (code, signal) => {
      if (code === 0 && signal === null && !failed) accept(stdout.trim());
      else reject(new Error('Read-only network snapshot command failed'));
    });
  });
  try {
    return await bounded(result, 'Read-only network snapshot');
  } catch (error) {
    child.kill();
    await result.catch(() => {});
    throw error;
  }
}

async function snapshotNetwork() {
  const output = await command('pwsh', ['-NoProfile', '-NonInteractive', '-File', join(root, 'tests', 'network-snapshot.ps1'), '-AsJson']);
  return JSON.parse(output).network;
}

function syntheticProfile(port) {
  require(rootCertificates.length > 0, 'Node has no bundled public CA certificate for the fixture');
  return `# ${canary}\nclient\ndev tun\nproto tcp-client\nremote 127.0.0.1 ${port}\nnobind\nauth-user-pass\nremote-cert-tls server\ndata-ciphers AES-256-GCM:AES-128-GCM\nauth SHA256\nverb 0\n<ca>\n${rootCertificates[0]}\n</ca>\n`;
}

try {
  require(['windows-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'].includes(`${platform}-${process.arch}`), 'Unsupported helper test target');
  await access(binary);
  scratch = await mkdtemp(join(tmpdir(), 'dsh-vpn-protocol-'));
  const before = await snapshotNetwork();
  const endpoint = await listener();
  let profile;
  try {
    profile = syntheticProfile(endpoint.port);
    await rejectBootstrap('', 'BOOTSTRAP_REQUIRES_PARENT_PIPE', 'Ignored stdin', 'ignore');
    const regularInput = join(scratch, 'bootstrap.json');
    await writeFile(regularInput, JSON.stringify({ ignoredCanary: canary }), { flag: 'wx' });
    const file = await open(regularInput, 'r');
    try {
      await rejectBootstrap('', 'BOOTSTRAP_REQUIRES_PARENT_PIPE', 'Regular-file stdin', file.fd);
    } finally {
      await file.close();
    }
    await rejectBootstrap(`{"secret":"${canary}"`, 'INVALID_BOOTSTRAP', 'Malformed JSON');
    await rejectBootstrap(JSON.stringify([canary]) + '\n', 'INVALID_BOOTSTRAP', 'Non-object JSON');
    await rejectBootstrap(`{"profileContent":"${canary}","profileContent":"${canary}"}\n`,
      'INVALID_BOOTSTRAP', 'Duplicate JSON fields');
    await rejectBootstrap(`{"secret":"${canary}"}{}\n`, 'INVALID_BOOTSTRAP', 'Trailing JSON value');
    await rejectBootstrap(canary + 'x'.repeat(1048577) + '\n', 'BOOTSTRAP_TOO_LARGE', 'Oversized bootstrap');
    await rejectBootstrap('{}\n', 'INVALID_BOOTSTRAP', 'Missing profile content');
    await rejectBootstrap(JSON.stringify({ profileContent: `client\nca ${canary}.crt\n` }) + '\n',
      'PROFILE_IMPORT_FAILED', 'External profile file reference');
    for (const field of ['proxyToken', 'username', 'password']) {
      const input = bootstrap(profile);
      delete input[field];
      await rejectBootstrap(JSON.stringify(input) + '\n', 'INVALID_BOOTSTRAP', `Missing ${field}`);
    }
    const missingTargets = bootstrap(profile);
    delete missingTargets.targets;
    await rejectBootstrap(JSON.stringify(missingTargets) + '\n', 'INVALID_TARGETS', 'Missing targets');
    for (const field of ['connectTimeoutSeconds', 'maxConnections', 'headerTimeoutMs',
      'targetConnectTimeoutMs', 'pollIntervalMs', 'maxPendingPacketBytes']) {
      const input = bootstrap(profile);
      delete input[field];
      await rejectBootstrap(JSON.stringify(input) + '\n', 'INVALID_RUNTIME_CONFIG', `Missing ${field}`);
      input[field] = -1;
      await rejectBootstrap(JSON.stringify(input) + '\n', 'INVALID_RUNTIME_CONFIG', `Invalid ${field}`);
    }
    const duplicateTarget = bootstrap(profile);
    duplicateTarget.targets.push({ host: 'MODEL.INVALID', port: 443 });
    await rejectBootstrap(JSON.stringify(duplicateTarget) + '\n', 'DUPLICATE_TARGET', 'Duplicate target');
    const invalidHost = { ...bootstrap(profile), targets: [{ host: 'https://model.invalid', port: 443 }] };
    await rejectBootstrap(JSON.stringify(invalidHost) + '\n', 'INVALID_TARGET_HOST', 'Invalid host');
    const invalidPort = { ...bootstrap(profile), targets: [{ host: 'model.invalid', port: 65536 }] };
    await rejectBootstrap(JSON.stringify(invalidPort) + '\n', 'INVALID_RUNTIME_CONFIG', 'Invalid target port');
    const embeddedNul = { ...bootstrap(profile), username: `${fakeUsername}\u0000suffix` };
    await rejectBootstrap(JSON.stringify(embeddedNul) + '\n', 'INVALID_BOOTSTRAP', 'Embedded NUL');
    const invalidTimeout = { ...bootstrap(profile), connectTimeoutSeconds: 0 };
    await rejectBootstrap(JSON.stringify(invalidTimeout) + '\n', 'INVALID_RUNTIME_CONFIG', 'Invalid timeout');
    await evaluate(profile, 'Synthetic profile evaluation');
    await evaluateFifo(profile);
    require(endpoint.acceptedConnections === 0, 'Bootstrap validation or evaluateOnly started a connection');
    ++checks;
    await lifecycle(profile, endpoint, 'stdin-eof');
  } finally {
    await endpoint.dispose();
  }
  const secondEndpoint = await listener();
  try {
    const secondProfile = syntheticProfile(secondEndpoint.port);
    await lifecycle(secondProfile, secondEndpoint, 'control-bytes');
  } finally {
    await secondEndpoint.dispose();
  }
  require(active.size === 0, 'A helper process remains active after the tests');
  const after = await snapshotNetwork();
  require(before === after, 'System routes, DNS, or interfaces changed');
  ++checks;
  console.log(`PASS ${checks} offline helper protocol checks: bootstrap validation/redaction, profile evaluation, stdin lifecycle, peer socket closure, unchanged system routes/DNS/interfaces, no remaining helper`);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : 'offline helper protocol test failed'}`);
  process.exitCode = 1;
} finally {
  for (const record of active) record.child.kill();
  await Promise.allSettled([...active].map((record) => record.completion));
  if (scratch) {
    const resolvedScratch = resolve(scratch);
    require(dirname(resolvedScratch) === resolve(tmpdir()) && basename(resolvedScratch).startsWith('dsh-vpn-protocol-'),
      'Temporary cleanup path is outside the test-owned directory');
    await rm(resolvedScratch, { recursive: true, force: true });
  }
}
