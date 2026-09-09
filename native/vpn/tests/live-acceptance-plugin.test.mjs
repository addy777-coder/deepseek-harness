/** Offline lifecycle verification for the opt-in Cordis acceptance action. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { apply } from './live-acceptance-plugin.ts';

async function fixture(modelExists = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-vpn-live-fixture-'));
  let ready;
  let connected = false;
  let connections = 0;
  const cleanups = [];
  const exit = Promise.withResolvers();
  const context = {
    get(name) {
      if (name === 'appReady') return { onReady(callback) { ready = callback; return () => { ready = undefined; }; } };
      if (name === 'appExit') return code => exit.resolve(code);
      throw new Error('Unexpected fixture host service');
    },
    effect(callback) { cleanups.push(callback()); },
    network: {
      async get() { return { connection: connected ? 'connected' : 'disconnected', passwordConfigured: true }; },
      async connect() { connections++; connected = true; },
      async disconnect() { connected = false; },
    },
    settings: { get() { return { providers: { gongsi: { network: 'vpn', api: 'anthropic-messages', baseURL: 'https://fixture.invalid' } } }; } },
    credentials: { async describeRecord() { return { configured: true }; } },
    llm: {
      async listModels() { return modelExists ? [{ id: 'fixture-model' }] : []; },
      async discoverModels() { return [{ id: 'fixture-model' }]; },
      async *stream(options) {
        const toolResult = options.messages.some(message => message.source.kind === 'tool');
        if (options.tools && !toolResult) {
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-call', name: 'vpn_echo',
            arguments: '{"value":"vpn-tool-roundtrip"}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        const long = options.messages[0].content[0].text.startsWith('Write 200');
        const text = toolResult ? 'vpn-tool-roundtrip' : long ? 'x'.repeat(2048) + 'VPN_LONG_DONE' : 'VPN_NATIVE_OK';
        yield { type: 'text-delta', index: 0, text: text.slice(0, 5) };
        if (options.signal.aborted) {
          yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Fixture cancellation' } } };
          return;
        }
        yield { type: 'text-delta', index: 0, text: text.slice(5) };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    subprocess: {
      spawn() {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const done = Promise.withResolvers();
        queueMicrotask(() => {
          stdout.end(JSON.stringify({ network: 'unchanged-fixture-network', externalOpenvpnActive: false, helperCount: connected ? 1 : 0 }));
          stderr.end();
          done.resolve({ exitCode: 0, signal: null });
        });
        return { stdout, stderr, done: done.promise, terminate() {} };
      },
    },
  };
  const config = { provider: 'gongsi', model: 'fixture-model', requestTimeoutMs: 1000, maxTokens: 1024,
    minimumLongResponseChars: 1024, checkDiscovery: true, connectionTimeoutMs: 1000,
    snapshotTimeoutMs: 1000, shutdownGraceMs: 100, reportPath: join(directory, 'report.json') };
  apply(context, config);
  return {
    get connections() { return connections; },
    get connected() { return connected; },
    start() { assert.ok(ready); ready(); },
    async result() {
      let timer;
      try {
        const code = await Promise.race([exit.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Fixture exit timed out')), 5000); })]);
        const bytes = await readFile(config.reportPath, 'utf8');
        assert.ok(!bytes.includes('fixture.invalid') && !bytes.includes('vpn-tool-roundtrip'));
        return { code, report: JSON.parse(bytes) };
      } finally { clearTimeout(timer); }
    },
    async dispose() {
      for (const cleanup of cleanups.reverse()) await cleanup?.();
      const path = resolve(directory);
      assert.equal(dirname(path), resolve(tmpdir()));
      assert.ok(basename(path).startsWith('dsh-vpn-live-fixture-'));
      await rm(path, { recursive: true, force: true });
    },
  };
}

test('live action waits for appReady, exercises the provider path, closes its tunnel and reports counters', async () => {
  const app = await fixture();
  try {
    assert.equal(app.connections, 0);
    app.start();
    const { code, report } = await app.result();
    assert.equal(code, 0);
    assert.equal(report.passed, true);
    assert.equal(report.networkUnchanged, true);
    assert.equal(report.ownedHelperExited, true);
    assert.equal(report.checks.cancellation, 'passed');
    assert.equal(report.checks.toolCalls, 1);
    assert.equal(report.checks.discovery, 'passed');
    assert.equal(app.connected, false);
  } finally { await app.dispose(); }
});

test('an unsaved model produces a redacted failure report without connecting', async () => {
  const app = await fixture(false);
  try {
    app.start();
    const { code, report } = await app.result();
    assert.equal(code, 1);
    assert.equal(report.failureCode, 'VPN_LIVE_SAVED_MODEL_MISSING');
    assert.equal(report.passed, false);
    assert.equal(app.connections, 0);
    assert.equal(app.connected, false);
  } finally { await app.dispose(); }
});
