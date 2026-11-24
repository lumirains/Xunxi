// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 开始时把所有消息标记为已读（触发批作为【未读信息】）→ agent 用工具发言/决定不发言
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
//
// Q9（night-plan §Q9）群聊分支摘除：
//   · 收到即唤醒 —— onIncoming 不再逐条判定"该不该回"（档位/掷骰/@ 权重/关键词
//     随群聊消亡，prompt.js 的同名判定纯函数整个删除，grep 全 src/ = 0）；
//   · effectiveTier 固定 tier-4 语义（见 EFFECTIVE_TIER 常量）；
//   · 禁言检测（#checkSelfMuted）与群名片缓存（#chatName）随旧载体退出摘除；
//   · 主动开口（startProactiveLoop/#proactiveCandidates）保留——"她想说话"属人格。
import { getConfig, personaForChat } from './config.js';
import { vendorOfConfig } from './model-prices.js';
import { randInt } from './util.js';
import { buildSystemPrompt, buildUserPrompt } from './prompt.js';
// P16（2026-11-20）：跨轮思考注入（只读派生：上一条已结束会话的【深度思考】→ user 尾部）。
import { buildTransitionSection } from './transition.js';
import { chatCompletionWithRetry, addUsage, isRetryableError } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool } from './tools.js';
import { modelImageVerdict } from './vision-scan.js';
import { currentProviders } from './providers.js';
import { moduleManager } from './modules/manager.js';
import { getToolAvailability } from './tool-registry.js';
// 身体层出站接线（Phase 8b · 草案 §7.1 接线点 #2）：registry 单例与 app.js 装配处
// 注册 web 身体用的是同一个实例 —— 身体未注册时 route 抛错（接线错误要响，不静默兜底）。
// Q10：PREFIX_ROUTES 一并取来——routeKeyOf 推导路由键用同一张前缀表（单一真源）。
import { registry, PREFIX_ROUTES } from './surfaces/registry.js';
import { rescueUnsentReply } from './reply-rescue.js';
// ── 步骤⑤（T5.1）：钟 + 反思执行器 ──
// 钟是皮层唯一的调度原语（kernel/clock，不含业务词表）；check/run 由反思执行器提供。
// cards.js 是第一个 ReflectionSpec 声明模块，import 即注册进执行器（同 id 重复注册会抛错）。
// 步骤⑥（T6.2/T6.3）：钟改为进程级默认钟（getDefaultClock）——日记/日程等子系统
//（reflection diary/life）经同一实例 registerTick 交钟，避免多实例多心跳把"唯一的钟"架空。
import { getDefaultClock } from './kernel/clock.js';
import { dueCount as reflectionDueCount, runDue as reflectionRunDue } from './capabilities/reflection/executor.js';
import './capabilities/reflection/cards.js';
// card-vector 夜2 T2.3：预取查询向量（submit 入库后单飞 + wake 兜底一发）与 #runAgent
// 读缓存组装 vectorHits——fire-and-forget，全程无新增 await 进组装路径（D4 v2 口径）。
import { cardIndex } from './capabilities/reflection/card-index.js';
// Q15（原日记插件 tick 收编）：灵魂/存储已在 capabilities/person，
// 这里只把“到点检查 + 起一次念头”注册到既有钟上；不新建 timer。
import { checkDue as diaryCheckDue, runDiary as diaryRun } from './capabilities/reflection/diary.js';
// night-plan-life §L3（生活→心绪接线）：life 声明模块自带消费接线（check/run），
// 同样只注册不实现——今日日程里的 emotionalLoad 条目过点即拨心绪数值轴并标 consumedAt。
import { checkDue as lifeCheckDue, consumeDue as lifeConsumeDue } from './capabilities/reflection/life.js';
// Q15（上下文预算收编）：历史裁剪 / 工具结果截断，纯函数，失败静默。
import { trimHistory, trimToolResult } from './context-budget.js';
// P2（night-plan §5.2）：brain.submit 写路径的入库成功记账与 app.js 旧路径同源
//（同一 events 事件日志，source:'chat'/kind:'message_in'，不加第二套）。
import { events } from './kernel/events.js';

/**
 * Q10 chatKey 收敛（night-plan §Q10）：存储键与路由键分离。
 *
 *   · 存储键 = 'main'（单一时间线）：store（main.json）、session 记录（chatKey:'main'）、
 *     kv 行 transition（旧布局 main.json）、/api/web 端点缺省 cid——全部数据层落点。
 *   · 路由键 = 身体前缀 + 存储键（'web:main'）：registry 前缀路由保留（pet:/diary:/web:
 *     是身体路由机制不是会话隔离，白皮书 7.5），intent.conversationId 保持路由语义——
 *     web adapter 的 broadcast cid 与前端 Chat.vue 的 CID='web:main'、SSE 过滤都按它。
 *
 * 入站 InboundEvent.conversationId 收**存储键**（web 端点缺省传 'main'），event.surface
 * 指出身体 → submit 据此推导路由键，供全部 registry.route / 出站语义使用。无前缀路由的
 * 身体或无 surface 的入口（积压恢复/主动开口等存储层来源，拿到裸存储键）原样透传，
 * registry.route 落 DEFAULT_SURFACE（Q11 起为 'web'，裸键自然路由 web 身体）。
 */
const routeKeyOf = (cid, surface) => {
  const k = String(cid ?? '');
  const pfx = `${String(surface ?? '')}:`;
  return surface && PREFIX_ROUTES[pfx] && !k.startsWith(pfx) ? `${pfx}${k}` : k;
};

/**
 * Q9：effectiveTier 固定 tier-4 语义的常量。
 *
 * 旧链路里 wake 实跑会对触发批重算一次档位判定（prompt.js 纯函数，Q9 删）；
 * 存活会话在旧判定里本就命中第一条短路分支——`isPrivate →
 * { tier: 4, count: historyCount(), reason: '私聊消息', shouldRespond: true }`，
 * 配置的档位/掷骰/关键词对私聊从不生效。
 * 群聊消亡后判定无输入，常量即旧行为：
 *   · count = tier-4 的读取条数 = store.historyCount 的出厂缺省值 **80**
 *     （来源：config.js DEFAULT_CONFIG.store.historyCount: 80，"2026-09-25 改版：
 *     四档统一读 historyCount，旧分档字段废弃"；真实数据根 data/config.json
 *     store.historyCount=80 同值，Q9 实读核对）。运行时不再读 store 段——
 *     per-chat 滑条换算（清债夜2 已随档位子系统删除）只影响档位/随机百分比
 *     对群聊的取值，从不影响 historyCount，写死不引入行为差。
 *   · reason 沿用旧私聊分支文案 '私聊消息'（session.contextReason 落账一致）。
 */
const EFFECTIVE_TIER = { tier: 4, count: 80, reason: '私聊消息', shouldRespond: true };

export class Orchestrator {
  // E5（夜间交接计划 Q1）：触发源登记——submit(event) 按**路由键**登记 event.id，
  // 出站意图构造点（typing start/stop、ctx.emit、#fireReminder）按各自 chatKey 查表，
  // 补 sourceEventId 指回触发源。清债夜3 per-routeKey 化（评审 P2-6①）：原先进程级
  // 单值字段在并发多会话下互相覆盖，现挂到会话粒度。E5 语义保持：无 submit 语境 = null
  // （无登记 / wake finally 或 abortAll 已清理时查表落空 → null）。
  #eventIds = new Map();   // routeKey -> 触发源 InboundEvent.id（submit 登记处并行登记）

  constructor({ store, stickers, sessions, emit = null, reminders = null, videoReader = null }) {
    this.store = store;
    this.stickers = stickers;
    this.sessions = sessions;
    // Q11（night-plan §Q11）：发送队列/协议端句柄持有摘除——旧身体归档后
    // 出站唯一通道是 registry.route().emit（身体意图层），编排器不再持有任何发送/
    // 协议句柄。#emitOutbound 的 sender 直连回滚分支同批死亡（见该方法注释）。
    this.reminders = reminders;   // ReminderStore（可选；闹钟/计时功能）
    this.videoReader = videoReader; // VideoReader（可选；视频读取功能）
    // 钟（步骤⑤ / T5.1；步骤⑥改为进程级默认钟）：皮层唯一的调度原语。反思执行器等
    // 子系统的 tick 在 startClock() 登记；钟本身不含任何业务词表（v3 §3 B 类耦合上限）。
    this.clock = getDefaultClock();
    // 事件出口：正常情况下由 app.js 注入（转发到 SSE）。
    // 兜底必须是**明确的 no-op** —— 早先用 createEventBus() 兜底，
    // 但那个总线上永远没人订阅，事件会被静默吞掉，排查时看不到任何线索。
    this.emit = typeof emit === 'function' ? emit : () => {};
    this.toolDefs = buildToolDefs();

    this.wakeTimers = new Map();       // chatKey -> timer
    // 未读兜底定时器（2026-09-18）：旧档位机制下"没触发会话"的散消息的兜底清理。
    // Q9 起收到即唤醒、无档位判定，不再产生"挂着的假未读"，本表只服务于
    // #cancelUnreadFallback 的空实现兼容（abortSession/abortAll 清理路径），不再有写入方。
    this.unreadFallbackTimers = new Map(); // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.pendingSessions = new Map();  // chatKey -> waiting sessionId（防抖期可见的“等待中”会话）
    this.verifiedWakes = new Set();    // 本轮 wake 由 onIncoming"收到即唤醒"排定的 chatKey（区别于 drain/重试/积压恢复等机械重排）
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.sessionAbortMarks = new Set(); // 用户请求中止的 sessionId（abortSession 打标记，#runAgent 每轮检查）
    this.sessionAbortControllers = new Map(); // sessionId -> AbortController（中止时中断在途 LLM 请求）
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    // ── 提示词锚点（前缀缓存深化，2026-09-25）──
    // chatKey -> { readIds, readCount, memberIds }：上一轮发给模型的
    // 【记忆】+【已读信息】前缀状态。下一轮 buildUserPrompt 据此判断能否
    // 原样复用该前缀（连续触发时缓存命中）。#runAgent 结束时从
    // session.promptAnchorState 取回新状态。重启丢失 = 回到标准结构，无害。
    this.promptAnchors = new Map();
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.aborted = false;
    this.reminderTimer = null;         // 提醒调度定时器
    this.reminderFiring = new Set();   // 防止同一提醒并发触发
    // ── "对方正在输入…"（仅私聊）──
    // chatKey -> interval：运行期间保持输入状态的刷新定时器。
    // 旧协议端的输入状态会在若干秒后自动消失，所以不是"开始发一次就完事"，
    // 必须按 refreshMs 持续续期，否则长推理（本地模型 20~30 秒）后半段会自己灭掉。
    this.typingTimers = new Map();
    // 协议端不支持/未实现时置位：整个进程不再尝试，避免每个会话刷一遍同样的错误日志。
    this.typingUnsupported = false;
    // ── brain.submit（P2 · night-plan §5.2，草案 §2.4）──
    // chatKey -> io：submit(event, io) 登记的出站通道（调用方=身体/装配层构造，
    // io.emit 的落点是 registry）。#emitOutbound 优先走它——本次提交触发的那轮
    // 运行里，大脑"命令身体"的语义（io.emit）落到实处；无 io 时回落 registry 直连
    //（与 P1 逐字节一致）。
    this.submitIo = new Map();
  }

