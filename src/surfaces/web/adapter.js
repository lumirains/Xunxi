// web 身体 · adapter（夜间计划 W2，内部文档 web-body-plan.md §5 Step 2 / night-plan-web-body §4 W2；
// Q12 起收薄为"意图翻译"层——night-plan §Q12 Step 9 发送链重写）。
// web 身体：意图 → SSE 广播 + 记档回报。无 QQ、无网络 —— 她的第二副嗓子住在浏览器里。
// 纪律（D28 / 草案 §1.3）：不 import store/person（记忆写入权归大脑，身体只经 onSent
//   交付报告回报）；不 import orchestrator。本文件 import 只有两处：
//   md-to-plain（纯函数，意图载荷归一）+ ./sender.js（发送细节，同目录）。
//   文件系统/存档都发生在装配层（app.js 的 onSent recorder），本文件保持零副作用、
//   离线可测（tools/web-body-test.mjs）。
//
// Q12 分层口径：adapter 只回答"这个意图该调发送链的哪一扇门"，不再关心节奏与重复——
//   text   → sender.sendBatch(cid, 归一分条, { mediaIds })   （分条 gapMs / 指纹去重 /
//           先 onSent 后 broadcast 的顺序铁律全在 sender.js）
//   image  → sender.sendImage(cid, mediaId, note)
//   typing → 直接 broadcast（"正在输入"是输入状态广播，不是消息发送——不进发送链、
//           不去重、无 {sent,failed}）
//
// 形状（草案 §3 五扩展点 #1）：createWebAdapter({ broadcast, onSent, log, dedupeWindowMs }) →
//   { surface, capabilities(), emit(intent), call(method, args) }
//   broadcast = app.js 的 SSE emit 闭包（app.js:586，(type, payload) 形状）；
//   onSent    = 装配层 recorder（app.js:655 同款参数 { chatKey, type, archiveText, messageId, ts }）。
//   dedupeWindowMs = 去重窗口注入口（Q12）：app.js 装配传 () => getConfig().send?.dedupeWindowMs
//   （每次判定现读 config，SendQueue 同参）；本文件自身零 config import（T10 硬前提，
//   见 sender.js 文件头），缺省 8000。
//   （前三参原样透传给 sender 构造，发送边界登记形状不变。）
//
// 返回形状铁律（草案拆分表 #7 / 坑 #9 / D15；tools.js:226 消费）：
//   text/image → { sent:[{text,messageId,at}], failed:[{text?,error}] }（与 archived QQ
//           身体 sendTextBatch 同构，不包 {ok} 信封）；顺序铁律：先 onSent 记档再 broadcast
//           （广播失败不丢档）。去重命中 = 跳过：不广播、不记档、不进 sent 也不进 failed
//           （sent ↔ broadcast ↔ 存档 1:1 不变式保持）。
//           Q6+Q8：payload.attachments（[{mediaId}]，send_message 媒体层）在翻译层解出
//           mediaIds 交给 sender，随最后一条实际发出的分条广播（存档只落文本，E1 不进 base64）。
//   image → payload.mediaId = mediaStore 内容哈希 id（Q6+Q8 新分支：broadcast
//           ('chat-message',{...,mediaIds:[id]})，Chat.vue 渲染 <img src="/api/media/<id>">）。
//   typing → { ok:true }（web 前端"正在输入"三点动画的事件源）。
//   其它 type → { ok:false, error:'unsupported type' }，不抛（contracts.js 文件头第 2 条：
//   词表个体，身体收到不认识的 type 返回不可用标记而不是崩溃）。
//   call() → { ok:false, error:'web 身体不支持读回' }，不抛（web 是纯出站身体，无读回）。
//
// 能力表是真诚的能力声明（canSticker:false——她"没有表情包这副嗓子"；maxTextLength:8000
// 是浏览器气泡的余量，不是 QQ 的 4500）。它与"工具被关掉"是两回事：能力表用于握手，
// 工具可见性由 surface 标注决定（night-plan-web-body D1，W1 已落）。
//
// V2 语音条 TTS（voice-walkie；architecture-v3 §8.A 第四批准口）：createWebAdapter
//   增可选注入参数 tts（async (text) => { mediaId, mime } | null）——app.js 装配传入
//   （动态 import capabilities/voice.js 的闭包；闸/熔断/超时全在 voice.js 内）。本文件
//   保持零 config import（T10 硬前提不变）：测试不传 tts = 行为与 V0 逐字节一致；
//   传了则 sendBatch 每段在 onSent/broadcast 之前合成——成功该段 onSent 载荷带
//   media=[{kind:'audio',id}] 且 broadcast 载荷带 audioIds:[id]，失败该段纯文字继续。
import { mdToPlain } from '../../md-to-plain.js';
import { createWebSender } from './sender.js';

