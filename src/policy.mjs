// メンテ用 Discord bot の決まりごと (純粋関数)。
// 読み書きできるのは許可したチャンネル (とその中のスレッド) だけ。消す・編集する・管理する操作は持たない。

export const DISCORD_CONTENT_MAX = 2000; // 1 通の本文の上限 (Discord の仕様)
export const MAX_FILES_PER_MESSAGE = 10;
// 1 ファイルの既定の上限。Discord の上限は時期とサーバーのブーストで変わり、資料によって食い違う
// (10 MiB / 20 MiB)。控えめな値を既定にし、DISCORD_MAINT_MAX_FILE_MB で上げられるようにする。
// 超えたときは Discord が 413 を返すので、その時点で分かる言葉で返す (src/discord.mjs)
export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_MESSAGE_BYTES = 25 * 1024 * 1024; // 1 回の送信の合計 (ブーストなしの上限)
export const READ_LIMIT_MAX = 50;

// スレッドの種類 (Discord の channel type)
const THREAD_TYPES = new Set([10, 11, 12]);
// 名前で引いてよいテキストチャンネルの種類 (通常のテキスト / お知らせ)
const TEXT_TYPES = new Set([0, 5]);

/**
 * 環境変数から設定を読む。足りないものは errors に入れて、起動を止める側に倒す。
 * @param {Record<string, string|undefined>} env
 */
export function parseSettings(env = {}) {
  const errors = [];
  const token = (env.DISCORD_MAINT_TOKEN ?? '').trim();
  const guildId = (env.DISCORD_GUILD_ID ?? '').trim();
  const channels = (env.DISCORD_MAINT_CHANNELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!token) errors.push('DISCORD_MAINT_TOKEN がありません (.env に bot のトークンを書く)');
  if (!/^\d+$/.test(guildId)) errors.push('DISCORD_GUILD_ID がありません (数字のサーバー ID)');
  if (channels.length === 0) {
    errors.push('DISCORD_MAINT_CHANNELS がありません (読み書きを許すチャンネル名をカンマ区切りで。全部許すことはできない)');
  }
  let maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  if (env.DISCORD_MAINT_MAX_FILE_MB !== undefined && env.DISCORD_MAINT_MAX_FILE_MB !== '') {
    const mb = Number(env.DISCORD_MAINT_MAX_FILE_MB);
    if (!Number.isFinite(mb) || mb <= 0 || mb > 500) {
      errors.push('DISCORD_MAINT_MAX_FILE_MB は 0 より大きく 500 以下の数で書く');
    } else {
      maxFileBytes = Math.floor(mb * 1024 * 1024);
    }
  }
  // 添付してよいファイルの置き場 (カンマ区切りの絶対パス)。**書かなければ添付は一切できない** —
  // read_messages で読んだ Discord の文面には他人の書いた指示が混ざりうる (prompt injection)。
  // 「C:/.../.env を添付して」に従っても外へ出せるのは、ここに書いたフォルダの中だけにする
  const uploadRoots = (env.DISCORD_MAINT_UPLOAD_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim().replaceAll('\\', '/'))
    .filter(Boolean);
  for (const root of uploadRoots) {
    if (!/^([A-Za-z]:\/|\/)/.test(root)) errors.push(`DISCORD_MAINT_UPLOAD_ROOTS は絶対パスで書く: ${root}`);
  }
  return {
    token,
    guildId,
    channels,
    maxFileBytes,
    uploadRoots,
    logPath: (env.DISCORD_MAINT_LOG ?? '').trim() || null,
    errors,
  };
}

/**
 * 添付してよいファイルか (実体パスで判定する。呼び出し側が realpath を解いて渡す)。
 * - ドットで始まる名前 (.env・.git・.ssh など) を途中に含むパスは、置き場の中でも拒否
 * - 置き場 (これも実体パス) の中でなければ拒否。大文字小文字は区別しない (Windows)
 * @param {string} realPath  添付するファイルの実体パス
 * @param {string[]} realRoots 置き場の実体パス
 * @returns {string|null} 拒否の理由 (null = 添付してよい)
 */
