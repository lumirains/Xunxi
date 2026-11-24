// 媒体存储层（Q6+Q8 · qq-exit-plan §3 Step 6.5 / night-plan §Q6+Q8）。
// QQ 载体退出后，图片不再走 QQ 图床（rkey ~1h 过期）也不把 base64 塞进消息存档（E1）：
// 所有媒体字节落本模块，消息里只引用**内容哈希 id**。
//
// 规格（白皮书 7.7 定案）：
//   put(buffer, {mime, ext})  → { id, name, size }   id = sha1(buffer) 前 16 hex
//   pathOf(id, mime)          → <DATA_DIR>/media/<yyyy-mm>/<id>.<ext>
//   read(id, hint)            → { buffer, mime }
//   publicUrl(id)             → /api/media/<id>
//
// 纪律：
//   · id 必须由**内容**算出（sha1 前 16 位）——天然去重（同图两次 put 只落一个文件）
//     与不可变缓存（id 永不指向不同字节）的基础；不自增、不随机。
//   · 写入走 tmp + rename 原子写（与 person/ 同纪律，进程中断不留半截文件）。
//   · 按月分目录（data/media/2026-11/<id>.jpg），目录体量可控、可整月归档。
//   · 单文件上限 20MB，超限抛错（调用方转成给模型/前端的提示，本模块不静默截断）。
//   · 数据根跟随 config.js 的 DATA_DIR（默认 <app>/data；部署经 XUNXI_DATA_DIR（旧名 QQ_AGENT_DATA_DIR 兼容 fallback）
//     指到真实数据根；沙箱测试经同一 env 重定向）——**不在模块加载时定死**，
//     与 sticker-manager 的 stickerImagesDir() 同款延迟取值（测试/便携重定向）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { detectImageType, detectAudioType, mimeToExt } from './image-type.js';

/** 单文件上限（qq-exit-plan Step 6.5：20 MB）。 */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** id 合法形态：sha1 前 16 位 hex（GET /api/media/:id 与 read() 共用这把闸防路径穿越）。 */
export const MEDIA_ID_RE = /^[a-f0-9]{16}$/;

// 延迟取目录：DATA_DIR 在测试里经 env 重定向，不能在模块加载时定死路径。
function mediaRoot() {
  return path.join(DATA_DIR, 'media');
}

/** 当前月份目录名（本地时区 yyyy-mm）。 */
function monthDirName() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 决定扩展名：显式 ext > 图片魔数 > 音频魔数 > mime 对照表 > 兜底 .bin。
 *  （音频魔数分支为 V0 媒体层音频化新增，asr-tts-v0-execution-spec §2.2；
 *  尾部 `.bin` 实际永远走不到——mimeToExt 内部已兜 .jpg。保持现状不顺手修，
 *  改了会让存量文件读取路径变化。） */
function extOf(buffer, { ext, mime } = {}) {
  const explicit = String(ext ?? '').trim();
  if (explicit) return explicit.startsWith('.') ? explicit.toLowerCase() : `.${explicit.toLowerCase()}`;
  const fromBytes = detectImageType(buffer)?.ext;
  if (fromBytes) return fromBytes;
  const fromAudio = detectAudioType(buffer)?.ext;
  if (fromAudio) return fromAudio;
  return mimeToExt(mime) || '.bin';
}

/**
 * 落一份媒体字节。同内容重复 put 天然去重（同 id 已存在 → 不重写，直接返回）。
 * @param {Buffer|Uint8Array} buffer 媒体字节
 * @param {{mime?: string, ext?: string}} meta mime/扩展名提示（留空按魔数嗅探）
 * @returns {Promise<{id: string, name: string, size: number}>}
 */
export async function put(buffer, meta = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (!buf.length) throw new Error('媒体内容为空，未保存');
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`媒体超过 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 上限（${Math.round(buf.length / 1024 / 1024)}MB），未保存`);
  }
  const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
  const ext = extOf(buf, meta);
  const name = `${id}${ext}`;
  const dest = path.join(mediaRoot(), monthDirName(), name);
  if (!fs.existsSync(dest)) {
    // tmp + rename 原子写：先写临时名，再 rename 到内容哈希定名。
    // 同图并发 put 只会产生同名冗余 rename，字节一致无破坏。
    const dir = path.dirname(dest);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, buf);
    try {
      fs.renameSync(tmp, dest);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖原错误 */ }
      throw error;
    }
  }
  return { id, name, size: buf.length };
}

/**
 * 内容哈希 id → 磁盘路径。写入用（read 不依赖它：读侧按 id 前缀在月份目录里定位，
 * 因为扩展名可能不是调用方此刻能给出的那份）。
 */
export function pathOf(id, mime) {
  const ext = mimeToExt(mime) || '.bin';
  return path.join(mediaRoot(), monthDirName(), `${String(id)}${ext}`);
}

/**
 * 读一份媒体。按 id 前缀在 data/media/<yyyy-mm>/ 里定位（同一内容全局唯一，
 * 跨月重复 put 也只会有一个文件）。找不到/格式不对抛错——调用方（路由层）
 * 负责转 404/400。
 * @param {string} id 16 位 hex 内容哈希
 * @param {string} [hint] mime 兜底提示（文件魔数识别不出时用）
 * @returns {Promise<{buffer: Buffer, mime: string}>}
 */
export async function read(id, hint = '') {
  const key = String(id ?? '');
  if (!MEDIA_ID_RE.test(key)) throw new Error('媒体 id 不合法（须为 16 位 hex 内容哈希）');
  const root = mediaRoot();
  let months = [];
  try {
    months = fs.readdirSync(root)
      .filter((name) => /^\d{4}-\d{2}$/.test(name))
      .sort()
      .reverse();   // 新月份优先：绝大多数读取命中最新的写入
  } catch {
    throw new Error('媒体不存在（存储目录尚未创建）');
  }
  for (const month of months) {
    const dir = path.join(root, month);
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((name) => name.startsWith(key) && !name.endsWith('.tmp'));
    if (hit) {
      const buffer = fs.readFileSync(path.join(dir, hit));
      const mime = detectImageType(buffer)?.mime
        || detectAudioType(buffer)?.mime
        || String(hint || '').trim()
        || 'application/octet-stream';
      return { buffer, mime };
    }
  }
  throw new Error('媒体不存在');
}

/** 前端可读地址（GET /api/media/:id，routes.js 提供，immutable 缓存一年）。 */
export function publicUrl(id) {
  return `/api/media/${String(id ?? '')}`;
}
