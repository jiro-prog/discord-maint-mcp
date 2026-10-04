import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDiscordClient } from '../src/discord.mjs';
import { DEFAULT_MAX_FILE_BYTES, checkPost, parseSettings, redact } from '../src/policy.mjs';
import { ToolError, createTools } from '../src/tools.mjs';

const TOKEN = 'secret-token-xyz';

function settings(patch = {}) {
  const s = parseSettings({
    DISCORD_MAINT_TOKEN: TOKEN,
    DISCORD_GUILD_ID: '100',
    DISCORD_MAINT_CHANNELS: 'kt, maint',
    DISCORD_MAINT_LOG: 'C:/logs/actions.jsonl',
    DISCORD_MAINT_UPLOAD_ROOTS: 'C:/tmp',
  });
  return { ...s, ...patch };
}

/** 偽の Discord: チャンネル 3 つ (kt と maint は許可、secret は不許可)、kt の中にスレッド 1 本 */
function fakeDiscord() {
  const calls = [];
  const channels = {
    1: { id: '1', name: 'kt', type: 0, position: 1 },
    2: { id: '2', name: 'maint', type: 0, position: 0 },
    3: { id: '3', name: 'secret', type: 0, position: 2 },
    9: { id: '9', name: 'voice', type: 2, position: 3 },
    11: { id: '11', name: '依頼', type: 11, parent_id: '1' },
    33: { id: '33', name: '秘密の話', type: 11, parent_id: '3' },
  };
  return {
    calls,
    guildChannels: async () => Object.values(channels).filter((c) => c.type !== 11),
    channel: async (id) => {
      if (!channels[id]) throw new Error('404');
      return channels[id];
    },
    activeThreads: async () => ({ threads: [channels[11], channels[33]] }),
    messages: async (id, limit) => {
      calls.push(['messages', id, limit]);
      return [
        { id: 'm2', timestamp: 't2', author: { id: 'O', username: 'Opus', bot: true }, content: '返事', attachments: [] },
        { id: 'm1', timestamp: 't1', author: { id: 'U', username: 'so' }, content: '依頼', attachments: [{ filename: 'a.png', size: 5, url: 'u' }] },
      ];
    },
    postMessage: async (id, payload) => {
      calls.push(['post', id, payload]);
      return { id: 'p1' };
    },
  };
}

/** files: 実在するファイルと大きさ。links: リンク (ジャンクション) の張り先 */
function fakeFs(files = {}, links = {}) {
  const logs = [];
  return {
    logs,
    realpathSync: (p) => {
      if (p in links) return links[p];
      if (p in files || p === 'C:/tmp') return p;
      throw new Error('ENOENT');
    },
    statSync: (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return { size: files[p], isFile: () => true };
    },
    readFileSync: (p) => new Uint8Array(files[p]),
    appendFileSync: (_p, line) => logs.push(JSON.parse(line)),
    mkdirSync: () => {},
  };
}

function setup({ files = {}, links = {}, s = settings() } = {}) {
  const discord = fakeDiscord();
  const fs = fakeFs(files, links);
  const tools = createTools({ settings: s, discord, fs, now: () => '2026-10-03T00:00:00Z' });
  return { discord, fs, tools };
}

test('設定: トークン・サーバー ID・許可チャンネルが無ければ起動しない (全部許可はできない)', () => {
  const s = parseSettings({});
  assert.equal(s.errors.length, 3);
  assert.ok(s.errors.some((e) => e.includes('DISCORD_MAINT_CHANNELS')));
  assert.deepEqual(settings().channels, ['kt', 'maint']);
  assert.equal(settings().maxFileBytes, DEFAULT_MAX_FILE_BYTES);
  assert.ok(parseSettings({ DISCORD_MAINT_TOKEN: 'x', DISCORD_GUILD_ID: '1', DISCORD_MAINT_CHANNELS: 'a', DISCORD_MAINT_MAX_FILE_MB: '-1' })
    .errors.some((e) => e.includes('MAX_FILE_MB')));
});

test('チャンネル一覧は許可の有無を付けて返す (ボイスは出さない)', async () => {
  const { tools } = setup();
  assert.deepEqual(await tools.listChannels(), [
    { name: 'maint', allowed: true },
    { name: 'kt', allowed: true },
    { name: 'secret', allowed: false },
  ]);
});

test('読む: 許可したチャンネルとその中のスレッドだけ、古い順に返す', async () => {
  const { tools, discord } = setup();
  const r = await tools.readMessages({ channel: 'kt', limit: 999 });
  assert.deepEqual(r.messages.map((m) => m.id), ['m1', 'm2']);
  assert.equal(discord.calls[0][2], 50, '件数の上限で切っていない');
  assert.deepEqual(r.messages[0].attachments, [{ name: 'a.png', bytes: 5, url: 'u' }]);
  const t = await tools.readMessages({ thread_id: '11' });
  assert.equal(t.target.kind, 'thread');
  assert.equal(t.target.parent, 'kt');
});

test('読む・書く: 許可していないチャンネルと、その中のスレッドは拒否する', async () => {
  const { tools, discord } = setup();
  await assert.rejects(tools.readMessages({ channel: 'secret' }), ToolError);
  await assert.rejects(tools.readMessages({ thread_id: '33' }), /許可されていません/);
  await assert.rejects(tools.postMessage({ channel: 'secret', content: 'x' }), ToolError);
  await assert.rejects(tools.postMessage({ thread_id: '1', content: 'x' }), /スレッドではありません/);
  await assert.rejects(tools.readMessages({}), /どちらか/);
  await assert.rejects(tools.readMessages({ channel: 'kt', thread_id: '11' }), /一方だけ/);
  assert.equal(discord.calls.filter((c) => c[0] === 'post').length, 0);
});

