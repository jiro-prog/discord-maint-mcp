// メンテ用 Discord bot の MCP サーバー (stdio)。
//   node --env-file=.env src/server.mjs
// 標準出力は MCP の通信に使うので、記録やエラーは標準エラーへ出す。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createDiscordClient } from './discord.mjs';
import { DISCORD_CONTENT_MAX, READ_LIMIT_MAX, parseSettings, redact } from './policy.mjs';
import { createTools } from './tools.mjs';

const settings = parseSettings(process.env);
if (settings.errors.length > 0) {
  console.error(`[discord-maint] 起動できません:\n${settings.errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}

const tools = createTools({ settings, discord: createDiscordClient({ token: settings.token }) });
const server = new McpServer({ name: 'discord-maint', version: '0.1.0' });

/** 結果を JSON の文字列で返し、失敗はツールのエラーとして返す (トークンは伏せる) */
function handler(fn) {
  return async (args) => {
    try {
      const result = await fn(args ?? {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: redact(err?.message ?? String(err), settings.token) }], isError: true };
    }
  };
}

const target = {
  channel: z.string().optional().describe('チャンネル名 (# なし)。許可したチャンネルだけ'),
  thread_id: z.string().optional().describe('スレッドの ID。親チャンネルが許可されているスレッドだけ'),
};

server.registerTool(
  'list_channels',
  {
    title: 'チャンネル一覧',
    description: 'サーバーのテキストチャンネルの名前と、メンテ用 bot が読み書きを許されているか (allowed) を返す。',
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handler(() => tools.listChannels()),
);

server.registerTool(
  'list_threads',
  {
    title: 'スレッド一覧',
    description: '許可したチャンネルの中の、今動いているスレッド (ID・名前・件数) を返す。依頼の返事を読む前に、どのスレッドかを探すのに使う。',
    inputSchema: { channel: z.string().describe('チャンネル名 (# なし)') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handler((args) => tools.listThreads(args)),
);

server.registerTool(
  'read_messages',
  {
    title: 'メッセージを読む',
    description: `許可したチャンネルかその中のスレッドの、最近のメッセージを古い順に返す (最大 ${READ_LIMIT_MAX} 件)。添付は名前・大きさ・URL だけ。`,
    inputSchema: { ...target, limit: z.number().int().min(1).max(READ_LIMIT_MAX).optional().describe('件数 (既定 20)') },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  handler((args) => tools.readMessages(args)),
);

server.registerTool(
  'post_message',
  {
    title: 'メッセージを投稿する',
    description:
      `許可したチャンネルかその中のスレッドに投稿する (本文 ${DISCORD_CONTENT_MAX} 字まで、ファイルは絶対パスで最大 10 個)。` +
      'メンションはユーザーだけ鳴る (@everyone / @here / ロールは鳴らない)。チャンネル直下で communitd の bot をメンションすると、' +
      '作者の代理として新しい仕事 (スレッド) を起こす。投稿はすべて記録に残る。消す・編集する操作は無い。',
    inputSchema: {
      ...target,
      content: z.string().max(DISCORD_CONTENT_MAX).optional().describe('本文'),
      files: z.array(z.string()).max(10).optional().describe('添付するファイルの絶対パス'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  handler((args) => tools.postMessage(args)),
);

await server.connect(new StdioServerTransport());
console.error(`[discord-maint] 起動しました (許可: ${settings.channels.map((c) => `#${c}`).join(' ')})`);
