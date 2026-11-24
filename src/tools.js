// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的会话，安全性反而更强。
//
// 工具命名去掉了平台前缀（更短，省 token）。
//
// 重构说明：所有工具通过 registerTool() 注册到 tool-registry.js，
// 支持在设置页按卡片勾选启用/禁用。
import fs from 'node:fs';
import { getConfig } from './config.js';
import { normalizeMessageList } from './util.js';
import { moduleManager } from './modules/manager.js';
import { safeFetchBinary, browseLockState, checkBrowseLock } from './safe-fetch.js';
import { webSearch, webFetch } from './web-search.js';
// （拆分表 #6 消亡，Phase 8b：原顶部对协议端模块的静态 import 已拆除
//  —— tools.js 不再 import 平台模块，发送改走 ctx.emit（拆分表 #7）。门禁
//  check-boundaries.mjs 自此把本文件移入扫描。
//  Q6+Q8：旧身体专属工具（跨会话发送/身体表情直发/戳一戳/合并转发等六件）整体摘除，
//  表情知识层工具保留去 surface 标注；媒体字节统一走 media-store（内容哈希 id）。
//  清债夜2：身体读回窄封装收窄为 { call, capabilities }（转发展开窄通道随
//  read_forward 消费者消亡一并摘除，评审 P2-6②口径）。）
import { registerTool, listTools } from './tool-registry.js';
// remember（v3 步骤③ T3.1）：写 person staging（海马体）——只追加、不调模型。
// person/memory.js 是 facts/cards/staging 的唯一写者，这里只经它的 API。
import { remember as rememberToStaging } from './person/memory.js';
// 心绪（原 mind 插件收编）：状态写者仍是 person/mind.js，这里只做工具壳。
import { noteMood, settle as settleMood } from './person/mind.js';
// 日记（原日记插件壳收编）：存储写者仍是 person/diary.js。
import * as diaryStore from './person/diary.js';
import { compressImage } from './image-compress.js';
import { localStickerPath } from './sticker-manager.js';
import { isGifBuffer, gifToVideoDataUrl, resolveGifRoute } from './gif-to-video.js';
import * as mediaStore from './media-store.js';
import { events } from './kernel/events.js';

/** 当前配置的 GIF 选路（vision/video 开关组合，规则矩阵见 resolveGifRoute 注释）。 */
function currentGifRoute() {
  const cfg = getConfig();
  return resolveGifRoute({ vision: cfg.api?.vision !== false, video: cfg.api?.video === true });
}

// Q6+Q8 媒体层改造：原 downloadImageAsDataUrl(url)（http 现拉旧图床直链）随旧载体
// 退出消亡——图字节现在来自 mediaStore.read（存档媒体）/本地表情文件，统一从这里
// 进投喂管线。GIF 分岔与压缩逻辑逐段保留（llm.js 消费形状不变：dataUrl/video_url 部件）。
async function bufferToFeedResult(buffer, contentType = '') {
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  // GIF 在这里分岔（规则矩阵见 resolveGifRoute）：
  //   vision+video 都开 → 转 mp4 按 video 部件发（llm.js 自动切视频专用模型）；
  //   只开 vision      → GIF 按图片原样发（读不了的模型由 llm.js 的"图片被拒"
  //                      降级路径换首帧重试 —— 见 image-compat 的 llm.retry-advisor）；
  //   vision 没开      → 看图工具整体不可用，不会被调到。
  if (isGifBuffer(buffer) && currentGifRoute() === 'video') {
    const video = await gifToVideoDataUrl(buffer);
    if (video) {
      return {
        dataUrl: '',
        gifVideo: {
          dataUrl: video.dataUrl,
          frames: video.frames,
          width: video.width,
          height: video.height
        }
      };
    }
    // 转换失败（没 ffmpeg / 文件异常）→ 落到下面的普通图片路径，按原样发
  }
  // 大图片自动压缩（有 ffmpeg 时）：缩到模型可接受的尺寸/体积，降低 token 成本
  const compressed = await compressImage(buffer);
  const mime = compressed.compressed ? compressed.mime : (detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0]);
  return {
    dataUrl: `data:${mime};base64,${compressed.buffer.toString('base64')}`,
    isGif: mime === 'image/gif',
    // 原始 GIF 字节留着：模型拒收 GIF 时降级重试要取首帧（gifFirstFrameDataUrl）。
    // 非 GIF 返回 null，不占内存。
    gifBuffer: isGifBuffer(buffer) ? buffer : null
  };
}

/**
 * 表情条目 → 本地图片字节。旧载体退出后表情的 http 直链（旧图床 rkey，~1h 过期）
 * 已是死链，只有本地转存过的条目（file:///，受控 data/sticker-images/ 目录内）可读；
 * 其余返回 null，由调用方转成明确提示（本地直读口径，见 get_sticker_image / attachments）。
 */
function stickerLocalBytes(sticker) {
  const localPath = localStickerPath(sticker?.localFile || sticker?.url || '');
  if (!localPath) return null;
  try {
    const buffer = fs.readFileSync(localPath);
    return { buffer, mime: detectMime(buffer) || 'image/png' };
  } catch {
    return null;
  }
}

/**
 * 把 bufferToFeedResult 的结果组装成工具返回的 content parts。
 * GIF 转出的视频用 video_url 部件（llm.js 检测到会自动切视频专用模型），
 * 其余仍是 image_url。GIF 按原图（gif-image 路线）发送时：能读 GIF 的模型
 * 看得到动图，读不了的会在网关报错后由 image-compat 的降级路径换首帧重试。
 */