  /**
   * 重新读取工具定义。
   *
   * 为什么需要它：构造函数里 `buildToolDefs()` 抓的是一次快照，
   * 而 Skill 是**启动之后**才加载的（loadPlugins 在 start() 里，晚于 Orchestrator 构造）。
   * 不刷新的话，Skill 注册的工具永远进不了会话的工具列表 —— 表现为
   * "插件加载成功但模型看不见"这种最难查的问题。
   * 热重载之后也要再调一次。
   */
  refreshToolDefs() {
    this.toolDefs = buildToolDefs();
    return this.toolDefs.length;
  }

  // ── 出站统一口（P1 · night-plan §4.1/§4.6）────────────────────────────
  /**
   * 所有出站意图的唯一出口。调用点：
   *   · ctx.emit（#runAgent 工具上下文，内置工具的发送）
   *   · #fireReminder（提醒）
   *   · #typingStart / #typingStop（输入状态反射）
   * 全部收敛到这里 —— 身体未注册时 registry.route 抛错（接线错误要响，不静默兜底）。
   *
   * 回滚开关 config.surface.intents 已随旧身体归档摘除（Q11）：false → 旧直连路径
   * （text → sender.sendTextBatch、typing → 协议端输入状态）的分支只曾存在于本方法
   * 与 app.js routeOutboundText 两处（坑 #8 口径），两处随身体一并死亡——出站自 P1
   * 起就是单路径，不再有开关。
   */
  #emitOutbound(chatKey, intent) {
    const cid = intent?.conversationId ?? chatKey;
    // P2（night-plan §5.2）：submit(event, io) 登记的 io 是本次提交触发运行的出站通道
    //（草案 §2.4：io.emit 是大脑"命令身体"的唯一方式）。io.emit 的落点仍是 registry
    //（app.js / cli-body 构造的 io 都经 registry.route 路由；M1/D19：conversationId
    // 在这里补齐，显式不覆盖）——未登记 io（提醒/积压/主动等无 submit 路径）时与
    // P1 的直连 registry 行为逐字节一致。
    // E5：sourceEventId 由四个构造点（typing start/stop、ctx.emit、#fireReminder）在
    // intent 上盖好后到达这里，下面的 spread 原样透传给 io.emit / registry，不覆盖、
    // 不补默认（缺了就是缺了——构造点负责）。
    const io = this.submitIo.get(chatKey);
    if (io && typeof io.emit === 'function') {
      return Promise.resolve(io.emit({ ...intent, conversationId: cid }));
    }
    return registry.route(cid).emit({ ...intent, conversationId: cid });
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0);
    }
  }

  /**
   * 手动重试一条失败的会话（会话页「重试」按钮）。
   *
   * ⚠️ 原地覆盖语义（2026-09-17 用户需求）：**复用同一个会话对象**，不新开。
   * 之前的做法是把触发消息翻回未读再 scheduleWake —— 那会创建一个全新会话，
   * 用户在会话页看到"旧的失败条目 + 新的成功条目"两条记录，账面（该看哪条）
   * 混乱。现在：直接把原会话重置回 running 状态、原对象重跑，全程同一个 id。
   *
   * 做法：恢复触发批（时间窗内翻回未读后重新 drain，拿到的就是当初那批消息）
   * → 复用与自动重试相同的 #resetSessionForRetry 清状态 → 重新走完整 wake 流程。
   * 唤醒流程里的"把等待会话转运行"分支会接住这个 running 状态的会话对象。
   *
   * ⚠️ 只有满足以下条件才允许重试：
   *   · 会话存在且状态是 error（aborted/noreply 不算失败，done 已成功）
   *   · 会话没有发出过任何消息（session.sent 为空）—— 已经说过话的
   *     重试会导致群里看到两遍一样的内容，宁可不允许
   *   · 该会话当前没有正在跑的新运行
   *
   * @returns {{ok:boolean, reason?:string, restored?:number}}
   */
  retrySession(sessionId) {
    const id = String(sessionId || '');
    // 先查 current（运行中/刚复活的），没有再查磁盘留档 —— finish() 会把会话
    // 从 current 移除，"已结束的失败会话"只在磁盘上。只查 current 的话，
    // 每次手动重试都会报"会话不存在"（2026-09-19 修）。
    const s = this.sessions.current.get(id) || this.sessions.get(id);
    if (!s) return { ok: false, reason: '会话不存在' };
    if (s.status !== 'error') return { ok: false, reason: '只有失败的会话才能重试' };
    if (Array.isArray(s.sent) && s.sent.length > 0) return { ok: false, reason: '该会话已发出过消息，重试会导致重复发言' };
    if (this.runningChats.has(s.chatKey)) return { ok: false, reason: '该会话正在运行中' };
    // 把触发批重新标记为未读（消息本体一直在存档里，只是当初被 drain 置了已读）。
    // triggerText 里的文本可能因改名/截断对不上，按会话起止时间窗恢复更稳。
    const restored = this.store.markUnreadInWindow(s.chatKey, s.startedAt, s.endedAt || s.startedAt);
    if (!restored) return { ok: false, reason: '触发消息已无法定位（时间窗内没有可恢复的消息）' };
    // ⚠️ 必须先从 current 注册表"复活"这个已结束的会话：
    // finish() 会把会话从 current 移除（get() 只剩磁盘读取的副本），
    // 后续 #runAgent / markActivity / abortSession 全都靠 current 里的活对象工作。
    // 复活 = 重新放回 current + 重置状态；磁盘文件会在下一次 update 覆盖。
    this.#resetSessionForRetry(s);
    s.status = 'running';
    s.endedAt = null;
    s.startedAt = Date.now();
    this.sessions.current.set(id, s);
    this.sessions.update(id);
    this.emit('session-update', id);
    this.scheduleWake(s.chatKey, 0, { reuseSessionId: id });
    return { ok: true, restored };
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /**
   * 收到新消息（已写入 store）。
   *
   * 触发语义（Q9 重做，night-plan §Q9"收到即唤醒"）：**不再判定"该不该回"**。
   * 旧版逐条跑档位判定（被@/关键词/随机/必响应），不触发的当场标已读；
   * 群聊参与度是那个判定存在的唯一理由（私聊/web 本就恒 tier-4 短路），
   * 群聊摘除后判定无输入 —— 现在每条消息入库后直接进入"等待中"倒计时
   * （固定 wakeDelayMs，不被重置），到点 drain 全部未读成【未读信息】。
   *
   * 批边界仍保留：verified 标记让 wake 信任等待会话的起点，起点之前的
   * 旧积压（停机/运行期攒下的）照旧归档沉历史（见 wake 的批边界注释）。
   * 运行中/倒计时中的新消息照旧只入库置未读，由会话结束的 drain 路径接管。
   */
  onIncoming(chatKey, entry = null) {
    if (this.paused || this.aborted) return;
    // 运行中 / 倒计时中：消息保持未读（不重置倒计时），由会话结束的
    // drain 路径接管（见 wake 末尾的 drain 注释）。
    if (this.runningChats.has(chatKey)) return;
    if (this.pendingWake.has(chatKey)) return;

    // 前置条件（与 wake 的闸门同口径，在这里提前拦截可以少建一次定时器）：
    //   模型未设置 → 消息保留未读，设置后（下一条消息或恢复积压）自动补处理
    if (!String(getConfig().api.model || '').trim()) return;

    // 收到即唤醒：进入固定的"等待中"倒计时（不重置）。verified 标记让 wake
    // 知道这一批由"收到即唤醒"排定，批边界可以信任等待会话的起点。
    this.scheduleWake(chatKey, null, { verified: true });
  }

  // ── brain.submit（P2 · night-plan §5.2，草案 §2.4 写路径）────────────────
  /**
   * 大脑唯一写路径入口：InboundEvent → 现有 存档/去重/事件/触发（wake/批处理）管线。
   * 调用方：app.js 新入站路径（adapter.normalize 之后）；cli-body（mock/复核用）。
   *
   * io（BrainIo，草案 §2.4）由调用方传入，在此登记到会话粒度（submitIo）；
   * 本次提交触发的运行，其出站经 #emitOutbound 优先走该 io —— io.emit 的落点是
   * registry.route（与 P1 出站同一目的地，"io.emit 走 registry"）。未传 io 或该
   * 会话无登记时 #emitOutbound 直连 registry，行为与 P1 逐字节一致。
   *
   * 映射（InboundEvent 信封 → store 条目，与 app.js 旧路径逐字段同口径）：
   *   conversationId → 存储键（Q10 收敛 'main'，store 一份 main.json）；
   *   surface + conversationId → 路由键（routeKeyOf，'web:main'），内部调度簿记
   *   （submitIo/wake 链）与出站 intent.conversationId 都用它——身体前缀保留，
   *   registry.route 才能把意图送对身体；
   *   actor.id / actor.name → senderId / senderName；
   *   ts → ts；payload.text → text（空文本且无附件在入口拦下；有附件空文本按
   *   附件 kind 回落 '[图片]'/'[语音]'，V0 媒体层音频化；V1 起 '[语音]' 先经
   *   voice.asr.transcribe 转写，成功以『（转写：…）』占位，失败保持 '[语音]'）；
   *   payload.attachments → media；
   *   hints.addressed → atMe（缺省 null = 判定层回落文本匹配，老存档同口径）；
   *   payload.meta.mid / payload.meta.atNames → mid / atNames。
   * event.id（'<surface>:mid:<mid>'/'<surface>:local:<id>' 形态）是协议层幂等键：进程内去重由 store
   * 的 mid / 近邻口径承担（与旧路径同一写者，不建第二套去重）。
   *
   * 返回（草案 §2.4）：{ ok:true }            已入库并进入触发判定（wake/批处理）；
   *                   { ok:true, silent:true } 重复投递（store 挡下，零副作用，幂等）；
   *                   { ok:false, error }     事件形状不合法。
   */
  async submit(event, io = null) {
    // Q10：cid = 存储键（web 端点缺省传 'main'）；rk = 路由键（'web:main'，见 routeKeyOf）。
    const cid = String(event?.conversationId ?? '');
    if (!cid) return { ok: false, error: 'submit：InboundEvent 缺 conversationId' };
    const rk = routeKeyOf(cid, event?.surface);
    if (event?.type !== 'message') {
      return { ok: false, error: `submit：暂只接受 type='message'（收到 ${JSON.stringify(event?.type ?? null)}）` };
    }
    if (io !== null && (typeof io !== 'object' || typeof io.emit !== 'function')) {
      return { ok: false, error: 'submit：io 形状不合法（需要 { emit } 函数，草案 §2.4 BrainIo）' };
    }
    const payload = event.payload ?? {};
    const meta = payload.meta ?? {};
    const text = String(payload.text ?? '');
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (!text && attachments.length === 0) {
      return { ok: false, error: 'submit：空 payload（无 text 且无 attachments）' };
    }
    // V0 媒体层音频化（asr-tts-v0-execution-spec §2.4）：空文本占位符按附件
    // kind 分支——含音频附件回落 '[语音]'，其余（图片/缺省 image）回落 '[图片]'。
    const mediaKinds = attachments.map((a) => String(a?.kind ?? 'image'));
    // V1 ASR 接入（voice-walkie；设计 §2.1 六站入库管道站⑤ / spec §7）：含音频附件
    // 且无文本 → 批组装前同步转写（第三批准口 voice.asr.transcribe，architecture-v3
    // §8.A 登记；动态 import 同 llm.embed 口径——import 期零网络零进程；关闭态函数体
    // 内即刻 null，零字节读取零 fetch）。成功 → 『（转写：…）』前缀占位（无标点原样
    // 注入，所有者拍板不补标点）并入 payload.text（下游 prefetchQuery/事件记账/触发
    // 摘要与 entry 同源）；失败/关闭/超时 → null → 保持 '[语音]'。不重试，超时 15s
    // （voice.js 实现）。挂点在 appendIncoming **之前**：V0 的占位是在 append 时落库
    // 的（persistAppend INSERT 即刻成行），"entry 后改 entry.text" 无 store 公开 API
    // 可持久化（指令明文不动 store）——转写随条目落库，重启不回退 '[语音]'。
    // 仅转第一个音频附件（V1 语音条=单条录音场景）。
    let placeholder = text || (mediaKinds.includes('audio') ? '[语音]' : '[图片]');
    if (!text && mediaKinds.includes('audio')) {
      const audioId = attachments.find((a) => a?.kind === 'audio')?.id;
      const { voice } = await import('./capabilities/voice.js');
      const tr = await voice.asr.transcribe(audioId, { lang: getConfig().voice?.asr?.language });
      if (tr?.text) {
        placeholder = `（转写：${tr.text}）`;
        payload.text = placeholder;
      }
    }
    const entry = this.store.appendIncoming(cid, {
      // 入站 id 回落（2026-11-13）：信封没带 meta.mid 时用 event.id 兜底。
      // web 身体（POST /api/web/send）从不带 meta.mid，导致入站条目 mid=null
      // → prompt.js formatEntry 的 hasMid 为假 → 提示词里这条消息**没有 #id**
      // → 模型只能编数字（08:20 那次编了 #128）→ get_message_images /
      // read_video 这类按 id 取消息的工具必然落空。
      // event.id 是协议层幂等键（'web:1700000000000:ab12cd'），本身唯一且稳定，
      // 做 mid 不引入第二套去重语义（store 的 mid 去重仍以它为准，不会误挡新消息）。
      mid: meta.mid ?? event?.id ?? null,
      ts: Number(event.ts) || Date.now(),
      senderId: String(event.actor?.id ?? ''),
      senderName: String(event.actor?.name ?? ''),
      text: placeholder,
      media: attachments,
      atMe: typeof event.hints?.addressed === 'boolean' ? event.hints.addressed : null,
      atNames: Array.isArray(meta.atNames) ? meta.atNames : []
    });
    // 重复投递（同 mid 被协议端重放）：store 已经挡掉，返回 null。
    // 此时不能进入触发判定，否则同一条消息会触发多轮会话（与旧路径同口径）。
    if (!entry) {
      console.log(`[去重] 忽略重复投递：${cid} mid=${meta.mid ?? ''}`);
      return { ok: true, silent: true };
    }
    // card-vector 夜2 T2.3：入库成功后预取本条消息的查询向量（计划 §3.5/D4 v2）——
    // "单飞"在 prefetchQuery 内（同 chatKey 在途嵌入被新文本原子替换），fire-and-forget，
    // 绝不 await 组装路径；重复投递分支（entry=null）不预取。键 = 路由键 rk（wake/#runAgent
    // 的 chatKey 同源）。enabled=false 时连函数都不进（关闭态零开销）。
    if (getConfig().memory?.embedding?.enabled) {
      cardIndex.prefetchQuery(rk, String(event.payload.text ?? '')).catch(() => {});
    }
    if (io) this.submitIo.set(rk, io);
    // E5 per-routeKey（清债夜3）：触发源与 submitIo 同位置登记——去重拦截的重复投递
    // 走不到这里，不登记也不产生出站，语义自洽；并发多会话各自登记各自的路由键，
    // 互不覆盖。本轮运行结束由 wake finally / abortAll 清理（无 submit 语境查表落空 = null）。
    this.#eventIds.set(rk, event?.id ?? null);
    // 入库成功记账 + 广播：与 app.js 旧路径同源（Phase 2 事件日志 T2.4 / SSE chat-update）。
    // E2：入站 surface = 身体 surface（InboundEvent.surface：身体装配归一后透传，
    // routes.js web send → 'web'）；信封缺 surface 时按「缺省空串」口径落 ''。
    events.append({ source: 'chat', kind: 'message_in', text: entry.text, ref: `mid:${entry.mid ?? entry.id}`, surface: String(event?.surface ?? '') });
    this.emit('chat-update', rk);
    // 收到即唤醒 → 防抖聚批 → wake：现有管线原样接管（onIncoming → scheduleWake → wake）。
    // 内部调度簿记（pendingWake/pendingSessions/runningChats/submitIo/typingTimers）按
    // 路由键记；store 调用键盲（单一 main.json），存储口径不受影响。
    this.onIncoming(rk, entry);
    return { ok: true };
  }

  /**
   * 进入"等待中"倒计时并到点唤醒（2026-09-25 重做）。
   *
   * 旧版是"防抖聚批"：窗口内每来一条消息就重置倒计时、重跑预判。
   * 新版语义：
   *   · 倒计时长度固定（wakeDelayMs），进入后不被任何因素重置；
   *   · 窗口内新消息只入库（onIncoming 里 pendingWake 直接 return）；
   *   · 除非手动中止（abortSession/abortAll）或全局暂停，倒计时必然走完 → wake。
   * reuseSessionId（原地重试）与 drainBacklogAfterResume（恢复积压）仍走本函数，
   * 但它们是"已确定要跑"的调用，直接排定时器即可。
   */
  scheduleWake(chatKey, delay = null, { reuseSessionId = null, verified = false } = {}) {
    const ms = delay ?? Math.max(0, Number(getConfig().wakeDelayMs) || 2000);
    // 不可重置：已在倒计时中就不动它（唯一例外是原地重试——它进来时
    // pendingWake 一定没有该 chatKey，因为 runningChats 刚释放、旧定时器已到期）。
    if (this.pendingWake.has(chatKey)) return;
    this.pendingWake.add(chatKey);
    // verified = 本轮 wake 由 onIncoming 的"收到即唤醒"排定（区别于 drain/积压恢复
    // 等机械重排）。wake 里据此决定批边界：verified 批信任等待会话的起点（起点前
    // 的旧积压归档），机械批没有判定锚点，全部未读即本批。
    if (verified) this.verifiedWakes.add(chatKey);

    const waitUntil = Date.now() + ms;
    // 创建/复用"等待中"会话（UI 可见）：触发摘要取当前未读第一条
    if (!reuseSessionId && !this.runningChats.has(chatKey)) {
      const unread = this.store.peekUnread(chatKey, 3);
      const first = unread[0];
      const summary = first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '等待新消息聚批';
      const existing = this.pendingSessions.get(chatKey);
      if (existing) {
        /* ⚠️ 必须用 current.get（活对象），不能用 get() ——
           get() 返回 structuredClone 副本，改副本后 update() 持久化的是
           未修改的活对象，等待会话的触发摘要将永远停留在第一条消息。 */
        const s = this.sessions.current.get(existing);
        if (s && s.status === 'waiting') {
          s.waitUntil = waitUntil;
          s.triggerSummary = summary;
          s.trigger = unread;
          s.triggerText = unread.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
          this.sessions.update(s.id);
          this.emit('session-update', s.id);
        } else {
          this.pendingSessions.delete(chatKey);
        }
      }
      if (!this.pendingSessions.has(chatKey)) {
        // Q10：create({source}) —— 身体归属由路由键经 registry 直取（#surfaceOf 前缀推导
        // 已随 sessions.js 收敛删除）；会话记录的 chatKey 固定 'main'（单一时间线）。
        const session = this.sessions.create({
          source: registry.route(chatKey).surface,
          trigger: unread,
          triggerSummary: summary,
          status: 'waiting',
          waitUntil
        });
        this.pendingSessions.set(chatKey, session.id);
        this.emit('session-start', { sessionId: session.id, chatKey, status: 'waiting', triggerSummary: summary });
      }
      this.emit('chat-update', chatKey);
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      const waitingId = this.pendingSessions.get(chatKey);
      this.pendingSessions.delete(chatKey);
      if (this.paused || this.aborted || this.runningChats.has(chatKey)) {
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        this.verifiedWakes.delete(chatKey);
        return;
      }
      this.wake(chatKey, { waitingSessionId: waitingId ?? null, reuseSessionId: reuseSessionId ?? null })
        .catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error))
        .finally(() => this.verifiedWakes.delete(chatKey));
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  // ── 未读兜底（已随 2026-09-25 触发链路重做移除）────────────────────────
  // 旧语义：1~3 档下"没触发会话"的散消息在防抖窗口后由定时器批量标已读。
  // 新语义：每条消息入库时当场判定，不触发的当场标已读（onIncoming），
  // 不存在"挂着的假未读"，兜底定时器失去存在意义。
  // 保留 #cancelUnreadFallback 的空实现以兼容 abortSession 等旧调用点。
  #cancelUnreadFallback(chatKey) {
    const t = this.unreadFallbackTimers.get(chatKey);
    if (t) { clearTimeout(t); this.unreadFallbackTimers.delete(chatKey); }
  }

  /**
   * 丢弃一个"等待中"会话：让它从会话页**干净消失**，而不是变成"中止"。
   *
   * 用户看到的应该是"什么都没发生"，而不是一条标着"中止"的条目（那会让人
   * 以为机器人坏了）。Q9 前主要供档位判定"这次不响应"用，现存的两个调用：
   * abortSession 中止等待会话、wake 的批边界防御路径（触发消息已缺失）。
   * 只有真正运行过（消耗了 token）的会话才走 #finishWaiting 留痕。
   */
  #discardWaiting(sessionId) {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    this.sessions.discard(sessionId);
    this.emit('session-end', {
      sessionId,
      chatKey: s?.chatKey || '',
      status: 'discarded',
      discarded: true
    });
  }

  #finishWaiting(sessionId, status, error = '') {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    if (!s || s.status !== 'waiting') return;
    if (error) s.error = error;
    this.sessions.finish(sessionId, status);
    this.emit('session-end', { sessionId, chatKey: s.chatKey, status, error: s.error || null });
  }

  /** 手动触发一次处理（UI 按钮）。 */
  // （「唤醒一次处理」按钮及其 force 唤醒链路已按需求移除：
  //   不触发的消息现在立即标已读，无需手动补处理。）

  // ── "对方正在输入…"（web/私聊性质会话）─────────────────────────────────
  //
  // 为什么群聊没有：旧协议端的输入状态是点对点能力，协议本身没有群聊版本。
  // （W3 修订 D2：web 会话同走 typing 意图——web adapter 有 chat-typing 广播。）
  // Q10：isPrivateChat 守卫随 chatKey 收敛消亡——单一时间线没有"非私聊性质"的
  // 会话，typing 意图一律发往身体的 adapter（web 广播等），由身体决定
  // 怎么表达；裸存储键（无前缀，积压恢复等路径）仍按"无可寻址 id"跳过。
  // 为什么需要它：本地模型一次回复要 20~30 秒，这段时间对方只看到"已读不回"；
  // 输入状态把等待变成"她在打字"。
  // 失败语义：任何异常都只让这个功能消失，绝不影响会话 —— 首次失败即置位
  // typingUnsupported，之后全进程不再尝试，错误日志也只出现一次。

  /** 点亮/续期某会话的输入状态；无可寻址 id 的裸键、开关关闭、身体不支持时都是空操作。 */
  #typingStart(chatKey) {
    if (this.typingUnsupported) return;
    if (getConfig().send?.typingIndicator === false) return;
    const [, id] = String(chatKey || '').split(':');
    if (!id) return;
    if (this.typingTimers.has(chatKey)) return;   // 已经亮着，不重复计时

    const tick = () => {
      const fail = (error) => {
        this.typingUnsupported = true;
        this.#typingStop(chatKey);
        console.warn(`[orchestrator] 输入状态不可用（本次进程内不再尝试）：${error?.message ?? error}`);
      };
      try {
        // P1（night-plan §4.3）：出站统一 —— typing 意图经 #emitOutbound（身体 adapter
        // 翻译成各自的输入状态语义；web 身体广播 chat-typing）。
        // 回滚开关已随旧身体归档摘除（Q11），#emitOutbound 单路径。
        // 返回 Promise：不接住失败会变成 unhandled rejection。
        // E5：sourceEventId 指回触发本轮的入站事件（按本会话路由键查表；无 submit 语境时为 null）。
        Promise.resolve(this.#emitOutbound(chatKey, { type: 'typing', payload: { on: true }, sourceEventId: this.#eventIds.get(chatKey) ?? null })).catch(fail);
      } catch (error) {
        fail(error);
      }
    };
    tick();                                       // 立刻亮起，不等第一个 4 秒
    const timer = setInterval(tick, 4000);        // 协议侧状态会超时，必须续期
    timer.unref?.();                              // 不阻塞进程退出
    this.typingTimers.set(chatKey, timer);
  }

  /** 熄灭输入状态（发 0 取消）。本来没亮着就是空操作。 */
  #typingStop(chatKey) {
    const timer = this.typingTimers.get(chatKey);
    if (!timer) return;
    clearInterval(timer);
    this.typingTimers.delete(chatKey);
    const [, id] = String(chatKey || '').split(':');
    if (!id || this.typingUnsupported) return;
    try {
      // P1：出站统一（typing 意图，on:false → 身体翻译成 setInputStatus(uid,0)）。
      // E5：sourceEventId 同口径补齐（on/off 成对，按本会话路由键查表）。
      Promise.resolve(this.#emitOutbound(chatKey, { type: 'typing', payload: { on: false }, sourceEventId: this.#eventIds.get(chatKey) ?? null })).catch(() => {});
    } catch { /* 熄灭失败无所谓：协议侧本来也会超时自动消失 */ }
  }

  /** 全局中止/退出：清掉所有输入状态，别让某个会话一直"正在输入"。 */
  #typingStopAll() {
    for (const chatKey of [...this.typingTimers.keys()]) this.#typingStop(chatKey);
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey, { proactive = false, waitingSessionId = null, reuseSessionId = null } = {}) {
    if (this.aborted) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.paused && !proactive) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.runningChats.has(chatKey)) return;

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '模型未设置');
      return;
    }

    // （旧"会话创建前检测禁言状态"段已随 Q9 群聊分支摘除 —— 禁言是旧群载体
    //   的发送约束，禁言检测 #checkSelfMuted 与按前缀识别的会话分支一并消亡。）

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      if (waitingSessionId) {
        const s = this.sessions.get(waitingSessionId);
        // sessions.get 判过 status 后 current.get 仍可能是 undefined
        // （等待会话恰好在两次读取之间被 discard），必须再判一层再写属性
        const live = s && s.status === 'waiting' ? this.sessions.current.get(waitingSessionId) : null;
        if (live) {
          live.waitUntil = Date.now() + 3000;
          this.sessions.update(waitingSessionId);
          this.emit('session-update', waitingSessionId);
        }
      }
      // ⚠️ 3 秒重排定时器必须被跟踪（2026-09-26 审查）：原先裸 setTimeout 不记句柄，
      // stop()/abortAll() 清不掉它 —— 应用退出后它仍会把 pendingWake 重新排上，
      // 测试环境里表现为进程挂着不退（unref 让它不阻塞退出，但运行期它照样会在
      // 停止后又拉起一次唤醒）。与 wakeTimers 同一张表管理，abortAll 时一并清掉。
      const retryTimer = setTimeout(() => {
        this.wakeTimers.delete(chatKey);
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          this.scheduleWake(chatKey, 0);
        }
      }, 3000);
      retryTimer.unref?.();
      this.wakeTimers.set(chatKey, retryTimer);
      return;
    }

    // ── 取走触发批 ──
    // Q9"收到即唤醒"：onIncoming 不再判定（进入倒计时 = 必定运行），wake 也
    // 不再对未读补判定 —— **全部未读即本批**，倒计时未被中止地走到这里就直接运行。
    //
    // 批的边界只保留一件事（batchFloorTs）：verified 批（onIncoming 收到即唤醒
    // 排定的）信任等待会话的起点，起点之前（留 60 秒时钟容差）的旧积压——
    // 停机期间/上个会话运行期间攒下、从未参与本批倒计时——标已读沉入历史；
    // 机械批（drain / drainBacklogAfterResume / 重试排的，无 verified）没有
    // 判定锚点，全部未读即本批。
    let triggerEntries = [];
    if (!proactive) {
      const probe = this.store.peekUnread(chatKey, 500) || [];
      if (probe.length === 0 && waitingSessionId) {
        this.#finishWaiting(waitingSessionId, 'aborted');
        return;
      }

      let batchFloorTs = Infinity;
      if (this.verifiedWakes.has(chatKey) && waitingSessionId) {
        const waiting = this.sessions.current.get(waitingSessionId);
        if (waiting?.startedAt) batchFloorTs = Number(waiting.startedAt) - 60_000;
      }

      if (Number.isFinite(batchFloorTs)) {
        const inWindow = probe.filter((m) => m.ts >= batchFloorTs);
        if (inWindow.length === 0) {
          // 防御性归档：verified 批的触发消息 ts 早于边界 60 秒容差（时钟漂移/
          // 重放事件），批内将没有任何消息——全部标已读、等待会话干净消失。
          const archived = this.store.markAllRead(chatKey);
          if (archived > 0) console.log(`[orchestrator] ${chatKey} ${archived} 条旧积压未读（触发消息已缺失）已标已读归档`);
          if (waitingSessionId) this.#discardWaiting(waitingSessionId);
          this.emit('chat-update', chatKey);
          return;
        }
        batchFloorTs = Math.min(...inWindow.map((m) => m.ts));
      }

      this.#cancelUnreadFallback(chatKey);

      // 取走触发批：边界之后的进批，边界之前的旧积压标已读沉入历史
      const { batch, archived } = Number.isFinite(batchFloorTs)
        ? this.store.drainUnreadFrom(chatKey, batchFloorTs)
        : { batch: this.store.drainUnread(chatKey), archived: 0 };
      triggerEntries = batch;
      if (archived > 0) {
        console.log(`[orchestrator] ${chatKey} ${archived} 条旧积压未读已标已读沉入历史（未进本次唤醒）`);
        this.emit('chat-update', chatKey);
      }
      if (triggerEntries.length === 0) {
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
        return; // 没有未读就不空跑
      }
      // card-vector 夜2 T2.3：wake 兜底一发——预取缓存未热时补预取（覆盖 submit 与 wake
      // 之间批内到达的更早消息、进程重启后的冷缓存）。取触发批最后一条非自身、非占位的
      // 用户消息；fire-and-forget，不阻塞唤醒。
      if (getConfig().memory?.embedding?.enabled && !cardIndex.peekQuery(chatKey)) {
        const lastUser = [...triggerEntries].reverse()
          .find((e) => !e?.self && String(e?.text ?? '').trim() && String(e?.text ?? '') !== '[图片]');
        if (lastUser) cardIndex.prefetchQuery(chatKey, String(lastUser.text ?? '')).catch(() => {});
      }
    } else {
      // 主动机会：不打扰、无触发批，只带状态
      this.store.drainUnread(chatKey); // 把可能的零星未读一并处理掉
    }

    // ── 档位 ──
    // Q9：旧档位判定函数（档位/掷骰/@ 权重/关键词，prompt.js，Q9 删）整个随群聊
    // 消亡——存活会话在旧判定里本就恒 tier-4 短路（私聊消息恒响应，
    // 配置档位从不生效），effectiveTier 固定为同语义常量（见 EFFECTIVE_TIER），
    // 行为零差。主动机会在旧代码里同样落 tier 4（count 同源 historyCount）。
    const effectiveTier = EFFECTIVE_TIER;

    this.runningChats.add(chatKey);
    const seq = (this.runSeq.get(chatKey) || 0) + 1;
    this.runSeq.set(chatKey, seq);
    const [kind, chatId] = String(chatKey).split(':');

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒/原地重试）才走别的分支
    let session = waitingSessionId ? this.sessions.get(waitingSessionId) : null;
    if (session && session.status === 'waiting') {
      this.sessions.current.get(waitingSessionId).status = 'running';
      this.sessions.current.get(waitingSessionId).waitUntil = null;
      this.sessions.current.get(waitingSessionId).trigger = triggerEntries;
      this.sessions.current.get(waitingSessionId).triggerSummary = triggerSummary;
      this.sessions.current.get(waitingSessionId).triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
      this.sessions.update(waitingSessionId);
      this.emit('session-update', waitingSessionId);
      session = this.sessions.current.get(waitingSessionId);
    } else if (reuseSessionId) {
      // 原地重试（retrySession）：复用同一个会话对象，不新开条目。
      // retrySession 已把它重置回 running 并放回 current；这里补触发批信息。
      const reused = this.sessions.current.get(reuseSessionId);
      if (!reused) {
        // 理论不可达：会话在唤醒前被清理。退回新建，别让消息丢掉。
        // Q10：create({source}) —— 身体归属由路由键经 registry 直取；记录 chatKey 固定 'main'。
        session = this.sessions.create({ source: registry.route(chatKey).surface, trigger: triggerEntries, triggerSummary });
        this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
      } else {
        reused.trigger = triggerEntries;
        reused.triggerSummary = triggerSummary;
        reused.triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
        this.sessions.update(reuseSessionId);
        this.emit('session-update', reuseSessionId);
        session = reused;
      }
    } else {
      // Q10：create({source}) 同上（身体归属路由键直取，记录 chatKey 固定 'main'）。
      session = this.sessions.create({ source: registry.route(chatKey).surface, trigger: triggerEntries, triggerSummary });
      this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
    }
    this.activeRuns.set(chatKey, session.id);
    this.emit('chat-update', chatKey);

    // ── 会话级重试 ──
    // 单次 API 请求内部已经会重试（见 chatCompletionWithRetry），
    // 这里处理的是"整轮都救不回来"的情况：清干净上下文从头再来一次。
    //
    // ⚠️ 只在**一次都没发出过消息**时才重试 —— 否则重试会导致重复发言。
    // 已经说过话的会话宁可记为 error，也不能让群里看到两遍同样的话。
    // 次数可在设置里配（sessionRetryAttempts，默认 2 = 最多 3 次尝试）；
    // 0 = 关闭自动重试（失败会话仍可在会话页手动重试）。
    const MAX_SESSION_ATTEMPTS = Math.max(1, 1 + (Math.min(5, Math.max(0, Number(getConfig().sessionRetryAttempts) ?? 0) || 0)));
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt++) {
        try {
          await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit: effectiveTier.count, tierInfo: effectiveTier });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const sentCount = (session.sent || []).length;
          const canRetry = attempt < MAX_SESSION_ATTEMPTS
            && isRetryableError(error)
            && sentCount === 0
            && !this.aborted;
          if (!canRetry) break;

          // 为重试准备干净的上下文：清掉本轮残留，避免脏状态影响下一次
          const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s
          console.warn(`[orchestrator] 会话 ${session.id} 第 ${attempt} 次失败（未发出任何消息），${wait}ms 后重试：${error?.message ?? error}`);
          this.#resetSessionForRetry(session);
          session.activity = `出错重试 ${attempt}/${MAX_SESSION_ATTEMPTS - 1}…`;
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (lastError) {
        // 用户手动中止（「中止」按钮）打断在途请求时，错误从 #runAgent 一路上抛
        // 到这里 —— 不能记成 error：那会让 UI 亮出"重试"按钮（中止不该重试），
        // 也会让会话账面状态与实际发生的事对不上。按 aborted 收尾（2026-09-19 修）。
        if (this.sessionAbortMarks.has(session.id)) {
          this.sessionAbortMarks.delete(session.id);
          this.sessionAbortControllers.delete(session.id);
          session.error = null;
          this.sessions.finish(session.id, 'aborted');
          this.emit('session-end', { sessionId: session.id, chatKey, status: 'aborted', sent: session.sent.length, usage: session.usage });
          console.log(`[orchestrator] 会话 ${session.id} 被用户中止（错误上抛路径收尾）`);
        } else {
          session.error = String(lastError?.message ?? lastError);
          this.sessions.finish(session.id, 'error');
          this.emit('session-end', { sessionId: session.id, chatKey, status: 'error', error: session.error });
          console.error(`[orchestrator] 运行 ${session.id} 出错:`, lastError);
        }
      }
    } finally {
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      // 无论正常结束、报错还是被中止，都必须熄灭"正在输入"——
      // 漏掉这一条，一次异常就会让对话永久停在"对方正在输入…"。
      this.#typingStop(chatKey);
      // E5 per-routeKey（清债夜3）：本轮运行收尾，清掉该路由键的触发源登记——
      // 运行结束后不再有 submit 语境，后续提醒/主动查表落空 = null（E5 语义保持）。
      // 删除放在 #typingStop 之后：typing stop 意图仍指回触发源（与单值时代口径一致）。
      this.#eventIds.delete(chatKey);
      this.emit('chat-update', chatKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      const unread = this.store.unreadCount(chatKey);
      if (unread > 0) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }
  }

  /**
   * 为会话重试清理累积状态。
   *
   * 调用前必须确保 session.sent 为空（没发出过任何消息），否则重试会重复发言。
   * #runAgent 本身会重建 messages / 提示词，所以这里只需清掉上一轮留下的痕迹，
   * 避免脏状态（半截的 messages、重复累加的 usage/error）带进下一次尝试。
   *
   * ⚠️ 手动重试（retrySession）复用此函数时注意：已结束会话不在 current 里，
   *    `live` 会回退成传入的 session 对象本身 —— 调用方随后要自己把它放回
   *    current（retrySession 就是这么做的），否则后续 update/finish 找不到活对象。
   */
  #resetSessionForRetry(session) {
    const live = this.sessions.current.get(session.id) || session;
    live.messages = [];
    live.sent = [];
    live.feedbacks = [];
    live.rounds = 0;
    live.error = null;
    live.finishReason = null;
    live.activity = '';
    live.inputMessages = [];
    live.usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
    this.sessions.update(session.id);
    this.emit('session-update', session.id);
  }

  // ── 回复安全网（reply-safety 插件）─────────────────────────────────────
  //
  // 这一整套只为**不遵守工具协议**的模型准备（尤其是本地小模型）：它们有时把要说的话
  // 直接写在正文里。正文按设计不会发出，于是对方什么都没收到 —— 用户看到的就是
  // "机器人不理我了"。下面几个方法就是那条兜底路径。
  //
  // 全部通过能力名取用：插件没装/没启用时 `#capFirst` 一律返回 null，所有分支都是空操作，
  // 行为与没有这套机制时**完全一致**。这是"关掉插件就退回原行为"的硬约束。

  /** 取某个能力的第一提供者函数；没有提供者（插件未启用）时返回 null。 */
  #capFirst(name, context = {}) {
    try {
      return moduleManager.getCapabilityProviders(name, context)[0]?.fn || null;
    } catch {
      return null;
    }
  }

  /** 给"正文裁判"用的模型参数：沿用当前聊天的主模型，不另开一份配置。 */
  #judgeApi() {
    const api = getConfig().api || {};
    // 密钥解析：模型走 providers 目录时顶层 api.apiKey 常为空 —— 直接取会 401。
    // 从已解析密钥的目录里找当前 provider 的真实 Key（与主调用路径同源）。
    let apiKey = api.apiKey;
    if (!apiKey && api.provider) {
      const p = currentProviders().find((x) => x.id === api.provider);
      apiKey = p?.apiKey || '';
    }
    return { baseUrl: api.baseUrl, apiKey, model: api.model, provider: api.provider };
  }

  /** 触发批的文本（裁判要知道"这轮收到了什么"，才能判断正文是对它的回复）。 */
  #triggerText(triggerEntries) {
    return (triggerEntries || []).map((e) => String(e?.text || '')).filter(Boolean).join('\n').slice(0, 400);
  }

  /**
   * 把"写在正文里、但没通过工具发出去"的成稿抢救成一条 send_message 调用。
   *
   * 判定逻辑本身在 src/reply-rescue.js（纯逻辑、可被测试直接驱动 —— 这条链路
   * 判错就是把内心戏发进群，必须能逐条验证）。这里只负责注入依赖：
   * 能力取用、裁判用的模型参数、触发批文本。
   *
   * @returns {Promise<Array>} 合成的 tool_call 数组；[] = 什么都别发
   */
  async #rescueUnsentReply({ rawContent, triggerEntries, session, skillContext }) {
    return rescueUnsentReply({
      text: rawContent,
      trigger: this.#triggerText(triggerEntries),
      sent: session.sent || [],
      api: this.#judgeApi(),
      cap: (name) => this.#capFirst(name, skillContext),
      log: (message) => moduleManager.recordError('reply-safety', message)
    });
  }

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit = null, tierInfo = null }) {
    const cfg = getConfig();
    // 开一轮新运行：清空回复安全网的候选草稿池（草稿只在"这一次运行"内有意义，
    // 跨运行留着会把上一次的句子当成这次可以发的原句）。
    this.#capFirst('reply.grounded-select')?.({ reset: true });
    // 会话级中止的请求中断器：本次运行的每次 LLM 请求都带这个 signal。
    // abortSession 中止会话时直接 abort —— 在途请求立刻断开（不用等 180 秒
    // 超时），这是"中止按钮停不住"的根治。运行结束必须清理（见 finally），
    // 否则 Map 随会话数无限增长。
    const abortController = new AbortController();
    this.sessionAbortControllers.set(session.id, abortController);
    const abortSignal = abortController.signal;
    // Q9：群聊分支摘除 —— chatName 是群名片概念（#chatName 经协议端会话信息调用），
    // 随群聊一并消亡；存活会话本就恒空串。ctx.selfName（@ 标签判定的"我的名字"）
    // 取账号 botName（清债夜2 由旧 QQ 时代字段名中立化更名，取值口径不变）。
    const chatName = '';
    const selfName = cfg.persona.botName;

    // （原"上下文统计"三件套 —— 最近消息密度/上次发言时间/最后消息时间 ——
    //  只喂【此刻状态】段，该段 2026-09-25 删除后不再计算。）

    // 表情库快照（提示词用）
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // ── 统一可用性上下文 ──
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const visionEnabled = cfg.api.vision !== false
      && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    const searchEnabled = cfg.webSearch?.enabled !== false;
    const toolsCfg = cfg.tools || {};
    const skillContext = {
      // Q10：钩子/skill 语境的 chatKey = 存储键 'main'（单一时间线；kv 'transition' 等
      // 数据落点按它命名）。工具 ctx（:1059 起的 ctx 对象）仍带路由键——set_reminder
      // 记录的键要能被 #fireReminder 直接路由。人设查找两种键形同值（personaForChat
      // 对 'web:main'/'main' 都落在 perChat['main']）。
      chatKey: 'main', kind, chatId, chatName,
      model: cfg.api.model,
      provider: cfg.api.provider,
      visionEnabled,
      searchEnabled,
      proactive,
      sessionId: session.id
    };

    // Skill 生命周期：提示词组装之前先跑 before-context。
    // 注意 hook 只能**追加/加工上下文**；安全规则、工具协议等核心提示词由 prompt.js 独占，
    // Skill 无法覆盖（manifest priority 上限 99）。
    try {
      await moduleManager.runHook('before-context', {
        ...skillContext,
        triggerEntries,
        store: this.store
      });
    } catch (error) {
      moduleManager.recordError('before-context', error);
    }

    // ── 人设（Q15 扩展禁用后：单用户单人格，主人识别由身体层 actor.id='owner' 承担）──
    // 旧的 message.owner-check 能力已随扩展禁用移除——
    // 单用户部署里每个入站都是主人，不再需要"按号码切换专属人设"这一层。
    // 人设恒取全局（cfg.persona，personaForChat 已随 2026-11-22 清理退化为直返全局值）。
    // 名字（botName/selfName）保持全局值 —— 那是账号身份，不允许按会话覆盖。
    const systemPrompt = buildSystemPrompt({
      skillContext,
      persona: personaForChat(chatKey)
    });
    // card-vector 夜2 T2.3 + 第二批 T3：组装前从 chatKey 预取缓存读向量命中（enabled &&
    // 缓存已热才传；peekQuery/search 均同步零网络——向量缓存住 orchestrator 进程内
    // chatKey 级 Map，绝不进 session 对象（D5：session 经 peek 序列化进 SSE）。
    // 异常静默 → 词法兜底）。四源：gist / fact / 行级向量。
    let vectorHits = null;
    if (cfg.memory?.embedding?.enabled) {
      try {
        const peek = cardIndex.peekQuery(chatKey);
        if (peek && Array.isArray(peek.vec) && peek.vec.length) {
          const res = cardIndex.search(peek.vec);
          vectorHits = [
            ...(Array.isArray(res.gists) ? res.gists : []).map((g) => ({
              kind: 'gist', date: String(g?.date ?? ''), text: String(g?.gist ?? ''), score: Number(g?.score) || 0
            })),
            ...(Array.isArray(res.facts) ? res.facts : []).map((f) => ({
              kind: 'fact', key: String(f?.key ?? ''), text: String(f?.text ?? ''), score: Number(f?.score) || 0
            })),
            ...(Array.isArray(res.rows) ? res.rows : []).map((r) => ({
              kind: 'row', date: String(r?.date ?? ''), rowKey: String(r?.rowKey ?? ''),
              text: String(r?.text ?? ''), score: Number(r?.score) || 0
            }))
          ];
        }
      } catch { vectorHits = null; }
    }
    // P16（2026-11-20）：跨轮思考——读上一条已结束会话的【深度思考】注入本轮 user 尾部。
    // 只读派生；session 文件缺失/过期/无思考/异常都返回空串，绝不阻断对话。
    let transitionText = '';
    try {
      transitionText = buildTransitionSection({
        sessions: this.sessions,
        chatKey,
        currentSessionId: session?.id,
        now: Date.now()
      });
    } catch { transitionText = ''; }

    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      stickerEntries,
      selfName,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      contextLimit,
      tierInfo,
      skillContext,
      // card-vector 夜2 T2.2 + 第二批 T3：四源向量路注入（gist/fact/row；prompt.js
      // 召回块唯一消费点；null = 纯词法，关闭态/预取未热恒 null）
      vectorHits,
      // P16：上一轮想到一半的地方（空串 = 不注入）
      transitionText,
      // 提示词锚点：传入上一轮的前缀状态；新状态经 session.promptAnchorState 带回
      promptAnchor: { prev: this.promptAnchors.get(chatKey) || null },
      session
    });

    session.systemPrompt = systemPrompt;
    session.userPrompt = userPrompt;
    session.promptChars = systemPrompt.length + userPrompt.length;
    session.model = cfg.api.model;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';
    }
    // 提示词锚点状态存回 chatKey 级 Map（下一轮 buildUserPrompt 复用前缀）。
    // buildUserPrompt 已把新状态写进 session.promptAnchorState；失败重试会
    // 重置该字段（#resetSessionForRetry），届时旧锚点继续生效（幂等：同一批
    // 消息重新锚定出相同前缀）。
    if (session.promptAnchorState) this.promptAnchors.set(chatKey, session.promptAnchorState);
    else this.promptAnchors.delete(chatKey);
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: proactive
        ? `${userPrompt}\n\n【未读信息】（主动机会）这边已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。`
        : userPrompt }
    ];

    // 让 Skill 加工即将发给模型的消息（如补充知识库片段）。
    // hook 拿到的是同一个数组引用，允许原地修改，返回值忽略。
    try {
      await moduleManager.runHook('before-llm-messages', { ...skillContext, messages });
    } catch (error) {
      moduleManager.recordError('before-llm-messages', error);
    }

    // Q15（上下文预算）：历史裁剪放在所有 hook 之后、inputMessages 快照之前——
    // 与插件时代同一位置；失败静默，绝不能因为省 token 影响对话。
    try { trimHistory(messages); } catch { /* ignore */ }

    // JSON 模式需要看到输入给模型的完整 messages（去工具之前）
    session.inputMessages = structuredClone(messages.map((m) => ({ role: m.role, content: m.content })));
    this.sessions.update(session.id);

    // ── 工具集过滤：唯一口径 ──
    // 以前这里手写五层条件，加 Skill 后如果继续手写就会变成六层、两处各判一半。
    // 现在统一交给 getToolAvailability()，并把不可用原因写进会话（UI 可解释）。
    const availability = new Map();
    const toolDefs = this.toolDefs.filter((d) => {
      const st = getToolAvailability(d.id, {
        skills: moduleManager,
        toolsCfg,
        visionEnabled,
        searchEnabled,
        runtimeContext: skillContext,
        // surface 过滤层（Phase 8b / 草案 §2.3）：平台工具不能进别的身体的工具表。
        // 旧会话（磁盘恢复）没有 surface 字段 → 传 null，过滤层空操作。
        sessionSurface: session.surface ?? null
      });
      availability.set(d.id, st);
      return st.enabled;
    });
    // 排障面板：本次因为什么原因少了哪些工具
    const excluded = [...availability.entries()]
      .filter(([, st]) => !st.enabled)
      .map(([id, st]) => ({ id, code: st.code, reason: st.reason }));
    session.excludedTools = excluded;
    const openAiTools = toOpenAiTools(toolDefs);

    // ── 出站接线（Phase 8b · 草案 §7.1 接线点 #2 / §8 M1）───────────────────
    // adapter：当前会话 chatKey 经前缀路由到的身体（历史前缀/裸串/裸 'main'
    // → 默认 'web'，D18；Q11 起 DEFAULT_SURFACE='web'）。身体未注册时这里就抛错
    // （接线错误要响，不静默兜底）。
    const adapter = registry.route(chatKey);
    // P3 ctx 收窄（night-plan §6.3 / 整改清单 §6-P8）：工具上下文无任何发送/协议句柄，
    // 只留 ctx.emit（出站唯一口）/ ctx.surface（读回窄封装）。插件需要的发送
    // 能力走既有窄口（plugin-loader 的 api.sendText → hostBridge → registry）；读回
    // 走 ctx.surface.call 窄通道（web 身体返回不支持读回）。
    // 内置工具的发送自 Phase 8b 起全部走 ctx.emit（拆分表 #7）。
    const ctx = {
      // Q10：工具语境的 chatKey = 路由键（'web:main'）——set_reminder 记录的键要能被
      // #fireReminder 直接 registry.route 到身体；store 读取全部键盲（单一 main.json）。
      // 钩子/skill 语境（skillContext）用存储键 'main'，见其注释。
      chatKey, kind, chatId,
      // P4（night-plan §7.2）：remember 工具从触发批取最后一条用户消息 id，给 staging
      // 条目带 mid（facts 提取的消息出处证据）。只读快照，工具不得改写。
      triggerEntries,
      // Q11：selfId 恒空串（号码身份源随身体归档消亡；消费面=旧态度插件/set_reminder
      // 均有空值回落路径，如实落空串）。
      selfId: '',
      selfName,
      botName: cfg.persona.botName,
      store: this.store,
      stickers: this.stickers,
      session,
      reminders: this.reminders,
      videoReader: this.videoReader,
      // 双分流（8a 预演门面定下的契约，tools/mock-adapter.mjs C3 实证）：
      //   · 字符串 = 旧 UI 事件（session-update / feedback …）→ 原样旁路，不进身体；
      //   · intent 对象 = 出站意图 → #emitOutbound（P1：与提醒/typing/hostBridge 同一
      //     出站口；内含 config.surface.intents 回滚分支与 M1/D19 的 conversationId
      //     语义 —— intent 未带 conversationId 时才补 ctx.chatKey，显式不覆盖，
      //     否则跨会话目标意图永远发回当前会话）。返回身体翻译层的原始形状（{sent,failed} /
      //     {message_id}，坑 #9：不包 {ok} 信封，形状一变模型会重试）。
      emit: (a, b) => {
        if (typeof a === 'string') return this.emit(a, b);
        // E5：intent 对象统一盖 sourceEventId（本运行的触发源，按本会话路由键查表；
        // 无 submit 语境为 null）。字符串 UI 事件旁路不盖。
        return this.#emitOutbound(chatKey, { ...a, sourceEventId: this.#eventIds.get(chatKey) ?? null });
      },
      // 读回窄封装（草案 §4）：皮层"问身体"的唯一通道 —— 只暴露 call / capabilities
      // 两个口，**不暴露任何发送/协议句柄本体**（v2-细化 T4.0.8）。
      // mock 身体下 call 返回 {}（草案 §4 规则 4），平台工具必须容忍空读回。
      // 清债夜2：读回展开窄通道摘除（评审 P2-6②）——唯一消费者 read_forward 工具
      // 已随 Q6+Q8 删除，web 身体本无此方法（直调即 TypeError），通道整体出清。
      surface: {
        call: (m, args) => adapter.call(m, args),
        capabilities: () => adapter.capabilities()
      }
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    // 单轮输出上限：默认 2048 token（config.js 的默认值）。0 = 不限制。
    // 本地模型不吐 EOS 时，没有这个上限就会一直生成到超时；正常聊天远用不到 2048。
    const mtCfg = Number(cfg.api.maxTokens);
    const chatMaxTokens = Number.isFinite(mtCfg) ? Math.max(0, Math.floor(mtCfg)) : 2048;
    let finish = false;
    // Bug1 纠正轮限次标记（bug-investigation-20261117.md §Bug1）：每次运行最多注入
    // 一次"正文不会自动发出"的纠正消息，防止与模型无限拉锯烧轮次。
    let noToolCallCorrected = false;
    let webSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      // 会话级中止（会话页「中止」按钮）：与全局 abort 同一条收尾路径。
      // 两个入口都会到这里：abortController 中断了在途请求（异常上抛后被
      // wake 的会话级重试判为不可重试 → #runAgent 正常返回 → 无需再拦），
      // 以及"中止时正处在工具执行/退避等待"（没有在途请求可中断）→ 这里拦住。
      // 收尾后清掉两套标记；abortAll 场景下不清（进程即将停止）。
      if (this.sessionAbortMarks.has(session.id)) {
        this.sessionAbortMarks.delete(session.id);
        this.sessionAbortControllers.delete(session.id);
        this.sessions.finish(session.id, 'aborted');
        this.emit('session-end', {
          sessionId: session.id,
          chatKey,
          status: 'aborted',
          sent: session.sent.length,
          usage: session.usage
        });
        return;
      }
      // 中途补一次检查：abortSignal 在上一轮工具执行期间被置位（例如模型
      // 正在跑一个长搜索时用户点了中止）。不等下一轮请求，当场收尾。
      if (abortSignal.aborted) {
        this.sessionAbortControllers.delete(session.id);
        this.sessions.finish(session.id, 'aborted');
        this.emit('session-end', {
          sessionId: session.id,
          chatKey,
          status: 'aborted',
          sent: session.sent.length,
          usage: session.usage
        });
        return;
      }
      if (this.aborted) {
        // 与其它终态（error / done / noreply / #finishWaiting）保持一致：必须 emit session-end。
        // 漏掉的话 UI 里这条会话会一直停在"运行中"，pendingSessionDetail 也不清，
        // 要等下一次轮询才恢复 —— 这正是"点了暂停后会话页像卡住"的成因。
        this.sessionAbortControllers.delete(session.id);
        this.sessions.finish(session.id, 'aborted');
        this.emit('session-end', {
          sessionId: session.id,
          chatKey,
          status: 'aborted',
          sent: session.sent.length,
          usage: session.usage
        });
        return;
      }
      markActivity('正在思考…');
      // 私聊里点亮"对方正在输入…"：本地模型一次推理 20~30 秒，这段等待
      // 对用户是空白的；输入状态让等待可见。非私聊/不支持时是空操作。
      this.#typingStart(chatKey);
      // ── 剩余轮次提醒：防止"工具轮次耗尽导致想说的话发不出去"──
      // 进入最后 3 轮且还一条消息都没发时，往对话里注入一条系统提醒，
      // 明确告诉模型"轮次快用完了，现在就该用 send_message 把话说出来"。
      // 没有这个提醒时，模型常把轮次花在搜索/看图上，循环一断消息就丢了。
      // 已发出过消息则不打扰（模型可能只是收尾查询，别催它重复发言）。
      const roundsLeft = maxRounds - round;
      if (roundsLeft <= 3 && roundsLeft > 0 && session.sent.length === 0
          && messages[messages.length - 1]?.role !== 'system') {
        messages.push({
          role: 'user',
          content: `【系统提醒】工具调用轮次只剩 ${roundsLeft} 轮。如果你打算回应本次消息，请立刻调用 send_message 把要说的话发出去，不要再调用其它工具 —— 轮次耗尽后你将没有机会发言，对方会收不到任何内容。`
        });
      }
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）。
      // abortSignal：会话级中止时在途请求立即断开 —— isRetryableError 把
      // "中止"判为不可重试，chatCompletionWithRetry 不再打下一发，直接上抛。
      const response = await chatCompletionWithRetry({ messages, tools: openAiTools, skillContext, signal: abortSignal, maxTokens: chatMaxTokens });
      // ── 截断留痕（2026-10-31）──────────────────────────────────────────
      // 主对话不设 max_tokens，走到 length 说明撞到了模型/网关自己的输出上限，
      // 正文很可能是半截的。这里**不丢弃**（丢了等于这一轮完全没回复，更糟），
      // 但要让它可查：日志里能看见，会话记录里打个标，排查"话说一半"时不用猜。
      // 插件侧的同类判断见 llm.js 的 chatCompletionFully。
      if (response.finishReason === 'length') {
        session.truncated = true;
        session.truncatedRounds = (Number(session.truncatedRounds) || 0) + 1;
        console.log(`[orchestrator] ${session.chatKey || ''} 第 ${round} 轮回复被截断（finish_reason=length），正文可能是不完整的`);
      }
      session.model = response.model || session.model;
      // 渠道与模型必须同源：fallback 可以配另一个 provider，只更新 model 会把
      // 这次调用记到主渠道名下，导致按渠道拆分的成本报表误导用户。
      if (response._usedApi) {
        session.vendor = vendorOfConfig({ api: response._usedApi, providers: getConfig().providers }) || session.vendor;
      }
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;
      // Skill 附加统计（如 reasoning tokens）——单独累加，不混进成本口径
      if (response.extraUsage) {
        session.usage.extra = { ...(session.usage.extra || {}) };
        for (const [k, v] of Object.entries(response.extraUsage)) {
          session.usage.extra[k] = (session.usage.extra[k] || 0) + (Number(v) || 0);
        }
      }
      // 取到响应后让 Skill 加工（提取 reasoning / 记录降级等）
      try {
        await moduleManager.runHook('after-response', { ...skillContext, response, session });
      } catch (error) {
        moduleManager.recordError('after-response', error);
      }

      // ── 深度思考（原 detailed-thinking 插件收编）──────────────────────────
      // 只写 session.messages 供会话页展示，不进模型请求；前端 isDeepThink()
      // 按【深度思考】前缀识别（frontend/src/lib/format.ts），前缀不可改。
      const reasoning = String(response?.reasoning ?? '').trim();
      if (reasoning) {
        const max = Math.max(0, Number(cfg.ui?.reasoningMaxChars) || 0);
        const text = max && reasoning.length > max
          ? `${reasoning.slice(0, max)}\n…（已截断，完整内容 ${reasoning.length} 字符）`
          : reasoning;
        session.messages.push({ role: 'assistant', content: `【深度思考】\n${text}` });
      }

      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
      const assistantEntry = {
        role: 'assistant',
        content: finalContent,
        tool_calls: finalToolCalls,
        raw: response.raw ?? null
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
        // 回复安全网（reply-safety 插件）的解析器覆盖更多书写格式，且可配置关闭。
        // **合并**而不是替换：核心解析器已覆盖标准 <tool_call> 写法，插件多认出来的
        // 那些补进来 —— 两边都不丢，且插件没启用时这段是空操作。
        const inlineFn = this.#capFirst('reply.inline-calls', skillContext);
        if (inlineFn) {
          try {
            const extra = inlineFn({ text: rawContent })?.calls || [];
            for (const c of extra) {
              if (!c?.name) continue;
              const same = inlineCalls.some((x) => x.name === c.name
                && JSON.stringify(x.args ?? {}) === JSON.stringify(c.args ?? {}));
              if (!same) inlineCalls.push(c);
            }
          } catch (error) { moduleManager.recordError('reply-safety', error); }
        }
        // 正文顺势记成候选草稿：后面 grounded-select 只允许"从草稿里挑原句"，
        // 没有这一步，筛选会把所有候选都判成"无出处"而全部丢掉。
        const rememberFn = this.#capFirst('reply.grounded-select', skillContext);
        if (rememberFn) {
          try { rememberFn({ remember: rawContent }); } catch { /* 记不进就算了 */ }
        }
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // 没有原生工具调用。两种可能：
        //   · 模型真的说完了（文本只是思考，按设计不发出）→ 正常结束
        //   · 模型不遵守工具协议，把要说的话写在了正文里 → 对方什么都收不到
        // 给回复安全网一次机会抢救后者（插件未启用时立刻返回空，行为完全不变）。
        const rescued = await this.#rescueUnsentReply({
          rawContent, triggerEntries, session, skillContext
        });
        if (!rescued.length) {
          // ── 纠正轮（Bug1 修复，2026-11-18）─────────────────────────────────
          // deepseek-v4.1-flash 间歇性把完整回复写进 content、一个工具都不调
          // （bug-investigation-20261117.md §Bug1：13 会话中 2 例 rounds=1/noreply/sent=0）。
          // 抢救网接不住时不再直接收尾：本轮正文非空且完整（非截断）、还有下一轮
          // 预算，就追加一条纠正性 user 消息再跑一轮，给模型一次"把原句放进
          // send_message"的机会。三条边界：
          //   · 每次 wake 限一次（noToolCallCorrected）：纠正后仍无工具调用 →
          //     按原样 noreply/done 收尾，不无限拉锯；
          //   · 截断轮不纠正（finish_reason=length）：半截正文没有"原句"可发，
          //     纠正它等于诱导模型把半句发出去；
          //   · 文案保留"只是思考"出路：模型确实只是思考（或已说完），仍可
          //     finish 结束 —— 不诱导它硬发不该发的话。
          // 与上方"剩余轮次提醒"同款惯例：纠正消息只进模型 messages，不进
          // session.messages（会话页不展示协议级注入）。
          const roundsLeftAfterCorrect = maxRounds - round - 1;
          if (rawContent && response.finishReason !== 'length'
              && !noToolCallCorrected && roundsLeftAfterCorrect > 0) {
            noToolCallCorrected = true;
            console.log(`[orchestrator] ${session.chatKey || ''} 第 ${round} 轮正文无工具调用（疑似回复写进 content），注入纠正轮`);
            messages.push({
              role: 'user',
              content: '【系统】你的文本输出不会自动发出。如果这是你想说的话，用 send_message 发送原句；如果只是思考，请继续思考或调用 finish 结束。'
            });
            continue;
          }
          break;
        }

        toolCalls = rescued;
        // 与上面的 inline 分支同理：把 assistant 条目改成 tool_calls 形态。
        // 不这么做的话，下面 push 进去的 tool 消息就没有对应的 tool_call，
        // 下一轮请求会被 OpenAI 兼容端点判为非法消息序列。
        const lastRescue = messages[messages.length - 1];
        if (lastRescue?.role === 'assistant') {
          lastRescue.content = null;
          lastRescue.tool_calls = toolCalls;
        }
        const liveRescue = this.sessions.current.get(session.id);
        const uiRescue = liveRescue?.messages?.[liveRescue.messages.length - 1];
        if (uiRescue?.role === 'assistant') {
          uiRescue.content = null;
          uiRescue.tool_calls = structuredClone(toolCalls);
          uiRescue.inlineParsed = true;
          uiRescue.rescued = true;
        }
        markActivity('正在抢救未发出的回复…');
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }

      const toolResults = [];
      const imageUserMessages = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      // 记下这批工具的起点：下面要用"本批新增了哪些发送记录"判断本地模型能不能收尾
      const sentBeforeBatch = session.sent.length;
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        // ── 工具执行前后钩子 ──
        // before-tool 可以**否决**一次调用（返回 {block:true, reason}）——
        // 用于"Skill 运行期发现不该执行"的场景（如知识库索引未就绪）。
        // 注意：否决只是拒绝这一次调用，不会绕过发送队列/限频/存档。
        let blocked = null;
        try {
          const hookResults = await moduleManager.runHook('before-tool', {
            ...skillContext, toolName: name, argsRaw, session
          });
          blocked = hookResults.map((r) => r.value).find((v) => v && v.block) || null;
        } catch (error) {
          moduleManager.recordError('before-tool', error);
        }
        const result = blocked
          ? { content: `错误：${blocked.reason || '该工具调用被 Skill 拒绝'}`, isError: true }
          : await executeTool(toolDefs, ctx, name, argsRaw);
        try {
          await moduleManager.runHook('after-tool', {
            ...skillContext, toolName: name, argsRaw, result, session
          });
        } catch (error) {
          moduleManager.recordError('after-tool', error);
        }
        // Q15（上下文预算）：只截文本结果，parts 数组（图片/视频）不碰。
        try { trimToolResult(result); } catch { /* ignore */ }
        // 工具结果：文本走 tool 消息；媒体（parts 数组）不能塞进 tool 消息 ——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，媒体随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'|'video_url'}]），这是兼容面最广的多模态输入方式。
        //
        // ⚠️ 媒体一律走 parts，**绝不能**混进 contentStr：
        //    base64 图片当文本送进去，模型看不到图却要为几十万 token 付钱。
        let contentStr = '';
        let media = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          // image_url 与 video_url 都要收：视频抽帧走前者，全模态原生读视频走后者。
          // 以前只 filter image_url，video_url 会被静默丢掉（模型只拿到「已发送视频输入」的说明文字）。
          media = result.content.filter((p) => p.type === 'image_url' || p.type === 'video_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (media.length) {
          const imgCount = media.filter((p) => p.type === 'image_url').length;
          const vidCount = media.filter((p) => p.type === 'video_url').length;
          const what = [
            imgCount ? `${imgCount} 张图片` : '',
            vidCount ? `${vidCount} 段视频` : ''
          ].filter(Boolean).join(' + ');
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${what}，请直接"看"了回应]` },
              ...media
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: media.length, images: imgCount, videos: vidCount } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (name === 'finish') {
          finish = true;
        }
      }

      // 这一批已经说出话了：熄灭"正在输入"（消息到达时协议侧本来也会清，
      // 但显式发 0 更稳）。下一轮若继续思考，循环开头会重新点亮。
      if (session.sent.length > sentBeforeBatch) this.#typingStop(chatKey);

      // ── 本地小模型的收尾策略（reply-safety 插件，默认关闭）──
      // 一批"只发送、不遗留待办"的工具结果之后允许提前结束，省掉没有意义的下一轮
      // （本地小模型多跑一轮既慢又容易把已说好的话改坏）。
      // 判定规则本身在插件里（canEndReplyBatch：失败发送 / 预告式结尾 / 该发图却没发
      // 等等都保留正常循环），这里只负责把现场信息递过去。
      // 插件没启用 / localPolicy 没开时该项为 false，行为与没有这套机制一致。
      if (!finish) {
        const policyFn = this.#capFirst('reply.local-policy', skillContext);
        if (policyFn) {
          try {
            const r = policyFn({
              api: cfg.api || {},
              entries: triggerEntries,
              batch: {
                calls: toolCalls,
                results: toolResults,
                newSent: session.sent.slice(sentBeforeBatch),
                allSent: session.sent,
                searched: webSearchCount > 0
              }
            });
            if (r?.shouldEnd) {
              finish = true;
              session.finishReason = session.finishReason || '本地收尾策略判定：本批已交付完毕';
            }
          } catch (error) { moduleManager.recordError('reply-safety', error); }
        }
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 媒体消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    this.sessionAbortControllers.delete(session.id);
    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage
    });
  }

  // （旧 getChatName/#chatName 群名片缓存已随 Q9 群聊分支摘除 —— routes.js
  //   /api/chats 的显示字段 chatName 恒空串，取号退回 chatKey。）

  // ── 钟（步骤⑤ / T5.1）────────────────────────────────────────────────

  /**
   * 启动钟：登记反思执行器的 tick 并开始心跳（每 60s 一轮"到点检查"）。
   * app.js 启动流程调用（与 startReminderLoop 并列）；abortAll() 里 stopClock() 收口。
   * check/run 都委托给反思执行器 —— 钟与 orchestrator 都不含反思的业务词表。
   */
  startClock() {
    this.clock.registerTick({
      id: 'reflection',
      check: (now) => reflectionDueCount(now, { store: this.store }) > 0,
      run: async (now) => { await reflectionRunDue({ store: this.store, now }); }
    });
    // Q15（原日记插件收编）：60 秒心跳里只做本地闸门判断；
    // 到点才调 runDiary（writeGate 自己找“互道晚安”，不依赖 after-response 钩子）。
    this.clock.registerTick({
      id: 'diary',
      check: (now) => diaryCheckDue({ store: this.store, now }),
      run: async (now) => { await diaryRun({ store: this.store, now, source: 'timer' }); }
    });
    // night-plan-life §L3（生活→心绪接线）：第三 tick——今日日程里的情绪载荷过点消费。
    // check：今日 plan 存在 + 有"时间已过且未消费"的 emotionalLoad 条目；run：逐条
    // mind.apply（数值轴，impact=0.5）+ 标 consumedAt（person/life.write 原子重写）。
    // mood.text 不自动改（文本轴归 mind_note 模型自驱）。check/run 全部委托 life 模块
    // ——钟与 orchestrator 不含业务词表（与 reflection/diary tick 同款 60s 心跳）。
    this.clock.registerTick({
      id: 'life',
      check: (now) => lifeCheckDue({ now }),
      run: (now) => { lifeConsumeDue({ now }); }
    });
    this.clock.startHeartbeat(60000);
  }

  /** 停钟（进程停止路径；tick 登记保留，重启后 startClock 原样续跑）。 */
  stopClock() {
    this.clock.stop();
  }

  // ── 提醒（闹钟/计时）调度 ─────────────────────────────────────────────

  /** 启动提醒调度循环：每 20 秒检查一次到点的提醒并触发。 */
  startReminderLoop() {
    this.stopReminderLoop();
    if (!this.reminders) return;
    const tick = async () => {
      if (this.aborted) return;
      try {
        const dueList = this.reminders.due(Date.now());
        for (const r of dueList) {
          if (this.reminderFiring.has(r.id)) continue;
          this.reminderFiring.add(r.id);
          try {
            // 发送成功后才标记 fired；失败保留未触发状态，下一轮重试。
            // （反过来"先标记再发"会让进程崩溃/发送链故障时的提醒永久丢失）
            await this.#fireReminder(r);
            this.reminders.markFired(r.id);
          } catch (error) {
            console.error('[reminder] 触发失败，将在下一轮重试:', error?.message ?? error);
          } finally {
            this.reminderFiring.delete(r.id);
          }
        }
        if (dueList.length) this.reminders.prune();
      } catch (error) {
        console.error('[reminder] 调度出错:', error?.message ?? error);
      }
      this.reminderTimer = setTimeout(() => { tick().catch(() => {}); }, 20000);
    };
    this.reminderTimer = setTimeout(() => { tick().catch(() => {}); }, 5000);   // 启动 5s 后第一次检查
  }

  stopReminderLoop() {
    if (this.reminderTimer) { clearTimeout(this.reminderTimer); this.reminderTimer = null; }
  }

  /** 触发一条提醒：往对应会话发一条提醒消息（走统一出站口，留档）。 */
  async #fireReminder(r) {
    // Q10：守卫放宽为"有键即可"——旧 `!id` 要求 'web:main' 式前缀键，收敛后存储键
    // 'main'（裸）也是合法落点（registry.route 落 DEFAULT_SURFACE 身体）；提醒记录的
    // 键来自 set_reminder 工具的 ctx.chatKey（路由键 'web:main'）或 cli-body（'main'），
    // 两条路都能路由到正确的身体。
    const [kind] = String(r.chatKey || '').split(':');
    if (!kind) return;
    const text = `⏰ 提醒：${r.text}`;
    // P1（night-plan §4.2）：改走统一出站口 #emitOutbound → 身体 emit('text') ——
    // 与机器人发言同一条身体发送链（限频 / 去重 / 超长切分 / 留档 appendSelf）。
    // 原先直呼发送原语会绕过这些项 —— 表现为提醒与正常发言并发抢发、限频计数
    // 不到它、超长提醒被截断；该纪律与身体无关，web 身体下同样成立。
    // 失败必须向上抛，让调度循环保留未触发状态以便重试。
    // E5：提醒不在任何 submit 运行内触发 —— sourceEventId 按该提醒会话的路由键查表
    // （该会话有在途提交时为其 event.id，否则 null），保持四构造点口径一致。
    await this.#emitOutbound(r.chatKey, { type: 'text', payload: { text: [text] }, sourceEventId: this.#eventIds.get(r.chatKey) ?? null }).then((result) => {
      // 极端边界：同一会话 8 秒窗口内两条文本完全相同的提醒，第二条会被发送去重
      // 拦下（sendTextBatch 正常返回但 deduped）。留个日志，别无声消失。
      if (result?.sent?.some((s) => s?.deduped)) {
        console.warn(`[reminder] 提醒文本与刚发送的内容完全相同，被去重跳过（${r.chatKey}）`);
      }
    });
    this.emit('chat-update', r.chatKey);
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      // 挑一个"安静且允许"的群
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      // Q9 群聊分支摘除：候选不再按会话性质过滤，旧白名单闸（config 缺省键 Q4
      // 已摘的接入名单段）一并消亡——主动开口是"她想说话"（人格），不是"群里
      // 插话"（参与度）；判据见内部文档（落地规格）§2.4。
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  // （旧 #muteCache + #checkSelfMuted 机器人禁言检测已随 Q9 群聊分支摘除：
  //   禁言是旧群载体的发送约束——ban-state 能力询问 + 协议端成员信息查询
  //   两条路径一并消亡；wake 的按前缀识别分支同批删除。）

  // ── 旧「群友印象自动整理」整链路已在步骤⑦（T7.1）移除并归档（_archive-20261107）──
  // 最后一条绕过卡片管线直调模型的旁路就此清零；记忆巩固唯一走 person 卡片管线
  //（src/capabilities/reflection/）。旧数据文件只读保留，数据归档另行处置。

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  /**
   * 中止单个运行中的会话（会话页「中止」按钮）。
   *
   * 与 abortAll（全局暂停用）不同：只针对一条会话，其它会话与调度不受影响。
   * 两层机制：
   *   1. **请求级中断（真正停住）**：给运行挂一个 AbortController，
   *      #runAgent 的每次 LLM 请求都带上它的 signal —— 正在途中的请求立刻
   *      中断（不再等 180 秒超时/响应读完），这是"停不住"的根治。
   *      fetch abort 抛 AbortError，chatCompletionWithRetry 里 isRetryableError
   *      判为不可重试（aborted），会话随即收尾，不会再打下一发请求。
   *   2. 轮次级检查（兜底）：工具循环每轮开始时检查标记并走标准收尾路径。
   *
   * 等待中（waiting）的会话也可以中止：撤掉防抖定时器，让等待会话干净消失
   * （从未消耗过 token 的等待会话不该留一条"中止"记录）。
   *
   * @returns {{ok:boolean, reason?:string}}
   */
  abortSession(sessionId) {
    const id = String(sessionId || '');
    if (!id) return { ok: false, reason: '缺少会话 id' };
    // 等待中：撤掉防抖定时器，让等待会话干净消失（不算"中止"，没花过 token）
    for (const [chatKey, waitingId] of this.pendingSessions.entries()) {
      if (waitingId === id) {
        if (this.wakeTimers.has(chatKey)) {
          clearTimeout(this.wakeTimers.get(chatKey));
          this.wakeTimers.delete(chatKey);
        }
        this.#cancelUnreadFallback(chatKey);
        this.pendingWake.delete(chatKey);
        this.pendingSessions.delete(chatKey);
        this.#discardWaiting(waitingId);
        return { ok: true };
      }
    }
    // 运行中：打标记 + 立刻中断在途请求
    for (const [chatKey, runId] of this.activeRuns.entries()) {
      if (runId === id) {
        this.sessionAbortMarks.add(id);
        // 在途的 LLM 请求立即中断。abort 的 reason 会一路抛到 #runAgent 的
        // catch —— isRetryableError 视为不可重试，直接走到轮次级检查收尾。
        const ctrl = this.sessionAbortControllers.get(id);
        if (ctrl) {
          try { ctrl.abort(new Error('会话已被用户中止')); } catch { /* 已中止过 */ }
        }
        // 会话级重试的退避等待中：没有在途请求可中断，靠标记在下一轮检查时拦住。
        return { ok: true };
      }
    }
    return { ok: false, reason: '该会话不在运行/等待中，无法中止' };
  }

  async abortAll() {
    this.aborted = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    for (const timer of this.unreadFallbackTimers.values()) clearTimeout(timer);
    this.unreadFallbackTimers.clear();
    this.pendingWake.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.#typingStopAll();   // 别让任何会话停在"对方正在输入…"
    // E5 per-routeKey（清债夜3）：全局中止 → 所有路由键的触发源登记一并清空。
    // 放在 #typingStopAll 之后：熄灭意图仍带各自触发源（与单值时代口径一致）。
    this.#eventIds.clear();
    this.stopProactiveLoop();
    this.stopClock();        // 钟（步骤⑤）：进程停止路径一并收口
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      // Q11：连接状态字段随协议端句柄持有摘除（/api/status 的
      // orchestrator 段少一键；前端 StatusPayload 未消费该键，形状变化零断链）。
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}
