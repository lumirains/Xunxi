// 身体层 · 信封契约（Phase 8a / T8a）。
// 只有 @typedef 与冻结常量，零实现 —— 与 person/contracts.js 同一纪律。
// 逐字照《内部文档 adapter-contract-draft.md》（v3 T1.1）抄录：§2 信封（InboundEvent /
// OutboundIntent / SurfaceCapabilities，字段与注释逐字保留，上游 v2 清单 §3.1–3.4）、
// §2.4 Brain 三入口与 io、§3「信封通用，词表个体」。
// 相关决策：D18（conversationId 前缀路由，历史零迁移）、D19（M1：emit 不覆盖显式
// conversationId）、D20（visibility/urgency 只落字段不做过滤逻辑）、D21（Phase 8 前不实装
// 运行时——本文件即 Phase 8a「只建框架」的第一块）、D28（记忆写入权归大脑，身体只回报）。
//
// ── 三句话读法（照草案 §3，五原则⑤：契约是膜）────────────────────────────
// 1. 信封通用：InboundEvent / OutboundIntent / SurfaceCapabilities 的字段名与形状、
//    五条规则（草案 §2.5），对所有身体（qq / 未来的 pet、diary）通用，写死在本文件。
// 2. 词表个体：type 的枚举值是各身体**私有**的意图词表。QQ 认识 text/sticker/image/
//    typing/poke（该身体已归档 legacy/qq-adapter，词表记录保留于此作契约史）；桌宠会
//    有 touch/reaction；日记本会有 diary。身体收到不认识的 type 必须返回
//    {ok:false,error:'unsupported'}（'unsupported type' 字样为各身体实现惯例）而不是崩溃。
// 3. 路由规则（D18）：conversationId 带 '<surface>:' 前缀 → 路由到对应身体
//    （'pet:default'→pet、'diary:*'→diary、'web:*'→web）；无前缀（含全部历史
//    'private:'/'group:' 与 Q10 起的裸存储键 'main'）→ 默认身体 'web'（Q11 起）。
//    历史数据零迁移，chatKey 格式不可变（v3 §3.A，存量消息与磁盘文件名语义不动）。
//    M1 修正（D19）：皮层组装工具 ctx 处，intent 未带 conversationId 时才补 ctx.chatKey
//    —— emit 不覆盖显式 conversationId，否则跨会话发送意图永远发回当前会话。
//    E5 追加（night-plan-qq-exit Q1，本地扩展、非上游草案字段）：OutboundIntent 增
//    sourceEventId —— 出站意图指回触发它的入站事件（InboundEvent.id），无 submit 语境
//    为 null。溯源字段：身体/日志按需读取，路由与翻译不依赖它。

/**
 * 入站事件信封（照草案 §2.1 = v2 清单 §3.1 逐字）。
 * 幂等：同一个 event.id 重放不产生两次副作用（身体至少进程内去重；
 * QQ 事件 id 形如 'qq:mid:<mid>'，草案 §2.5 规则 4 / §7 拆分表 #3）。
 *
 * @typedef {Object} InboundEvent
 * @property {string} id                 // 幂等键；adapter 重试不重复处理
 * @property {'qq'|'pet'} surface
 * @property {string} conversationId     // QQ 沿用 'private:123' / 'group:456'
 * @property {'message'|'touch'|'presence'|'idle'|'command'} type
 * @property {{id:string,name:string}} actor
 * @property {number} ts
 * @property {{text?:string, attachments?:Array, meta?:Object}} payload
 * @property {{addressed?:boolean, urgency?:'fast'|'normal'}} hints
 * @property {'private'|'ambient'|'shared'} visibility
 */

/**
 * 出站意图信封（照草案 §2.2 = v2 清单 §3.2 逐字）。
 *
 * Intent 是声明式的（草案 §2.5 规则 3）：大脑不说"调用 send_private_msg"，
 * 只说"发一条文字给这个会话"；分几条、延迟多久、失败怎么重试是身体的事（草案 §1.3）。
 *
 * 返回形状铁律（草案拆分表 #7 / v2 清单 §12 坑 #9 / 决策 D15）：工具面向的 emit
 * （M1：ctx.emit → registry.route(cid).emit，草案 §8）返回**身体翻译层的原始形状**——
 * text 的 {sent,failed}、sticker/image 的 {message_id}——逐字节保持，不包 {ok} 信封、
 * 不改字段名。草案 §2.4 io.emit 的 {ok,intentId,messageId?,error?} 信封属于
 * brain.submit 写路径（Phase 8b orchestrator 出站接线时落），两处不得混用：
 * 形状一变，工具抛 TypeError，模型连续收到"发送失败"并重试
 * （DRY_RUN 12 轮 / 164k token 为活证，D15）。
 *
 * @typedef {Object} OutboundIntent
 * @property {string} id
 * @property {string} conversationId
 * @property {'text'|'sticker'|'image'|'typing'|'poke'|'reaction'} type
 * @property {Object} payload            // text / stickerId / url / on:true / motion
 * @property {'fast'|'normal'} urgency
 * @property {string|null} replyTo       // QQ 的 mid；桌宠可为 null
 * @property {string|null} sourceEventId // E5（night-plan-qq-exit Q1）：触发本意图的入站
 *                                       // InboundEvent.id（'qq:mid:<mid>' / 'web:<ts>:<rand>'
 *                                       // 等）；无 submit 语境（提醒/积压/主动）为 null。
 *                                       // 大脑出站构造点负责盖戳，身体只读不校验。
 */