function getImagePartsOrVideo(text, results) {
  const parts = [{ type: 'text', text }];
  const gifAsImage = [];
  for (const r of results) {
    if (r?.gifVideo) {
      parts.push({ type: 'video_url', video_url: { url: r.gifVideo.dataUrl } });
    } else {
      parts.push({ type: 'image_url', image_url: { url: r.dataUrl } });
      if (r?.isGif) gifAsImage.push(r);
    }
  }
  if (gifAsImage.length) {
    parts[0].text += `\n（其中 ${gifAsImage.length} 张是 GIF 动图，按原图发送：部分模型只能看到第一帧，读不了时会自动换成首帧重试）`;
  }
  return { content: parts, videoCount: parts.filter((p) => p.type === 'video_url').length };
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfName, botName,
 *   store, memory, stickers, session,
 *   emit    字符串=UI/日志事件；intent 对象=出站意图（Phase 8b，M1：未带
 *           conversationId 时补当前会话），返回身体翻译层原始形状（坑 #9）
 *   surface 身体读回窄封装 { call, capabilities }（Phase 8b，草案 §4；清债夜2 收窄）
 * }
 *
 * 重构后：工具定义注册到 tool-registry，这里从 registry 读取并过滤。
 */
export function buildToolDefs() {
  // 确保所有工具已注册（幂等）
  registerAllTools();
  // 加载插件工具（如果还没加载）
  loadPluginTools();
  return listTools();
}

/** 加载插件工具（幂等） */
let pluginToolsLoaded = false;
function loadPluginTools() {
  if (pluginToolsLoaded) return;
  pluginToolsLoaded = true;
  // 插件工具已在 app.js 启动时通过 loadPlugins() 注册到 registry
  // 这里只需要确保 registry 里有它们
}

