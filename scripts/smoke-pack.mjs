#!/usr/bin/env node
/**
 * Packaging smoke test: build the npm tarball exactly as it would be
 * published, install it into a clean project and exercise the installed
 * binaries (CLI, installer, MCP handshake over stdio).
 *
 *   npm run build && node scripts/smoke-pack.mjs
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const isWin = process.platform === 'win32';
const npm = (args, cwd) => {
  const r = spawnSync(isWin ? 'npm.cmd' : 'npm', args, { cwd, encoding: 'utf8', shell: isWin });
  if (r.status !== 0) throw new Error(`npm ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

const work = mkdtempSync(join(tmpdir(), 'sentinel-pack-'));
try {
  // 1. Pack and inspect the tarball contents.
  const [pack] = JSON.parse(npm(['pack', '--json', '--pack-destination', work], repo));
  const files = pack.files.map((f) => f.path);
  for (const required of ['dist/cli/index.js', 'dist/mcp/server.js', 'dist/index.js', 'dist/index.d.ts', 'SKILL.md', 'README.md', 'README.zh-TW.md', 'LICENSE', 'package.json']) {
    assert.ok(files.includes(required), `tarball is missing ${required}`);
  }
  for (const forbidden of ['src/', 'tests/', 'scripts/', '.github/', 'tsconfig.json']) {
    assert.ok(!files.some((f) => f.startsWith(forbidden)), `tarball must not ship ${forbidden}`);
  }
  console.log(`✔ tarball ${pack.filename}: ${files.length} files, ${(pack.size / 1024).toFixed(1)} kB`);

  // 2. Install into a clean consumer project.
  const consumer = join(work, 'consumer');
  spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(consumer)})`]);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }));
  npm(['install', '--no-audit', '--no-fund', join(work, pack.filename)], consumer);
  const cli = join(consumer, 'node_modules', 'agent-token-sentinel', 'dist', 'cli', 'index.js');
  const server = join(consumer, 'node_modules', 'agent-token-sentinel', 'dist', 'mcp', 'server.js');
  assert.ok(existsSync(cli) && existsSync(server));
  for (const bin of ['agent-token-sentinel', 'sentinel', 'sentinel-mcp']) {
    assert.ok(existsSync(join(consumer, 'node_modules', '.bin', isWin ? `${bin}.cmd` : bin)), `bin ${bin} not linked`);
  }
  console.log('✔ installed; bins linked: agent-token-sentinel, sentinel, sentinel-mcp');

  // 3. CLI works from the installed package.
  const help = spawnSync(process.execPath, [cli, 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /agent-token-sentinel v\d+\.\d+\.\d+/);
  const dry = spawnSync(process.execPath, [cli, 'install', '--claude', '--cursor', '--windsurf', '--dry-run', '--root', consumer], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /\.claude[\\/]settings\.json \(dry-run\)/);
  assert.match(dry.stdout, /\.cursor[\\/]hooks\.json \(dry-run\)/);
  assert.match(dry.stdout, /\.windsurf[\\/]hooks\.json \(dry-run\)/);
  const run = spawnSync(process.execPath, [cli, 'run', '--root', consumer, '--', 'node', '-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /passed/);
  console.log('✔ CLI: help, install --dry-run, run');

  // 4. MCP handshake over real stdio.
  const tools = await mcpListTools(server, consumer);
  for (const t of ['sentinel_guard_edit', 'sentinel_record_run', 'sentinel_check_circuit', 'sentinel_distill_log', 'sentinel_prune_file', 'sentinel_compact_history']) {
    assert.ok(tools.includes(t), `MCP tool ${t} missing`);
  }
  console.log(`✔ MCP stdio handshake: ${tools.length} tools`);
  console.log('\nPackage smoke test passed.');
} finally {
  rmSync(work, { recursive: true, force: true });
}

function mcpListTools(serverPath, root) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [serverPath, '--root', root], { stdio: ['pipe', 'pipe', 'inherit'] });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP server did not answer within 15s'));
    }, 15_000);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n').slice(0, -1)) {
        const msg = JSON.parse(line);
        if (msg.id === 2) {
          clearTimeout(timer);
          child.kill();
          resolvePromise(msg.result.tools.map((t) => t.name));
        }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });
}
