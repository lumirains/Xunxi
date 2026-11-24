// D19 引擎装配层（call-mode design §2.4「呼叫入口与引擎准备」/ §10.1 voice.engine /
// §10.2 降级链；night-plan §2-T7 第 3 条）。呼叫中由通话运行器（call.js hello 处理）
// 调 ensureForCall()：探测端口 → 未运行且 manage='auto' → 按 handoff-voice-walkie
// §4-b/§4-c 命令拉起 whisper / GPT-SoVITS api_v2 → 健康探针 → 就绪；失败重试一次；
// 仍败返回降级原因（调用方按 §10.2 处置：TTS 纯文字 / ASR 文字输入 / 双不可用拒接）。
//
// ── 纪律（review 可 grep）────────────────────────────────────────────────────
//   · capabilities/voice.js 保持无状态——本层只做"探测/拉起/健康探针/登记清理"，
//     不改任何批准口语义（第三口 ASR / 第四口 TTS 调用面零触碰）；
//   · 只清理自己拉起的进程：每个 spawn 登记 {pid, 命令, 启动方式}（owned 表），
//     release() 只杀登记过的 PID；所有者手启的引擎（同端口应答者）绝不触碰
//     （kill 已退出 PID 为 no-op；端口竞态下登记的是自己的死 PID，不误伤占用者）；
//   · manage:'manual' 只探测不拉起；engine='off' 或 baseUrl 空 = 引擎未配置
//     （B2 同款：绝不回落主聊天 provider，也绝不拉起进程——零进程依赖纪律）；
//   · gpuAllow=false → 不拉起 GPU 引擎（§2.4："只有所有者明确要求本轮不许用
//     GPU 时才跳过 GPU 引擎"——本层能拉起的只有 GPU 本地引擎）；
//   · 非本机（127.0.0.1/localhost/::1 之外）baseUrl 只探测不拉起；
//   · 一切失败进结果对象 reason 字段，不抛错（§10.2 铁律：不卡死不静默）。
//
// ── 引擎命令（walkie §4-b/§4-c 语义逐字；端口/宿主取 config.voice.*.baseUrl）──
//   whisper: MSYS_NO_PATHCONV=1 D:/Tools/WhisperCpp/whisper-server.exe
//            -m D:/Tools/WhisperCpp/models/ggml-large-v3-turbo.bin
//            --inference-path /v1/audio/transcriptions --host 127.0.0.1
//            --port <port> -l auto
//   SoVITS : cwd=D:/Tools/GPT-SoVITS  ./runtime/python.exe api_v2.py
//            -a 127.0.0.1 -p <port>
//   walkie 坑①（MSYS 路径转换）本层天然免疫：spawn(argv 数组) 不经 shell；
//   仍按任务书显式带 MSYS_NO_PATHCONV=1（对 shell 包装场景兜底，无害）。
//   可执行/模型/目录允许 env 覆盖（XUNXI_WHISPER_EXE / XUNXI_WHISPER_MODEL /
//   XUNXI_SOVITS_HOME；旧名 QQ_AGENT_* 兼容 fallback），XUNXI_WHISPER_ARGS / XUNXI_SOVITS_ARGS（JSON 数组，
//   逐字替换默认参数——测试注入假引擎用；设了它端口注入交给测试自己）。
//
// ── 健康探针（walkie §4-b/§4-c / handoff-voice-v3 §3 口径）────────────────────
//   GET {baseUrl}/ 有任何 HTTP 应答即"进程在"（whisper 根路由 200；api_v2 无根
//   路由 404=进程在——handoff §3-b 实测口径）。拉起后按预算轮询（whisper 秒级
//   起 15s 预算；SoVITS 全量载模 ~25s 给 45s 预算）。
//   TTS 预热：tts 就绪后追一发 POST /tts（TTS_FROZEN 冻结组 + 短句）——首调含
//   CUDA 编译 5.9-7.4s（walkie §4-c），预热把这笔开销移进"准备声音"态，不占首句
//   5s 超时。失败容忍（预热非健康判据，健康以探针为准）。
import { spawn } from 'node:child_process';
import { getConfig } from '../config.js';
import { TTS_FROZEN, resetTtsBreaker, dialectOf } from '../capabilities/voice.js';

