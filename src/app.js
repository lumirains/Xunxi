// 总装：存储 → 编排器；HTTP API + SSE 给 UI（Q11 起：QQ 身体已归档 legacy/qq-adapter、
// 发送队列与协议端客户端随行——无协议端接入；web 身体经 SSE 广播，入站唯一入口是
// POST /api/web/send → orchestrator.submit）。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR } from './kernel/config.js';
import { ChatStore } from './kernel/store.js';
import { StickerManager } from './sticker-manager.js';
import { SessionRegistry } from './kernel/sessions.js';
import { Orchestrator } from './orchestrator.js';
// 身体层（Phase 8b 出站接线 · 草案 §7.1 接线点 #1 的注册半边）：
// 装配处创建身体并 register 进 registry 单例（orchestrator 的 ctx.emit / ctx.surface
// 经同一实例路由）。hostBridge.sendText 收口进身体意图层（P1，routeOutboundText）；
// 入站段 ingestMessage→normalize 已随 QQ 身体归档（Q11 摘，§9-17-1 的去向兑现）——
// web 身体是纯出站身体，无 normalize。
import { createWebAdapter } from './surfaces/web/adapter.js';
import { registry } from './surfaces/registry.js';
import { ReminderStore } from './reminders.js';
import { VideoReader } from './video-reader.js';
import { cacheHitRate } from './kernel/llm.js';
import { isPeakHour, priceAt, resolveModelPrice, modelLabel, splitModelLabel, UNKNOWN_VENDOR } from './model-prices.js';
import { loadPlugins, watchPlugins, reloadSkillAt, setHostBridge } from './plugin-loader.js';
import { moduleManager } from './modules/manager.js';
// Q7：media-links 的 app.js 消费点（forwardLinkedMedia 链接媒体转发）已随入站解耦删除；
// media-links.js 本体按本注登记的处置计划于 2026-11-19 全库体检删除（全模块零导入实证，
// 原文在 git 历史：内部文档 codebase-audit-20261119.md §五）。
import { createRoutes } from './routes.js';
import { consoleCookieOf } from './console-auth.js';
import * as instanceLockModule from './instance-lock.js';
import { logger } from './kernel/logger.js';
import { events } from './kernel/events.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// M4（D45）静态接管：/ 由新前端 frontend/dist 提供（Vue 3 构建产物，见 frontend/）；
// 旧 ui/ 归档于 _archive-20261108/（git 历史保留全量）。/api 与 SSE 分发逻辑零改动。
const UI_DIR = path.resolve(__dirname, '..', 'frontend', 'dist');

// Q7（qq-exit Step 6 入站解耦）：白名单判断 allowed() 删除——唯一消费面是 QQ 入站
// 三入口（ingest 消息/拍一拍），随 WS 事件分发断开一并出清；config.allow/deny/
// allowAllWhenEmpty 键在 Q4 已从缺省摘除（磁盘键留晨间决策），设置页白名单 UI 去
// 向见 handoff §9-14-4②（Q11 裁决：白名单 UI 属前端残段，留 PWA 处置，§9-20）。

// ── 版本更新检查 ─────────────────────────────────────────────────────
// 线上版本信息源；留空 = 关闭更新检查（2026-11-21 开发版：旧站的版本信息源
// 会对 0.1.0-dev 乱报更新——发自己的 version.json 后再填回）。
// 由后端代取而不是前端直连：绕过 CORS，且失败信息能统一回给 UI。
const UPDATE_INFO_URL = '';

function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch { return '0.0.0'; }
}

/** x.y.z 三段数字比较；返回 1 / 0 / -1。非数字段按 0 处理，够用。 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/* createApp 产生的所有 appLog 函数（模块级 WeakSet）。
   用于识别"调用方传入的 log 是不是上一次 createApp 留下的 appLog"，
   防止监听器链式递归（见 createApp 内的递归护栏注释）。 */
