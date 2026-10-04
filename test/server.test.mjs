import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 本物のサーバーを子プロセスで起動し、MCP で 4 つのツールが見えるかを確かめる。
// ツールは呼ばない (呼ぶと Discord へ通信するため)。トークンは偽物
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('起動すると 4 つのツールが見え、消す・編集する操作は無い', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(ROOT, 'src/server.mjs')],
    env: { DISCORD_MAINT_TOKEN: 'fake', DISCORD_GUILD_ID: '100', DISCORD_MAINT_CHANNELS: 'kt', PATH: process.env.PATH ?? '' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, ['list_channels', 'list_threads', 'post_message', 'read_messages']);
  assert.ok(!names.some((n) => /delete|edit|remove|ban|kick|manage/i.test(n)));
  const post = tools.find((x) => x.name === 'post_message');
  assert.equal(post.annotations?.destructiveHint, false);
});

test('設定が足りなければ起動しない', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [resolve(ROOT, 'src/server.mjs')], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /起動できません/);
});