// ── 常量（walkie §4-b/§4-c 实测口径 + 预算）──────────────────────────────────
const PROBE_TIMEOUT_MS = 2500;        // 单次探针超时
const PROBE_INTERVAL_MS = 800;        // 拉起后轮询间隔
const WHISPER_READY_BUDGET_MS = 15000;   // whisper-server 秒级起（handoff §3-a 实测 1s 内）
const SOVITS_READY_BUDGET_MS = 45000;    // api_v2 全量载模 ~25s（walkie §4-c），留余量
const WARMUP_TIMEOUT_MS = 12000;      // 首调含 CUDA 编译 5.9-7.4s，12s 兜底
const WARMUP_TEXT = '嗯，我在呢。';    // walkie §4-c 探针句（UTF-8 由 fetch JSON 序列化保证，
                                      // 不经 shell——坑② 天然免疫）

const WHISPER_EXE_DEFAULT = 'D:/Tools/WhisperCpp/whisper-server.exe';
const WHISPER_MODEL_DEFAULT = 'D:/Tools/WhisperCpp/models/ggml-large-v3-turbo.bin';
const SOVITS_HOME_DEFAULT = 'D:/Tools/GPT-SoVITS';

/** 本机宿主判定（非本机 baseUrl 只探测不拉起）。 */
function isLocalHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** baseUrl → { host, port }；无端口（默认 80/443）返回 port=''。 */
function parseBaseUrl(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return { host: u.hostname, port: u.port, origin: u.origin };
  } catch {
    return null;
  }
}