/** 注册所有内置工具到 registry。 */
function registerAllTools() {
  // 消息发送类
  registerTool({
    id: 'send_message',
    name: '发送消息',
    description: '发送消息到当前聊天。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用。不要在字符串内部用空格分句。带图片时传 attachments：表情用 {kind:"sticker", id}（id 来自 list_stickers），已上传媒体用 {kind:"image", mediaId}。',
    category: 'messaging',
    icon: '💬',
    sideEffects: ['send'],
    parameters: {
      type: 'object',
      properties: {
        messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前 # 后面那串字符，原样照抄；可能是数字，也可能是以 web 开头的长串。可选）' },
        attachments: {
          type: 'array',
          description: '可选：随消息附带的媒体（一次最多 4 个）。每项 {kind:"sticker", id:表情id} 或 {kind:"image", mediaId:媒体id}；媒体 id 在消息里只存引用不存字节',
          items: { type: 'object' }
        }
      },
      required: ['messages']
    },
    async execute(ctx, args) {
      try {
        const messages = normalizeMessageList(args.messages);
        if (!messages.length) return err('消息内容为空');
        // attachments 解析（Q6+Q8 媒体层）：sticker id → stickers.find → 本地字节
        // → mediaStore.put（内容哈希 id）→ mediaId。媒体在意图里只带 id（E1：
        // 存档不进 base64/字节）。无附件时字段整体缺省（意图形状与旧版逐字节一致）。
        const rawAttachments = Array.isArray(args.attachments) ? args.attachments.slice(0, 4) : [];
        const mediaIds = [];
        for (const a of rawAttachments) {
          if (a?.kind === 'image' && a.mediaId) {
            mediaIds.push(String(a.mediaId));
            continue;
          }
          if (a?.kind === 'sticker' && a.id) {
            const sticker = await ctx.stickers.find(String(a.id));
            if (!sticker) return err(`找不到表情 ${a.id}（attachments 里的 id 要原样抄 list_stickers 返回的 id）`);
            const bytes = stickerLocalBytes(sticker);
            if (!bytes) return err(`表情 ${sticker.id} 没有本地图片可发（旧图床直链已随旧载体退出失效），请换个表情或改用文字`);
            const saved = await mediaStore.put(bytes.buffer, { mime: bytes.mime });
            mediaIds.push(saved.id);
            ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
            continue;
          }
          return err('attachments 项不合法：只支持 {kind:"sticker", id} 或 {kind:"image", mediaId}');
        }
        const attachmentPayload = mediaIds.length ? mediaIds.map((id) => ({ mediaId: id })) : undefined;
        // 出站意图（Phase 8b / 草案 §2.2，拆分表 #7）：发什么由大脑声明（type/payload），
        // 怎么发（分条/限频/去重）是身体的事。不带 conversationId → ctx.emit 按 M1/D19
        // 补当前会话；返回 sender 的 {sent,failed} 原形状（坑 #9：逐字节保持，改了模型会重试）。
        const result = await ctx.emit({
          type: 'text',
          payload: {
            text: messages,
            replyTo: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null,
            ...(attachmentPayload ? { attachments: attachmentPayload } : {})
          },
          urgency: 'normal',
          replyTo: args.replyToMessageId ?? null
        });
        ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
        ctx.emit('session-update', ctx.session.id);
        const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
        if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
        return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'list_stickers',
    name: '查看表情库',
    // Q6+Q8 去 surface 标注（night-plan §Q6 表情能力保留 0.2 铁律）：表情知识库是
    // 本地资产（stickers.json + 本地笔记），不再绑定单一身体——所有身体可用。
    description: '查看/搜索你的表情收藏库（含备注和你的本地笔记）。',
    category: 'sticker',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
        limit: { type: 'integer', description: '最多返回条数，默认 24' }
      }
    },
    async execute(ctx, args) {
      try {
        const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
        return ok(result);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'get_sticker_image',
    name: '查看表情图片',
    description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
    category: 'sticker',
    icon: '🖼️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: { stickerId: { type: 'string', description: '表情 id' } },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const sticker = await ctx.stickers.find(args.stickerId);
        if (!sticker) return err(`找不到表情 ${args.stickerId}`);
        // Q6+Q8 去 surface 标注 + 本地直读口径：本地转存条目（file:///，受控
        // data/sticker-images/ 内）直接读字节投喂；旧图床 http 直链（rkey ~1h
        // 已过期）随载体退出不可读，明确报错不猜。
        const bytes = stickerLocalBytes(sticker);
        if (!bytes) return err(`表情 ${sticker.id} 没有本地图片可看（旧图床直链已随旧载体退出失效）`);
        const r = await bufferToFeedResult(bytes.buffer, bytes.mime);
        const built = getImagePartsOrVideo(`表情 ${sticker.id}（备注：${sticker.desc || sticker.localNote || '无'}）：`, [r]);
        if (r.gifVideo) {
          built.content[0].text += `\n（这是 GIF 动图，已转成 ${r.gifVideo.frames} 帧、最长边 ${Math.max(r.gifVideo.width, r.gifVideo.height) || '≤480'}px 的视频输入，画面按视频发给模型）`;
        }
        return built;
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'sticker_note',
    name: '备注表情',
    description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
    category: 'sticker',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情 id（list_stickers 返回的那个，照抄不要改）' },
        note: { type: 'string', description: '你的理解/含义' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
        usage: { type: 'string', description: '适用场景（可选）' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.stickers.note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
        if (!entry) return err(`找不到表情 ${args.stickerId}`);
        return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // collect_sticker（原 :454-497）随 Q6+Q8 删除：硬平台绑定（add_custom_face 入旧
  // 收藏 + get_image 读协议端缓存），收藏语义留待桌宠/前端载体（night-plan §Q6）。
  // send_poke（原 :499-535）随 Q6+Q8 删除：poke 是旧身体专属意图词表。

  registerTool({
    id: 'get_recent_messages',
    name: '查看历史消息',
    description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。',
    category: 'query',
    icon: '📜',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
        offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
      }
    },
    async execute(ctx, args) {
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      const offset = Math.max(0, Number(args.offset) || 0);
      const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
      // 来源标签（Q6+Q8，night-plan §Q6）：原号码后缀随旧载体退出改为
      // 会话来源（哪副身体在说话，session.source = 'web'/…，sessions.js 落字段）。
      const source = String(ctx.session?.source ?? '');
      return ok({
        count: messages.length,
        messages: messages.map((m) => ({
          messageId: m.mid ?? undefined,
          time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
          sender: m.self ? '我' : `${m.senderName}${source ? `(${source})` : ''}`,
          text: m.text
        }))
      });
    }
  });

  // read_forward（原 :568-608）/ get_active_members（原 :610-631）/ get_chats（原
  // :633-658）/ get_message_detail（原 :660-683）随 Q6+Q8 删除：读回走旧协议端
  // 转发消息、按号码找人、跨会话枚举、旧消息 id 详情均为旧载体专属能力。

  registerTool({
    id: 'get_message_images',
    name: '查看消息图片',
    description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用。id 用聊天记录里每条消息前 # 后面那串字符，原样照抄（可能是数字，也可能是以 web 开头的长串）；拿不准就先 get_recent_messages 查，不要自己编。',
    category: 'query',
    icon: '🖼️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: { messageId: { type: ['integer', 'string'], description: '消息 id（聊天记录里的 #数字，可能为负数）' } },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        // ── id 回落（2026-11-13）─────────────────────────────────────────
        // 旧存档里入站条目的 mid 是 null（web 身体早期不写 meta.mid，见
        // orchestrator.submit 的 mid 回落注释）：模型即使照抄也拿不到 id，
        // 于是编一个数字撞空。与其让她"看不见这张图"，不如退到最近一条带图
        // 消息，并在结果里说清换了哪条 —— 只读，不猜 id、不碰旧直链。
        let entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        let fellBack = false;
        if (!entry) {
          const recent = ctx.store.recent(ctx.chatKey, { limit: 50 });
          for (let i = recent.length - 1; i >= 0; i--) {
            const m = recent[i];
            if ((m.media || []).some((x) => x.kind === 'image')) { entry = m; fellBack = true; break; }
          }
        }
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}（历史消息没有 #id，或 id 已随旧载体存档失效）`);
        const idLabel = fellBack
          ? `${entry.mid ?? entry.id}（你给的 #${args.messageId} 没找到，已改用最近一条带图消息）`
          : args.messageId;
        // Q6+Q8 媒体层改造（脱离计划 Step 6.5）：media[].id → mediaStore.read →
        // 压缩 → image_url 投喂（llm.js 一行不改，投喂层仍是 base64 image_url）。
        // 旧直链条目（media[].url，rkey 已过期）跳过并计数提示——不猜、不再下载。
        const media = (entry.media || []).filter((m) => m.kind === 'image');
        const withId = media.filter((m) => m.id);
        const skippedLegacy = media.length - withId.length;
        if (!withId.length) {
          return ok(skippedLegacy
            ? `消息 ${idLabel} 的 ${skippedLegacy} 张图片是旧直链存档（已随旧载体退出失效，本地无媒体副本）`
            : `消息 ${idLabel} 没有可查看的图片`);
        }
        const results = [];
        const failed = [];
        for (const m of withId) {
          try {
            const { buffer, mime } = await mediaStore.read(m.id, m.mime || '');
            results.push(await bufferToFeedResult(buffer, mime));
          } catch (e) {
            failed.push(`#${m.id}: ${String(e?.message ?? e)}`);
          }
        }
        if (!results.length) return err(`图片获取失败：${failed.join('；')}`);
        const notes = [];
        if (failed.length) notes.push(`另有 ${failed.length} 张获取失败`);
        if (skippedLegacy) notes.push(`跳过 ${skippedLegacy} 张旧直链存档（已失效）`);
        const note = notes.length ? `（${notes.join('，')}）` : '';
        // GIF 动图可能被转成了视频部件（见 bufferToFeedResult），文案里区分张数
        const videoCount = results.filter((r) => r?.gifVideo).length;
        const imageCount = results.length - videoCount;
        const what = [
          imageCount ? `${imageCount} 张图片` : '',
          videoCount ? `${videoCount} 段视频（由 GIF 动图转换，≤480px/≤24帧）` : ''
        ].filter(Boolean).join(' + ');
        const built = getImagePartsOrVideo(`消息 ${idLabel} 的内容${note}：${what}。`, results);
        return built;
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // 旧「按会话存印象」三工具已随旧记忆存档在步骤⑦（T7.1）下架归档（_archive-20261107）；写记忆走 remember。
  // remember（v3 步骤③ T3.1 新增）：写 person staging（海马体），只追加、不调模型；
  // 巩固流程（步骤⑤）再把 staging 整理成长期记忆。这是"大脑记档"的第一块拼图。
  registerTool({
    id: 'remember',
    name: '记住这件事',
    description: '把一件值得你记住的事暂存进自己的短时记忆（当天暂存区，当晚会和聊天记录一起整理成记忆卡）。只记以后用得上的：对方的稳定事实、你们约好/说好的事、没聊完的话题、你自己的重要偏好。宁可多记一条，也别让今天过去就忘了；但不要当备忘录流水账——一条一件事，用一句完整的话写清楚（谁、什么事、什么约定）。别记寒暄、玩笑、一眼就会过去的事。',
    category: 'memory',
    icon: '🧠',
    sideEffects: ['memory'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的内容，一句完整的话（≤120 字，一件事一条）' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args.text ?? '').trim();
      if (!text) return err('text 为空：要记住的内容不能是空的。');
      // P4（night-plan §7.2）：尽量带 mid —— 从触发批倒序找最后一条**用户**消息
      // （mid 优先；个别事件无协议 mid 时用本地 id，巩固侧 validateMid 两者都认）。
      // 找不到（主动机会/触发批为空/全是自己发言）→ mid=null 并留日志：staging
      // mid:null 的条目不当事实来源（reflection 提示词会标注，executor 校验侧计数）。
      const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
      let mid = null;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (!e || e.self) continue;
        // mid 可能是协议串（web:…，2026-11-13 起入站消息都有），而 staging 契约
        // 只收数字或 null —— 先试 mid（数字才认），不成立退回本地 id。两者都不成立
        // 才继续往前找；全都没有 → mid=null（不当事实出处）。
        const rawMid = Number(e.mid);
        if (e.mid !== null && e.mid !== undefined && e.mid !== '' && Number.isFinite(rawMid)) { mid = rawMid; break; }
        const rawId = Number(e.id);
        if (Number.isFinite(rawId)) { mid = rawId; break; }
      }
      if (mid === null) {
        console.warn('[tools] remember 无法归属用户消息 mid（触发批为空/全是自己发言）→ staging 条目 mid=null，不作为 facts 证据');
      }
      const entry = rememberToStaging({ text, mid, source: 'chat' });
      if (!entry) return err('暂存失败（写入当天暂存区出错），这件事没有记上，可稍后重试。');
      return ok({ saved: true, entry });
    }
  });

  registerTool({
    id: 'report_feedback',
    name: '反馈问题',
    description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
    category: 'system',
    icon: '📢',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'warning', 'error'], description: '反馈等级：info=提示 / warning=警告 / error=出错' },
        message: { type: 'string', description: '反馈内容（一句话说清哪里有问题）' }
      },
      required: ['message']
    },
    async execute(ctx, args) {
      const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
      ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
      ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
      return ok({ reported: true });
    }
  });

  registerTool({
    id: 'web_search',
    name: '联网搜索',
    description: '联网搜索（Bing），返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
    category: 'web',
    icon: '🔍',
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索词' } },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const result = await webSearch(String(args.query ?? ''));
        if (!result.results.length) {
          return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
        }
        return ok(result);
      } catch (error) {
        return err(`搜索失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'web_fetch',
    name: '抓取网页',
    description: '只读抓取网页正文（≤2 万字符）。对方发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。禁止访问内网/本机地址。',
    category: 'web',
    icon: '📄',
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
      required: ['url']
    },
    async execute(ctx, args) {
      try {
        // 浏览锁定开启时逐跳校验白名单（与 send_image/search_images 同一口径；
        // 曾经漏传导致锁定形同虚设）
        const result = await webFetch(String(args.url ?? ''), { browseLocked: browseLockState().enabled });
        const body = String(result.body || '');
        return ok({
          url: result.url,
          statusCode: result.statusCode,
          truncated: result.truncated || body.length > 20000,
          content: body.slice(0, 20000)
        });
      } catch (error) {
        return err(`抓取失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'finish',
    name: '结束会话',
    description: '结束本次处理。发完消息、没有别的事要做时，必须调用它收尾——不要重复发送，也不要再调别的工具。看完不打算说话，也调用它（summary 写一句理由）。',
    category: 'system',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）' }
      },
      required: ['summary']
    },
    async execute(ctx, args) {
      ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
      return ok({ finished: true });
    }
  });

  // ── 提醒（闹钟/计时）──
  registerTool({
    id: 'set_reminder',
    name: '设置提醒',
    description: '设置一个定时提醒（闹钟）。到点后机器人会在当前聊天里主动发一条提醒消息。适用：对方说"X分钟后提醒我"、"明天早上叫我"、"X点提醒我吃饭"。delayMinutes（多少分钟后）和 atTime（具体时间，如"18:30"或"2026-09-12 08:00"）二选一。',
    category: 'system',
    icon: '⏰',
    sideEffects: ['remind'],
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容（到点要发的话，如"该吃饭了"、"你让提醒你的：开会"）' },
        delayMinutes: { type: 'number', description: '多少分钟后提醒（与 atTime 二选一）' },
        atTime: { type: 'string', description: '具体时间提醒，格式 "HH:MM"（今天/明天）或 "YYYY-MM-DD HH:MM"（与 delayMinutes 二选一）' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args.text ?? '').trim();
      if (!text) return err('提醒内容为空');
      let dueAt = null;
      if (args.delayMinutes != null && Number(args.delayMinutes) > 0) {
        dueAt = Date.now() + Number(args.delayMinutes) * 60000;
      } else if (args.atTime) {
        dueAt = parseAtTime(String(args.atTime));
        if (!dueAt) return err('时间格式不对：用 "HH:MM"（如 18:30）或 "YYYY-MM-DD HH:MM"');
        if (dueAt <= Date.now()) return err('这个时间已经过了，请给个未来的时间');
      } else {
        return err('请提供 delayMinutes（多少分钟后）或 atTime（具体时间）之一');
      }
      if (!ctx.reminders) return err('提醒服务未启用');
      const entry = ctx.reminders.add({ chatKey: ctx.chatKey, text, dueAt, createdBy: String(ctx.selfId || '') });
      const when = new Date(dueAt);
      const whenStr = `${when.getMonth() + 1}月${when.getDate()}日 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      return ok({ set: true, id: entry.id, dueAt, note: `已设置提醒：${whenStr} 到点我会在当前聊天里说「${text}」。` });
    }
  });

  registerTool({
    id: 'list_reminders',
    name: '查看提醒',
    description: '查看当前会话里还没触发的所有提醒（闹钟）。适用：对方问"我设了什么提醒"、"还有哪些闹钟"。',
    category: 'system',
    icon: '📋',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      if (!ctx.reminders) return err('提醒服务未启用');
      const list = ctx.reminders.pending(ctx.chatKey);
      if (!list.length) return ok({ count: 0, note: '当前没有待触发的提醒。' });
      const lines = list.map((r) => {
        const d = new Date(r.dueAt);
        const whenStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `- [${r.id}] ${whenStr}：${r.text}`;
      });
      return ok({ count: list.length, reminders: lines.join('\n') });
    }
  });

  registerTool({
    id: 'cancel_reminder',
    name: '取消提醒',
    description: '取消一个还没触发的提醒（闹钟）。id 从 list_reminders 获取。适用：对方说"取消那个提醒"、"别提醒我了"。',
    category: 'system',
    icon: '🗑️',
    sideEffects: ['remind'],
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要取消的提醒 id（list_reminders 里 [r_xxx] 那个）' } },
      required: ['id']
    },
    async execute(ctx, args) {
      if (!ctx.reminders) return err('提醒服务未启用');
      const id = String(args.id ?? '').trim();
      if (!id) return err('请提供提醒 id');
      const ok_ = ctx.reminders.cancel(id);
      return ok_ ? ok({ cancelled: true, id }) : err(`没找到提醒 ${id}（可能已触发或 id 不对，用 list_reminders 查一下）`);
    }
  });

  // ── 发网图（send_image / search_images）────────────────────────────────
  //
  // 补的是一个明显缺口：机器人此前没有"主动发一张网上找的图"的能力
  //（Q6+Q8 起字节统一落 media-store，见 send_image 内注释）。
  //
  // 安全校验：预览确认、字节魔数校验、safe-fetch（SSRF 防护 + 限量 + 浏览锁定）。
  registerTool({
    id: 'send_image',
    name: '发送网图',
    description: '把一张网上找到的图片发到当前聊天。默认需要先预览确认（send_image(url, preview=true) 看一眼，再 send_image(url) 发出）。只支持 png/jpg/gif/webp 直链；网页地址不是图片。',
    category: 'media',
    icon: '🖼️',
    requiresVision: false,
    sideEffects: ['send'],
    // Q6+Q8 去 surface 标注（night-plan §Q6+Q8）：发图能力不再绑定单一身体——
    // 字节落 mediaStore（内容哈希 id），身体按 mediaId 翻译（web 前端 /api/media/<id> 读）。
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片直链（要整条照抄，不要改动路径字符）' },
        preview: { type: 'boolean', description: 'true = 先只给自己看一眼、不发送' },
        note: { type: 'string', description: '可选：配一句话一起发' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：引用某条消息的 id' },
        atUserId: { type: ['integer', 'string'], description: '可选：@ 某人（填对方会话里的 id）' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      try {
        const cfg = getConfig();
        const opt = cfg.security?.imageSend || {};

        const url = String(args.url ?? '').trim();
        if (!url) return err('url 不能为空');
        if (!/^https?:\/\//i.test(url)) {
          return err('只支持 http(s) 图片直链。本地文件路径不能发（那会暴露宿主文件系统）。');
        }
        // 每次运行的状态挂在 ctx 上（ctx 每次运行新建，天然隔离、不用持久化）
        ctx.sendImageState = ctx.sendImageState || { previewed: [], previews: 0, sent: 0 };
        const st = ctx.sendImageState;

        const isPreview = args.preview === true;
        const lock = cfg.security?.browseLock || {};
        // 浏览锁定站点内的图可跳过预览：站内图源可信，省一轮
        const lockCheck = checkBrowseLock(url, browseLockState());
        const trusted = lockCheck.enabled && lockCheck.allowed && opt.skipPreviewForLockedHosts !== false;

        if (!isPreview) {
          if (opt.requirePreview !== false && !trusted && !st.previewed.includes(url)) {
            return err('发图前要先看一眼：先调 send_image(url, preview=true) 确认这张图合适，再调 send_image(url) 发送。');
          }
          if (st.sent >= Math.max(1, Number(opt.maxPerRun) || 3)) {
            return err(`本次运行已经发了 ${st.sent} 张图，达到上限（设置里可调）。`);
          }
        } else if (st.previews >= Math.max(1, Number(opt.maxPreviewsPerRun) || 5)) {
          return err(`本次运行预览次数已达上限（${st.previews} 次）。挑最有把握的一张直接发。`);
        }

        // 下载：safe-fetch 全套防护（DNS 固定、逐跳校验、限量、浏览锁定）
        const maxBytes = Math.max(1, Number(opt.maxBytesMB) || 5) * 1024 * 1024;
        let buffer;
        let contentType;
        try {
          ({ buffer, contentType } = await safeFetchBinary(url, maxBytes, { browseLocked: !!lock.enabled }));
        } catch (error) {
          const msg = String(error?.message ?? error);
          // 404 多半是模型抄 URL 时手抖（实测把 /2026/04/xx.jpg 抄成 /2026-04-xx.jpg），
          // 提醒它原样复制，别自己"修复"路径
          const hint = /HTTP 404/.test(msg)
            ? '（地址可能抄错了：请从 web_fetch / search_images 返回的 images 里原样复制，不要改动路径字符；也可能是图已删除）'
            : '';
          return err(`图片下载失败：${msg}${hint}`);
        }
        if (!buffer || !buffer.length) return err('图片内容为空');

        // 魔数校验：只认真图。很多"图片链接"其实返回 HTML（防盗链页/错误页）
        const mime = detectMime(buffer);
        if (!mime) {
          const head = buffer.subarray(0, 200).toString('utf8').trim().toLowerCase();
          if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
            return err('这个地址返回的是网页（HTML），不是图片直链。先用 web_fetch 抓那页，再从它返回的 images 里挑一条直链。');
          }
          return err(`这个地址返回的不是图片（Content-Type: ${contentType || '未知'}）。只支持 png/jpg/gif/webp 直链。`);
        }

        const b64 = buffer.toString('base64');
        if (isPreview) {
          st.previews += 1;
          if (!st.previewed.includes(url)) st.previewed.push(url);
          // 问图片格式兼容 Skill：这种格式能不能喂给当前模型。
          // webp/avif 在部分本地视觉接口会直接 400，那会把整轮打挂 ——
          // 比"这轮看不到图"严重得多，所以改成字节校验后让模型自己决定发不发。
          let supported = true;
          try {
            for (const p of moduleManager.getCapabilityProviders('image.mime-support', {})) {
              const r = p.fn({ mime });
              if (r && r.supported === false) supported = false;
              break;
            }
          } catch { /* 能力坏了不影响预览 */ }

          if (!supported) {
            return ok(`这张图是 ${mime}（约 ${Math.round(buffer.length / 1024)}KB）。当前视觉接口不支持 ${mime}，看不到画面内容，但字节已校验过是真图、能正常显示。你觉得合适就直接调 send_image(url) 发出去（URL 照抄：${url}）。`);
          }
          // 预览的 dataUrl 只进模型投喂（llm.js 形状），不进消息存档（E1 口径不变）
          return { content: imageParts(`这张图（${mime}，约 ${Math.round(buffer.length / 1024)}KB）——觉得合适就立刻调 send_image(url) 发出去：`, [`data:${mime};base64,${b64}`]) };
        }

        // Q6+Q8 媒体层改造（脱离计划 Step 6.5）：下载的字节落 mediaStore.put
        // （内容哈希 id，同图天然去重），意图只带 mediaId —— **不再**把 base64 dataUrl
        // 塞进图床/事件流/存档（E1：消息里媒体只存 id）。web 身体把 mediaId
        // 翻译成 SSE broadcast（Chat.vue 经 /api/media/<id> 读图）。
        let saved;
        try {
          saved = await mediaStore.put(buffer, { mime });
        } catch (error) {
          return err(`图片保存到本地媒体库失败：${error?.message ?? error}`);
        }
        // 出站意图（Phase 8b / 拆分表 #7）：身体按 payload.mediaId 翻译；
        // 返回 {message_id} 原形状（坑 #9）。
        const result = await ctx.emit({
          type: 'image',
          payload: {
            mediaId: saved.id,
            note: args.note,
            replyTo: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          },
          urgency: 'normal',
          replyTo: args.replyToMessageId ?? null
        });
        st.sent += 1;
        ctx.session.sent.push({
          type: 'image',
          text: `[图片${args.note ? `:${String(args.note).slice(0, 40)}` : ''}]`,
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        ctx.emit('session-update', ctx.session.id);
        return ok({ sent: true, messageId: result?.message_id ?? null, note: '图片已发送。' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'search_images',
    name: '搜索网图',
    description: '搜网图，直接拿到"能发的图片直链"。用法：先 search_images("关键词") 看列表，再挑一条用 send_image(url) 发出去。被要求"发张图/来点表情/找张照片"时用它。',
    category: 'web',
    icon: '🔎',
    requiresVision: false,
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（越具体越准）' },
        limit: { type: 'integer', description: '最多返回几条，默认 8' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const cfg = getConfig();
        const query = String(args.query ?? '').trim();
        if (!query) return err('query 不能为空');
        const limit = Math.min(12, Math.max(1, Number(args.limit) || 8));

        // 动态取图搜能力：特性检测，避免 web-search 缺这个函数时整个注册就崩
        let searchImages = null;
        try {
          const mod = await import('./web-search.js');
          searchImages = typeof mod.searchImages === 'function' ? mod.searchImages : null;
        } catch { /* 下面统一报错 */ }
        if (!searchImages) {
          return err('图搜能力不可用（web-search 里没有 searchImages）。请用 web_search 找图片页面，再用 web_fetch 拿 images。');
        }

        const list = await searchImages(query, { limit, browseLocked: browseLockState().enabled });
        if (!Array.isArray(list) || !list.length) {
          return ok({ query, results: [], note: '没搜到图。换个更具体的关键词再试一次（最多搜 3 次）。' });
        }
        return ok({
          query,
          results: list.slice(0, limit).map((r) => ({ title: String(r?.title ?? '').slice(0, 60), url: String(r?.url ?? '') })),
          note: '挑一条用 send_image(url) 发出去；url 要整条照抄，不要改。都不贴切就换个更具体的词再搜一次（最多搜 3 次）。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── 视频读取 ──
  registerTool({
    id: 'read_video',
    name: '读取视频',
    description: '读取消息里的视频。会返回时长/分辨率等元信息，并根据设置页的「视频模式」把画面交给模型：原生视频输入（全模态模型）或抽帧截图（普通视觉模型）。适用：对方发了一个视频，你想"看看"里面是什么。需要消息 id（聊天记录里 # 后面那串字符，原样照抄，不要自己编）。',
    category: 'query',
    icon: '🎬',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '那条带视频的消息的消息 id（聊天记录里 # 后面那串字符，原样照抄）' },
        frames: { type: ['integer', 'string'], description: '可选：本次要抽几帧（1~12）。不传用设置页的默认值。' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`在当前会话找不到消息 ${args.messageId}（历史消息没有 #id，或 id 已随旧载体存档失效）`);
        const videoMedia = (entry.media || []).find((m) => m.kind === 'video');
        if (!videoMedia) return err('该消息没有视频（媒体里没有 video 段）');
        if (!ctx.videoReader) return err('视频读取服务未启用');
        const info = await ctx.videoReader.probe(videoMedia, { count: Number(args.frames) || 0 });

        // 元信息（不含画面）单独作为文本返回。
        // ⚠️ 必须把画面字段剥掉再序列化：
        //    以前是把 frameDataUrl（base64 图片）直接塞进这个 JSON 字符串，
        //    结果整张图被当成**文本**送进上下文 —— 模型既看不到图，
        //    又要为几十万 token 的 base64 付钱。画面一律走下面的 parts。
        const metaOut = {
          messageId: entry.mid,
          durationSec: info.durationSec,
          width: info.width,
          height: info.height,
          sizeBytes: info.sizeBytes,
          format: info.format,
          route: info.route,
          routeReason: info.routeReason,
          frameCount: Array.isArray(info.frames) ? info.frames.length : 0,
          frameTimes: info.frameTimes,
          note: info.note || '已读取视频信息。'
        };
        const metaText = JSON.stringify(metaOut, null, 1);

        // 原生视频输入：把视频地址作为 video 部分交给模型（由 llm.js 换成 videoModel）
        if (info.route === 'native' && info.nativeUrl) {
          return {
            content: [
              { type: 'text', text: `${metaText}\n\n（画面已作为视频输入发送）` },
              { type: 'video_url', video_url: { url: info.nativeUrl } }
            ]
          };
        }

        // 抽帧：每一帧作为一个 image 部分交给模型
        if (info.route === 'frames' && Array.isArray(info.frames) && info.frames.length) {
          return {
            content: [
              { type: 'text', text: `${metaText}\n\n（以下 ${info.frames.length} 张是抽帧截图，不是连续视频）` },
              ...info.frames.map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
          };
        }

        // 只给元信息（off / 抽帧不可用 / 全模态模型没配）
        return ok(metaOut);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── 心绪（原 plugins/mind 收编；状态写者 person/mind.js）──────────────
  registerTool({
    id: 'mind_note',
    name: '记下此刻的心绪',
    description:
      '记下你此刻的心绪——这是你跨轮延续的"自己"。mood 是现在的情绪（一句短话，≤20 字，写你真实的情绪）；'
      + 'topics 是还挂在心里、没想完的话题（每条一句话，≤30 字，最多记 3 条，72 小时没续会自己淡掉）。'
      + '**挂心事只挂真没想完的**：在等的一件事、要说的话、没解开的情绪。'
      + '随口起的玩笑、玩过的梗、打趣过的待办（"等他回来吹""明天跟他算账"）**不算心事，别往上挂**——'
      + '挂了它每一轮都会回来找你，一个梗被你反复提，反而变假。'
      + '**只在真的变了、或有新的事挂上来时才记**：心绪还是刚才那样、也没有新心事，就不记——'
      + '同一件事换个说法也算同一件（记了也只会刷新时间），翻来覆去记同一件事会变成回音。'
      + '想通/结束了的话题，用 mind_settle 清掉，别永远背着。',
    category: 'memory',
    icon: '💭',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'string', description: '现在的情绪，一句短话（≤20 字），写你真实的情绪' },
        topics: {
          type: 'array',
          description: '新增的、还挂在心里没想完的话题（每条 ≤30 字）。已经记过的不必重复传。',
          items: { type: 'string' }
        }
      }
    },
    async execute(_ctx, args) {
      try {
        const r = noteMood({ mood: args?.mood, topics: args?.topics, source: 'mind_note' });
        if (!r) return err('记录心绪失败（写入出错），这次没记上。');
        const saved = r.state;
        const list = saved.preoccupations.length
          ? `；挂着的事：${saved.preoccupations.map((t) => t.text).join('；')}`
          : '';
        const tail = r.added === 0 && r.touched > 0 ? '（同一件事，只更新了时间，没多记）' : '';
        return ok(`已记下心绪${saved.mood?.text ? `：${saved.mood.text}` : ''}${list}${tail}。`);
      } catch (error) {
        return err(`记录心绪失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'mind_settle',
    name: '想通了，放下心事',
    description:
      '放下想通了/结束了的心绪话题：传 keyword 匹配话题里包含这个词的；不传就全部放下。'
      + '比如想通了某件一直挂着的事，就 mind_settle 传 keyword=那件事的关键词。也可以顺手更新 mood。',
    category: 'memory',
    icon: '🍃',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要放下的话题关键词；不传 = 放下全部挂着的事' },
        mood: { type: 'string', description: '想通后现在的情绪（可选，≤20 字）' }
      }
    },
    async execute(_ctx, args) {
      try {
        const r = settleMood({ keyword: args?.keyword, mood: args?.mood });
        if (!r) return err('放下心事失败（写入出错）。');
        const left = r.state.preoccupations.length
          ? `；还挂着：${r.state.preoccupations.map((t) => t.text).join('；')}`
          : '；现在没有挂着的事了';
        const kw = String(args?.keyword ?? '').trim();
        return ok(r.removed
          ? `已放下 ${r.removed} 件心事${left}`
          : `没找到包含「${kw}」的心事${left}`);
      } catch (error) {
        return err(`放下心事失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 日记（原日记插件壳收编；存储写者 person/diary.js）──────
  registerTool({
    id: 'write_one',
    name: '在本子上写一条',
    description: '想记点什么的时候，往自己的日记本上写一条。想写一两句就一两句，想摊开写一长段也行。',
    category: 'system',
    icon: '✍️',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要写下来的那一两句，具体一点，不要总结。' },
        title: { type: 'string', description: '（可选）给这条日记取个名字，6~14 个字，像「雨天的画册」。' },
        mood: { type: 'string', description: '（可选）一个词的当下感觉，比如 还行 / 有点闷 / 挺好。不写也行。' }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      const s = getConfig().diary || {};
      if (s.enabled === false) return err('日记本现在是合上的。');
      try {
        const entry = diaryStore.append({ content: args?.content, title: args?.title, mood: args?.mood, source: 'tool' });
        if (s.sendEnabled === true && typeof ctx?.emit === 'function') {
          const configured = String(s.sendTo || '').trim();
          const cid = configured && (/^(web|pet|diary):/.test(configured) || configured === 'main')
            ? configured
            : (ctx?.chatKey || 'main');
          try {
            await ctx.emit({ type: 'text', conversationId: cid, payload: { text: `${entry.title ? `《${entry.title}》\n` : ''}${entry.content}` } });
          } catch { /* 发送失败不影响已写入的日记 */ }
        }
        return ok(`写下了：${entry.time}${entry.title ? `《${entry.title}》` : ''}${entry.mood ? ' · ' + entry.mood : ''}\n${entry.content}`);
      } catch (error) {
        return err(`没写进去：${String(error?.message ?? error)}`);
      }
    }
  });

  registerTool({
    id: 'recent_diary',
    name: '翻自己的日记本',
    description: '看看自己最近写过什么、或者某一天写了什么。适用：主人问「你日记里写了什么」「前几天记了啥」。',
    category: 'system',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '（可选）某一天，YYYY-MM-DD。' },
        limit: { type: 'number', description: '（可选）看最近几条，默认 8。' }
      }
    },
    async execute(_ctx, args) {
      const all = diaryStore.entries();
      if (!all.length) return ok('本子还是空的。');
      const day = String(args?.date ?? '').trim();
      const fmt = (e) => `${e.time}${e.title ? `《${e.title}》` : ''}${e.mood ? ' · ' + e.mood : ''}：${e.content}`;
      if (day) {
        const hit = diaryStore.entriesOn(day);
        return ok(hit.length ? hit.map(fmt).join('\n') : `${day} 那天没写。`);
      }
      const ds = getConfig().diary || {};
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || Number(ds.maxRead) || 8));
      return ok(all.slice(-limit).map(fmt).join('\n'));
    }
  });
}