const appLogFns = new WeakSet();

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();

  // 详尽日志：把 createApp 的 log 接到分级日志系统（落盘 + 内存缓冲 + SSE）。
  // 关键：logger 的 mirrorConsole 已经会走 console，所以这里**只写 logger、不再调原 log**，
  // 否则 appLog → logger.info → console(log) → 若 log 又被指回 appLog 就会无限递归（selftest 就是这么挂的）。
  // logger.mirrorConsole = true 时 console 输出不丢；调用方传入的自定义 log（如测试的静默 log）
  // 通过 logger 的 onLog 监听器另行转发，不经过 console。
  const appLog = (...args) => {
    logger.info('app', ...args);
  };
  // 把调用方传入的 log（如 Electron 的 console.log 或测试的静默 log）挂到 logger 的监听器上，
  // 与 mirrorConsole 解耦：mirrorConsole 管 console，监听器管调用方的 log。
  //
  // ⚠️ 递归护栏（15GB 日志事故根因）：
  //   若调用方传入的 log 本身就是上一次 createApp 留下的 appLog
  //   （同进程内二次 createApp：Electron 重启核心 / 测试串行多轮），
  //   监听器链会形成 appLog→logger→监听器→appLog 的无限递归，
  //   每轮递归给文本再包一层 [app] 前缀 —— 一条日志膨胀成几千条、
  //   每条带几千个 [app] 前缀，几个小时内日志文件就能写到 15GB。
  //   这里用 WeakSet 识别"这个 log 是不是 appLog"，是则跳过挂载。
  let removeAppLogListener = null;
  if (!appLogFns.has(log)) {
    removeAppLogListener = logger.onLog((entry) => {
      try { log(`[${entry.module}] ${entry.text}`); } catch { /* ignore */ }
    });
  }
  appLogFns.add(appLog);
  // 关掉 logger 的 console 镜像，避免与上面的监听器重复打印（调用方 log 通常就是 console.log）。
  logger.mirrorConsole = false;
  // 后续内部调用统一指向 appLog（关键事件落盘 + 走调用方 log）
  log = appLog;
  // 启动时清理过期日志文件
  logger.prune();

  // ── 进程单实例锁（防止桌面端 + headless 双开导致重复处理消息）──
  // 与 Electron 的 requestSingleInstanceLock 互补：那只管 Electron 进程之间，
  // 这里管"同一数据目录下任何形态的 Xunxi 核心"（含 node src/server.js）。
  const { acquireInstanceLock, releaseInstanceLock } = instanceLockModule;
  const lockResult = acquireInstanceLock();
  if (!lockResult.ok) {
    // 不抛异常上抛让进程退出 —— 创建期的失败应当让整个启动失败。
    throw new Error(`[单实例] ${lockResult.reason}。如需多开测试，请用不同的 XUNXI_DATA_DIR（旧名 QQ_AGENT_DATA_DIR 仍兼容）。`);
  }
  /* 抢到锁后立刻注册退出清理：正常 exit / SIGINT / SIGTERM 都会释放锁文件。
     曾经只在 stop() 里释放 —— 进程被直接杀掉（任务管理器结束、控制台叉掉）
     时锁文件残留，下次启动要靠"PID 已死"探测才能清掉，多一层失败面。 */
  instanceLockModule.registerLockCleanup();
  const sseClients = new Set();

  // Q11：isPortOpen（原协议端 WS 端口就绪轮询的探测器）与 obPortPollTimer 随
  // WS 诊断段一并摘除——唯一消费面是已归档的 WS 轮询，无其它端口探测需求。

  let pluginWatcher = null;        // 开发模式热重载 watcher（stop() 时要 close，否则句柄泄漏）

  const emit = (type, payload) => {
    // 说明：这里曾经先走一个进程内事件总线（createEventBus），但全项目**没有任何订阅者**，
    // 属于纯空转；更糟的是它给人"存在进程内订阅者"的错觉。真正的消费者只有 SSE。
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      // 同步异常 + 已经不可写的连接都要清理，否则集合只增不减、每次都白写
      if (res.writableEnded || res.destroyed) { sseClients.delete(res); continue; }
      try {
        res.write(line);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  const stickers = new StickerManager();
  // Q11（night-plan §Q11）：QQ 身体装配面整体摘除——协议端客户端构造/连接/诊断
  // （原 connect / 端口轮询 / 状态推送三段）、SendQueue
  // （sender，QQ 出站队列；本体随批归档 legacy/sender-qq.js）、qqAdapter 注册、
  // ingestMessage（无调用方死代码，jsdoc 去向=随身体归档一并摘）全部出清。
  // 出站唯一通道 = 身体意图层（registry.route().emit）；web 身体自带发送链
  // （broadcast + onSent recorder），不依赖任何已归档件——应用可独立启动（Q11/Q12
  // 边界口径：Q12 只重写 web 发送细节 src/surfaces/web/sender.js）。

  // ── P1 出站收口（night-plan §4.1/§4.6）──────────────────────────────────
  // hostBridge.sendText 统一走身体意图层 registry.route(chatKey).emit({type:'text'})，
  // 身体的 {sent,failed} 原样回来后再映射成插件认得的旧返回形状
  // （调用方是插件，期望 {ok,via,sent,messageId,deduped}）。
  // 回滚开关 config.surface.intents 已随 QQ 身体归档摘除（config.surface 段同批删，
  // Q11）：false→旧直连路径的分支只曾存在于本函数与 orchestrator.#emitOutbound 两处
  //（坑 #8 口径），两处随身体一并死亡——出站自 P1 起就是单路径，不再有开关。
  const routeOutboundText = (chatKey, texts) => {
    // M1/D19：conversationId 显式带上 —— 身体的 cid 取 intent.conversationId，
    // 不补的话身体翻译层拿到 undefined 会报"缺会话键"。
    return registry.route(chatKey).emit({ type: 'text', payload: { text: texts }, conversationId: chatKey });
  };

  // ── 扩展的发送通道（api.sendText）────────────────────────────────────────
  // 唯一写入者：身体意图层负责发送，记档经 onSent 由身体装配的 recorder 统一写
  // （D28），扩展不再自己改 messages/*.json。
  // 背景：ChatStore 整份状态缓存在内存里，扩展用文件直写加的那条会被核心下一次
  // 写入覆盖（旧主动开口类插件的"主动开口没进聊天历史"就是这个）。
  setHostBridge({
    sendText: async (chatKey, text) => {
      const body = String(text ?? '').trim();
      if (!body) throw new Error('消息内容为空');
      // P1：发送统一经身体意图层（routeOutboundText）。
      const r = await routeOutboundText(chatKey, [body]);
      const first = r?.sent?.[0] || null;
      try { emit('chat-update', chatKey); } catch { /* 广播失败不影响发送 */ }
      return { ok: true, via: 'core', sent: r?.sent?.length || 0, messageId: first?.messageId ?? null, deduped: !!first?.deduped };
    }
  });
  const reminders = new ReminderStore();
  const videoReader = new VideoReader();
  const orchestrator = new Orchestrator({ store, stickers, sessions, emit, reminders, videoReader });

  // ── 身体注册（Phase 8b · 草案 §7.1；Q11 起唯一身体）───────────────────────
  // web 身体 = 「intent → SSE 广播 + 记档回报」的机械翻译层：adapter 不记档（D28）、
  // 不调模型、不 import person/*；发送细节（分条 gapMs/指纹去重/先记档后广播顺序）Q12 起
  // 在 src/surfaces/web/sender.js，adapter 只做意图翻译。必须在任何 wake 之前注册完成：
  // ctx.emit 路由到未注册身体会抛错（registry 设计：接线错误要响，不静默兜底）。
  const webAdapter = createWebAdapter({
    broadcast: (type, payload) => emit(type, payload),
    onSent: ({ chatKey, type, archiveText, messageId, ts, media }) => {
      // V2 语音条：media（[{kind:'audio',id}]，E1 只存 id）透传 appendSelf——
      // 音频与文字同条同档（刷新后语音气泡仍在）。缺省 undefined → appendSelf 落 []。
      store.appendSelf(chatKey, { text: archiveText, ts, mid: messageId, media });
      // E2：本 recorder 是 web 身体发送链（web adapter onSent）——计划口径「出站='web'」。
      events.append({ source: 'chat', kind: 'message_out', text: archiveText, surface: 'web' });
    },
    // Q12 发送链去重窗口：函数注入（sender 每次判定现读 config，SendQueue #dedupeWindow
    // 同参；config 读数归装配层，web/adapter·sender 保持零 config import 离线可测）。
    dedupeWindowMs: () => getConfig().send?.dedupeWindowMs,
    // V2 语音条 TTS（voice-walkie；§8.A 第四批准口）：注入 tts 闭包——闸/熔断/超时/
    // media-store 落盘全在 voice.tts.synthesize 内（capabilities 层），这里只做动态
    // import 转发（adapter/sender 零 config import 纪律不变）。关闭态 synthesize 恒
    // null = 零网络零字节，分条纯文字与 V0 逐字节一致。
    tts: async (text) => {
      const { voice } = await import('./capabilities/voice.js');
      return voice.tts.synthesize(text);
    },
    log
  });
  registry.register(webAdapter);

  // Q11：ingestMessage（QQ 身体入站入口，Q7 起无调用方的死代码）按其 jsdoc 去向
  // 随身体归档一并摘除——normalize 的唯一实现（legacy/qq-adapter/adapter.js）已出
  // src/，submit 入站的活口只剩 web 侧（/api/web/send → orchestrator.submit(event, io)）。

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  // ── WS /api/voice（V2 通话下行通道，D16 独立出站；night-plan §2-T2 / spec §2.5）──
  // 绕开 adapter/sender/INTENT_TYPES（sent↔broadcast↔存档 1:1 不变式与临时音频流冲突）。
  // 鉴权面与既有 /api 一致（originAllowed，不新增 token 要求）；协议帧表照 spec §2.5：
  // 上行二进制 = PCM16/16k/40ms 帧（V3 ASR 消费，V2 收到即忽略）/ 下行二进制 = 整段
  // ogg（Opus 24k/voip，night-plan §0 2026-11-18 裁定）/ 控制消息 = 文本 JSON
  //（客户端 decode 失败 → {type:'audio-format',value:'wav'} → 服务端 synthesizeRaw 换档）。
  // voice.call.enabled=false 时握手 404（design §12 回滚口径：开关关=通话入口消失）。
  // 动态 import 同 capabilities 口径——import 期零网络零进程；call.js 纪律头见该文件。
  let voiceCall = null;
  server.on('upgrade', async (req, socket, head) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname !== '/api/voice') {
        // 其余 upgrade 路径本服务无消费者——按无监听器时的默认行为销毁
        socket.destroy();
        return;
      }
      if (!originAllowed(req)) {
        socket.write('HTTP/1.1 403 Origin Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      const { createVoiceCall } = await import('./voice/call.js');
      voiceCall ??= createVoiceCall({ store, log, originAllowed });
      await voiceCall.handleUpgrade(req, socket, head);
    } catch (error) {
      log('[voice] WS 升级失败:', error?.message ?? error);
      try { socket.destroy(); } catch { /* ignore */ }
    }
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  // ── 请求体读取 ──────────────────────────────────────────────────────────
  // 抛出的错误必须是**可暴露的 HTTP 错误**（带 .expose 标记），由 /api 分发层
  // 统一转成 4xx。否则：JSON.parse 异常会冒成 500；"超限直接 throw" 会让没读完的
  // socket 变脏 —— 客户端连接池下次复用这条连接就是 ECONNRESET。
  const MAX_BODY_BYTES = 2 * 1024 * 1024;
  const HARD_BODY_LIMIT = 16 * 1024 * 1024;   // 超此值不再排空，直接断链
  function httpError(status, message) {
    const e = new Error(message);
    e.expose = true;
    e.status = status;
    return e;
  }

  async function readBody(req, { maxBytes = MAX_BODY_BYTES } = {}) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > HARD_BODY_LIMIT) {
        req.destroy();
        throw httpError(413, '请求体过大');
      }
      if (size > maxBytes) {
        tooLarge = true;          // 继续读干净（内容丢弃），保证连接可复用
        chunks.length = 0;
        continue;
      }
      chunks.push(chunk);
    }
    if (tooLarge) throw httpError(413, `请求体过大（上限 ${Math.round(maxBytes / 1024)}KB）`);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw httpError(400, '请求体不是合法 JSON');
    }
  }

  // ── 来源校验（CSRF / DNS rebinding 防护）────────────────────────────────
  // 服务只监听回环，但**浏览器里的任意网页都能向 127.0.0.1 发简单请求**，
  // 而 CORS 只挡"读响应"、挡不住"副作用"（改配置、暂停、重置数据…）。
  // 所以所有 /api/* 都必须来自回环 Host；带 Origin/Referer 时必须同源。
  function isLoopbackHostHeader(host) {
    return /^127\.0\.0\.1(:\d+)?$/.test(host)
      || /^localhost(:\d+)?$/.test(host)
      || /^\[::1\](:\d+)?$/.test(host);
  }

  /**
   * 额外允许的 Host（2026-11-12）：配置 `server.allowedHosts` 里显式登记的主机名。
   * 用途 = 手机/平板经 Tailscale MagicDNS（如 xunxi.tailXXXX.ts.net）访问控制台。
   * 只比主机名、不比端口：同一服务可能同时暴露在 :3210 和 tailscale serve 的 :443。
   * 未登记的主机（局域网 IP 扫描、他人设备）一律拒——这道闸是 host 改成 0.0.0.0
   * 之后唯一的访问边界，不要改成"非空即放行"。
   */
  function isAllowedExtraHost(host) {
    const hostname = String(host ?? '').split(':')[0].toLowerCase();
    if (!hostname) return false;
    const list = getConfig().server?.allowedHosts;
    if (!Array.isArray(list)) return false;
    return list.some((h) => String(h ?? '').trim().toLowerCase() === hostname);
  }

  function originAllowed(req) {
    const host = String(req.headers.host ?? '');
    // 回环照旧放行；非回环必须是配置里登记过的域名
    if (!isLoopbackHostHeader(host) && !isAllowedExtraHost(host)) return false;
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      try {
        const u = new URL(origin);
        // 同源校验：Host 已过白名单，这里只要求 Origin 与请求 Host 完全一致
        //（防 DNS rebinding：攻击者域名解析到本机时，Host 对不上直接被拒）
        return u.host === host;
      } catch { return false; }
    }
    const referer = String(req.headers.referer ?? '');
    if (referer) {
      try { return new URL(referer).host === host; } catch { return false; }
    }
    // 无来源信息（curl / 本机脚本 / 地址栏直达）—— 放行
    return true;
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    // E6（R2）三通道：cookie（POST /api/auth/login 下发，HttpOnly+SameSite=Strict，
    // SSE/HTTP 统一凭证）> x-console-token 头（脚本/curl 用）。
    // ⚠️ 旧 ?token= query 通道已按白皮书 E6 移除——query 会进访问日志、浏览器历史
    //    与 Referer，是凭证泄露面（登记见 handoff §28-R2 破坏面一节）。
    return consoleCookieOf(req) === token || req.headers['x-console-token'] === token;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password / cookie …
  // ⚠️ cookie 必须在内：media-download 插件的 bilibiliCookie / douyinCookie
  //    是登录凭据，曾经 pattern 不认导致 /api/config 明文返回。
  // ⚠️ server.token（控制台管理令牌）也在内：它只用于 x-console-token 校验，
  //    GET /api/config 没有任何理由把明文管理令牌回传给浏览器（2026-09-26 审查发现
  //    裸 "token" 键名不命中原 pattern，配置了 token 的实例会在每次打开设置页时泄露它）。
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|communitykey|cookie|secret|password|privatekey|private_key|^token$)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线是「校验请求来源」。
   *
   * ⚠️ 历史实现里有一句 `if (req.headers['x-console-token']) return true`：
   *    只看"有没有这个头"、不看值，等于任何人加个头就能读明文密钥。
   *    已删除 —— 来源校验交由 originAllowed() 统一负责。
   */
  function keyEndpointAllowed(req) {
    const token = String(getConfig().server?.token ?? '');
    if (token) {
      // E6（R2）：与 authorize 同口径——cookie（新增）+ x-console-token 头；
      // ?token= query 通道一并移除（同理由：query 进日志）。cookie 通道不补上，
      // 浏览器登录后的「显示密钥」按钮会因前端从不发 x-console-token 而全数 403。
      if (consoleCookieOf(req) === token || req.headers['x-console-token'] === token) return true;
    }
    return originAllowed(req);
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  // 声明式路由表（src/routes.js）：把所有依赖一次性注入。
  // 路由 handler 通过闭包取用这些依赖，handleHttp 只负责匹配分发。
  // Q11：协议端依赖摘除（/api/status 诊断段、好友列表、test-send 直发随行）。
  const apiRoutes = createRoutes({
    store, sessions, orchestrator, webAdapter, registry,
    emit, log,
    localVersion, compareSemver, UPDATE_INFO_URL,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills
  });

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      if (!originAllowed(req)) return json(res, 403, { error: '请求来源不被信任' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      // 心跳：半开 TCP（拔网线 / NAT 超时，没有 FIN）不会触发 req 'close'，
      // 少了心跳这些客户端会永久留在 sseClients 里，之后每次 emit 都白写一遍。
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* 下面 error/close 会清理 */ }
      }, 15000);
      heartbeat.unref?.();
      const cleanup = () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
      };
      // 异步写错误不会走 try/catch，必须显式兜住，否则会变成 uncaughtException
      res.on('error', cleanup);
      res.on('close', cleanup);
      req.on('close', cleanup);
      return;
    }

    if (pathname.startsWith('/api/')) {
      // E6（R2）：登录端点免令牌检（它本身就是用来获取凭证的，先有鸡先有蛋）。
      // 只豁免 POST 本体；GET /api/auth/login 仍走 authorize（不暴露端点存在性）。
      // ⚠️ 来源校验不豁免——外域网页借浏览器打 127.0.0.1 暴破登录的口子不能开。
      const isLoginAttempt = pathname === '/api/auth/login' && req.method === 'POST';
      if (!isLoginAttempt && !authorize(req)) return json(res, 401, { error: '未授权' });
      // 来源校验：挡住"恶意网页借浏览器打 127.0.0.1"（CSRF / DNS rebinding）。
      // 必须在 authorize 之后、路由分发之前。
      if (!originAllowed(req)) {
        return json(res, 403, { error: '请求来源不被信任（仅接受本机控制台的同源请求）' });
      }
      const method = req.method;

      // 声明式路由分发（路由表在 src/routes.js）
      try {
        for (const route of apiRoutes) {
          if (route.method !== '*' && route.method !== method) continue;
          let match = null;
          if (typeof route.pattern === 'string') {
            if (route.pattern !== pathname) continue;
          } else {
            match = route.pattern.exec(pathname);
            if (!match) continue;
          }
          return await route.handler({ req, res, url, pathname, method, match, json });
        }
      } catch (error) {
        // readBody 等抛出的"可暴露错误"统一转 4xx；其余记日志、返回 500 而不是让连接挂掉
        if (error?.expose && Number.isInteger(error.status)) {
          return json(res, error.status, { error: String(error.message || '请求无效') });
        }
        log(`[api] ${method} ${pathname} 处理失败：${error?.stack ?? error?.message ?? error}`);
        return json(res, 500, { error: '服务器内部错误' });
      }
      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }


    // 静态 UI
    if (req.method === 'GET') {
      // 路径穿越防护：
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".." —— "/....//" 删完仍还原出 ".."，
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      // 正确做法：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      // SPA 回退（P4，night-plan-pwa §P4 / handoff §29-7 增补项）：dist 内无此
      // 文件 + 末段无扩展名 + Accept 含 text/html（浏览器导航）→ 回 index.html。
      // PWA start_url '/pwa' 由启动器直开，静态段原先按 pathname 精确映射文件、
      // 未知路径 404——无此回退则安装后首开即 404 白屏。窄口径：带扩展名的缺失
      // 文件（/assets/*、/icons/* 等资产 404 面）与 API 404 面均不变（API 在上
      // 方独立分支）；既存文件（含目录）优先按原逻辑，目录命中仍走 EISDIR→404。
      const isNavigation = !clean[clean.length - 1].includes('.') && String(req.headers.accept || '').includes('text/html');
      const serving = isNavigation && !fs.existsSync(fullPath) ? path.join(UI_DIR, 'index.html') : fullPath;
      try {
        const data = fs.readFileSync(serving);
        const ext = path.extname(serving);
        // jpg/jpeg/webp/gif/ico：设置页群二维码彩蛋（group-qrcode.jpg）与
        // 市场页图片要用 —— 曾经只认 png/svg，jpg 会以 octet-stream 下载而非显示
        // .webmanifest（P4）：manifest 拉取必需，缺失时回落 octet-stream 安装必败
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };
        // 缓存头（P4，handoff §29-7）：/assets/* 是 Vite hash 文件名=内容不可变
        // → immutable 长缓存；其余（index.html、public 静态件含 sw.js/manifest/
        // icons）保持 no-cache——桌面既有缓存行为零变化（红线 #3），sw.js 靠
        // no-cache 走浏览器更新检查。
        const isHashedAsset = clean[0] === 'assets';
        const headers = { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache' };
        if (ext === '.html') {
          // CSP 用 HTTP 头再声明一次：header 里的 frame-ancestors 才生效
          // （meta 版本会被浏览器忽略该指令），同时给不解析 meta 的场景兜底。
          // ⚠️ script-src 与 index.html 的 meta 版本同款（sha256 hash 精确放行
          //    首屏主题预置脚本，不含 unsafe-inline）—— 两处口径必须一致，
          //    否则 meta 被剥离的场景下 unsafe-inline 立即生效。
          // 2026-10-29 精简：社区/反馈/验证码已移除，与 meta 版本同步收回全部外部来源。
          headers['content-security-policy'] = [
            "default-src 'self'",
            "script-src 'self' 'sha256-xBF5qExTuqfXHlYtKYaaldGJshQgQOr5zvcGHjbPL7w='",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob: http: https:",
            "media-src 'self' data: blob:",
            "connect-src 'self'",
            "worker-src 'self' blob:",
            "font-src 'self' data:",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'"
          ].join('; ');
          headers['x-content-type-options'] = 'nosniff';
          headers['referrer-policy'] = 'no-referrer';
        }
        res.writeHead(200, headers);
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      // 监听地址可配（2026-11-12）：默认 127.0.0.1 只给本机；手机/平板访问时
      // 配置改为 0.0.0.0。对外只靠 originAllowed 的 Host 白名单把关，见下。
      const host = String(getConfig().server?.host || '127.0.0.1');
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // ── 启动顺序（2026-09-18 按耗时画像重排；2026-11-12 Q3 随进程管理摘除再简；
    //     Q11 协议端连接段随 QQ 身体归档一并摘除）──
    // 旧顺序的瓶颈：HTTP → 遥测 → Skill加载(串行import) → 进程启动(最长20s等端口)
    //              → 协议端连接 → 就绪日志。进程启动段已随 QQ 载体摘除（qq-exit Step 2）。
    // 现顺序：HTTP（页面先活）→ 遥测(纯后台) → Skill 加载 →
    //         就绪。会话索引的磁盘对账（reconcileInBackground）
    //         在 HTTP 起来后就排上，不占启动关键路径。
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 会话索引后台对账：启动读的是毫秒级缓存，这里异步补扫磁盘修正差异
    // （缓存缺失的新文件/外部删除的文件）。不 await —— 不挡任何启动步骤。
    sessions.reconcileInBackground();

    // 用量档案预热：首次打开用量页的卡顿来自"冷 parse 全部会话文件"
    //（2290 个 / 178MB 实测 1.3~1.9 秒）。启动后台先预热一次（collectUsageRows
    // 内部分片让步，不阻塞事件循环），用户点开用量页时档案已就绪，
    // 只剩窗口过滤（毫秒级）。不 await；失败静默（用量页会自己再算）。
    collectUsageRows({ range: '7' }).catch(() => {});

    // ── Skill 加载（进程启动段已摘除，串行段只剩这一个）──
    const skillsReady = (async () => {
      try {
        const pluginResult = await reloadSkills({ reason: 'boot' });
        const okCount = pluginResult.loaded.length;
        const failCount = pluginResult.failed.length;
        if (okCount > 0) log(`[skill] 已加载 ${okCount} 个 Skill`);
        for (const f of pluginResult.failed) {
          log(`[skill] ❌ ${f.id || '(未知)'}：${f.error}`);
        }
        if (failCount > 0) log(`[skill] ${failCount} 个 Skill 加载失败`);

        const toolCount = orchestrator.refreshToolDefs();
        log(`[skill] 工具集已刷新：${toolCount} 个工具`);

        // 热重载日志：reloadSkills({reason:'boot'}) 里已经把 watcher 建好了
        // （默认开 config.extensions.hotReload，XUNXI_DEV=1 可强制打开）
        if (pluginWatcher) {
          // 明确告知"落地的代码会被执行"，让用户知道这个行为的边界
          log('[skill] 热重载已启用：放入 plugins/ 或 skills/ 的目录会自动加载并执行'
            + '（要关闭请设 config.extensions.hotReload=false）');
        } else {
          log('[skill] 热重载未启用（config.extensions.hotReload=false）：改动后需重启');
        }
      } catch (error) {
        log('[skill] 加载失败:', error?.message ?? error);
      }
    })();

    await skillsReady;

    // Q11：协议端 connect / WS 端口就绪轮询（isPortOpen 每 2 秒探测）/ 45 秒账号信息
    // 终检三段随 QQ 身体归档一并摘除——无协议端可连，启动链再无外部依赖。

    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    orchestrator.startReminderLoop();   // 提醒（闹钟）调度：到点发提醒（web 身体广播）
    orchestrator.startClock();          // 钟（步骤⑤/T5.1）：反思执行器的 tick 挂这里；stop 经 abortAll→stopClock 收口
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  // ── Skill 重扫：UI「刷新」按钮的唯一后端入口 ──────────────────────────
  // 之前「刷新」只重读内存注册表（GET /api/skills），不碰磁盘 —— watcher 丢事件
  // （目录删除重建后 fs.watch 句柄失效、网络盘、杀毒软件）时，点多少次刷新都
  // 看不到新插件。这里把"重扫磁盘 + 激活 + 刷工具 + 重建 watcher"做成一个
  // 幂等函数，启动流程和手动重扫共用，行为完全一致。
  /**
   * 重扫扩展。
   *
   * @param {object} opts
   * @param {string} opts.reason        'boot' | 'watch' | 'manual'
   * @param {'all'|'one'} [opts.scope]  'one' = 只重载 dir 这一个（热重载用）
   * @param {string} [opts.dir]         单目录重载的目标目录
   * @param {string} [opts.kind]        'plugin' | 'skill'（参与两型语义校验）
   *
   * 为什么要有 'one'：全量重扫会对**每个**已启用扩展重跑 deactivate→setup→activate，
   * 带定时器的插件（旧主动开口/旧日程类）因此被重新排班 ——
   * 改一个无关文件就可能让"每 2~5 小时自己上网一次"从零开始计时。
   * 单目录重载只动变化的那一个，其他扩展的定时器/连接/缓存全部原样保留。
   */
  async function reloadSkills({ reason = 'manual', scope = 'all', dir = null, kind = null } = {}) {
    const single = scope === 'one' && !!dir;
    let result;
    let singleId = null;
    if (single) {
      // 单目录：结果形状与 loadPlugins 不同，补齐成调用方（日志/UI）认得的形状
      const one = await reloadSkillAt(dir, { log, kind });
      singleId = one.id || null;
      result = {
        loaded: one.loaded ? [{ id: one.id, dir }] : [],
        failed: one.loaded ? [] : [{ id: one.id, error: one.error }],
        pruned: [],
        single: { id: one.id, dir, loaded: !!one.loaded, error: one.error || null }
      };
    } else {
      result = await loadPlugins({ log });
    }

    // 激活：单目录只激活它自己；全量沿用原逻辑（启用中的全部 activate）
    if (single) {
      // 旧 id 幽灵：manifest.id 被改过时，旧 id 的实例不会在单目录重载里被替换
      // （loader 按 id 找 prev），会留下一个带定时器的影子实例。按目录对账卸掉。
      const targetDir = path.resolve(String(dir));
      for (const s of moduleManager.registry.list()) {
        if (s?.dir && path.resolve(s.dir) === targetDir && s.manifest?.id !== singleId) {
          try { moduleManager.unregister(s.manifest.id, { reason: 'reload-renamed' }); } catch { /* ignore */ }
        }
      }
      const st = singleId ? moduleManager.list().find((x) => x.id === singleId) : null;
      if (st?.enabled && st?.loaded) {
        try { moduleManager.activate(singleId); } catch (error) { log(`[skill] 激活 ${singleId} 失败：${error?.message ?? error}`); }
      }
    } else {
      for (const st of moduleManager.list()) {
        if (st.enabled && st.loaded) {
          try { moduleManager.activate(st.id); } catch (error) { log(`[skill] 激活 ${st.id} 失败：${error?.message ?? error}`); }
        }
      }
    }
    try { orchestrator.refreshToolDefs(); } catch { /* 刷新失败不影响主流程 */ }

    // watcher 自愈：fs.watch 监听的目录被删除再重建后收不到任何事件，
    // 这里关掉旧的重新建。热重载关闭时保持关闭（尊重用户配置）。
    // ⚠️ 单目录重载**不重建** watcher：重建本身会让新 watcher 重新观察到目录状态，
    //    在有文件正在被写入时容易自激（关掉→立刻新建→又收到事件）。
    if (!single) {
      const hotReloadOn = process.env.XUNXI_DEV === '1' || process.env.QQ_AGENT_DEV === '1'
        || getConfig().extensions?.hotReload !== false;
      try { pluginWatcher?.close?.(); } catch { /* ignore */ }
      pluginWatcher = null;
      if (hotReloadOn) pluginWatcher = watchPlugins({ log, onReload: onWatchChange });
    }

    if (reason !== 'boot') {
      const what = single ? `${path.basename(String(dir))}（单目录）` : '全部';
      log(`[skill] 重扫完成（${reason}）：${what} ${result.loaded.length} 成功，${result.failed.length} 失败`
        + (result.pruned?.length ? `，卸载 ${result.pruned.length} 个已删除的 Skill` : ''));
      emit('status', { configUpdated: true });
    }
    return result;
  }

  /** 热重载回调：watchPlugins 只给"意图"，由这里决定单目录还是全量。 */
  function onWatchChange(intent) {
    if (intent?.scope === 'one') {
      return reloadSkills({ reason: 'watch', scope: 'one', dir: intent.dir, kind: intent.kind });
    }
    return reloadSkills({ reason: 'watch', scope: 'all' });
  }

  async function stop() {
    // 先停掉热重载 watcher：否则 stop() 之后文件变动仍会触发重载 + 广播
    try { pluginWatcher?.close?.(); } catch { /* ignore */ }
    pluginWatcher = null;
    // D19 引擎装配层（T7）：退出清理**自己拉起**的引擎进程（登记面在
    // engine-manager.js；所有者手启的引擎不在登记内，绝不触碰）。挂断不清理
    // （GPU 无限制口径引擎可长驻，night-plan §1-1），只有装配层退出时清。
    try { voiceCall?.releaseEngines?.(); } catch { /* ignore */ }
    // W1 兜底：Settings 快捷开关经 /api/voice/ensure 拉起的引擎走共享登记表，
    // 通话从未发生（voiceCall=null）时上面一行不触及——这里对共享单例再 release
    // 一次（幂等，owned 清空后为 no-op）。
    try {
      const { getSharedEngineManager } = await import('./voice/engine-manager.js');
      getSharedEngineManager({ log }).release();
    } catch { /* ignore */ }
    await orchestrator.abortAll();
    orchestrator.stopReminderLoop();
    // 索引缓存立刻落盘：正常运行中靠防抖（5s），退出前必须写一次，
    // 否则最后的会话变动丢失、下次启动要靠后台对账补（慢路径）
    sessions.flushIndexCache();
    // 关闭所有 SSE 长连接，避免 server.close() 一直等它们
    for (const c of [...sseClients]) {
      try { c.end(); } catch { /* ignore */ }
    }
    sseClients.clear();
    server.close();
    logger.flush();
    // 解绑本次 createApp 的日志转发器，避免 Electron/测试重复创建 app 时监听器累积。
    try { removeAppLogListener?.(); } catch { /* ignore */ }
    releaseInstanceLock();
  }

  // Q11：返回对象摘协议端客户端/发送队列（QQ 身体装配面）——消费面（hostbridge-shape-test
  // E1 分发断开断言）随断言前提死亡同步改写；electron/main.js 与 server.js 只用
  // start/stop/orchestrator/getConfig/updateConfig，不受影响。
  return { server, store, stickers, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, reloadSkills };
}

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds。
 * 没有历史汇总文件也能算 —— 直接扫留档即可。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  // 前端"全部"按钮：不设起始时间。曾经静默回落"近 7 天"（Number('all')||7），
  // 用户以为在看全量历史实际被截断 —— 与"求和一致"的产品口径冲突。
  if (s === 'all') {
    return { mode: 'all', start: 0, end: now, label: '全部' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时
// 单次约 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。
// 会话文件是"结束写一次、之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原来是 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，
//      导致切过去时缓存经常刚好过期 → 每次都走 200ms 的冷启动（"黑一下"）。
//      用量统计不是实时数据，20 秒的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
//
// ⚠️ 数据量增长后的实测（2026-09-17，真实部署 2144 个会话 / 172MB）：
//    全量 parse 需要 ~1.9s —— 20 秒 TTL 到期后的每次重算都会把主进程
//    event loop 阻塞近 2 秒，期间 HTTP/SSE/消息处理全部排队 —— 前端表现
//    就是"用量页卡住、整个控制台无响应"。两条治理（同步进 collectUsageRows）：
//    A. **增量解析**：目录快照没变时复用上一轮解析结果（不只 TTL 内 ——
//       sig 相同就复用，只是重做时间窗过滤与派生字段），冷启动只在
//       真有新会话落盘时才发生。TTL 仍然保留，兜"内容被改写"的边缘情况。
//    B. **流式分片解析**：真要冷启动时，把 172MB 的同步 parse 拆成
//       每 50 个文件一让步（setImmediate）的异步流水线 —— 单次让步前的
//       阻塞 <100ms，消息处理/界面请求不再被长阻塞。
//      会话文件"结束写一次、之后不改"的语义不变，A 的复用与原缓存同样安全。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;
// 已解析会话的档案（增量解析的持久层）：sig（目录快照）→ 每会话的展开行/计数。
// 与 usageRowsCache 的区别：后者是"某个时间窗的最终 rows"，前者是
// "全部会话的原始素材" —— 换 range 时不必重新读盘。
const usageArchive = { sig: '', at: 0, sessions: null };   // sessions: Map(file -> {rows[], searchCount, toolCounts})
// 让步前最多同步解析的文件数（B 方案的切片粒度）
const USAGE_PARSE_CHUNK = 50;

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs + ':' + files.reduce((a, f) => a + f.length, 0);
  } catch {
    return '';
  }
}

/**
 * 读盘解析单个会话文件 → { rows, searchCount, toolCounts, started }。
 * 纯函数（不含时间窗过滤）：窗口过滤在 collectUsageRows 里做 —— 这样
 * 换 range（今天/7天/全部）时可以完全复用这份解析结果。
 */
function parseUsageSessionFile(dir, f) {
  const out = { rows: [], searchCount: 0, toolCounts: Object.create(null), started: 0, mtime: 0 };
  try {
    const fp = path.join(dir, f);
    out.mtime = fs.statSync(fp).mtimeMs;
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const started = Number(s.startedAt) || 0;
    out.started = started;
    // ⚠️ 不能因缺 startedAt 就整文件丢弃：行上的 raw.created 仍有时间戳，
    // 否则老会话/异常会话的 token 会整体消失。
    out.searchCount = Number(s.webSearchCount) || 0;
    // 逐次调用展开：每条 message.raw 有独立的 usage / created / model
    const exactRows = [];
    for (const m of (s.messages || [])) {
      const name = m && m.toolCall && m.toolCall.name;
      if (name) out.toolCounts[String(name)] = (out.toolCounts[String(name)] || 0) + 1;
      const raw = m?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const ru = raw.usage || {};
      const rp = Number(ru.prompt_tokens) || 0;
      const rc = Number(ru.completion_tokens) || 0;
      if (!rp && !rc) continue;
      const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
      exactRows.push({
        promptTokens: rp,
        completionTokens: rc,
        // 各家字段名不同，必须逐个兼容，否则命中率恒为 0：
        //   · OpenAI / 多数中转：usage.prompt_tokens_details.cached_tokens
        //   · DeepSeek 官方：usage.prompt_cache_hit_tokens（**没有** prompt_tokens_details）
        // 这里原来只读第一个 —— 接 DeepSeek 后缓存命中率永远是 0，成本看板把全部输入
        // 按"未命中"计价，估出来比实际贵一倍以上。llm.js 的 addUsage 早就兼容了，
        // 唯独这条"精确统计"路径漏了（2026-10-31）。
        cachedTokens: Number(
          ru.prompt_tokens_details?.cached_tokens
          ?? ru.prompt_cache_hit_tokens
          ?? ru.cached_tokens
        ) || 0,
        at,
        model: String(raw.model || s.model || '') || '(未知)'
      });
    }
    if (exactRows.length) {
      for (const c of exactRows) {
        out.rows.push({ ...c, vendor: String(s.vendor || ''), chatKey: String(s.chatKey || '(未知)'), sessionId: s.id, exact: true });
      }
    } else {
      const u = s.usage || {};
      const p = Number(u.promptTokens) || 0;
      const c = Number(u.completionTokens) || 0;
      if (p || c) {
        out.rows.push({
          promptTokens: p,
          completionTokens: c,
          cachedTokens: Number(u.cachedTokens) || 0,
          at: started,
          model: String(s.model || '') || '(未知)',
          chatKey: String(s.chatKey || '(未知)'),
          vendor: String(s.vendor || ''),
          sessionId: s.id,
          exact: false
        });
      }
    }
  } catch { /* 坏文件跳过（与旧行为一致） */ }
  return out;
}

/**
 * （异步）刷新"已解析档案"到当前目录快照。
 * 只重读**变化过的文件**（新文件 + mtime 变了的文件），其余复用 ——
 * 2144 个文件只有几个新增时，重读量从 172MB 降到几 MB。
 * 解析按 USAGE_PARSE_CHUNK 分片、片间 setImmediate 让步，不长阻塞事件循环。
 */
async function refreshUsageArchive(dir, files, sig) {
  if (usageArchive.sessions && usageArchive.sig === sig) return usageArchive.sessions;
  const prev = (usageArchive.sessions && usageArchive.sig.split(':').slice(0, 2).join(':') === sig.split(':').slice(0, 2).join(':'))
    ? usageArchive.sessions : new Map();
  const next = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const old = prev.get(f);
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (old && old.mtime === st.mtimeMs) {
      next.set(f, old);   // 文件没变：复用上次的解析结果（零读盘）
      continue;
    }
    next.set(f, parseUsageSessionFile(dir, f));
    // 分片让步：单文件最大 ~1MB，50 个一批的同步解析 < 100ms
    if ((i + 1) % USAGE_PARSE_CHUNK === 0) await new Promise((r) => setImmediate(r));
  }
  usageArchive.sessions = next;
  usageArchive.sig = sig;
  usageArchive.at = Date.now();
  return next;
}