export function createWebAdapter({ broadcast, onSent, log = () => {}, dedupeWindowMs, tts } = {}) {
  if (typeof broadcast !== 'function') throw new Error('createWebAdapter：缺少 broadcast');
  if (typeof onSent !== 'function') throw new Error('createWebAdapter：缺少 onSent');

  // 发送链实例（Q12）：每个 adapter 一份 sender——去重窗口随之按身体实例隔离
  // （测试内新建 adapter 即全新窗口，mock-adapter/web-body-test 的用例隔离不受影响）。
  const sender = createWebSender({ broadcast, onSent, log, dedupeWindowMs, tts });

  return {
    surface: 'web',

    capabilities() {
      return {
        surface: 'web',
        // canVoice:true（V2 · voice-walkie 语音条）：文字分条带可播放语音气泡
        // （TTS 合成经第四批准口 voice.tts.synthesize，闸在 config.voice 缺省关——
        // 能力声明=链路已通，开关状态是配置面不是能力面）。
        canText: true, canVoice: true, canImage: true,
        canSticker: false, canAnimate: false, canTyping: true,
        maxTextLength: 8000, supportsReply: true
      };
    },

    async emit(intent) {
      const type = String(intent?.type ?? '');
      const cid = String(intent?.conversationId ?? '');
      if (!cid) return { ok: false, error: 'web.emit：缺 conversationId' };

      if (type === 'text') {
        const raw = intent?.payload?.text ?? intent?.payload?.messages;
        const list = (Array.isArray(raw) ? raw : [raw])
          .map((m) => mdToPlain(String(m ?? '')).trim())
          .filter(Boolean);
        if (!list.length) return { sent: [], failed: [{ error: '消息内容为空' }] };

        // Q6+Q8 媒体层：payload.attachments（send_message 的 [{mediaId}])在翻译层解出
        // mediaIds 交给 sender——随最后一条实际发出的分条广播（媒体跟话走，不逐条复读）。
        const mediaIds = (Array.isArray(intent?.payload?.attachments) ? intent.payload.attachments : [])
          .map((a) => String(a?.mediaId ?? '')).filter(Boolean);
        // V2 语音条：tts 注入（缺省 undefined = 零 TTS 行为，测试离线口径）逐段透传
        // ——每段在 onSent/broadcast 之前合成（顺序铁律不变，见 sender.sendBatch）。
        return sender.sendBatch(cid, list, { mediaIds, tts });
      }

      if (type === 'image') {
        // Q6+Q8 媒体层新分支（night-plan §Q6+Q8）：payload.mediaId（send_image 落
        // mediaStore 后的内容哈希 id）→ sender 广播图片消息。存档文本只落 note/占位符，
        // 不落字节（E1）。缺 mediaId 在翻译层拒收（body 只认内容哈希 id）。
        const mediaId = String(intent?.payload?.mediaId ?? '');
        if (!mediaId) return { sent: [], failed: [{ error: 'image 意图缺 mediaId（媒体层 Q6+Q8 起 body 只认内容哈希 id）' }] };
        const note = String(intent?.payload?.note ?? '').trim();
        return sender.sendImage(cid, mediaId, note);
      }

      if (type === 'typing') {
        broadcast('chat-typing', { conversationId: cid, on: intent?.payload?.on !== false });
        return { ok: true };
      }

      return { ok: false, error: 'unsupported type' };
    },

    async call() {
      return { ok: false, error: 'web 身体不支持读回' };
    }
  };
}
