// 运行期表情库管理（Q6+Q8 摘 QQ 调用后）：本地 stickers.json（认知层：备注/笔记/
// 使用计数）的唯一运行期读者/写者。纯函数在 stickers.js。
// QQ 载体退出后表情库没有上游同步源：原 fetch_custom_face_detail 同步、ensureSendable
// 的 get_image 转存、collect 的 add_custom_face/modify_custom_face 全部摘除（night-plan
// §Q6 表情能力保留 0.2 铁律：stickers.js 纯函数库原样、list 只走本地库）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import {
  loadStickerStore, saveStickerStore,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed
} from './stickers.js';

// 收藏表情的本地图片目录：历史收藏把图片转存到这里（QQ 图床 rkey 会过期，
// 本地副本是唯一长寿形态）。
// 注意：用函数延迟取 DATA_DIR，而不是模块加载时定死 —— 测试/便携场景会重定向数据目录。
function stickerImagesDir() {
  return path.join(DATA_DIR, 'sticker-images');
}

/**
 * 只允许访问由收藏功能维护的本地图片，拒绝配置/存档中指向目录外的 file URI。
 * 返回绝对路径（存在且是文件）；不合法返回 null。
 *
 * 搬家自愈（2026-09-26）：严格路径失效但同名文件在受控目录里 —— 部署换目录 /
 * data 被整体拷贝后，旧绝对路径全部失效，16 条历史收藏曾因此集体发不出去。
 * 这时按文件名重定位到受控目录里的那份（仍然只在受控目录内，安全边界不变）。
 */
export function localStickerPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  // file:///C:/... 在 Windows URL pathname 前面多一个斜杠。
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  const root = path.resolve(stickerImagesDir()) + path.sep;
  const inside = (p) => String(p).toLowerCase().startsWith(root.toLowerCase());
  const isFile = (p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; } };
  const full = path.resolve(pathname);
  if (inside(full) && isFile(full)) return full;
  const base = path.basename(pathname);
  if (base && base !== '.' && base !== '..') {
    const cand = path.resolve(path.join(stickerImagesDir(), base));
    if (inside(cand) && isFile(cand)) return cand;
  }
  return null;
}

export class StickerManager {
  // Q11（night-plan §Q11）：协议端句柄形参随 QQ 身体归档摘除（Q6 已摘全部协议端调用，
  // 本类内零消费；app.js 装配同批改无参构造）。
  constructor() {
    this.entries = loadStickerStore();
    this.healLocalPaths();
  }

  /**
   * 搬家自愈：条目里的旧绝对路径若文件已在受控目录中（按文件名匹配），重写 url。
   * 构造时跑一次（幂等）——部署换目录后第一次启动即可复活全部本地收藏。
   */
  healLocalPaths() {
    let changed = 0;
    for (const e of this.entries) {
      const u = String(e.url || '');
      if (!u.toLowerCase().startsWith('file:///')) continue;
      const healed = localStickerPath(u);
      if (!healed) continue;
      const fresh = `file:///${healed.replace(/\\/g, '/')}`;
      if (fresh.toLowerCase() !== u.toLowerCase()) {
        e.url = fresh;
        e.localFile = fresh;
        changed += 1;
      }
    }
    if (changed) {
      try { saveStickerStore(this.entries); } catch { /* 自愈写盘失败不影响运行 */ }
    }
    return changed;
  }

  /**
   * 「同步」退化成本地读（Q6+Q8 摘 QQ 调用）：QQ 收藏表情的上游
   * fetch_custom_face_detail 随载体退出消亡，list/find 只走本地 stickers.json。
   * 方法与返回形状保留（orchestrator.js 提示词注入与 tools list/find 仍按
   * { entries, fromCache } 消费），force 形参兼容旧调用点。
   */
  async sync(force = false) {
    void force;
    return { entries: this.entries, fromCache: true };
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  // collect（原 :212-312）与私有 helpers（#persistImage/#getImageBytes/#saveLocalImage/
  // #downloadBytes，原 :319-368）随 Q6+Q8 删除：唯一调用方 collect_sticker 工具已摘除，
  // 且整条链绑协议端（get_image/add_custom_face/modify_custom_face/fetch_custom_face_detail，
  // Q11 起该链路随身体归档无复活面）。
  // 收藏语义（"把图变成表情"）留待桌宠/前端载体（night-plan §Q6）。
}
