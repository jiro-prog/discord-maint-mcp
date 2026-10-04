// Discord REST API の薄い窓口 (読む・投稿するだけ)。fetch を差し替えればテストで偽物にできる。
import { ALLOWED_MENTIONS, redact } from './policy.mjs';

const API = 'https://discord.com/api/v10';

export class DiscordError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {{token: string, fetchImpl?: typeof fetch}} p
 */
export function createDiscordClient({ token, fetchImpl = globalThis.fetch }) {
  async function call(method, path, { json = undefined, form = undefined } = {}) {
    const headers = { Authorization: `Bot ${token}`, 'User-Agent': 'discord-maint-mcp (local, 0.1)' };
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      body = form; // FormData は境界つきの Content-Type を自分で付ける
    }
    let res;
    try {
      res = await fetchImpl(`${API}${path}`, { method, headers, body });
    } catch (err) {
      throw new DiscordError(`Discord に接続できません: ${redact(err?.message, token)}`, 0);
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    const detail = await res.text().catch(() => '');
    throw new DiscordError(explain(res.status, redact(detail, token)), res.status);
  }

  return {
    guildChannels: (guildId) => call('GET', `/guilds/${guildId}/channels`),
    channel: (channelId) => call('GET', `/channels/${channelId}`),
    activeThreads: (guildId) => call('GET', `/guilds/${guildId}/threads/active`),
    messages: (channelId, limit) => call('GET', `/channels/${channelId}/messages?limit=${limit}`),
    /**
     * @param {string} channelId チャンネルかスレッドの ID
     * @param {{content: string, files: {name: string, data: Uint8Array}[]}} p
     */
    postMessage: (channelId, { content, files = [] }) => {
      const payload = { content, allowed_mentions: ALLOWED_MENTIONS };
      if (files.length === 0) return call('POST', `/channels/${channelId}/messages`, { json: payload });
      const form = new FormData();
      payload.attachments = files.map((f, i) => ({ id: i, filename: f.name }));
      form.append('payload_json', JSON.stringify(payload));
      files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.data]), f.name));
      return call('POST', `/channels/${channelId}/messages`, { form });
    },
  };
}

function explain(status, detail) {
  const tail = detail ? ` (${detail.slice(0, 300)})` : '';
  if (status === 401) return `トークンが通りません (401)。.env の DISCORD_MAINT_TOKEN を確かめてください${tail}`;
  if (status === 403) {
    return `権限がありません (403)。bot に「チャンネルを見る・メッセージを送る・履歴を読む・ファイルを添付」を付けてください${tail}`;
  }
  if (status === 404) return `見つかりません (404)${tail}`;
  if (status === 413) {
    return `ファイルが Discord の上限を超えました (413)。小さくして送り直してください${tail}`;
  }
  if (status === 429) return `送りすぎで止められました (429)。少し待ってから送ってください${tail}`;
  return `Discord がエラーを返しました (${status})${tail}`;
}