async function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      // 深拷贝：曾经 slice() 只是浅拷贝，调用方往行对象上写字段（如 dayKey）
      // 会写穿到缓存对象；当前写入恰好幂等无害，但承诺的"防污染"并不成立
      rows: usageRowsCache.rows.map((r) => ({ ...r })),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  // ── 数据量治理（2026-09-17，见"用量行缓存"注释的 A/B 方案）──
  // 档案层增量解析 + 分片让步；时间窗过滤只对窗口内的素材做。
  const archive = await refreshUsageArchive(dir, files, sig.split('@')[0]);

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 注意这些是"次数"不是"成本"：搜索通常是资源包或免费的，
  // 所以只列数量、绝不参与成本计算（用户明确要求）。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    const parsed = archive.get(f);
    if (!parsed) continue;
    // started 只用于工具/搜索归窗；调用行一律按 r.at 过滤，started 缺失不再丢行
    const started = Number(parsed.started) || Number(parsed.mtime) || 0;
    if (started >= win.start && started <= win.end) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts || {})) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    // 逐次调用行：窗口内才收进 rows（行自带 at，可精确到调用时刻）
    for (const r of (parsed.rows || [])) {
      if (r.at < win.start || r.at > win.end) continue;
      rows.push(r);
    }
  }
  // 模型身份 = 渠道 + 模型 id。
  // 渠道取**会话自己记录的** vendor（创建会话时由当时的配置派生）。
  // 老会话没这个字段 → 标为「未知渠道」，绝不拿当前配置去倒推历史 ——
  // 用户很可能早就换过渠道了，猜出来的结果是错的。
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染
  // ⚠️ rows 里的对象来自档案层（可能被多个 range 的缓存共享引用）——
  //    上面 vendor/modelKey 的改写是幂等的，但调用方还会写 dayKey，
  //    所以缓存里也存一份浅拷贝行（同 range 复用时的防污染，与旧行为一致）。
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.map((r) => ({ ...r }));
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
  return { rows, win, searchCount, toolCounts };
}

