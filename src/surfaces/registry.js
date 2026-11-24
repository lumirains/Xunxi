// 身体层 · adapter 注册表（Phase 8a）。
// 照草案 §8 / 决策 D18（源：v2-细化 T4.0.5）：registry 就是纯 Map + 前缀表 ——
// { register(adapter), get(surface), list(), route(conversationId) }；
// 改路由 = 改一行纯数据（v2-细化 §0.1 五扩展点 #3）。纯 Map 零依赖：不 import 任何模块。
//
// 路由规则（D18，历史数据零迁移——chatKey 格式不可变，v3 §3.A）：
//   'pet:xxx'   → surface 'pet' 的身体（未来桌宠）
//   'diary:xxx' → surface 'diary' 的身体（未来日记本）
//   'web:xxx'   → surface 'web' 的身体（web 身体，夜间计划 W2 起）
//   其余（含全部历史 'private:123' / 'group:456' / 无前缀裸串 / 空串）→ 默认身体 'web'
//   （Q11 起：QQ 身体归档 legacy/qq-adapter，web 是唯一在册身体也是默认落点——
//   Q10 的裸存储键 'main' 直入 route 的积压恢复/主动开口路径自此落 web 身体，
//   handoff §9-19-9 登记的 Q10→Q11 边界随之闭环消亡。历史键值零迁移，store 键盲。）
//
// 用法（草案 §8 M1 修正 / D19，Phase 8b 在 orchestrator 出站 ctx 接线）：
//   ctx.emit = (intent) => {
//     const cid = intent.conversationId ?? ctx.chatKey;   // 显式 conversationId 不覆盖
//     return registry.route(cid).emit({ ...intent, conversationId: cid });
//   };
// 身体未注册时 route 抛错：接线错误要响，不要静默兜底（emit 内部的发送失败语义另见
// surfaces/web/adapter.js —— {sent,failed} 形状铁律不变，坑 #9）。

/** `'<surface>:'` 前缀 → 身体 surface。纯数据：新增身体路由 = 在这里加一行（五扩展点 #3）。
 *  Q10 起导出：orchestrator 推导"路由键"（身体前缀 + 存储键 'main'）时需要同一张前缀表
 *  （routeKeyOf 单一真源，避免 kernel 再内联第二份前缀表——sessions.js #surfaceOf 先例）。 */
export const PREFIX_ROUTES = Object.freeze({ 'pet:': 'pet', 'diary:': 'diary', 'web:': 'web' });

/** 无前缀（含全部历史 chatKey）时的默认身体（D18）。Q11 起 = 'web'（QQ 身体已归档）。 */
const DEFAULT_SURFACE = 'web';

/**
 * 创建一个 adapter 注册表。
 * adapter 形状见 src/surfaces/contracts.js 与草案 §3 五扩展点 #1：
 *   createXxxAdapter(deps) → { surface, capabilities, emit, call?, normalize? }
 *   （清债夜2：读回展开窄通道已摘除——唯一消费者 read_forward 随 Q6+Q8 删除，
 *    web 身体本无此方法，adapter 不再需要实现它。）
 */
export function createAdapterRegistry() {
  const bodies = new Map();   // surface → adapter

  function mustGet(surface, cid) {
    const adapter = bodies.get(surface);
    if (!adapter) {
      throw new Error(
        `registry：会话 "${cid}" 路由到身体 "${surface}"，但该身体未注册` +
        `（已注册：${[...bodies.keys()].join(', ') || '无'}）`
      );
    }
    return adapter;
  }

  return {
    /**
     * 注册一个身体（同 surface 重复注册 = 后者覆盖，与 tool-registry 同口径）。
     * 只验最小形状（surface 非空字符串 + emit/capabilities 函数），不做更多机制。
     */
    register(adapter) {
      if (!adapter || typeof adapter !== 'object') throw new Error('registry.register：adapter 必须是对象');
      if (!adapter.surface || typeof adapter.surface !== 'string') {
        throw new Error('registry.register：adapter 必须带非空 surface 字符串');
      }
      if (typeof adapter.emit !== 'function') {
        throw new Error(`registry.register：身体 "${adapter.surface}" 必须实现 emit(intent)`);
      }
      if (typeof adapter.capabilities !== 'function') {
        throw new Error(`registry.register：身体 "${adapter.surface}" 必须实现 capabilities()`);
      }
      bodies.set(adapter.surface, adapter);
      return adapter;
    },

    /** 按 surface 取身体；未注册返回 null（route 才负责抛错）。 */
    get(surface) {
      return bodies.get(String(surface)) ?? null;
    },

    /** 已注册身体列表（注册序）。 */
    list() {
      return [...bodies.values()];
    },

    /** 按 conversationId 前缀路由（规则表见文件头）。 */
    route(conversationId) {
      const cid = String(conversationId ?? '');
      for (const [prefix, surface] of Object.entries(PREFIX_ROUTES)) {
        if (cid.startsWith(prefix)) return mustGet(surface, cid);
      }
      return mustGet(DEFAULT_SURFACE, cid);
    }
  };
}

// ── 模块级单例（Phase 8b 出站接线）────────────────────────────────────────
// 接线点只有两处（草案 §7.1）：app.js 装配处 `registry.register(createWebAdapter(...))`
// 注册身体（Q11 起 QQ 身体已归档，唯一注册者；未来 pet/diary 身体在此并行注册）；
// orchestrator 出站 ctx 经**同一个实例**做 route().emit() —— 两边各 new 一份
// 注册表就会出现"注册进了 A、路由查的是 B"的静默断线，所以单例从这里导出，两侧只
// import、不自建。测试需要隔离注册表时仍可用上面的 createAdapterRegistry() 工厂
// （tools/mock-adapter.mjs 即如此），互不影响。
export const registry = createAdapterRegistry();
