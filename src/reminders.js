// 提醒（闹钟/计时）持久化存储。
// storage-v2 V5 起后端 = xunxi.db **kv 表（k='reminders'，v={reminders:[…]} 整容器 JSON）**
//（原 data/reminders.json 已随迁移改为 .pre-storage-v2 原位归档；数据根该文件在夜0 时
// 不存在——kv 迁移段对缺文件按"无行"处理，读侧同样回落空表，语义一致）。
// 每条：{ id, chatKey, text, dueAt, createdAt, createdBy, fired }
//
// 设计：模型通过 set_reminder 工具设定 → 这里落库 → ReminderScheduler 到点触发。
// 落库是为了重启不丢：进程重启后调度器会重新加载所有未触发的提醒。
import crypto from 'node:crypto';
import { kvGet, kvPut } from './storage/state-map.js';

const KV_KEY = 'reminders';

function load() {
  try {
    const obj = kvGet(KV_KEY);
    if (obj && Array.isArray(obj.reminders)) return obj.reminders;
  } catch { /* 行缺失/损坏 → 空表（与文件时代 catch 口径一致） */ }
  return [];
}

function save(reminders) {
  // 整容器 UPSERT（kv 值 = 原文件形态 {reminders:[…]}，导出工具可还原文件形态）；
  // 写失败抛错上抛——与文件时代 writeFileSync 的失败面一致（调用方可见）。
  kvPut(KV_KEY, { reminders });
}

export class ReminderStore {
  constructor() {
    this.reminders = load();
  }

  /** 新增一条提醒。返回该提醒。 */
  add({ chatKey, text, dueAt, createdBy = '' }) {
    const entry = {
      id: `r_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`,
      chatKey: String(chatKey),
      text: String(text ?? '').trim(),
      dueAt: Number(dueAt),
      createdAt: Date.now(),
      createdBy: String(createdBy ?? ''),
      fired: false
    };
    this.reminders.push(entry);
    save(this.reminders);
    return entry;
  }

  /** 列出某会话未触发的提醒（按到期时间升序）。 */
  pending(chatKey = null) {
    return this.reminders
      .filter((r) => !r.fired && (!chatKey || r.chatKey === chatKey))
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  /** 取所有到点且未触发的提醒。 */
  due(now = Date.now()) {
    return this.reminders.filter((r) => !r.fired && r.dueAt <= now);
  }

  /** 标记一条提醒已触发（落库）。 */
  markFired(id) {
    const r = this.reminders.find((x) => x.id === id);
    if (!r) return false;
    r.fired = true;
    r.firedAt = Date.now();
    save(this.reminders);
    return true;
  }

  /** 取消一条提醒（按 id）。返回是否取消成功。 */
  cancel(id) {
    const before = this.reminders.length;
    this.reminders = this.reminders.filter((x) => x.id !== id);
    if (this.reminders.length < before) {
      save(this.reminders);
      return true;
    }
    return false;
  }

  /** 清理已触发很久的旧提醒（保留最近 200 条已触发的，防容器无限增长）。 */
  prune() {
    const fired = this.reminders.filter((r) => r.fired).sort((a, b) => (b.firedAt || 0) - (a.firedAt || 0));
    const pending = this.reminders.filter((r) => !r.fired);
    if (fired.length > 200) {
      this.reminders = [...pending, ...fired.slice(0, 200)];
      save(this.reminders);
    }
  }
}