// ── 按日快照（2026-09-19）──────────────────────────────────────────
//
// 问题：collectUsageRows 即使有档案层缓存，冷启动（2144 文件 / 172MB）仍要
// 全量流式解析；"今天之前的每一天"的数据是**不可变的**（会话结束写一次、
// 之后不改），每次打开用量页都从头统计它们是纯浪费。
//
// 方案：把"已完结自然日"（今天之前）的聚合结果固化到
// data/usage-daily.json。读取路径优先快照；只有快照缺失/失效的日才回退
// 到"从档案聚合"。写快照时机：每次统计完顺手补齐（异步、不阻塞响应）。
//
// 有效性判据：每条日快照带生成时的目录快照 sig。sig 没变 → 该日必然没
// 新增会话（会话文件不改写），直接用。sig 变了 → 重算该日（分片解析会
// 复用 mtime 相同的旧解析结果，增量代价很小）。"今天"永远不进快照。
//
// ⚠️ 成本口径：快照存 costOfRows 聚合结果。价格表（自定义价/远程价）变化
//    会让历史成本跟着变 —— 快照固定的是"生成当时的计价"。这是刻意取舍：
//    量级收益（秒→毫秒）远大于"改价后历史成本不联动"的小误差；想重算
//    任何一天，删掉快照文件对应条目即可。
const USAGE_DAILY_FILE = path.join(DATA_DIR, 'usage-daily.json');
const USAGE_DAILY_VERSION = 1;

