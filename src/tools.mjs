// MCP のツールの中身。Discord の窓口とファイルの読み書きを差し替えられるので、テストは偽物で回せる。
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute } from 'node:path';
import {
  checkPost,
  clampReadLimit,
  isAllowedChannelName,
  isTextChannelType,
  isThreadType,
  postLogEntry,
  redact,
  summarizeMessage,
  uploadRejection,
} from './policy.mjs';

export class ToolError extends Error {}

/**
 * @param {object} p
 * @param {ReturnType<import('./policy.mjs').parseSettings>} p.settings
 * @param {ReturnType<import('./discord.mjs').createDiscordClient>} p.discord
 * @param {{statSync?: Function, readFileSync?: Function, appendFileSync?: Function, mkdirSync?: Function}} [p.fs]
 * @param {() => string} [p.now]
 */
export function createTools({ settings, discord, fs = {}, now = () => new Date().toISOString() }) {
  const io = { statSync, readFileSync, appendFileSync, mkdirSync, realpathSync, ...fs };

  async function textChannels() {
    const all = await discord.guildChannels(settings.guildId);
    return all.filter((c) => isTextChannelType(c.type));
  }

  /** 宛先を 1 つに決める。許可していないチャンネル (とその中のスレッド) は読み書きしない */
  async function resolveTarget({ channel, thread_id: threadId }) {
    if (channel && threadId) throw new ToolError('channel と thread_id はどちらか一方だけ指定してください');
    if (!channel && !threadId) throw new ToolError('channel (チャンネル名) か thread_id のどちらかを指定してください');
    if (threadId) {
      if (!/^\d+$/.test(threadId)) throw new ToolError('thread_id は数字の ID で指定してください');
      const thread = await discord.channel(threadId);
      if (!isThreadType(thread?.type)) throw new ToolError(`${threadId} はスレッドではありません`);
      const parent = thread.parent_id ? await discord.channel(thread.parent_id) : null;
      if (!isAllowedChannelName(settings, parent?.name)) {
        throw new ToolError(`このスレッドの親チャンネル (#${parent?.name ?? '?'}) は許可されていません`);
      }
      return { id: threadId, kind: 'thread', name: thread.name, parent: parent.name };
    }
    if (!isAllowedChannelName(settings, channel)) {
      throw new ToolError(`#${channel} は許可されていません (許可: ${settings.channels.map((c) => `#${c}`).join(' ')})`);
    }
    const matches = (await textChannels()).filter((c) => c.name === channel);
    if (matches.length !== 1) {
      throw new ToolError(matches.length === 0 ? `#${channel} が見つかりません` : `#${channel} が ${matches.length} 個あります`);
    }
    return { id: matches[0].id, kind: 'channel', name: channel };
  }

  function log(entry) {
    if (!settings.logPath) return;
    try {
      io.mkdirSync(dirname(settings.logPath), { recursive: true });
      io.appendFileSync(settings.logPath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      console.error(`[discord-maint] 記録に失敗 (投稿は続行): ${err.message}`);
    }
  }

  /** 置き場の実体パス。解けない置き場は無いものとして扱う (fail-closed) */
  function realRoots() {
    return settings.uploadRoots.flatMap((root) => {
      try {
        return [io.realpathSync(root)];
      } catch {
        return [];
      }
    });
  }

  function readFiles(paths = []) {
    if (paths.length === 0) return [];
    const roots = realRoots();
    return paths.map((p) => {
      if (typeof p !== 'string' || !isAbsolute(p)) throw new ToolError(`ファイルは絶対パスで指定してください: ${p}`);
      // **実体パスで判定する** — 置き場の中に張ったリンクやジャンクションで外のファイルを指せないように
      let real;
      try {
        real = io.realpathSync(p);
      } catch {
        throw new ToolError(`ファイルが見つかりません: ${p}`);
      }
      const rejected = uploadRejection(real, roots);
      if (rejected) throw new ToolError(rejected);
      const st = io.statSync(real);
      if (!st.isFile()) throw new ToolError(`ファイルではありません: ${p}`);
      return { path: real, name: basename(real), bytes: st.size };
    });
  }

  return {
    async listChannels() {
      const chans = (await textChannels()).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
      return chans.map((c) => ({ name: c.name, allowed: isAllowedChannelName(settings, c.name) }));
    },

    async listThreads({ channel }) {
      const target = await resolveTarget({ channel });
      const { threads = [] } = await discord.activeThreads(settings.guildId);
      return threads
        .filter((t) => t.parent_id === target.id)
        .map((t) => ({ id: t.id, name: t.name, messageCount: t.message_count ?? null, lastMessageId: t.last_message_id ?? null }));
    },

    async readMessages({ channel, thread_id: threadId, limit }) {
      const target = await resolveTarget({ channel, thread_id: threadId });
      const raw = await discord.messages(target.id, clampReadLimit(limit));
      // Discord は新しい順で返す。会話として読めるよう古い順に並べ直す
      return { target, messages: [...raw].reverse().map(summarizeMessage) };
    },

    async postMessage({ channel, thread_id: threadId, content = '', files = [] }) {
      const target = await resolveTarget({ channel, thread_id: threadId });
      const meta = readFiles(files);
      const problems = checkPost({ content, files: meta }, settings);
      if (problems.length > 0) throw new ToolError(problems.join('\n'));
      const attachments = meta.map((f) => ({ name: f.name, data: io.readFileSync(f.path) }));
      try {
        const posted = await discord.postMessage(target.id, { content, files: attachments });
        log(postLogEntry({ at: now(), target, content, files: meta, messageId: posted.id }));
        return {
          target,
          messageId: posted.id,
          link: `https://discord.com/channels/${settings.guildId}/${target.id}/${posted.id}`,
        };
      } catch (err) {
        log(postLogEntry({ at: now(), target, content, files: meta, error: redact(err.message, settings.token) }));
        throw err;
      }
    },
  };
}
