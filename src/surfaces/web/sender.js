// web 身体 · 发送链（Q12 · night-plan §Q12 Step 9 发送链重写）。
// 从 adapter.js 提取的发送细节：分条节奏 gapMs、内容指纹去重（对齐 SendQueue #isDuplicate
// 口径——legacy/sender-qq.js:95-139：窗口内 `<存储键>::<text>` 指纹、0=明确关闭、
// 成功后才记账、失败允许重试）、SSE broadcast、onSent 交付报告。
// adapter 只做"意图翻译"（intent → sender 调用），发送节奏/去重/广播顺序都归这里。
//
// 纪律（沿袭 adapter D28 口径）：不 import store/person（记忆写入权归大脑，身体只经
// onSent 交付报告回报）；不 import orchestrator；不 import config.js、不写文件系统
// （记档在装配层 app.js 的 onSent recorder）——config 读数走**装配注入**（见下），
// 这也是 web-body-test T10 的硬前提：config.js 的 DATA_DIR 在模块体执行期就解析
// XUNXI_DATA_DIR（旧名 QQ_AGENT_DATA_DIR 兼容，config.js 顶部），谁在 import 期把 config.js 拉进模块图，谁就会把
// 测试内"切沙箱再新 import store.js"的回归口径钉死在第一个沙箱上。
// 唯一 import 是 registry.js 的 PREFIX_ROUTES 前缀表（纯数据冻结对象，单一真源：
// orchestrator routeKeyOf 推导路由键用同一张表，这里反向剥前缀还原存储键）。
//
// 去重窗口的注入口径（SendQueue #dedupeWindow 语义保持）：构造参数 dedupeWindowMs 收
//   · 函数 —— 每次判定时调用（app.js 装配传 () => getConfig().send?.dedupeWindowMs，
//     与 SendQueue"每次发送读 config"逐次同参：UI 改窗口立即生效）；
//   · 数值 —— 直接采用（测试注入用；30ms 窗口/0 关闭都可离线构造）；
//   · 缺省 —— 8000（DEFAULT_CONFIG.send.dedupeWindowMs 同值）。
//   0 是明确的关闭值，不能用 `|| 8000` 把它误当默认值（SendQueue 注释原话）。
//
// 去重指纹用**存储键**而不是路由键（Q12 口径）：'web:main'（出站 intent.conversationId
// 的路由键形态）与裸 'main'（/api/web 缺省、提醒/主动开口直落 DEFAULT 身体的形态）
// 指的是同一条单一时间线（Q10 chatKey 收敛），前缀不同不该互相漏挡——剥前缀后都归 'main'，
// 指纹 = `main::${text}`。
//
// 去重命中 = "跳过不记档"语义（SendQueue 同款）：不广播、不交 onSent 报告、不进 sent、
// 也不算 failed（不是失败，重试无意义）。web 身体自 W2 起的不变式保持成立：
// sent ↔ broadcast ↔ 存档 一一对应（web-body-test T2c/T3b、mock-adapter E4 断言的正是它）。
//
// 返回形状铁律不变（坑 #9 / 草案拆分表 #7，tools.js:226 消费）：
//   sendBatch/sendImage → { sent:[{text,messageId,at}], failed:[{text?,error}] }，
//   与 archived QQ 身体 sendTextBatch 同构，不包 {ok} 信封。
//   顺序铁律：每条先 onSent 记档再 broadcast（广播失败不丢档）。
//
// 节奏：分条 gapMs 沿用 W2 的"打字时间人味复刻"公式（首条 0、后续 min(1800, 260+字数×26)）。
// Q12 实测校准（W7 遗留 #6）：main.json 历史批内间隔 608 样本中位数 1685ms（p25 295 /
// p75 4309），现行上限 1800ms 已落在实测中位数附近——常数不改（计划"保持现状优先"）；
// web 分条不读 config.send 的限速键（QQ 身体的限速六键随身体归档、清债夜2 已删）；
// send.dedupeWindowMs 由装配层注入本文件（去重窗口见下），本文件自身
// 零 config 依赖。
//
// V2 语音条 TTS（voice-walkie；§8.A 第四批准口）：构造参数增可选 tts（async (text) =>
//   { mediaId, mime } | null，app.js 装配注入——voice.tts.synthesize 闭包，闸/熔断/
//   超时全在 capabilities/voice.js 内，本文件零 config import 不变）。sendBatch 每个计划
//   分条在 onSent/broadcast 之前合成：成功 → 该段 onSent 载荷带 media=[{kind:'audio',id}]
//   （存档同条同档，E1 只存 id）且 broadcast 载荷带 audioIds:[id]；失败/null → 该段
//   纯文字继续（不抛不整段失败）。不传 tts = 零 TTS 行为（mock-adapter/web-body-test
//   离线口径与 V0 逐字节一致）。被去重跳过的分条不合成（只对实际发送的计划分条合成）。
import { PREFIX_ROUTES } from '../registry.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 分条节奏：按字数估算"打字时间"，首条立即发（W2 公式原样，Q12 实测校准后维持）。 */
const gapMs = (text, isFirst) =>
  isFirst ? 0 : Math.min(1800, 260 + String(text).length * 26);