/** 解析 "HH:MM" 或 "YYYY-MM-DD HH:MM" 为时间戳；解析不了返回 null。 */
function parseAtTime(raw) {
  const s = String(raw || '').trim();
  // YYYY-MM-DD HH:MM；严格校验边界，避免 Date 把 2 月 31 日归一化成 3 月 3 日
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const hour = Number(m[4]), minute = Number(m[5]);
    const d = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (month < 1 || month > 12 || hour > 23 || minute > 59
      || d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
      || d.getHours() !== hour || d.getMinutes() !== minute) return null;
    return d.getTime();
  }
  // HH:MM（今天；若已过则明天）
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = Number(m[1]), minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   // 今天已过 → 明天
    return d.getTime();
  }
  return null;
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.id || d.name,   // 优先用 id（英文标识），兼容旧版 name 字段
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  // 兼容：name 可能是 id（英文标识）或 name（中文显示名）
  const def = defs.find((d) => d.id === name || d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  // E2：工具事件按语境落 surface（计划口径「反射/反思按语境」）——工具跑在某个会话里，
  // 会话路由键前缀即身体（D18）：带 'web:' 前缀的键归 web 身体；裸键/历史前缀键按
  // DEFAULT_SURFACE 归默认身体（surfaces/contracts.js，Q11 起恒 'web'——现网唯一在册
  // 身体）。无 ctx.chatKey（插件直调等无会话语境）→ 缺省空串 ''。
  // （Q14 终审：原三目把非 'web:' 键落旧身体名——与 DEFAULT_SURFACE='web' 的 D18
  //   路由契约相悖；现网路由键恒 'web:main'，该分支休眠，修正为零休眠面偏差。）
  const chatKeyStr = String(ctx?.chatKey ?? '');
  const toolSurface = chatKeyStr ? 'web' : '';
  events.append({ source: 'tool', kind: name, text: '', surface: toolSurface });   // Phase 2 事件日志：解析出工具名后补记（T2.4）
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