function loadUsageDaily() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USAGE_DAILY_FILE, 'utf8'));
    if (parsed?.version === USAGE_DAILY_VERSION && parsed.days && typeof parsed.days === 'object') {
      return parsed.days;
    }
  } catch { /* 无文件/坏文件 = 全部重算 */ }
  return {};
}

function saveUsageDaily(days) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${USAGE_DAILY_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: USAGE_DAILY_VERSION, savedAt: Date.now(), days }, null, 1), 'utf8');
    fs.renameSync(tmp, USAGE_DAILY_FILE);
  } catch { /* 快照写失败只是慢一点，绝不能影响统计主流程 */ }
}

/* ── 按天预聚合文件（data/usage-days/YYYY-MM-DD.json）────────────────
   设计：已完结日固化成小文件；点用量页 = 读日文件之和 + 只实时算今天。
   不再每次全量扫 sessions/。日文件缺失时才按需回算该日并落盘。 */
const USAGE_DAYS_DIR = path.join(DATA_DIR, 'usage-days');
const USAGE_DAY_VERSION = 1;

/** 一天是否完全没量（调用/成本/token/搜索都为 0）——空日不进柱图与按天表。 */
function isEmptyDayAgg(agg) {
  const t = agg?.totals || {};
  return !(Number(t.runs) || 0)
    && !(Number(t.cost) || 0)
    && !(Number(t.promptTokens) || 0)
    && !(Number(agg?.searchCount) || 0);
}