const clock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });

export function createWebSender({ broadcast, onSent, log = () => {}, dedupeWindowMs, tts } = {}) {
  if (typeof broadcast !== 'function') throw new Error('createWebSender：缺少 broadcast');
  if (typeof onSent !== 'function') throw new Error('createWebSender：缺少 onSent');

  // 发送去重窗口："chatKey::text" -> ts（SendQueue recentSent 同款）。
  const recentSent = new Map();

  /**
   * 去重窗口毫秒数（SendQueue #dedupeWindow 口径逐行对齐）：
   * 注入函数/数值优先（app.js 装配传 () => getConfig().send?.dedupeWindowMs，
   * 每次判定现读 config = SendQueue 同参；测试可直接注数值）；0 是明确的关闭值，
   * 不能用 `|| 8000` 把它误当默认值；缺省/非数值回落 8000。
   */
  const dedupeWindow = () => {
    const raw = typeof dedupeWindowMs === 'function' ? dedupeWindowMs() : dedupeWindowMs;
    if (raw === null || raw === undefined || raw === '') return 8000;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : 8000;
  };

  /**
   * 路由键 → 存储键：剥身体前缀（前缀表取自 registry.PREFIX_ROUTES 单一真源）。
   * 'web:main' → 'main'；裸 'main' → 'main'（无前缀原样）；'pet:x' → 'x'（未来身体同规）。
   */
  const storageKeyOf = (conversationId) => {
    const k = String(conversationId ?? '');
    for (const prefix of Object.keys(PREFIX_ROUTES)) {
      if (k.startsWith(prefix)) return k.slice(prefix.length);
    }
    return k;
  };

  /**
   * 只读判断：窗口期内是否已发出过相同内容（SendQueue #isDuplicate 口径）。
   * ⚠️ 绝不在发送前记账 —— 广播抛错的消息必须允许重试，提前记账会把合法重试
   * 误判为重复、导致消息静默丢失。
   */
  const isDuplicate = (storageKey, text) => {
    const win = dedupeWindow();
    if (!win) return false;
    const last = recentSent.get(`${storageKey}::${String(text)}`);
    return Boolean(last && Date.now() - last < win);
  };

  /** 发送成功后记账（去重指纹；顺手清理过期条目，避免 Map 无限增长——SendQueue 同款）。 */
  const markSent = (storageKey, text) => {
    const win = dedupeWindow();
    if (!win) return;
    const now = Date.now();
    recentSent.set(`${storageKey}::${String(text)}`, now);
    if (recentSent.size > 500) {
      for (const [k, t] of recentSent) {
        if (now - t > win) recentSent.delete(k);
      }
    }
  };

  return {
    /**
     * 发送一批文本分条（adapter text 分支的唯一落点）。
     * @param {string} conversationId 路由键（'web:main' / 裸 'main'），广播载荷与
     *        onSent 报告原样透传，去重指纹按其存储键归一。
     * @param {string[]|string} texts adapter 归一后的纯文本分条数组（mdToPlain + 去
     *        空白已在上游完成；空列表在 adapter 层就拒收，这里兜底同款标记）。
     * @param {{mediaIds?: string[]}} opts mediaIds（send_message attachments 的内容
     *        哈希 id）随**最后一条实际发出**的分条广播（媒体跟话走，不逐条复读）；
     *        末条若被去重跳过，媒体跟末条发送位前移——媒体永不静默丢失。
     * @returns {{sent, failed}} 形状铁律见文件头。
     */
    async sendBatch(conversationId, texts, { mediaIds = [] } = {}) {
      const list = (Array.isArray(texts) ? texts : [texts]).map((m) => String(m ?? ''));
      if (!list.length) return { sent: [], failed: [{ error: '消息内容为空' }] };
      const storageKey = storageKeyOf(conversationId);

      // 计划先行：整批的去重判定一次算清（窗口状态取计划时刻快照 + 批内复读本地判重，
      // 与"逐条发送时记账"的判重结果一致——先发的条目即时进入窗口）。
      // 末条发送位由计划决定，mediaIds 不会因末条被去重而静默丢媒体。
      const win = dedupeWindow();
      const plan = [];
      for (let i = 0; i < list.length; i += 1) {
        const text = list[i];
        if (win && isDuplicate(storageKey, text)) {
          log(`[web-sender] 跳过重复消息（${win}ms 内已发过相同内容）：${text.slice(0, 30)}`);
          continue;
        }
        if (win && plan.some((j) => list[j] === text)) {
          // 批内复读判重同样受窗口开关约束（0=关闭去重时批内复读照发，语义完全关闭）。
          log(`[web-sender] 跳过批内复读消息：${text.slice(0, 30)}`);
          continue;
        }
        plan.push(i);
      }

      const sent = [];
      const failed = [];
      for (let p = 0; p < plan.length; p += 1) {
        const i = plan[p];
        const text = list[i];
        const isLastDelivered = p === plan.length - 1;
        await sleep(gapMs(text, p === 0));
        // V2 语音条：该段在 onSent/broadcast 之前合成（第四批准口 voice.tts.synthesize
        // 经装配注入的 tts 闭包；失败/关闭/熔断 → null → 纯文字继续，不抛不整段失败）。
        let audio = null;
        if (typeof tts === 'function') {
          try {
            audio = await tts(text);
          } catch (error) {
            audio = null;   // 注入闭包自身的异常同按失败处理（与 synthesize 不抛语义对齐）
            log(`[web-sender] TTS 合成异常（该段纯文字继续）：${String(error?.message ?? error)}`);
          }
        }
        // E1：存档 media 只存 id（media-store 内容哈希）；元素形状 {kind,id} 与
        // 入站 attachments/entryAudioIds 消费面同款（routes.js/orchestrator 实锚）。
        const audioMedia = audio?.mediaId ? [{ kind: 'audio', id: audio.mediaId }] : null;
        const ts = Date.now();
        const messageId = `web-${ts}-${i}`;   // 下标保留输入位次（形状与 W2 版逐字节一致）
        const idsOut = (isLastDelivered && mediaIds.length) ? mediaIds : undefined;
        // 2026-11-19 修：图片 id 也要落档。原实现只落 audioMedia，图片只写进 archiveText 的
        // "[图片]" 字样 → 刷新/重启后图就没了（她的图走 send_message attachments = 本函数，
        // 不是 sendImage，所以昨天只补 sendImage 没有覆盖这条）。顺序：图在前、语音在后。
        const imageMedia = (idsOut ?? []).map((id) => ({ kind: 'image', id }));
        const archiveMedia = (imageMedia.length || audioMedia) ? [...imageMedia, ...(audioMedia ?? [])] : null;
        try {
          // 顺序铁律：先记档再广播（广播失败不该丢档）。存档只落文本与媒体 id（E1：
          // 字节只在 media-store），mediaId/audioIds 只进 SSE 载荷（前端
          // 经 /api/media/<id> 读图/读音频）。
          onSent({
            chatKey: conversationId, type: 'text',
            archiveText: idsOut ? `${text} [图片]` : text, messageId, ts,
            ...(archiveMedia ? { media: archiveMedia } : {})
          });
          broadcast('chat-message', {
            conversationId, role: 'self', text, ts, messageId,
            ...(audioMedia ? { audioIds: [audio.mediaId] } : {}),
            ...(idsOut ? { mediaIds: idsOut } : {})
          });
          markSent(storageKey, text);   // 只有 onSent+broadcast 都成功后才记入去重窗口
          sent.push({ text, messageId, at: clock(ts) });
        } catch (error) {
          failed.push({ text, error: String(error?.message ?? error) });
        }
      }
      return { sent, failed };
    },

    /**
     * 发一张图片（adapter image 分支的唯一落点；Q6+Q8 媒体层语义原样迁移）。
     * payload.mediaId = mediaStore 内容哈希 id → SSE 广播图片消息（Chat.vue 渲染
     * <img src="/api/media/<id>">）。存档文本只落 note/占位符，不落字节（E1）。
     * 去重按 `__img__<mediaId>` 指纹（SendQueue sendImage 同款 __img__ 前缀口径；
     * mediaId 是内容哈希，天然唯一键）——模型对同一张图连发两次时第二次跳过。
     */
    async sendImage(conversationId, mediaId, note = '') {
      const storageKey = storageKeyOf(conversationId);
      const fingerprint = `__img__${mediaId}`;
      if (isDuplicate(storageKey, fingerprint)) {
        log(`[web-sender] 跳过重复图片（${dedupeWindow()}ms 内已发过同一张图）：${mediaId.slice(0, 12)}`);
        return { sent: [], failed: [] };
      }
      const ts = Date.now();
      const messageId = `web-${ts}-img`;
      try {
        // 顺序铁律同 text：先记档再广播。
        // E1：存档只存 id（media=[{kind:'image',id}]），字节留在 media-store；
        // 不带 media 会让消息只剩 '[图片]' 占位文本，重启后她的图就消失
        // （2026-11-18 修复：原实现漏传 media，与 text 分支的 audio 落档口径不一致）。
        onSent({
          chatKey: conversationId, type: 'image', archiveText: `${note || '[图片]'}`,
          messageId, ts, media: [{ kind: 'image', id: mediaId }]
        });
        broadcast('chat-message', {
          conversationId, role: 'self', text: note, ts, messageId, mediaIds: [mediaId]
        });
        markSent(storageKey, fingerprint);
        return { sent: [{ text: note, messageId, at: clock(ts) }], failed: [] };
      } catch (error) {
        return { sent: [], failed: [{ text: note, error: String(error?.message ?? error) }] };
      }
    }
  };
}