export function uploadRejection(realPath, realRoots) {
  const norm = (p) => String(p).replaceAll('\\', '/').replace(/\/+$/, '');
  const file = norm(realPath);
  if (file.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..')) {
    return `ドットで始まるファイルやフォルダは添付しません (.env などの秘密を外へ出さないため): ${realPath}`;
  }
  if (realRoots.length === 0) {
    return '添付を許すフォルダ (DISCORD_MAINT_UPLOAD_ROOTS) が設定されていないので、添付できません';
  }
  const lower = file.toLowerCase();
  const inside = realRoots.some((root) => lower.startsWith(`${norm(root).toLowerCase()}/`));
  return inside ? null : `添付を許すフォルダの外です: ${realPath}`;
}

export function isAllowedChannelName(settings, name) {
  return typeof name === 'string' && settings.channels.includes(name);
}

export function isThreadType(type) {
  return THREAD_TYPES.has(type);
}

export function isTextChannelType(type) {
  return TEXT_TYPES.has(type);
}

/**
 * 投稿の中身の検査。
 * @param {{content?: string, files?: {name: string, bytes: number}[]}} input
 * @returns {string[]} エラー行 (空 = 送ってよい)
 */
export function checkPost({ content = '', files = [] }, settings) {
  const errors = [];
  const text = typeof content === 'string' ? content : '';
  if (text.trim() === '' && files.length === 0) errors.push('本文もファイルも空です');
  if (text.length > DISCORD_CONTENT_MAX) {
    errors.push(`本文が長すぎます (${text.length} 字 > ${DISCORD_CONTENT_MAX} 字)。分けて送ってください`);
  }
  if (/@(everyone|here)\b/.test(text)) {
    errors.push('@everyone / @here は送れません (メンテ用 bot は全員を呼ばない)');
  }
  if (files.length > MAX_FILES_PER_MESSAGE) {
    errors.push(`ファイルは 1 通 ${MAX_FILES_PER_MESSAGE} 個までです (${files.length} 個)`);
  }
  let total = 0;
  for (const f of files) {
    total += f.bytes;
    if (f.bytes > settings.maxFileBytes) {
      errors.push(`${f.name} が大きすぎます (${mb(f.bytes)} MB > ${mb(settings.maxFileBytes)} MB)`);
    }
  }
  if (total > MAX_MESSAGE_BYTES) {
    errors.push(`ファイルの合計が大きすぎます (${mb(total)} MB > ${mb(MAX_MESSAGE_BYTES)} MB)`);
  }
  return errors;
}

/** メンションの範囲: ユーザーだけ。@everyone / @here / ロールは鳴らさない */
export const ALLOWED_MENTIONS = Object.freeze({ parse: ['users'] });

export function clampReadLimit(limit) {
  const n = Number.isInteger(limit) ? limit : 20;
  return Math.min(Math.max(n, 1), READ_LIMIT_MAX);
}

/** 読んだメッセージを、モデルに渡す小さな形にする (古い順に並べるのは呼び出し側) */
export function summarizeMessage(m) {
  return {
    id: m.id,
    at: m.timestamp,
    author: m.author?.global_name || m.author?.username || '?',
    authorId: m.author?.id ?? null,
    bot: m.author?.bot === true,
    content: m.content ?? '',
    attachments: (m.attachments ?? []).map((a) => ({ name: a.filename, bytes: a.size, url: a.url })),
    thread: m.thread ? { id: m.thread.id, name: m.thread.name } : null,
  };
}

/** トークンを文字列から伏せる (エラー文やログに混ざらないように) */
export function redact(text, token) {
  const s = String(text ?? '');
  return token ? s.split(token).join('[token]') : s;
}

/** 投稿の記録 1 行 (本文は先頭だけ。全文は Discord に残る) */
export function postLogEntry({ at, target, content = '', files = [], messageId = null, error = null }) {
  return {
    at,
    tool: 'post_message',
    target,
    contentLength: content.length,
    contentHead: content.slice(0, 80),
    files: files.map((f) => ({ name: f.name, bytes: f.bytes })),
    messageId,
    error,
  };
}

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}