function usageDayFile(dayKey) {
  return path.join(USAGE_DAYS_DIR, `${dayKey}.json`);
}

function loadUsageDayFile(dayKey) {
  try {
    const parsed = JSON.parse(fs.readFileSync(usageDayFile(dayKey), 'utf8'));
    if (parsed?.version === USAGE_DAY_VERSION && parsed.day === dayKey && parsed.aggregates) {
      return parsed.aggregates;
    }
  } catch { /* 缺失/损坏 → 回算 */ }
  // 一次性迁移：旧的单文件快照 usage-daily.json
  try {
    const snap = loadUsageDaily()[dayKey];
    if (snap?.aggregates) {
      saveUsageDayFile(dayKey, snap.aggregates);
      return snap.aggregates;
    }
  } catch { /* ignore */ }
  return null;
}

function saveUsageDayFile(dayKey, aggregates) {
  // 空日不落盘：曾因 completedDayKeys(0) 从 1970 枚举，给每一天都写了空壳文件
  // （两万多个 463 字节 JSON），把 usage-days 目录和统计全部打乱。
  if (isEmptyDayAgg(aggregates)) return;
  try {
    fs.mkdirSync(USAGE_DAYS_DIR, { recursive: true });
    const tmp = `${usageDayFile(dayKey)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      version: USAGE_DAY_VERSION, day: dayKey, savedAt: Date.now(), aggregates
    }, null, 1), 'utf8');
    fs.renameSync(tmp, usageDayFile(dayKey));
  } catch { /* 写失败只是下次再算，不影响主流程 */ }
}

/**
 * 只解析「在 fromTs 之后写过」的会话文件。
 * 行的时间戳不可能晚于文件最后一次写入，因此 mtime < fromTs 的文件
 * 不可能包含该窗口内的调用行 —— 直接跳过，不 readFileSync / JSON.parse。
 */
async function collectArchiveForWindow(dir, files, fromTs) {
  const map = new Map();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let st;
    try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (fromTs && st.mtimeMs < fromTs) continue;
    map.set(f, parseUsageSessionFile(dir, f));
    if ((i + 1) % USAGE_PARSE_CHUNK === 0) await new Promise((r) => setImmediate(r));
  }
  return map;
}

/**
 * 已完结自然日列表：从窗口起点（或快照里最早的日）到昨天。
 * 今天永远实时算（数据还在长）。
 */
function completedDayKeys(fromTs) {
  const out = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  // 昨天的 0 点（今天之前最后一个已完结日）
  d.setDate(d.getDate() - 1);
  // ⚠️ all 模式曾经传 0 → 从 1970 年逐日枚举两万多天，
  // 每天还去 loadUsageDayFile 试读 —— 点「全部」卡死的主因。
  let startMs = Number(fromTs) || 0;
  if (!startMs) {
    const keys = listUsageDayKeys();
    startMs = keys.length
      ? (new Date(keys[0] + 'T00:00:00')).getTime()
      : (Date.now() - 29 * 24 * 60 * 60 * 1000);
  }
  const start = new Date(startMs);
  start.setHours(0, 0, 0, 0);
  while (d.getTime() >= start.getTime()) {
    out.push(dayKeyOf(d.getTime()));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/** 已落盘的按天文件日期列表（升序）。 */
function listUsageDayKeys() {
  try {
    return fs.readdirSync(USAGE_DAYS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  } catch { return []; }
}

/**
 * 从档案层聚合出"某一个自然日"的统计（不使用快照 —— 这是重算路径）。
 * 返回与 buildUsageStats 的 days/chats/models 三段同构的聚合体。
 */
function aggregateDayFromArchive(archive, dayKey) {
  const dayStart = new Date(dayKey + 'T00:00:00');
  if (isNaN(dayStart.getTime())) return null;
  const dayEnd = dayStart.getTime() + 24 * 60 * 60 * 1000 - 1;
  const rows = [];
  let searchCount = 0;
  const toolCounts = Object.create(null);
  for (const parsed of archive.values()) {
    if (!parsed) continue;
    // started 只用于工具/搜索归日；调用行一律按 r.at 入桶（started 缺失不再连坐丢行）
    const started = Number(parsed.started) || Number(parsed.mtime) || 0;
    if (started >= dayStart.getTime() && started <= dayEnd) {
      searchCount += parsed.searchCount || 0;
      for (const [name, n] of Object.entries(parsed.toolCounts || {})) {
        toolCounts[name] = (toolCounts[name] || 0) + n;
      }
    }
    for (const r of (parsed.rows || [])) {
      if (r.at >= dayStart.getTime() && r.at <= dayEnd) rows.push(r);
    }
  }
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  const totals = costOfRows(rows);
  const chats = groupBy(rows, 'chatKey', 0);
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  // 按小时桶（今日 spark / 悬停提示）；搜索按会话 start 落到对应小时
  const hourSearch = Array(24).fill(0);
  for (const parsed of archive.values()) {
    if (!parsed) continue;
    const started = Number(parsed.started) || Number(parsed.mtime) || 0;
    if (started >= dayStart.getTime() && started <= dayEnd) {
      const sc = Number(parsed.searchCount) || 0;
      if (sc) hourSearch[new Date(started).getHours()] += sc;
    }
  }
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const hs = dayStart.getTime() + h * 60 * 60 * 1000;
    const he = hs + 60 * 60 * 1000 - 1;
    const ht = costOfRows(rows.filter((r) => r.at >= hs && r.at <= he));
    hours.push({
      hour: h, cost: ht.cost, runs: ht.runs, searchCount: hourSearch[h] || 0,
      promptTokens: ht.promptTokens, completionTokens: ht.completionTokens,
      cachedTokens: ht.cachedTokens, cacheHitRate: ht.cacheHitRate, totalTokens: ht.totalTokens
    });
  }
  return { totals, chats, models, searchCount, toolCounts, hours };
}

/**
 * 快照加速版统计：days 维度全部走快照 + 今天实时聚合。
 * 其余维度（chats/models/totals）= 各日快照聚合 + 今天实时。
 * 任一需要的日快照缺失/失效 → 重算该日并回写快照。
 *
 * @returns {Promise<{stats: object, usedSnapshotDays: number, recomputedDays: number}>}
 */
async function buildUsageStatsWithSnapshots({ range = '7' } = {}) {
  const win = resolveRange(range);
  const todayKey = dayKeyOf(Date.now());
  const todayStart = new Date(todayKey + 'T00:00:00').getTime();
  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }

  // 已完结日：直接读按天文件；缺失的才记入待回算
  const fromTs = win.mode === 'all' ? 0 : win.start;
  const wantedDays = completedDayKeys(fromTs);
  const dayAggs = [];   // { day, aggregates }
  const needDays = [];
  for (const dayKey of wantedDays) {
    const agg = loadUsageDayFile(dayKey);
    if (agg && !isEmptyDayAgg(agg)) dayAggs.push({ day: dayKey, aggregates: agg });
    else if (!agg) needDays.push(dayKey);
  }

  // 只有「缺日文件」或「窗口含今天」才碰 sessions/；且按 mtime 裁剪
  const includesToday = win.end >= todayStart;
  let archive = null;
  let recomputed = 0;
  if (needDays.length) {
    const minNeed = Math.min(...needDays.map((d) => new Date(d + 'T00:00:00').getTime()));
    archive = await collectArchiveForWindow(dir, files, minNeed);
    for (const dayKey of needDays) {
      const agg = aggregateDayFromArchive(archive, dayKey);
      if (!agg) continue;
      saveUsageDayFile(dayKey, agg);   // 固化，下次点用量页不再扫
      // 空日不进列表：30 天窗口会把「窗口起点→有数据那天」之间的空白日全枚举，
      // 全 0 的日子既不该占柱图也不该进按天表
      if (isEmptyDayAgg(agg)) continue;
      dayAggs.push({ day: dayKey, aggregates: agg });
      recomputed++;
    }
    dayAggs.sort((a, b) => a.day.localeCompare(b.day));
  }

  // 今天（窗口含今天才需要）：实时聚合，只解析今天 0 点后写过的文件
  let todayAgg = null;
  if (includesToday) {
    if (!archive) archive = await collectArchiveForWindow(dir, files, todayStart);
    todayAgg = aggregateDayFromArchive(archive, todayKey);
  }

  // days 行带 searchCount：搜索是会话级计数，原先只在聚合顶层 → 柱图恒 0
  const byDay = dayAggs.map(({ day, aggregates }) => ({
    day, ...aggregates.totals, searchCount: Number(aggregates.searchCount) || 0
  }));
  // 今天也进 days 表：否则「近 7 天」最后一行永远缺今天（空日除外）
  if (todayAgg?.totals && !isEmptyDayAgg(todayAgg)) {
    byDay.push({ day: todayKey, ...todayAgg.totals, searchCount: Number(todayAgg.searchCount) || 0 });
    byDay.sort((a, b) => a.day.localeCompare(b.day));
  }

  // 合并各维度：已完结日按天文件 + 今天实时
  const mergeGroups = (groupsList) => {
    const map = new Map();
    for (const groups of groupsList) {
      for (const g of groups || []) {
        const key = String(g.key ?? '');
        if (!map.has(key)) map.set(key, { key, ...g, runs: 0, exactCalls: 0, cost: 0 });
        const t = map.get(key);
        t.cost += Number(g.cost) || 0;
        t.peakCost += Number(g.peakCost) || 0;
        t.offPeakCost += Number(g.offPeakCost) || 0;
        t.peakTokens += Number(g.peakTokens) || 0;
        t.offPeakTokens += Number(g.offPeakTokens) || 0;
        t.promptTokens += Number(g.promptTokens) || 0;
        t.completionTokens += Number(g.completionTokens) || 0;
        t.cachedTokens += Number(g.cachedTokens) || 0;
        t.totalTokens += Number(g.totalTokens) || 0;
        t.runs += Number(g.runs) || 0;
        t.exactCalls += Number(g.exactCalls) || 0;
      }
    }
    let out = [...map.values()];
    out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
    return out;
  };

  const snapAggs = dayAggs.map((x) => x.aggregates);
  const totalsAggs = snapAggs.map((a) => a.totals);
  if (todayAgg) totalsAggs.push(todayAgg.totals);
  const totals = totalsAggs.reduce((acc, t) => {
    if (!acc) return { ...t, runs: t.runs, exactCalls: t.exactCalls };
    return {
      cost: (acc.cost || 0) + (t.cost || 0),
      peakCost: (acc.peakCost || 0) + (t.peakCost || 0),
      offPeakCost: (acc.offPeakCost || 0) + (t.offPeakCost || 0),
      peakTokens: (acc.peakTokens || 0) + (t.peakTokens || 0),
      offPeakTokens: (acc.offPeakTokens || 0) + (t.offPeakTokens || 0),
      promptTokens: (acc.promptTokens || 0) + (t.promptTokens || 0),
      completionTokens: (acc.completionTokens || 0) + (t.completionTokens || 0),
      cachedTokens: (acc.cachedTokens || 0) + (t.cachedTokens || 0),
      totalTokens: (acc.totalTokens || 0) + (t.totalTokens || 0),
      runs: (acc.runs || 0) + (t.runs || 0),
      exactCalls: (acc.exactCalls || 0) + (t.exactCalls || 0),
      hasPeakModel: Boolean(acc.hasPeakModel || t.hasPeakModel)
    };
  }, null) || { cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cacheHitRate: 0, peakRatio: 0, exactCalls: 0, hasPeakModel: false, runs: 0 };
  // 派生比率不能相加，重算
  totals.cacheHitRate = totals.promptTokens ? Math.min(1, totals.cachedTokens / totals.promptTokens) : 0;
  totals.peakRatio = (totals.peakTokens + totals.offPeakTokens) ? totals.peakTokens / (totals.peakTokens + totals.offPeakTokens) : 0;

  const chats = mergeGroups([...snapAggs.map((a) => a.chats), ...(todayAgg ? [todayAgg.chats] : [])]);
  const models = mergeGroups([...snapAggs.map((a) => a.models), ...(todayAgg ? [todayAgg.models] : [])])
    .map((m) => {
      const { vendor, model } = splitModelLabel(m.key);
      return { ...m, vendor, model };
    });
  let searchCount = snapAggs.reduce((a, x) => a + (x.searchCount || 0), 0) + (todayAgg?.searchCount || 0);
  const toolCounts = {};
  for (const a of snapAggs) {
    for (const [k, v] of Object.entries(a.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;
  }
  for (const [k, v] of Object.entries(todayAgg?.toolCounts || {})) toolCounts[k] = (toolCounts[k] || 0) + v;

  // 日文件已在回算时逐个落盘，这里不再写 usage-daily.json

  return {
    stats: {
      range: String(range),
      rangeLabel: win.label,
      mode: win.mode,
      totals,
      searchCount: searchCount || 0,
      toolCounts: toolCounts || {},
      days: byDay,
      hours: todayAgg?.hours || [],
      chats,
      models
    },
    recomputedDays: recomputed,
    usedSnapshotDays: wantedDays.length - recomputed
  };
}

/** 用配置解析价格（成本只与实际调用的模型有关，与当前选中模型无关）。 */
/**
 * 取某次调用的单价。
 *
 * 按「渠道：模型 id」优先查 —— 用户可以为某个渠道下的模型单独定价
 * （A6API 的 GLM-5.3-Flash 与 OpenRouter 的可能是两个价）。
 * 查不到再退回裸模型 id（通用价），最后才是全局兜底。
 *
 * ⚠️ 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor) {
  const cfg = getConfig();
  if (vendor) {
    const byVendor = resolveModelPrice(modelLabel(vendor, model), cfg);
    // 命中自定义价才算数；否则退回通用价（避免渠道名干扰官方表匹配）
    if (byVendor.source === 'custom') return byVendor;
  }
  return resolveModelPrice(model, cfg);
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows) {
  const cfg = getConfig();
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0, hasPeakModel = false;
  for (const r of rows) {
    const p = priceOf(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const c = (fresh / 1_000_000) * tier.in + (cached / 1_000_000) * tier.cached + (completion / 1_000_000) * tier.out;
    cost += c;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
  }
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel, runs: rows.length
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。
 * 2026-09-19 起优先走"按日快照"路径（历史日聚合固化在 data/usage-daily.json，
 * 只实时算今天），快照层出错时自动回落到旧的实时聚合 —— 用量页绝不能白屏。 */
async function buildUsageStats({ range = '7' } = {}) {
  try {
    const { stats } = await buildUsageStatsWithSnapshots({ range });
    if (stats && stats.totals) return stats;
  } catch (error) {
    console.warn('[usage] 快照统计路径失败，回落实时聚合：', error?.message ?? error);
  }
  const { rows, win, searchCount, toolCounts } = await collectUsageRows({ range });
  const totals = costOfRows(rows);
  // 单日/24小时场景下"按天"没有意义（只有一行），由前端决定是否隐藏
  // 按天分桶需要 dayKey 字段
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // 按天 / 按小时都算出来：回退路径曾经没有 hours，前端 spark 退化成单柱实心块
  const byDayMap = new Map();
  for (const r of rows) {
    const k = r.dayKey;
    if (!byDayMap.has(k)) byDayMap.set(k, []);
    byDayMap.get(k).push(r);
  }
  const byDay = [...byDayMap.entries()]
    .map(([day, list]) => ({ day, ...costOfRows(list) }))
    .sort((a, b) => a.day.localeCompare(b.day));
  const todayKey2 = dayKeyOf(Date.now());
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const hs = new Date(todayKey2 + 'T00:00:00').getTime() + h * 60 * 60 * 1000;
    const he = hs + 60 * 60 * 1000 - 1;
    const ht = costOfRows(rows.filter((r) => r.at >= hs && r.at <= he));
    hours.push({
      hour: h, cost: ht.cost, runs: ht.runs,
      promptTokens: ht.promptTokens, completionTokens: ht.completionTokens,
      cachedTokens: ht.cachedTokens, cacheHitRate: ht.cacheHitRate, totalTokens: ht.totalTokens
    });
  }
  const chats = groupBy(rows, 'chatKey', 0);
  // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
  // 行数多时由前端滚动容器处理。
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return {
    range: String(range),
    rangeLabel: win.label,
    mode: win.mode,
    totals,
    searchCount: searchCount || 0,
    toolCounts: toolCounts || {},
    days: byDay,
    hours: hours || [],
    chats,
    models
  };
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=main&by=model → 该会话下各模型的成本
 */
/**
 * 明细弹窗走按天文件：dim=day 读该日文件；dim=chat/model 跨日取同 key 分组。
 * 对不上（缺文件）返回 null，回落全量扫。
 */
function tryBreakdownFromDayFiles({ range, dim, key, by }) {
  if (!dim) return null;
  // 日文件只有「按会话」「按模型」两份平行聚合，没有 chat×model 交叉表。
  // 交叉下钻（会话→各模型 / 模型→各会话）必须回落全量扫 ——
  // 否则会把 dim 自己的 key 再当成 by 的行（表现为「各模型」里出现会话键）。
  if ((dim === 'chat' && by === 'model') || (dim === 'model' && by === 'chat')) return null;
  const win = resolveRange(range);
  const fromTs = win.mode === 'all' ? 0 : win.start;
  const wantedDays = completedDayKeys(fromTs);
  const aggs = [];
  for (const dayKey of wantedDays) {
    const agg = loadUsageDayFile(dayKey);
    if (agg) aggs.push({ day: dayKey, aggregates: agg });
  }
  if (!aggs.length) return null;
  const emptyTotals = () => ({
    cost: 0, peakCost: 0, offPeakCost: 0, peakTokens: 0, offPeakTokens: 0,
    promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0,
    runs: 0, exactCalls: 0, cacheHitRate: 0, hasPeakModel: false
  });
  const addTotals = (acc, t) => {
    const o = { ...acc };
    for (const k of ['cost', 'peakCost', 'offPeakCost', 'peakTokens', 'offPeakTokens',
      'promptTokens', 'completionTokens', 'cachedTokens', 'totalTokens', 'runs', 'exactCalls']) {
      o[k] = (Number(acc[k]) || 0) + (Number(t[k]) || 0);
    }
    o.hasPeakModel = Boolean(acc.hasPeakModel || t.hasPeakModel);
    o.cacheHitRate = o.promptTokens ? Math.min(1, o.cachedTokens / o.promptTokens) : 0;
    return o;
  };
  const pack = (sum, groups) => ({
    range: String(range), dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key, cost: g.cost,
      promptTokens: g.promptTokens, completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens, totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate, runs: g.runs, exactCalls: g.exactCalls
    }))
  });

  if (dim === 'day') {
    const hit = aggs.find((x) => x.day === key);
    if (!hit) return null;
    const src = by === 'model' ? hit.aggregates.models : hit.aggregates.chats;
    const groups = (src || []).map((g) => ({ ...g }));
    const sum = groups.reduce((acc, g) => addTotals(acc, g), emptyTotals());
    return pack(sum, groups);
  }
  const field = dim === 'model' ? 'models' : 'chats';
  const map = new Map();
  for (const { day, aggregates } of aggs) {
    for (const g of (aggregates[field] || [])) {
      const gk = String(g.key ?? '');
      if (gk !== String(key)) continue;
      const bk = by === 'day' ? day : gk;
      if (!map.has(bk)) map.set(bk, { key: bk, ...emptyTotals() });
      map.set(bk, addTotals(map.get(bk), g));
    }
  }
  if (!map.size) return null;
  // by=day 按日期升序（时间序）；其余维度仍按成本降序
  const groups = [...map.values()].sort(by === 'day'
    ? (a, b) => String(a.key).localeCompare(String(b.key))
    : (a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  const sum = groups.reduce((acc, g) => addTotals(acc, g), emptyTotals());
  return pack(sum, groups);
}

async function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  // 能走按天文件就走：避免每次点明细行都全量扫 sessions/
  const dayFileHit = tryBreakdownFromDayFiles({ range, dim, key, by });
  if (dayFileHit) return dayFileHit;
  const { rows, win } = await collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  // by=day 按日期升序；groupBy 默认按成本降序，这里纠偏
  if (by === 'day') groups.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  const sum = costOfRows(subset);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}