/** 单次健康探针：GET {baseUrl}/ 有任何 HTTP 应答=进程在（§3-b 404 也算在）。 */
async function probeOnce(origin) {
  try {
    const res = await fetch(`${origin}/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.status > 0;
  } catch {
    return false;
  }
}

/** 拉起后轮询到就绪或预算耗尽。 */
async function waitForReady(origin, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await probeOnce(origin)) return true;
    await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
  }
  return false;
}

/**
 * D19 引擎装配层工厂。log 注入（app.js log 链）；实例内持有 owned 登记 Map——
 * 工厂在 createVoiceCall 内创建一次，登记随装配层生命周期（进程退出经
 * createVoiceCall 暴露的 releaseEngines → app.stop() 调）。
 */
export function createEngineManager({ log = () => {} } = {}) {
  /** 自拉进程登记：pid → { kind, exe, args, cwd, startedAt, child }（只杀这里面的）。 */
  const owned = new Map();
  /** ensure 去重（并发两通呼叫只做一次拉起）。 */
  let ensurePromise = null;
  // ── W3 状态卡（GET /api/voice/status 只读快照消费）─────────────────────
  // 每引擎最近一次探针结果 { ok, ms, at } | null（null=本进程还没探测过）。
  // 记账点：ensureEngine 全程耗时（呼叫装配/Settings 联动都走它）与 probeEngines
  // （状态卡"立即探测"）。纯观测态，零行为影响——闸门/拉起/熔断都不读它。
  const lastProbe = { asr: null, tts: null };
  function recordProbe(kind, ok, ms) {
    lastProbe[kind] = { ok: ok === true, ms: Math.max(0, Math.round(ms)), at: Date.now() };
  }

  /** 引擎闸（与 capabilities/voice.js asrGate/ttsGate 同口径的"配置面"读取——
   *  只判断"配置了没有"，不做任何调用）。未配置返回 null。
   *  W1 起 asr/tts.enabled 显式 false 同样视为未配置（快捷开关关=不探测不拉起）。
   *  W2 起透传 dialect（plan §9）：非 'gpu-local' 方言=云端协议，ensure 只探测
   *  不拉起——spawnEngine 只会拉起本地 whisper/SoVITS 可执行件，云端方言拉本地
   *  进程是错误行为。 */
  function gateOf(kind) {
    const v = getConfig()?.voice;
    if (!v?.enabled) return null;
    const e = v?.[kind];
    if (!e || e.enabled === false || String(e.engine ?? 'off') === 'off') return null;
    const baseUrl = String(e.baseUrl ?? '').trim();
    if (!baseUrl) return null;
    const dialect = dialectOf(e);   // W2：单一事实源（voice.js dialectOf）
    if (!dialect) return null;      // 显式方言键非法 = fail-closed 未配置（不探测不拉起）
    return { origin: baseUrl.replace(/\/+$/, ''), dialect };
  }

  // W6-①：env 更名 QQ_AGENT_*→XUNXI_*（旧名兼容 fallback 读取，优先新名）。
const envOf = (name) => process.env[`XUNXI_${name}`] ?? process.env[`QQ_AGENT_${name}`];

/** 拉起一个引擎进程并登记（spawn 失败/参数缺失返回 null）。 */
  function spawnEngine(kind, port) {
    const env = { ...process.env, MSYS_NO_PATHCONV: '1' };
    let exe = '';
    let args = [];
    let cwd;
    try {
      if (kind === 'asr') {
        exe = String(envOf('WHISPER_EXE') ?? '').trim() || WHISPER_EXE_DEFAULT;
        args = envOf('WHISPER_ARGS')
          ? JSON.parse(envOf('WHISPER_ARGS'))
          : [
              '-m', String(envOf('WHISPER_MODEL') ?? '').trim() || WHISPER_MODEL_DEFAULT,
              '--inference-path', '/v1/audio/transcriptions',
              '--host', '127.0.0.1',
              '--port', String(port),
              '-l', 'auto'
            ];
      } else {
        cwd = String(envOf('SOVITS_HOME') ?? '').trim() || SOVITS_HOME_DEFAULT;
        exe = String(envOf('SOVITS_EXE') ?? '').trim() || 'runtime/python.exe';
        args = envOf('SOVITS_ARGS')
          ? JSON.parse(envOf('SOVITS_ARGS'))
          : ['api_v2.py', '-a', '127.0.0.1', '-p', String(port)];
      }
    } catch (err) {
      log(`[voice][engine] ${kind} 启动参数构造失败：`, err?.message ?? err);
      return null;
    }
    let child = null;
    try {
      child = spawn(exe, args, { cwd, env, stdio: 'ignore', windowsHide: true, detached: false });
    } catch (err) {
      log(`[voice][engine] ${kind} spawn 失败：`, err?.message ?? err);
      return null;
    }
    // error 监听必须最先挂（exe 不存在等 spawn 失败走异步 error 事件——
    // 未挂监听的 error 会以 unhandled 崩掉宿主进程）
    child.on('error', () => {
      // spawn 失败进程从未起来：出登记，release 不摸死 PID
      owned.delete(child.pid);
      log(`[voice][engine] ${kind} 进程错误（已出登记）pid=${child.pid}`);
    });
    const pid = child.pid;
    if (!pid) return null;   // spawn 失败（Windows 下 exe 不存在走 error 事件，pid 可能在）
    owned.set(pid, { kind, exe, args, cwd: cwd ?? '', startedAt: Date.now(), child });
    child.on('exit', () => { owned.delete(pid); });   // 自己退出即出登记（release 不再摸它）
    log(`[voice][engine] ${kind} 已拉起 pid=${pid} ${exe} ${args.join(' ')}${cwd ? ` (cwd=${cwd})` : ''}`);
    return child;
  }

  /** 杀一个自己拉起的尝试（重试前清理；只动登记过的 PID）。 */
  function killOwned(child) {
    if (!child || !child.pid) return;
    try { child.kill(); } catch { /* 已死 */ }
    owned.delete(child.pid);
  }

  /** 单引擎确保（W3 记账壳）：全程耗时进 lastProbe 快照（状态卡消费），本体不动。 */
  async function ensureEngine(kind, gate) {
    const t0 = Date.now();
    const r = await ensureEngineImpl(kind, gate);
    recordProbe(kind, r.ok, Date.now() - t0);
    return r;
  }

  /** 单引擎确保本体：探测 → （auto 且 gpu-local 方言）拉起 → 健康探针 → 重试一次
   *  → 就绪/降级原因。W2：非 gpu-local 方言（云端协议）只探测不拉起。 */
  async function ensureEngineImpl(kind, gate) {
    // ① 先探测：在跑（所有者手启或上次拉起的长驻进程）→ 直接就绪
    if (await probeOnce(gate.origin)) {
      return { ok: true, configured: true, spawned: false, reason: '' };
    }
    // ② W2：云端方言（deepseek-tools / openai-compat）——不可达即降级原因，绝不拉起
    if (gate.dialect !== 'gpu-local') {
      return { ok: false, configured: true, spawned: false,
        reason: `不可达（${gate.dialect} 云端方言不拉起本地进程，检查 baseUrl/apiKey/网络）` };
    }
    // ③ 运行策略闸
    const eng = getConfig()?.voice?.engine ?? {};
    const manage = String(eng.manage ?? 'auto');
    if (manage !== 'auto') {
      return { ok: false, configured: true, spawned: false,
        reason: `未运行（manage=${manage} 只探测不拉起，请手动启动引擎）` };
    }
    if (eng.gpuAllow === false) {
      return { ok: false, configured: true, spawned: false,
        reason: '未运行（gpuAllow=false 本轮不许用 GPU，不拉起 GPU 引擎）' };
    }
    const parsed = parseBaseUrl(gate.origin);
    if (!parsed || !isLocalHost(parsed.host) || !parsed.port) {
      return { ok: false, configured: true, spawned: false,
        reason: `未运行（${parsed ? `非本机引擎 ${parsed.host}` : 'baseUrl 不可解析'} 或无端口，不可拉起）` };
    }
    // ④ 拉起 → 健康探针 → 失败重试一次（night-plan §2-T7 口径）
    const budget = kind === 'asr' ? WHISPER_READY_BUDGET_MS : SOVITS_READY_BUDGET_MS;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const child = spawnEngine(kind, parsed.port);
      if (child && await waitForReady(gate.origin, budget)) {
        return { ok: true, configured: true, spawned: true, reason: '' };
      }
      killOwned(child);   // 只清自己刚拉的（探针失败=没就绪，进程留着也是孤儿）
      log(`[voice][engine] ${kind} 第 ${attempt}/2 次拉起未就绪（预算 ${budget}ms）`);
    }
    return { ok: false, configured: true, spawned: false,
      reason: '拉起失败（重试 1 次仍不就绪，看服务日志）' };
  }

  /** TTS 预热（TTS_FROZEN 冻结组 + 短句；失败容忍——非健康判据）。 */
  async function warmupTts(origin) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${origin}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: WARMUP_TEXT, ...TTS_FROZEN }),
        signal: AbortSignal.timeout(WARMUP_TIMEOUT_MS)
      });
      const ms = Date.now() - t0;
      if (!res.ok) {
        log(`[voice][engine] TTS 预热 HTTP ${res.status}（${ms}ms，容忍——健康以探针为准）`);
        return { ok: false, ms };
      }
      log(`[voice][engine] TTS 预热完成 ${ms}ms`);
      // 引擎确认可用 → 清掉 voice.js 的连续失败熔断（熔断原口径"至进程重启"，
      // 但 D19 允许呼叫中拉起引擎：引擎回来了进程没重启，不重置会一直纯文字）。
      if (resetTtsBreaker()) log('[voice][engine] TTS 熔断已重置（引擎恢复）');
      return { ok: true, ms };
    } catch (err) {
      log(`[voice][engine] TTS 预热失败（容忍）：`, err?.message ?? err);
      return { ok: false, ms: Date.now() - t0 };
    }
  }

  /**
   * 呼叫中引擎确保（call.js hello 处理调）。
   * 引擎均未配置（off/空 baseUrl）→ **同步**返回普通对象（零探测零进程零 await
   * ——握手感保持既有同步路径）；否则返回 Promise（探测/拉起/预热都在"准备声音"态内）。
   * 结果形状：{ asr, tts, bothDown, warmup? }，引擎项 { ok, configured, spawned, reason }。
   * bothDown = 双引擎**均已配置**但均不可用（§10.2-4 拒接口径的判据——配置关的不算）。
   */
  function ensureForCall() {
    const asrG = gateOf('asr');
    const ttsG = gateOf('tts');
    const notConfigured = () => ({ ok: false, configured: false, spawned: false, reason: '未配置' });
    if (!asrG && !ttsG) {
      return { asr: notConfigured(), tts: notConfigured(), bothDown: false };
    }
    ensurePromise ??= (async () => {
      const [asr, tts] = await Promise.all([
        asrG ? ensureEngine('asr', asrG) : Promise.resolve(notConfigured()),
        ttsG ? ensureEngine('tts', ttsG) : Promise.resolve(notConfigured())
      ]);
      const out = { asr, tts, bothDown: asr.configured && tts.configured && !asr.ok && !tts.ok };
      // W2：预热是 gpu-local 冻结组专用请求（POST /tts + TTS_FROZEN）——其余方言
      // 跳过（健康=探针；对云端方言发冻结组请求是协议错误）。云端方言探针可达
      // 同样重置熔断（D19 同理由：引擎恢复而进程未重启，不重置会一直纯文字）。
      if (tts.ok && ttsG) {
        if (ttsG.dialect === 'gpu-local') {
          out.warmup = await warmupTts(ttsG.origin);
        } else if (resetTtsBreaker()) {
          log('[voice][engine] TTS 熔断已重置（云端方言探针可达）');
        }
      }
      return out;
    })();
    const p = ensurePromise;
    ensurePromise = null;
    return p;
  }

  /** 退出清理（app.stop() 调）：只杀登记过的自拉进程，返回被杀清单。 */
  function release() {
    const killed = [];
    for (const [pid, rec] of owned) {
      killed.push({ pid, kind: rec.kind, exe: rec.exe });
      try { rec.child.kill(); } catch { /* 已死 */ }
    }
    owned.clear();
    if (killed.length) log(`[voice][engine] release：清理自拉进程 ${killed.length} 个（${killed.map((k) => `${k.kind}#${k.pid}`).join(', ')}）`);
    return killed;
  }

  /** 登记表快照（测试/排障用）。 */
  function listOwned() {
    return [...owned.entries()].map(([pid, rec]) => ({
      pid, kind: rec.kind, exe: rec.exe, args: rec.args, cwd: rec.cwd, startedAt: rec.startedAt
    }));
  }

  // ── W3 状态卡（GET /api/voice/status）────────────────────────────────────
  /**
   * 双引擎即时健康探针（状态卡"立即探测"调）：只探测**绝不拉起**——与 ensure
   * 不同，不触 manage/gpuAllow/spawn 链，探测本身零副作用（probeOnce=GET /）。
   * 云端方言同样适用（probeOnce 口径=有任何 HTTP 应答即在，404 也算）。
   * 结果记入 lastProbe（本次快照与下次无参 status 都能读到）。未配置引擎项
   * configured=false（gateOf null 同口径：总闸/快捷开关/engine=off/baseUrl 空/方言非法）。
   */
  async function probeEngines() {
    const out = {};
    await Promise.all(['asr', 'tts'].map(async (kind) => {
      const g = gateOf(kind);
      if (!g) {
        out[kind] = { ok: false, configured: false, probed: true, ms: 0, reason: '未配置' };
        return;
      }
      const t0 = Date.now();
      const ok = await probeOnce(g.origin);
      const ms = Date.now() - t0;
      recordProbe(kind, ok, ms);
      out[kind] = { ok, configured: true, probed: true, ms, reason: ok ? '' : '探针不可达' };
    }));
    return out;
  }

  /** lastProbe 快照（无参 status 用：最近一次探针结果，null=本进程还没探测过）。 */
  function probeState() {
    return {
      asr: lastProbe.asr ? { ...lastProbe.asr } : null,
      tts: lastProbe.tts ? { ...lastProbe.tts } : null
    };
  }

  return { ensureForCall, release, listOwned, probeEngines, probeState };
}

// ── W1 共享单例（Settings 快捷开关联动）────────────────────────────────────
// Settings 打开 TTS/ASR 开关时经 POST /api/voice/ensure 拉起/预热引擎——必须与
// call.js 呼叫装配用**同一个** manager 实例：owned 登记表共享（release 只杀
// 登记过的自拉进程口径不破）、ensurePromise 去重共享（通话中开关并发不双拉起）。
// 首个调用方的 log 定型（app.js 的 log 链两处一致）。
let sharedManager = null;

/** 取共享 engine-manager 单例（call.js 装配与 routes.js ensure 端点共用）。 */
export function getSharedEngineManager({ log = () => {} } = {}) {
  if (!sharedManager) sharedManager = createEngineManager({ log });
  return sharedManager;
}