test('スレッド一覧は指定したチャンネルの中のものだけ', async () => {
  const { tools } = setup();
  assert.deepEqual((await tools.listThreads({ channel: 'kt' })).map((t) => t.id), ['11']);
  await assert.rejects(tools.listThreads({ channel: 'secret' }), ToolError);
});

test('書く: 投稿してリンクを返し、記録に 1 行残す (本文は先頭だけ)', async () => {
  const { tools, discord, fs } = setup({ files: { 'C:/tmp/a.png': 3 } });
  const r = await tools.postMessage({ channel: 'kt', content: '<@O> 3 行を撮って', files: ['C:/tmp/a.png'] });
  assert.equal(r.link, 'https://discord.com/channels/100/1/p1');
  const [, id, payload] = discord.calls.find((c) => c[0] === 'post');
  assert.equal(id, '1');
  assert.equal(payload.files[0].name, 'a.png');
  assert.equal(fs.logs.length, 1);
  assert.equal(fs.logs[0].tool, 'post_message');
  assert.equal(fs.logs[0].messageId, 'p1');
  assert.deepEqual(fs.logs[0].files, [{ name: 'a.png', bytes: 3 }]);
});

test('書く: 上限を超えるもの・相対パス・無いファイル・@everyone は送らない', async () => {
  const big = DEFAULT_MAX_FILE_BYTES + 1;
  const { tools, discord } = setup({ files: { 'C:/tmp/big.mp4': big } });
  await assert.rejects(tools.postMessage({ channel: 'kt', files: ['C:/tmp/big.mp4'] }), /大きすぎます/);
  await assert.rejects(tools.postMessage({ channel: 'kt', content: 'x', files: ['rel.png'] }), /絶対パス/);
  await assert.rejects(tools.postMessage({ channel: 'kt', content: 'x', files: ['C:/nope.png'] }), /見つかりません/);
  await assert.rejects(tools.postMessage({ channel: 'kt', content: '@everyone 見て' }), /@everyone/);
  await assert.rejects(tools.postMessage({ channel: 'kt', content: 'x'.repeat(2001) }), /長すぎます/);
  await assert.rejects(tools.postMessage({ channel: 'kt', content: '  ' }), /空です/);
  assert.equal(discord.calls.filter((c) => c[0] === 'post').length, 0);
  assert.deepEqual(checkPost({ content: 'ok' }, settings()), []);
});

test('添付: 許したフォルダの外・ドットで始まる名前・リンクで外を指すもの・置き場の未設定は拒否する', async () => {
  const files = {
    'C:/other/a.png': 3,
    'C:/tmp/.env': 3,
    'C:/tmp/sub/.git/config': 3,
    'C:/secret/x.png': 3,
    'C:/tmp2/a.png': 3,
    'C:/tmp/ok.png': 3,
  };
  const links = { 'C:/tmp/link.png': 'C:/secret/x.png' };
  const { tools, discord } = setup({ files, links });
  await assert.rejects(tools.postMessage({ channel: 'kt', content: 'x', files: ['C:/other/a.png'] }), /フォルダの外/);
  await assert.rejects(tools.postMessage({ channel: 'kt', content: 'x', files: ['C:/tmp/.env'] }), /ドットで始まる/);
  await assert.rejects(tools.postMessage({ channel: 'kt', content: 'x', files: ['C:/tmp/sub/.git/config'] }), /ドットで始まる/);
  await assert.rejects(tools.postMessage({ channel: 'kt', content: 'x', files: ['C:/tmp/link.png'] }), /フォルダの外/);
  // 前方一致のすり抜け (C:/tmp を許しても C:/tmp2 は外)
  await assert.rejects(tools.postMessage({ channel: 'kt', content: 'x', files: ['C:/tmp2/a.png'] }), /フォルダの外/);
  assert.equal(discord.calls.filter((c) => c[0] === 'post').length, 0);

  // 置き場を書いていなければ、添付は一切できない (本文だけなら送れる)
  const none = setup({ files, s: settings({ uploadRoots: [] }) });
  await assert.rejects(none.tools.postMessage({ channel: 'kt', content: 'x', files: ['C:/tmp/ok.png'] }), /設定されていない/);
  assert.equal((await none.tools.postMessage({ channel: 'kt', content: '本文だけ' })).messageId, 'p1');

  // 中のふつうのファイルは送れる
  assert.equal((await tools.postMessage({ channel: 'kt', content: 'x', files: ['C:/tmp/ok.png'] })).messageId, 'p1');
});

test('窓口: メンションはユーザーだけ鳴らし、エラー文にトークンを出さない', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: false, status: 403, text: async () => `denied for ${TOKEN}` };
  };
  const client = createDiscordClient({ token: TOKEN, fetchImpl });
  await assert.rejects(client.postMessage('1', { content: 'hi' }), (err) => {
    assert.match(err.message, /権限がありません \(403\)/);
    assert.ok(!err.message.includes(TOKEN), 'エラー文にトークンが出ている');
    return true;
  });
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual(body.allowed_mentions, { parse: ['users'] });
  assert.equal(seen[0].init.headers.Authorization, `Bot ${TOKEN}`);
  assert.equal(redact(`a ${TOKEN} b`, TOKEN), 'a [token] b');
});

test('窓口: 413 は「上限を超えた」と分かる言葉で返す', async () => {
  const client = createDiscordClient({
    token: TOKEN,
    fetchImpl: async () => ({ ok: false, status: 413, text: async () => 'Request entity too large' }),
  });
  await assert.rejects(client.postMessage('1', { content: '', files: [{ name: 'v.mp4', data: new Uint8Array(1) }] }), /上限を超えました \(413\)/);
});