/**
 * 身体能力表（照草案 §2.3 = v2 清单 §3.3 逐字）。
 * 能力握手是大脑了解身体的唯一通道之一（草案 §2.5 规则 2：大脑不 import 平台模块）。
 * QQ 最小值（v2 清单 §5.5）：canText/canSticker/canImage/canTyping=true，
 * canVoice/canAnimate=false，maxTextLength=4500，supportsReply=true。
 *
 * @typedef {Object} SurfaceCapabilities
 * @property {string} surface
 * @property {boolean} canText
 * @property {boolean} canVoice
 * @property {boolean} canSticker
 * @property {boolean} canImage
 * @property {boolean} canAnimate
 * @property {boolean} canTyping
 * @property {number} maxTextLength
 * @property {boolean} supportsReply
 */

/**
 * Brain（大脑）接口 —— 照草案 §2.4（v2 清单 §3.4）：只有三个入口，不要更多。
 *   1. 写路径：brain.submit(event, io) -> Promise<{ ok, silent?, error? }>
 *      io.emit 是 Brain 唯一能"命令身体"的方式。
 *   2. 读路径：brain.project(view, params) -> Object
 *      view: 'recent_context' | 'surface_state'（只读投影，按 surface 过滤，
 *      不暴露原始记忆；surface_state 只含 mood 标签 / energy / 是否可打扰）。
 *   3. 能力握手（adapter → brain）：io.capabilities() -> SurfaceCapabilities。
 *   可选：brain.describe() -> { views: string[], tools: string[] }（调试/UI 自述，不参与主流程）。
 * 大脑不 import 平台模块：需要平台信息，通过 io.capabilities() 或 event.hints（草案 §2.5 规则 2）。
 *
 * @typedef {Object} Brain
 * @property {(event: InboundEvent, io: BrainIo) => Promise<{ok: boolean, silent?: boolean, error?: string}>} submit
 * @property {(view: 'recent_context'|'surface_state', params: Object) => Object} project
 * @property {() => {views: string[], tools: string[]}} describe
 */

/**
 * io —— 由身体实现，交给 brain.submit（照草案 §2.4 逐字）。
 * 身体不传 prompt / tools（草案 §2.5 规则 1）；五原则②：身体只回报事实（onSent
 * 交付报告，D28），记忆写入权归大脑。
 *
 * @typedef {Object} BrainIo
 * @property {() => SurfaceCapabilities} capabilities
 * @property {(intent: OutboundIntent) => Promise<{ok: boolean, intentId?: string, messageId?: any, error?: string}>} emit
 */

/**
 * 当前在册身体 surface 名单（冻结）。
 * 现在只有 'web' 一个身体（surfaces/web/adapter.js，夜间计划 W2 起；Q11 起 QQ 身体已
 * 归档 legacy/qq-adapter 并注销注册）——它同时是 registry 的默认路由目标（无前缀
 * chatKey → 'web'，D18；Q11 起 DEFAULT_SURFACE='web'）。'pet'/'diary' 身体按 Phase 8
 * 拆分表 #4 落地后随 registry 一起扩这份名单 —— 提前写进常量属于为第二个身体加机制
 * （五原则⑤：第二三个身体出现前不加机制）。
 */
export const SURFACES = Object.freeze(['web']);

// R1（2026-11-13）登记：主人跨身体别名 OWNER_ACTOR_ID='owner' 的常量本体放在
// src/person/contracts.js（含约定全文与安全依据）——身体按此约定在 actor.id 断言
// 主人（web 生产者：src/routes.js /api/web/send）。不落在本文件的原因：check-
// boundaries（tools/check-boundaries.mjs:213）禁止扫描根（含 plugins/）以任何相对
// 形式 import 'surfaces' 路径段；首个消费者已随 Q15 禁用，但常量
// 仍是身体层契约的一部分。person/contracts.js 是插件可达的契约之家，两侧同源同义，
// 此处只留指针。

/**
 * 意图 type 候选合集（冻结）—— 照草案 §3（源：v2-细化 T4.0.2）**仅作登记**。
 * 这不是跨身体协议：每个身体只认识自己的子集（QQ：text/sticker/image/typing/poke；
 * 桌宠：touch/reaction；日记本：diary），认识与否由各身体的 emit 自行判定 ——
 * 收到不认识的 type 返回 {ok:false,error:'unsupported…'} 而不是崩溃（见文件头第 2 条）。
 * 常量冻结只为防手滑改写；语义上仍是登记表，新身体接入**不需要改信封**（草案 §3）。
 */
export const INTENT_TYPES = Object.freeze(['text', 'sticker', 'image', 'typing', 'poke', 'reaction', 'diary']);
