// 单一时间线消息存储（Q10 chatKey 收敛，night-plan-qq-exit §Q10）。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"已读信息"。
//
// Q10 降维：旧版按 chatKey（group:xxx / private:xxx / web:xxx）分会话存档（Map + 一
// 文件一键）；群聊随 Q9 摘除、web 身体接管唯一活跃对话后，会话不再有"多份"——
// 全部收敛到单一时间线 `main`。**storage v2 起（2026-11-17，执行清单 T2.1）落盘从
// data/messages/main.json 整文件原子回写切换为 SQLite `messages` 表 + `meta` 精确
// 计数器（data/xunxi.db，WAL）**：写放大消灭（每条消息 = 一次 INSERT，不再是 600KB+
// 整文件重写）。公开方法签名保留 chatKey 形参但**内部一律忽略**（白皮书 7.5"ChatStore
// 参数可留"口径：调用点零改动，存储键与 orchestrator→registry 的路由键分离——路由键
// 'web:main' 等带身体前缀的值到了这一层都指向同一条时间线）。
//
// **读缓存取舍（T2.1 实测决策）**：内存缓存保留（plan §4 本行明文口径）——#state 懒
// 加载一次（messages 全量按插入序 + meta 计数器），全部读方法继续走内存数组（与文件
// 时代逐字节同序同形），只有写路径落 DB。读穿透 DB 会拖慢 recent() 热路径且引入形状
// 漂移风险，最小改动=只换持久化后端、读面零改动。
//
// 条目格式（web 身体现行语义；isPoke/atMe/atNames/recalled 为历史数据兼容字段）：
// {
//   id:        本地递增序号（自 1 起，时间线内唯一，用于 UI 定位）
//   mid:       协议事件 id（InboundEvent.id，如 'web:<ts>:<rand>'，或信封自带的
//              meta.mid；本地自发记录可能为 null）—— 入站回落口径见 orchestrator.submit
//   ts:        时间戳毫秒
//   senderId:  身体侧 actor id（自己发送的为 'self'）
//   senderName:actor 显示名（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, id }] 现行 web 形状（消息条目只存媒体 id）；
//              kind: 'image' | 'audio'（V0 媒体层音频化新增音频值；16 列 schema
//              与 JSON 文本列不动，spec §2.5）；
//              QQ 时代 { kind, url, ... } 条目在历史数据中共存
//   isPoke:    历史数据兼容字段（拍一拍标记；Q9 起纯数据，不进【已读信息】）
//   atMe/atNames: 历史数据兼容字段（@ 判定的历史产物；Q9 起纯数据，不再参与判定）
//   recalled:  历史撤回标记（写入方 API 已删；提示词组装仍按该字段过滤历史条目）
// }
// 行 ↔ 条目映射与形状保真契约（键序/self 行缺键/mid 类型重建/seq 插入序）统一在
// src/storage/messages-map.js（store 与迁移工具共用，勿在两侧各写一份）。
import { getDb, transaction, setMeta } from './storage/db.js';
import { MESSAGE_COLUMNS, entryToRow, loadTimelineFromDb } from './storage/messages-map.js';

const INSERT_SQL = `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')}) VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})`;

// 语句按调用点 prepare（不模块级缓存：测试/迁移经 closeDb() 重开连接后旧语句失效，
// 每消息一次的频率下 prepare 开销可忽略——正确性优先）。

export class ChatStore {
  // 单一时间线状态（懒加载，内存缓存保留）：{ chatKey:'main', nextLocalId, messages }。
  // 旧版是 Map（chatKey -> state，随消息懒加载各会话）；Q10 收敛后只有这一份；
  // storage v2 起数据真身在 data/xunxi.db（messages 表 + meta 计数器）。
  #state = null;

  constructor(maxPerChat = 0) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  #loadState() {
    if (!this.#state) this.#state = loadTimelineFromDb();
    return this.#state;
  }

  listChats() {
    // Q10：单一时间线，恒 ['main']。旧版从磁盘文件名还原会话键（group_N.json /
    // web_main.json → group:123 / web:main）；收敛后唯一会话键固定 'main'（v2 起 =
    // messages 单表 + meta.chatKey），历史文件名不再还原成会话。
    this.#loadState();
    return ['main'];
  }

  getChatMeta(chatKey) {
    const st = this.#loadState();
    // 未读只计他人消息（与 unreadCount / peekUnread 口径一致）——
    // 曾经用 !m.read 把 self 也算进去，机器人自己的发言会把角标顶大。
    const unread = st.messages.filter((m) => !m.read && !m.self).length;
    const last = st.messages[st.messages.length - 1] || null;
    // chatKey 恒 'main'（单一时间线；形参忽略——调用点兼容保留）
    return { chatKey: 'main', total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /** 追加一条收到的消息（未读）。返回写入的条目；重复消息返回 null。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], isPoke = false, atMe = null, atNames = [] }) {
    const st = this.#loadState();
    const midKey = mid === null || mid === undefined ? '' : String(mid);
    const tsNow = ts || Date.now();
    const textNow = String(text ?? '');
    const senderNow = String(senderId ?? '');
    // ── 去重（2026-11-06）──────────────────────────────────────────────
    // 实测同一条 QQ 消息会被重复投递（重连/协议端重放），同 mid 连写 4 条，
    // 历史里还有 x2/x3。QQ 的 message_id 在同一会话内唯一，同 mid 必为同一条。
    // 另外兜一层"同人 + 同文本 + 1 秒内"：协议端偶尔重放时 mid 可能变，
    // 1 秒窗口足够挡住重投，又不会误伤正常的重复发言（人不会同秒发两遍）。
    if (midKey) {
      const dupMid = st.messages.find((m) => m && String(m.mid ?? '') === midKey);
      if (dupMid) return null;
    }
    if (!isPoke && textNow) {
      const dupNear = st.messages.find((m) => m && !m.self && !m.isPoke
        && String(m.senderId ?? '') === senderNow
        && String(m.text ?? '') === textNow
        && Math.abs(Number(m.ts || 0) - tsNow) <= 1000);
      if (dupNear) return null;
    }
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: tsNow,
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : [],
      // 拍一拍事件：可作触发批（即时召唤信号；Q9 前由档位判定按 1 档响应），
      // 但不进【已读信息】
      isPoke: Boolean(isPoke),
      // @ 判定标记（2026-09-26）：atMe 以 @ 段的 QQ 号为准 —— 文本包含匹配
      // 分不清"同名不同人"（群友 @ 的人与机器人重名时被误判为 @机器人）。
      // null = 老存档未标。Q9 起纯数据字段（判定层已随群聊摘除），保留兼容历史数据。
      atMe: atMe === null || atMe === undefined ? null : Boolean(atMe),
      // 渲染进 text 的 @片段原文（含 @ 前缀）：旧关键词判定据此剔除
      // （Q9 起纯数据字段，保留兼容历史数据）。空数组 = 该消息没有 @ 段。
      atNames: (Array.isArray(atNames) ? atNames : []).map((n) => String(n ?? '')).filter(Boolean).slice(0, 20)
    };
    st.messages.push(entry);
    const removedIds = this.#trim(st);
    this.#persistAppend(entry, removedIds);
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。
   *  V2 语音条（voice-walkie）：可选 media（[{kind:'audio', id}]，E1 只存 id）——
   *  web 身体 recorder 透传 TTS 合成的音频 id，与文字同条同档（刷新后语音气泡仍在）。
   *  缺省 []（向后兼容：既有调用方零感知，形状与 appendIncoming media 同款）。 */
  appendSelf(chatKey, { text, ts, mid = null, media = [] }) {
    const st = this.#loadState();
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: Array.isArray(media) ? media : []
    };
    st.messages.push(entry);
    const removedIds = this.#trim(st);
    this.#persistAppend(entry, removedIds);
    return entry;
  }

  /**
   * 写路径（storage v2）：新行 INSERT + 被裁剪行 DELETE + 精确计数器递增，全部同一事务。
   * 计数器真身 = meta.nextLocalId（迁移取旧文件原值；MAX(id)+1 在删过消息后会复用 id，
   * plan §3 meta 注——**禁止**用它替代计数器）。chatKey 每次写入归一落 'main'（旧
   * saveChat 归一内嵌键的 DB 对应物）。
   */
  #persistAppend(entry, removedIds) {
    const st = this.#state;
    transaction(() => {
      const db = getDb();
      if (removedIds.length) {
        const ph = removedIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...removedIds);
      }
      // seq = 插入序（messages-map.js 契约 6）：与 INSERT 同事务取 MAX+1，裁剪删除
      // 先执行所以 MAX 反映裁剪后的行集。
      const seq = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM messages').get().s;
      db.prepare(INSERT_SQL).run(...entryToRow(entry, seq));
      setMeta('nextLocalId', String(st.nextLocalId));
      setMeta('chatKey', 'main');
    });
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#loadState();
    const unread = st.messages.filter((m) => !m.read && !m.self);
    for (const m of st.messages) m.read = true;
    // 置已读只翻 read=0 的行（self 行恒已读——appendSelf 写 read:true）；最终状态与
    // 旧实现「全量置 true + 整文件回写」逐字节一致。
    transaction(() => getDb().prepare('UPDATE messages SET read = 1 WHERE read = 0').run());
    return unread;
  }

  /**
   * 只 drain「从某条消息起**之后**」的未读：取走触发批，之前的旧积压单独标已读。
   *
   * 为什么需要它（2026-09-25 触发链路重做的补丁）：磁盘上可能遗留旧进程/
   * 暂停期间攒下的积压未读。它们没赶上本批的倒计时窗口，如果一次
   * 触发的 drain 把它们全部吃进触发批，模型会看到一大坨"未读信息"——用户
   * 看到的就是"积压消息被整批塞进唤醒"。正确语义：
   *   · 触发消息 X 之后的未读 = 本批的聚批对象（X 也在内）；
   *   · X 之前的旧未读 = 触发前就该已读的历史 → 标已读沉入【已读信息】。
   *
   * @param {string} chatKey
   * @param {number} fromTs 批的起点（触发消息的 ts，含）；早于它的未读标已读
   * @returns {{ batch: object[], archived: number }} batch = 触发批，archived = 被归档的旧未读条数
   */
  drainUnreadFrom(chatKey, fromTs) {
    const st = this.#loadState();
    const unread = st.messages.filter((m) => !m.read && !m.self);
    const batch = [];
    let archived = 0;
    for (const m of unread) {
      if (m.ts >= fromTs) batch.push(m);
      else { m.read = true; archived++; }   // 触发点之前的旧积压：沉入历史
    }
    for (const m of st.messages) m.read = true;   // batch 里的也置已读（作为触发批取走）
    transaction(() => getDb().prepare('UPDATE messages SET read = 1 WHERE read = 0').run());
    return { batch, archived };
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#loadState();
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; n++; }
    }
    if (n) transaction(() => getDb().prepare('UPDATE messages SET read = 1 WHERE read = 0 AND self = 0').run());
    return n;
  }

  /**
   * 把时间窗内的**已读**消息重新标记为未读（手动重试失败会话用）。
   *
   * 触发批当初被 drainUnread 置了已读；重试时按会话起止时间把它们翻回未读，
   * 唤醒流程就能重新取走它们。窗口向前放宽 5 分钟（容纳防抖聚批期），
   * 向后到会话结束 —— 窗口外的不动，避免误翻后来真正已读的历史。
   * @returns {number} 恢复为未读的条数
   */
  markUnreadInWindow(chatKey, startedAt, endedAt) {
    const st = this.#loadState();
    const winStart = Number(startedAt) - 5 * 60 * 1000;
    const winEnd = Number(endedAt || startedAt) + 1000;
    let n = 0;
    for (const m of st.messages) {
      if (m.self) continue;
      if (m.read && m.ts >= winStart && m.ts <= winEnd) { m.read = false; n++; }
    }
    if (n) {
      transaction(() => getDb()
        .prepare('UPDATE messages SET read = 0 WHERE read = 1 AND self = 0 AND ts >= ? AND ts <= ?')
        .run(winStart, winEnd));
    }
    return n;
  }

  unreadCount(chatKey) {
    const st = this.#loadState();
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#loadState();
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#loadState();
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#loadState();
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#loadState();
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /**
   * 删除指定本地 id 的消息（部分清除）。返回删掉的条数。
   * @param {string} chatKey
   * @param {number[]} localIds 本地递增 id 数组
   */
  removeByLocalIds(chatKey, localIds = []) {
    const st = this.#loadState();
    const ids = new Set((Array.isArray(localIds) ? localIds : [localIds]).map(Number));
    if (!ids.size) return 0;
    const before = st.messages.length;
    st.messages = st.messages.filter((m) => !ids.has(m.id));
    const removed = before - st.messages.length;
    if (removed) {
      // DELETE 触发 messages_ad 触发器 → FTS 同步移除（plan §3/§12）
      transaction(() => {
        const ph = [...ids].map(() => '?').join(', ');
        getDb().prepare(`DELETE FROM messages WHERE id IN (${ph})`).run(...ids);
      });
    }
    return removed;
  }

  /**
   * 清空某会话的全部消息（整体清除）。返回删掉的条数。
   * v2 起 = messages 表清空；meta.nextLocalId **不重置**（与旧实现一致：只清 messages
   * 数组，id 计数器延续——清空后再来的消息 id 继续递增，不复用已删 id）。
   */
  clearChat(chatKey) {
    const st = this.#loadState();
    const removed = st.messages.length;
    if (removed) {
      st.messages = [];
      transaction(() => getDb().prepare('DELETE FROM messages').run());
    }
    return removed;
  }

  /** 超限裁剪（从头部截断）。返回被裁剪条目的本地 id（由写路径在同一事务里 DELETE）。 */
  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      const removed = st.messages.splice(0, st.messages.length - this.maxPerChat);
      return removed.map((m) => m.id);
    }
    return [];
  }
}
