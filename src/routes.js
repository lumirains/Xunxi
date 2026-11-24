// API 路由表：把 handleHttp 的巨型 if-else 链拆成声明式路由。
//
// 每个路由：{ method, pattern, handler }
//   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'（'*' 匹配任意方法）
//   - pattern: 字符串（精确匹配）或 RegExp（exec 捕获组传给 handler）
//   - handler: async (ctx) => 结果
//       ctx = { req, res, url, pathname, method, match, body?, ...deps }
//       handler 返回 undefined 表示"已自行写响应"（如 SSE）；否则框架统一 json() 返回。
//
// 依赖（store/sessions/orchestrator/webAdapter/registry/…）通过 createRoutes(deps) 注入，
// 路由 handler 通过闭包取用，避免在 app.js 里反复传参。
// Q11：协议端客户端依赖摘除——/api/status 的连接诊断段、好友列表端点、test-send 直发、
// 重置数据时的连接关闭随 QQ 身体归档一并出清（路由表零协议端依赖）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// E6（R2）控制台令牌登录：免检端点（app.js 分发层豁免 authorize）的校验与 cookie 下发。
import { consoleCookieValue, consoleTokenMatches } from './console-auth.js';
import { getConfig, updateConfig, deepMerge as deepMergeConfig, DATA_DIR, ownerLabelFor } from './config.js';
// 步骤⑥ / T6.4：记忆页数据源切 person/*（前额叶 facts + cards 只读供数）。
import * as personMemory from './person/memory.js';
// Phase 9 / M1（phase9-plan.md §3、D40 只增不改）：皮层读前额叶 = 合法边
//（v3 §0：合法耦合仅"调度器调用进来"与"前额叶 API"）。person 只读端点供数。
import * as personMind from './person/mind.js';
// person/relationship 已于 2026-11-21 整体丢弃（所有者裁定：数值轴零消费方），
// 导入边随之摘除；state 行与历史归档处置记录见内部文档 state-ownership.md。
// person/self 同日整体丢弃（narrative 运行期零写者/恒空、values 代码种子无消费——
// 人设 roleText 已覆盖其职责），见内部文档 state-ownership.md v11。
import * as personLife from './person/life.js';
// night-plan-life §L1（2026-11-14）控制台「晚安整理」按钮：能力都已存在，纯接线——
// cards 走执行器 runOnce（统一管线：取数→产出→解析→normalizeCard→writeCard 同日替换），
// diary 走自驱声明自己的入口 runDiary（force 口径见 diary.js runDiary 注释）。
// 皮层"调度器调用进来"的合法耦合方向（routes=控制台装配层，同 orchestrator startClock）。
import { runOnce as reflectionRunOnce, localDayKey, dayBounds, shiftDayKey } from './capabilities/reflection/executor.js';
import { runDiary as reflectionRunDiary } from './capabilities/reflection/diary.js';
// Phase 9 M2（15f）：事件流读数 + kernel-event SSE 桥（只增）。
import { events } from './kernel/events.js';
import { customSearch } from './web-search.js';
import { listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices } from './model-prices.js';
import {
  currentProviders, setProviderKey, testAllProviders, testOneProvider,
  testModelChat, fetchModelsFrom, upsertProvider, renameProvider, addModelsToProvider, removeModelFromProvider, removeProvider
} from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { todayKey } from './util.js';
import { logger } from './logger.js';
import { moduleManager } from './modules/manager.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './modules/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
// Q7：safe-fetch 的本文件消费点（/api/media-data 的 QQ 图床 URL 下载）已随该端点
// 改走 media-store read 删除；safe-fetch 本体仍服务 web-search/tools/sender/video-reader。
import { detectDialect as detectThinkingDialect } from './thinking.js';
// Q6+Q8 媒体层（qq-exit-plan §3 Step 6.5）：媒体按内容哈希 id 存取。
import { put as mediaPut, read as mediaRead, MEDIA_ID_RE, MAX_FILE_BYTES } from './media-store.js';
import { detectImageType, detectAudioType } from './image-type.js';

/**
 * 构建路由表。
 * @param {object} deps 依赖注入
 */
// Phase 9 M2（15f）：kernel-event 桥注册标记——createRoutes 每进程只调一次，
// 但自测/多实例可能重复调，这里保证监听器只挂一份。
let kernelEventBridged = false;

// ── Q6+Q8 媒体层：/api/web/upload 的请求体工具 ─────────────────────────────
// upload 走**原始字节**读取（不走 readBody——它按 JSON 解析且有 16MB 硬限，
// 20MB 图片 base64 后 ≈27.3MB 会先撞限）。上限给足 base64 膨胀 + multipart 边界余量。
const UPLOAD_MAX_FILES = 10;
const UPLOAD_RAW_LIMIT = 32 * 1024 * 1024;

// ── V0 媒体层音频化：上传类型判定（asr-tts-v0-execution-spec §2.3）──────────
// 音频白名单 mime：webm/ogg/wav/mp4/mpeg（mp3 无容器魔数，只能靠 contentType）。
// 判定顺序：音频（mime 命中白名单 或 魔数命中）> 图片（image/* 或 图片魔数，
// 既有行为零回归）> 其余一律拒绝——此前 upload 完全不校验 mime，音频字节会被
// extOf 兜成 .jpg；魔数优先分支已在 media-store/image-type 落地，这里挡的是
// "既不是图片也不是已知音频"的杂类型（此前会静默落成 .jpg）。
const AUDIO_UPLOAD_MIME_RE = /^audio\/(?:webm|ogg|wav|mp4|mpeg)$/i;

/** 单个上传文件的类型归类：'image' | 'audio' | null（null=白名单外，拒绝）。 */
function uploadKindOf(buffer, contentType) {
  const mime = String(contentType || '').toLowerCase();
  if (AUDIO_UPLOAD_MIME_RE.test(mime) || detectAudioType(buffer)) return 'audio';
  if (mime.startsWith('image/') || detectImageType(buffer)) return 'image';
  return null;
}

/** 读原始请求体（字节），超限断链并抛带 status 的可暴露错误（与 readBody 同口径）。 */
function readRawBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limitBytes) {
        done = true;
        const err = new Error(`请求体过大（上限 ${Math.round(limitBytes / 1024 / 1024)}MB）`);
        err.expose = true;
        err.status = 413;
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', (error) => { if (!done) { done = true; reject(error); } });
  });
}

/**
 * 轻量 multipart 文件部件解析：只取带 filename 的部件（file 控件），
 * 文本控件忽略。返回 [{ filename, contentType, buffer }]。
 */
function parseMultipartFiles(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!m) return [];
  const boundary = Buffer.from(`--${(m[1] || m[2] || '').trim()}`);
  const files = [];
  let start = body.indexOf(boundary);
  while (start !== -1) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    const part = body.subarray(start + boundary.length, next);
    start = next;
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd === -1) continue;
    const head = part.subarray(0, headEnd).toString('utf8');
    if (!/filename="/i.test(head)) continue;   // 只要 file 部件
    files.push({
      filename: /filename="([^"]*)"/i.exec(head)?.[1] ?? '',
      contentType: /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim() ?? '',
      // 段尾 \r\n 属边界分隔符，不计入内容
      buffer: part.subarray(headEnd + 4, part.length - 2)
    });
  }
  return files;
}

// ── 自定义头像（2026-11-21）：data/avatar.<ext> 单真身，读写删三端点共用 ──────
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;   // 5MB：UI 头像足够，防随手塞原图
const AVATAR_VARIANTS = [
  { ext: 'png', mime: 'image/png' },
  { ext: 'jpg', mime: 'image/jpeg' },
  { ext: 'jpeg', mime: 'image/jpeg' },
  { ext: 'webp', mime: 'image/webp' },
  { ext: 'gif', mime: 'image/gif' }
];

/** 当前生效的自定义头像（变体里取最新 mtime 的一个）；未设置 → null。 */
function avatarCurrent() {
  let best = null;
  for (const v of AVATAR_VARIANTS) {
    const file = path.join(DATA_DIR, `avatar.${v.ext}`);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && (!best || st.mtimeMs > best.mtimeMs)) {
        best = { ext: v.ext, mime: v.mime, mtimeMs: st.mtimeMs, buffer: fs.readFileSync(file) };
      }
    } catch { /* 无此变体 */ }
  }
  return best;
}

/** 头像 mtime（缓存击穿用）；未设置 → 0。 */
function avatarCurrentTs() {
  const found = avatarCurrent();
  return found ? Math.round(found.mtimeMs) : 0;
}

/** 清头像变体；keepExt 非空时跳过该扩展名（上传新格式前清旧变体用）。 */
function avatarClearVariants(keepExt = '') {
  for (const v of AVATAR_VARIANTS) {
    if (keepExt && v.ext === keepExt) continue;
    try { fs.unlinkSync(path.join(DATA_DIR, `avatar.${v.ext}`)); } catch { /* 无文件 */ }
  }
}

/** 上传文件 → 扩展名（魔数优先、mime 兜底；白名单外 → null 拒收）。 */
function extOfAvatar(file) {
  const byMagic = detectImageType(file.buffer);   // { mime, ext } | null
  if (byMagic) return byMagic.ext.replace(/^\./, '') || null;
  const mime = String(file.contentType ?? '').toLowerCase();
  if (/png/.test(mime)) return 'png';
  if (/jpe?g/.test(mime)) return 'jpg';
  if (/webp/.test(mime)) return 'webp';
  if (/gif/.test(mime)) return 'gif';
  return null;
}

export function createRoutes(deps) {
  const {
    store, sessions, orchestrator, webAdapter, registry,
    emit, log,
    // app.js 内部的过程/状态
    localVersion, compareSemver, UPDATE_INFO_URL,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    // Q2（qq-exit Step 1）：QQ 载体 12 个 deps 随 10 端点 + /api/status 诊断
    // 字段摘除；app.js 侧的传参清理在 Q3（Step 2）对齐。
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills
  } = deps;

  // 小工具：读请求体（容错：没 body 当空对象）。
  // 但 readBody 明确标记的可暴露错误（400 非法 JSON / 413 过大）必须透传，
  // 否则会从"应返回 400"退化成静默当成空 patch。
  const bodyOf = (req) => readBody(req).catch((e) => { if (e?.expose) throw e; return {}; });

  // M2 15f（D43）：内核事件 → SSE 'kernel-event' 桥。events.jsonl 唯一写者
  // （kernel/events.js）追加成功后回调这里；广播只经既有 emit（app.js 的
  // sseClients 群发），既有 SSE 事件类型与载荷零改动（D40 只增不改）。
  if (!kernelEventBridged && typeof events.onAppend === 'function') {
    kernelEventBridged = true;
    events.onAppend((event) => {
      try {
        emit('kernel-event', event ?? {});
      } catch {
        // 广播失败不影响事件落盘
      }
    });
  }

  /**
   * Skill 可用性判断的运行期上下文。
   * 必须和 orchestrator 用同一份输入，否则会出现
   * "设置页说可用、运行时空工具列表"的口径分裂。
   */
  const skillRuntimeContext = () => {
    const cfg = getConfig();
    return {
      skills: moduleManager,
      toolsCfg: cfg.tools || {},
      // 与 orchestrator 同款判定：vision 开关开着，且当前模型没有被
      // 视觉扫描判定为 no-vision（曾经只看前半项，模型不支持时
      // 设置页仍显示视觉工具可用，运行时却剔除）
      visionEnabled: cfg.api?.vision !== false
        && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision',
      searchEnabled: cfg.webSearch?.enabled !== false,
      runtimeContext: {
        model: cfg.api?.model || '',
        provider: cfg.api?.provider || '',
        source: 'api'
      }
    };
  };

  return [
    // ── 认证（E6 · R2）：控制台令牌登录 ──────────────────────────────────
    // app.js 分发层对「POST /api/auth/login」豁免 authorize（免检），其余 /api/*
    // 作用面不变（/api/* 全检、静态不检）。成功 → Set-Cookie（HttpOnly;
    // SameSite=Strict; Path=/）——之后浏览器所有请求（含 SSE /api/events）自动带
    // cookie，前端不再需要任何 token 头。token 非空才发：'' 本就是全放行模式，
    // 没有凭证可校验也没有 cookie 可发（与 authorize 的 '' 早退同构——不在全放行
    // 模式下制造任何新 401 面，R2 红线）。
    {
      method: 'POST', pattern: '/api/auth/login',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const provided = String(body?.token ?? '');
        const expected = String(getConfig().server?.token ?? '');
        if (expected && !consoleTokenMatches(provided, expected)) {
          // 401 文案与分发层闸门的 {error:'未授权'} 不同——客户端可据此区分
          // "端点已到达、令牌不对"与"根本没带凭证"。
          return json(res, 401, { error: '令牌不匹配' });
        }
        const payload = { ok: true };
        if (expected) {
          // writeHead 会与 setHeader 合并（writeHead 同名键优先），Set-Cookie 存活
          res.setHeader('Set-Cookie', consoleCookieValue(expected));
          payload.cookie = true;
        } else {
          payload.tokenRequired = false;   // 全放行模式：登录成功但无凭证可发
        }
        return json(res, 200, payload);
      }
    },
    // ── 状态 / 数据目录 / 重置 ─────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/status',
      handler: async ({ res, json }) => {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        // Q11：连接诊断段（协议端状态对象，Q2 摘 QQ 载体诊断字段后仅剩的连接层自诊）
        // 随协议端归档一并摘除——响应不再有该键（前端 StatusPayload 声明为可选键，
        // 零消费点，形状变化零断链）。
        return json(res, 200, {
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          dataDir: DATA_DIR
        });
      }
    },
    {
      method: 'POST', pattern: '/api/open-data-dir',
      handler: async ({ res, json }) => {
        try {
          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir: DATA_DIR });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/reset-data',
      handler: async ({ res, json }) => {
        try {
          // 安全闸：只允许重置"看起来确实是数据目录"的路径。
          // XUNXI_DATA_DIR（旧名 QQ_AGENT_DATA_DIR 兼容）被误设成 C:\ 或用户目录时，无闸直接 rmSync 就是删盘。
          const resolved = path.resolve(DATA_DIR);
          const looksLikeDataDir = path.basename(resolved).toLowerCase().startsWith('data')
            || fs.existsSync(path.join(resolved, 'config.json'));
          if (!looksLikeDataDir || resolved === path.parse(resolved).root) {
            return json(res, 400, { ok: false, error: `数据目录不像 Xunxi 数据目录，已拒绝重置：${resolved}` });
          }

          await orchestrator.abortAll();
          // Q11：原在此处先关闭协议端连接再清数据——身体归档后无连接可关，直接清。

          // 删前先备份：同级带时间戳的副本，出问题还能捞回来；备份失败则中止重置。
          let backupDir = '';
          try {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            backupDir = `${resolved}.backup-${stamp}`;
            fs.cpSync(resolved, backupDir, { recursive: true, force: true });
          } catch (error) {
            return json(res, 500, { ok: false, error: `备份失败，已中止重置：${String(error?.message ?? error)}` });
          }

          // 只清内容，不删目录本身（目录可能被占用/是挂载点）；
          // 跳过两代实例锁文件（qq-agent.lock 旧名 / xunxi.lock 新名）——
          // 那是本进程活着的凭证，删了会让第二个实例误判无锁启动。
          for (const name of fs.readdirSync(resolved)) {
            if (name === 'qq-agent.lock' || name === 'xunxi.lock') continue;
            fs.rmSync(path.join(resolved, name), { recursive: true, force: true });
          }
          const { loadConfig } = await import('./config.js');
          updateConfig(loadConfig());
          return json(res, 200, { ok: true, backupDir, message: `已重置为初始形态（原数据已备份到 ${backupDir}），请重启应用` });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 成本看板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/usage/stats',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = await buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/breakdown',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 价格表 ───────────────────────────────────────────────────────
    // （远程价格表拉取已随 price-feed.js 精简移除，只返回内置官方价格）
    {
      method: 'GET', pattern: '/api/model-prices',
      handler: async ({ res, json, url }) => json(res, 200, {
        prices: listOfficialPrices(),
        current: resolveOfficialPrice(String(url.searchParams.get('model') || getConfig().api?.model || ''))
      })
    },

    // ── 体检 / 引导 ──────────────────────────────────────────────────
    // 2026-10-31：GET /api/groups 路由已删除（唯一调用方是设置页"群名补底"，随群聊下线）。
    // Q11：GET 好友列表端点（原协议端 get_friend_list 直读，白名单"选择好友"选择器
    // 数据源）随 QQ 身体归档一并删除——白名单机制 Q4/Q7 已死，选择器属前端残段
    // （§9-14-4②，留 PWA 处置；点按报"拉取失败"与未连接时同款提示，无新增破坏面）。

    // ── 人设模板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-templates',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-templates\/(custom_\d+)$/,
      handler: async ({ res, json, match }) => {
        const idx = Number(match[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }
    },

    // ── 多提供商模型目录 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/providers',
      handler: async ({ res, json }) => {
        const providers = currentProviders().map((p) => ({
          id: p.id, displayName: p.displayName, baseURL: p.baseURL,
          apiKey: '', apiKeyFrom: p.apiKeyFrom || '', needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey, anthropicOrigin: p.anthropicOrigin === true,
          models: p.models, modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }
    },
    {
      method: 'GET', pattern: '/api/providers/key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }
    },
    {
      method: 'GET', pattern: '/api/api-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }
    },
    {
      method: 'GET', pattern: '/api/search-key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const field = String(url.searchParams.get('field') || '');
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        // 各家对应的环境变量名：Key 没存进配置但环境里有时，也算"有 Key"
        //（web-search.js 的取值优先级就是 cfg.apiKey > env），UI 的掩码/显示
        // 口径必须与之一致，否则会出现"明明能搜，Key 框却显示空"的错觉。
        const ENV_OF = {
          deepseek: 'DEEPSEEK_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          bocha: 'BOCHA_API_KEY',
          baidu: 'BAIDU_SEARCH_API_KEY',
          metaso: 'METASO_API_KEY'
        };
        if (allowed.includes(field)) {
          const fromCfg = String(getConfig().webSearch?.[field]?.apiKey || '');
          return json(res, 200, { apiKey: fromCfg, hasApiKey: Boolean(fromCfg || (ENV_OF[field] && process.env[ENV_OF[field]])) });
        }
        // 自定义搜索服务：field 形如 custom:<id>，按 id 在 providers 数组里找
        if (field.startsWith('custom:')) {
          const id = field.slice('custom:'.length);
          const entry = (getConfig().webSearch?.providers || []).find((p) => String(p.id) === id);
          const k = String(entry?.apiKey || '');
          return json(res, 200, { apiKey: k, hasApiKey: Boolean(k) });
        }
        return json(res, 400, { error: `未知搜索服务：${field}` });
      }
    },
    // Q2（qq-exit Step 1）：协议端令牌明文查询端点已删除。唯一调用方是设置页
    // 协议端分区的「显示令牌」按钮，分区随进程管理页一起摘除；令牌本身属
    // QQ 载体 config 段，Q4（Step 3）随 config 摘除一起走。
    {
      method: 'POST', pattern: '/api/providers/fetch-models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          // Key 解析顺序（2026-09-20 修 401 高发）：显式明文 > 按 providerId 查该提供商
          // 保存的 Key（dshProviderKeys / providers[].apiKey）> 顶层 api.apiKey。
          // 旧实现只看顶层 Key —— 多提供商场景下顶层只存"当前选中那个"的 Key，
          // 从其它提供商拉列表就会拿错 Key，全部 401。
          let apiKey = '';
          if (body.apiKey !== undefined && String(body.apiKey ?? '').trim() && body.apiKey !== '******') {
            apiKey = String(body.apiKey).trim();
          } else {
            const pid = String(body.providerId ?? '').trim();
            const p = pid ? currentProviders().find((x) => x.id === pid) : null;
            apiKey = String(p?.apiKey ?? '').trim();
            if (!apiKey) apiKey = String(cfgNow.api.apiKey || '').trim();
            if (apiKey === '******') apiKey = '';
          }
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-one',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-chat',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const submitted = String(body.apiKey ?? '').trim();
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const baseUrl = String(body.baseUrl ?? '');
          const model = String(body.model ?? '');
          const result = await testModelChat({ baseUrl, apiKey, model });
          // 「思考方言」由内置方言表识别（原 thinking-adapters 插件收编进核心）。
          // 接在这里是为了让用户在"测试连通性"时就能看到这个模型会走哪套思考参数，
          // 而不是开了思考模式后默默不生效、只能去翻日志。
          let thinking = null;
          try {
            thinking = detectThinkingDialect({ baseUrl, model }) || null;
          } catch { /* 识别失败不影响连通性测试结论 */ }
          return json(res, 200, { ok: true, result: { ...result, thinking } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/rename',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = renameProvider(String(body.providerId ?? ''), String(body.displayName ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/set-key',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }
    },
    {
      // 删除整个提供商（含 Key 与模型目录；当前选中它时一并清空选中态）
      method: 'DELETE', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const removed = removeProvider(String(body.providerId ?? ''));
          if (!removed) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-all',
      handler: async ({ res, json }) => {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }
    },

    // ── 视觉能力 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/vision/results',
      handler: async ({ res, json }) => json(res, 200, {
        results: { ...builtinVisionResults(currentProviders()), ...visionResults() },
        scanning: visionScan.running
      })
    },
    {
      method: 'POST', pattern: '/api/vision/scan',
      handler: async ({ req, res, json }) => {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await bodyOf(req);
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({ providers: currentProviders(), emit, onlyProviderIds, timeoutMs: 25000, limit: 3 })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }
    },

    // ── 自定义搜索提供商 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/search-providers',
      handler: async ({ res, json }) => {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
          count: p.count, timeoutMs: p.timeoutMs, hasApiKey: Boolean(String(p.apiKey || '').trim())
        }));
        return json(res, 200, { providers: list });
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // apiKey 语义（与「清除密钥」按钮配套）：
            //   undefined / '******' → 不动（保持原 Key）
            //   非空字符串           → 覆盖为新 Key
            //   ''（显式空串）        → 清除
            if (body.apiKey === undefined) {
              /* 未提交：保持原值 */
            } else if (String(body.apiKey) === '******') {
              /* 掩码回传：保持原值 */
            } else {
              existing.apiKey = String(body.apiKey).trim();
            }
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type, baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, { ok: true, provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) updateConfig({ webSearch: { provider: 'bing' } });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers/test',
      handler: async ({ req, res, json }) => {
        const startedAt = Date.now();
        try {
          const body = await bodyOf(req);
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, { ok: true, result: { ok: true, count: r.results.length, sample: r.results[0]?.title || '', latencyMs: Date.now() - startedAt } });
        } catch (error) {
          return json(res, 200, { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt } });
        }
      }
    },

    // ── 连通性测试 ───────────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/test/api',
      handler: async ({ res, json }) => {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({ messages: [{ role: 'user', content: '请只回复两个字符：pong' }], tools: null, temperature: 0 });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }
    },

    // ── 配置 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/config',
      handler: async ({ res, json }) => json(res, 200, sanitizeConfig(getConfig()))
    },
    {
      // 完整系统提示词预览：按**当前**插件/技能/工具启用状态组装（没开的不出现），
      // 供设置-工具与技能页和技能页右侧预览共用。走后端而不是前端拼：组装逻辑
      // 就是运行时的 buildSystemPrompt + getToolAvailability，前端另写一份迟早漂移。
      // 注意 skillContext 与 orchestrator 同构（visionEnabled/searchEnabled/toolsCfg），
      // 否则预览和实际运行的口径会分裂。
      //
      // POST + 可选 overrides：前端自动保存有 600ms 防抖，用户刚点的开关还没落盘；
      // 调用方把"当前工具面板状态"随请求发来，这里先 deepMerge 到临时副本上组装
      // （绝不写回 currentConfig），预览就能立即反映未保存的开关。
      method: '*', pattern: '/api/prompt-preview',
      handler: async ({ req, res, json }) => {
        const cfg = getConfig();
        let overrides = {};
        try {
          if (req.method === 'POST') overrides = (await bodyOf(req)) || {};
        } catch { overrides = {}; }
        const effective = Object.keys(overrides).length
          ? deepMergeConfig(structuredClone(cfg), structuredClone(overrides))
          : cfg;
        // chatKey：动态提示词片段（skill.promptSections(context)）靠它决定"给谁看"。
        // Q15 起 plugins/ 为空，此参数只影响未来扩展；保留是因为预览端点契约不变。
        // 取值：请求里显式指定，否则空串（白名单回落已随 2026-11-22 清理删除）。
        const previewChatKey = String(overrides?.chatKey || '');
        const skillContext = {
          skills: moduleManager,
          chatKey: previewChatKey,
          kind: previewChatKey.split(':')[0] || '',
          chatId: previewChatKey.split(':')[1] || '',
          toolsCfg: effective.tools || {},
          visionEnabled: effective.api?.vision !== false
            && modelImageVerdict(effective.api?.provider, effective.api?.model) !== 'no-vision',
          searchEnabled: effective.webSearch?.enabled !== false,
          runtimeContext: { model: effective.api?.model || '', provider: effective.api?.provider || '', source: 'api' }
        };
        const { buildSystemPrompt } = await import('./prompt.js');
        const { buildToolDefs } = await import('./tools.js');
        const { getToolAvailability } = await import('./tool-registry.js');
        // 可用工具清单与 orchestrator 同一口径（tools.js 的 def → OpenAI 函数名）
        const tools = buildToolDefs()
          .filter((d) => getToolAvailability(d.id, skillContext).enabled)
          .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category }));
        return json(res, 200, {
          systemPrompt: buildSystemPrompt({ skillContext }),
          tools
        });
      }
    },

    // ── Skill 管理 ─────────────────────────────────────────────────────
    // 统一开关入口：前端只改这里，模块内部一律读 moduleManager。
    {
      method: 'GET', pattern: '/api/skills',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
        // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
        const installedIds = new Set(moduleManager.list(context).map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installedIds.has(id))
          .map((id) => {
            const c = getConfig()?.modules?.[id] || {};
            return {
              id,
              enabled: c.enabled !== false,
              hasSettings: Object.keys(c).some((k) => k !== 'enabled')
            };
          });
        return json(res, 200, {
          skills: moduleManager.list(context),
          summary: moduleManager.summary(context),
          capabilities: moduleManager.capabilities.list().sort(),
          uninstalled
        });
      }
    },
    {
      // 手动重扫磁盘：UI「刷新」按钮的后端动作。
      // 之前刷新只读内存注册表，watcher 丢事件（目录删除重建 / 网络盘 / 杀软）
      // 时新插件永远进不来。这里走 app.reloadSkills()：重扫 + 激活 + 刷工具 + 重建 watcher。
      method: 'POST', pattern: '/api/skills/reload',
      handler: async ({ res, json }) => {
        if (typeof reloadSkills !== 'function') {
          return json(res, 500, { ok: false, error: '核心未提供 reloadSkills（请升级或检查启动方式）' });
        }
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned,
            skills: moduleManager.list(context),
            summary: moduleManager.summary(context),
            capabilities: moduleManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 清理"已配置但未安装"的残留配置段：删掉 config.modules.<id>（W6-② 容器键更名）。
      // body: { ids: [id...] }，只删传入的 id，且要求该 id 当前确实不在注册表里
      //（防止把正在运行的 Skill 配置误删）。
      method: 'POST', pattern: '/api/skills/cleanup',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少 ids' });
        const installed = new Set(moduleManager.list().map((s) => s.id));
        const removable = ids.filter((id) => !installed.has(id));
        if (!removable.length) {
          return json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        }
        const modulesCfg = getConfig()?.modules || {};
        const next = { ...modulesCfg };
        for (const id of removable) delete next[id];
        // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
        updateConfig({ modules: { __replace__: next } });
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          removed: removable,
          skipped: ids.filter((id) => installed.has(id)),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 单个 Skill：切开关 / 改设置。两个动作分开处理，避免"改了设置顺手把我开着的关了"。
      method: 'POST', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await bodyOf(req);
        const context = skillRuntimeContext();
        const skill = moduleManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `Skill 不存在：${id}` });

        // 1) 开关（先写配置，再跑生命周期；顺序不能反 ——
        //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
        if (body.enabled !== undefined) {
          setSkillEnabled(id, !!body.enabled);
          if (body.enabled) moduleManager.activate(id, context);
          else moduleManager.deactivate(id, context);
        }

        // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
        if (body.settings && typeof body.settings === 'object') {
          const allowed = new Set([
            ...Object.keys(skill.manifest.settings || {}),
            ...Object.keys(skill.manifest.configSchema || {})
          ]);
          const schema = skill.manifest.configSchema || {};
          const current = getSkillConfig(id, skill.manifest.settings || {});
          const patch = {};
          // ⚠️ 与 settingsView 同一套口径（2026-09-26 审查二轮）：
          //    ① secret 标记；② 字段名命中 /key|token|secret|password|cookie/i 的
          //    字符串字段（web-fetch 的 cookie 没有 secret 标记也属密文）。
          //    收到掩码 '******' 或空串 = "不修改" —— 否则用户只是打开表单点了
          //    保存，Cookie/Key 就被覆盖成六个星号。
          const SECRET_NAME_RE = /key|token|secret|password|cookie/i;
          const isSecretField = (k) => Boolean(schema[k]?.secret)
            || (SECRET_NAME_RE.test(k) && typeof current[k] === 'string');
          for (const [k, v] of Object.entries(body.settings)) {
            if (!allowed.has(k)) continue;
            if (isSecretField(k) && (v === '******' || String(v ?? '').trim() === '')) continue;
            patch[k] = v;
          }
          if (Object.keys(patch).length) setSkillConfig(id, patch);
        }

        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          skill: moduleManager.status(id, context),
          // ⚠️ 响应里的 settings 必须用脱敏视图（settingsView）：
          //    曾经直接回 getSkillConfig（明文），保存一次设置就把
          //    apiKey / Cookie 原文发回浏览器，与 GET 列表的脱敏口径相反。
          settings: moduleManager.settingsView(id),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 开关配置总览：给设置页渲染"技能"区块
      method: 'GET', pattern: '/api/skills/capabilities',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const caps = moduleManager.capabilities.list().sort();
        return json(res, 200, {
          capabilities: caps.map((c) => ({
            name: c,
            ...moduleManager.explainCapability(c, context)
          }))
        });
      }
    },
    {
      // 工具可用性总览：明确告诉 UI "这个工具为什么没生效"
      method: 'GET', pattern: '/api/tools/availability',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const availability = availabilityOf(context);
        const defs = new Map(listTools().map((t) => [t.id, t]));
        return json(res, 200, {
          categories: CATEGORY_META,
          tools: availability.map((a) => ({
            id: a.id,
            category: defs.get(a.id)?.category || 'system',
            skillId: a.skillId,
            enabled: a.enabled,
            code: a.code,
            reason: a.reason
          }))
        });
      }
    },


    {
      method: 'POST', pattern: '/api/config',
      handler: async ({ req, res, json }) => {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        sessions?.setKeepFiles?.(next.store?.keepSessionFiles ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        emit('status', { configUpdated: true });
        // ⚠️ 必须脱敏：updateConfig 返回的是内存里的活配置对象，含明文 apiKey /
        //    accessToken / dshProviderKeys。GET /api/config 一直是脱敏的，
        //    这里漏掉会让"任何一次保存设置"把全部明文密钥回传给浏览器。
        return json(res, 200, { ok: true, config: sanitizeConfig(next) });
      }
    },
    // ── W1 快捷开关联动：Settings 打开 TTS/ASR 开关后拉起+预热本地引擎 ──────
    // 复用 engine-manager ensureForCall（探测/auto 拉起/健康探针/TTS 预热；闸内
    // 自动降级：未配置/manage=manual/gpuAllow=false 返回 reason，不抛错不卡死）。
    // 共享单例（getSharedEngineManager）与 call.js 呼叫装配同一登记表——
    // owned 进程照旧只由 app.stop() release 清理（app.js 也补了共享兜底）。
    // voice.enabled / asr.enabled / tts.enabled 任一关 → gateOf null → 零探测零拉起。
    {
      method: 'POST', pattern: '/api/voice/ensure',
      handler: async ({ res, json, log }) => {
        try {
          const { getSharedEngineManager } = await import('./voice/engine-manager.js');
          const result = await getSharedEngineManager({ log }).ensureForCall();
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    // ── W3 状态卡：语音运行态只读快照（night-plan-polish §2-W3.2）──────────
    // 两引擎 {dialect,configured,running,lastProbeMs,breakerOpen} + engine-manager
    // 自拉进程表（owned 登记表口径——外部手启引擎不在列）+ 上次合成/转写耗时 +
    // memory.embedding 开关态 + 消息语音条开关态。
    // ?probe=1 = 先做一次即时探针（engine-manager probeEngines：只探测**绝不拉起**
    // ——manage/spawn 链不在此，Settings「立即探测」按钮走它）；无参 = 读缓存快照
    // （lastProbe：本进程内 ensure/上次 probe 留下的最近结果，null=还没探测过）。
    // GET 语义纯只读：零配置写入、零进程操作；apiKey/令牌零回显（不在响应形状里）。
    {
      method: 'GET', pattern: '/api/voice/status',
      handler: async ({ res, json, log, url }) => {
        try {
          const probe = String(url.searchParams.get('probe') || '') === '1';
          const { getSharedEngineManager } = await import('./voice/engine-manager.js');
          const { dialectOf, voiceRuntimeSnapshot } = await import('./capabilities/voice.js');
          const mgr = getSharedEngineManager({ log });
          const fresh = probe ? await mgr.probeEngines() : null;
          const cached = mgr.probeState();
          const rt = voiceRuntimeSnapshot();
          const cfg = getConfig();
          const v = cfg?.voice ?? {};
          const mem = cfg?.memory ?? {};
          // 单引擎条目：configured = gateOf 同口径四合成（总闸+快捷开关+engine≠off+
          // baseUrl 非空+方言合法）；running=true/false/null（null=本进程未探测过，
          // 前端渲染灰点+"未探测"）；probe=1 时以即时探针为准并回写缓存。
          const entry = (kind) => {
            const s = v[kind] ?? {};
            const totalOn = v.enabled === true && s.enabled !== false;
            const engine = String(s.engine ?? 'off');
            const baseUrl = String(s.baseUrl ?? '').trim();
            const dialect = dialectOf(s);   // 非法显式方言 → null（fail-closed 未配置）
            const configured = totalOn && engine !== 'off' && !!baseUrl && !!dialect;
            const f = fresh ? fresh[kind] : null;
            const p = cached[kind];
            return {
              kind,
              engine,
              dialect: dialect ?? '',
              enabled: totalOn,
              configured,
              running: f ? f.ok : (p ? p.ok : null),
              lastProbeMs: f ? f.ms : (p ? p.ms : null),
              lastProbeAt: f ? f.at : (p ? p.at : null),
              breakerOpen: kind === 'tts' ? rt.ttsBreakerOpen === true : false,
              reason: f ? f.reason : (p ? (p.ok ? '' : '上次探测不可达') : '本进程未探测')
            };
          };
          return json(res, 200, {
            ok: true,
            probed: !!fresh,
            voiceEnabled: v.enabled === true,
            engines: { asr: entry('asr'), tts: entry('tts') },
            processes: mgr.listOwned().map((o) => ({
              pid: o.pid, kind: o.kind, exe: o.exe, startedAt: o.startedAt
            })),
            timings: { lastSynth: rt.lastSynth, lastTranscribe: rt.lastTranscribe },
            ttsFailStreak: rt.ttsFailStreak,
            embedding: {
              enabled: mem?.embedding?.enabled === true,
              model: String(mem?.embedding?.model ?? '')
            },
            messageVoiceBars: v.enabled === true && v.tts?.enabled !== false
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('./tool-registry.js');
        const tools = listTools().map((t) => ({
          id: t.id, name: t.name, description: t.description, category: t.category,
          icon: t.icon, defaultEnabled: t.defaultEnabled, requiresVision: t.requiresVision, requiresSearch: t.requiresSearch,
          // 来源标记：属于哪个 Skill（内置工具为 null）—— UI 据此打「skill」标识，
          // 并在所属技能失活时把工具整组隐藏（与提示词口径一致）。
          skillId: t.skillId ?? null
        }));
        return json(res, 200, { tools });
      }
    },

    // ── 版本 / 更新 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/version',
      handler: async ({ res, json }) => json(res, 200, { version: localVersion() })
    },
    {
      method: 'GET', pattern: '/api/update-check',
      handler: async ({ res, json }) => {
        const current = localVersion();
        try {
          const r = await fetch(UPDATE_INFO_URL, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const info = await r.json();
          const latest = String(info.version || '');
          if (!latest) throw new Error('version.json 缺少 version 字段');
          return json(res, 200, {
            ok: true, current, latest,
            hasUpdate: compareSemver(latest, current) > 0,
            url: String(info.url || 'https://github.com/lumirains/Xunxi'),
            notes: String(info.notes || '')
          });
        } catch (error) {
          return json(res, 200, { ok: false, current, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 模型 / 会话 / 存档 ───────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/models',
      handler: async ({ res, json }) => {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const s = sessions.get(match[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }
    },
    {
      // 主动删除一条会话记录（正在运行的不能删）
      method: 'DELETE', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const removed = sessions.remove(match[1]);
        if (!removed) return json(res, 409, { ok: false, error: '会话不存在或正在运行（运行中的会话不能删除）' });
        emit('session-end', { sessionId: match[1], status: 'deleted' });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 清空全部已结束的会话记录（保留运行中/等待中的）
      method: 'POST', pattern: '/api/sessions/clear-finished',
      handler: async ({ res, json }) => {
        const removed = sessions.clearFinished();
        emit('session-end', { status: 'cleared', removed });
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 手动重试一条失败的会话：把触发批翻回未读并立即唤醒（会话页「重试」按钮）。
      // 只有 error 状态且未发出过消息的会话允许重试（已发言的重试 = 群里看到两遍）。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/retry$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.retrySession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true, restored: r.restored });
      }
    },
    {
      // 中止一个运行中/等待中的会话（会话页「中止」按钮）。
      // 运行中的会话在下一轮 LLM 请求前安全收尾（不截断途中的请求/发送）；
      // 等待中的会话直接干净消失。不在两种状态之一（如已结束）则拒绝。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/abort$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.abortSession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'GET', pattern: '/api/chats',
      handler: async ({ res, json }) => {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        // Q9：orchestrator.getChatName（群名片缓存，协议端会话信息调用）已随群聊
        // 分支摘除——chatName 恒空串（响应形状不变：每条仍带 chatName 字段，
        // 前端对空串自退回显示 key）。Q10 chatKey 收敛 main 后本端点一并收敛。
        for (const c of chats) c.chatName = '';
        return json(res, 200, { chats });
      }
    },

    // ── web 身体（自建通道：控制台内对话，不经 QQ）────────────────────
    // Q10 chatKey 收敛：cid 缺省 'main'（存储键；store 键盲——前端 Chat.vue 仍发
    // 'web:main' 路由键，同落一份 main.json，单一时间线）。事件 conversationId 收
    // 存储键，surface='web' 由 orchestrator.submit 推导路由键 'web:main' 供出站
    // registry.route / broadcast 使用（路由键与存储键分离，见 routeKeyOf 注释）。
    {
      method: 'GET', pattern: '/api/web/messages',
      handler: async ({ res, json, url }) => {
        const cid = String(url.searchParams.get('cid') || 'main');
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
        // P2（night-plan-pwa §P2 / handoff §29-5 定案公式）：offset=跳过最近 N 条
        // 取更早一页（PWA 上翻翻页）。store.recent 原生支持（store.js recent 的
        // {offset}——start=all.length-offset 后取末尾 limit 条，返回保持时间正序），
        // 本端点此前未接线（29-4 实锚），此处 routes 层单点透传，store/orchestrator
        // 零改动。缺省 0=现行为逐字节不变（红线 #3）：不带 offset 时
        // Number(null)=NaN→||0→0，与改前 recent(cid,{limit}) 同一 store 调用形状
        //（recent 内 offset 缺省同为 0）。
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        return json(res, 200, { conversationId: cid, messages: store.recent(cid, { limit, offset }) });
      }
    },
    {
      method: 'POST', pattern: '/api/web/send',
      handler: async ({ res, json, req }) => {
        const body = await bodyOf(req);
        const cid = String(body.cid || 'main');
        const text = String(body.text ?? '').trim();
        // P3（night-plan-pwa §P3 / handoff §29-6 接线定案）：可选 attachments
        // （mediaStore 内容哈希 id）。校验：数组形态、逐项 16-hex
        //（MEDIA_ID_RE）、≤10 个（UPLOAD_MAX_FILES，与 upload 端点上限对齐），
        // 非法/超限 400 不静默剥离；映射 [{kind, id}] 装入 event.payload
        // .attachments → orchestrator submit 已就绪透传（:330 attachments 归一 +
        // :343 media 入 appendIncoming），entry.media 只存 id——媒体字节不落
        // cards/facts/staging、存档零 base64（白皮书 7.7.6 铁律 #4/#5）。
        // V0 媒体层音频化（asr-tts-v0-execution-spec §2.3）：元素形态扩为
        //   · string → { kind:'image', id }（向后兼容，行为逐字节不变——
        //     现有图片发送链路与 web-body 契约都走这条）；
        //   · { id, kind } → 原样透传，kind 只接受 'image' | 'audio'，其它值 400。
        // 缺省（body 不带 attachments）payload 仍恰 { text } = 改前逐字节不变
        //（红线 #3：新增参数缺省关闭）；纯附件（text 空 + 有附件）放行到
        // orchestrator（text 按 kind 落 '[图片]'/'[语音]' 占位。29-6 登记边界：
        // store 近重防抖对 1 秒内连续纯附件会静默去重，登记不修）。
        let mediaItems = null;
        if (body.attachments !== undefined) {
          if (!Array.isArray(body.attachments)) {
            return json(res, 400, { ok: false, error: 'attachments 须为 string[] 或 [{ id, kind }]（kind: image|audio）' });
          }
          if (body.attachments.length > UPLOAD_MAX_FILES) {
            return json(res, 400, { ok: false, error: `一次最多附带 ${UPLOAD_MAX_FILES} 个文件` });
          }
          // 归一：string → {kind:'image', id}；{id, kind} 原样（kind 白名单外 null → 400）。
          const normalized = body.attachments.map((a) => {
            if (typeof a === 'string') return { kind: 'image', id: a };
            if (a && typeof a === 'object' && !Array.isArray(a)) {
              const kind = String(a?.kind ?? '');
              if (kind === 'image' || kind === 'audio') return { kind, id: String(a?.id ?? '') };
            }
            return null;
          });
          const badKind = normalized.findIndex((it) => it === null);
          if (badKind !== -1) {
            return json(res, 400, { ok: false, error: `attachments[${badKind}] 形态不合法（须 string 或 { id, kind }，kind 只接受 image|audio）` });
          }
          const bad = normalized.find((it) => !MEDIA_ID_RE.test(it.id));
          if (bad !== undefined) {
            return json(res, 400, { ok: false, error: `attachments 含非法媒体 id（须 16 位 hex 内容哈希）：${bad.id.slice(0, 24) || '(空)'}` });
          }
          mediaItems = normalized;
        }
        if (!text && !(mediaItems && mediaItems.length)) {
          return json(res, 400, { ok: false, error: '消息内容为空' });
        }

        const event = {
          id: `web:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          surface: 'web',
          conversationId: cid,
          type: 'message',
          // P01：主人的提示词标签走配置（默认“对方”，可带 {surface} 平台后缀）。
          // web 身体如实声明 'web'；未来 pet/其它身体各自传自己的 surface。
          actor: { id: 'owner', name: ownerLabelFor('web') },
          ts: Date.now(),
          payload: { text, ...(mediaItems ? { attachments: mediaItems } : {}) },
          hints: { addressed: true, urgency: 'normal' },
          visibility: 'private'
        };
        // io（BrainIo）：本端点就是 web 身体的入站装配——emit 落点 registry 按意图的
        // conversationId（orchestrator 补齐的路由键 'web:main'）前缀路由到 web 身体；
        // 兜底（意图未带 cid）用 event.conversationId（存储键 'main'，落 DEFAULT 身体——
        // 单一时间线下仅理论可达）。
        const io = {
          capabilities: () => webAdapter.capabilities(),
          emit: (intent) => {
            const target = intent?.conversationId ?? event.conversationId;
            return registry.route(target).emit({ ...intent, conversationId: target });
          }
        };
        const result = await orchestrator.submit(event, io);
        return json(res, result.ok ? 200 : 400, result);
      }
    },

    // ── 记忆（步骤⑥ / T6.4：记忆页数据源切 person/*）────────────────
    // 供数 = 前额叶 facts（长期事实）+ cards（记忆卡，"她自己的记忆"，v3 §0 词汇表）。
    // 旧"按会话/对象存印象"的数据源与增删改/整理接口已随旧记忆系统在步骤⑦（T7.1）
    // 移除归档（_archive-20261107）；记忆页只读展示，人编辑入口待 person 版（决策⑪）。
    {
      method: 'GET', pattern: '/api/memory-files',
      handler: async ({ res, json }) => {
        const facts = personMemory.facts({ status: 'all' });
        const cards = personMemory.cards({});
        const cardTs = cards.map((c) => Date.parse(`${String(c?.date || '')}T00:00:00`) || 0);
        return json(res, 200, {
          facts,
          cards,
          counts: {
            factsActive: facts.filter((f) => (f?.status ?? 'active') === 'active').length,
            factsAll: facts.length,
            cards: cards.length
          },
          updatedAt: Math.max(0, ...facts.map((f) => Number(f?.validFrom) || 0), ...cardTs)
        });
      }
    },

    // ── 存档消息 ─────────────────────────────────────────────────────
    // Q10 chatKey 收敛：URL 接受 'main'（单一时间线的新形态）；handler 存储键一律
    // 'main'（store 键盲，legacy 形态的 URL 也指向同一份 main.json）。前端当前无调用方
    //（Chat.vue 走 /api/web/messages），保留端点只为 URL 兼容。
    {
      method: 'GET', pattern: /^\/api\/chats\/(?:(group|private|web)_(\w+)|main)\/messages$/,
      handler: async ({ res, json, url, match }) => {
        const chatKey = 'main';
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply, media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }
    },
    {
      // POST /api/media-data —— 看图链路的 dataUrl 解析（Q7 · night-plan §Q7 顺带项）。
      //   原：协议端 get_image 读缓存/图床 URL —— 前端看图链路的 QQ 依赖（Q11 全清）。
      //   现：与 Q6+Q8 媒体层同款 —— items[].id（media-store 内容哈希）→ mediaRead →
      //   dataUrl（mime 取存储时记录值）。id 不是合法内容哈希（旧 QQ file/url 条目，
      //   rkey 已过期无法迁移）→ 该项落 null（即 404 提示：图不再可得），不整批失败。
      //   新前端（Q6+Q8 起）媒体只存 id 并直接走 GET /api/media/<id>（immutable 缓存），
      //   本端点保留为兼容面；单文件 15MB 封顶由 media-store 20MB 上限自然覆盖，
      //   超限文件当年就传不进来。
      method: 'POST', pattern: '/api/media-data',
      handler: async ({ req, res, json }) => {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const results = [];
          for (const it of items) {
            const id = String(it?.id || '');
            if (!MEDIA_ID_RE.test(id)) { results.push(null); continue; }
            try {
              const { buffer, mime } = await mediaRead(id);
              results.push(buffer?.length ? { dataUrl: `data:${mime || 'application/octet-stream'};base64,${buffer.toString('base64')}` } : null);
            } catch {
              results.push(null);   // 合法 id 但文件缺失（沙箱清过/月目录移走）→ 404 提示
            }
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }
    },

    // ── 媒体层（Q6+Q8 · qq-exit-plan §3 Step 6.5）──────────────────────
    {
      // GET /api/media/:id —— 内容哈希 id 读媒体。
      //   · 路由正则放宽到 /api/media/<任意串>，格式校验放 handler：路径穿越形态
      //     （../、%2e%2e、带点带斜杠）不满足 ^[a-f0-9]{16}$ → 400，**不进 fs**。
      //   · id 是内容哈希（media-store.js）→ 字节永不变 → immutable 缓存一年。
      //   · 格式合法但文件不存在 → 404 空响应（白皮书 Step 6.5「不要抛栈」）。
      method: 'GET', pattern: /^\/api\/media\/(.+)$/,
      handler: async ({ res, match }) => {
        const id = String(match[1] ?? '');
        if (!MEDIA_ID_RE.test(id)) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('bad media id');
          return;
        }
        try {
          const { buffer, mime } = await mediaRead(id);
          res.writeHead(200, {
            'content-type': mime || 'application/octet-stream',
            'cache-control': 'public, max-age=31536000, immutable',
            'content-length': buffer.length
          });
          res.end(buffer);
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('');
        }
      }
    },
    {
      // POST /api/web/upload —— 入站媒体上传（mediaStore.put → {id,url}）。
      //   今晚只做端点：Chat.vue 的图片入口属 PWA 阶段（night-plan §Q6+Q8 登记），
      //   前端暂无调用方；端点先就位供 PWA/脚本验收。
      //   V0 媒体层音频化（asr-tts-v0-execution-spec §2.3）：白名单从纯图片扩到
      //   图片/音频（uploadKindOf：音频 mime 白名单或魔数、图片 mime 或魔数），
      //   白名单外逐项拒绝不整批失败；响应 items 增 kind（'image'|'audio'）供
      //   前端暂存区透传 send 的 {id, kind} 形态（spec §2.8），其余形状不变。
      //   请求体两形态（≤10 个文件，单个 ≤20MB = media-store 上限）：
      //     · multipart/form-data：file 部件（本模块内置轻量解析，只取带 filename 的部件）；
      //     · JSON：{ files: [{ filename?, mime?, dataBase64 }] }（或单对象简写）。
      //   返回：{ ok, count, items: [{ id, url, name, size, kind }] }；单张失败不整批
      //   失败，对应项落 { error }（超限提示由 media-store 抛错文案给出）。
      method: 'POST', pattern: '/api/web/upload',
      handler: async ({ req, res, json }) => {
        let uploads = [];
        try {
          const raw = await readRawBody(req, UPLOAD_RAW_LIMIT);
          const contentType = String(req.headers['content-type'] || '');
          if (/^multipart\/form-data/i.test(contentType)) {
            uploads = parseMultipartFiles(raw, contentType);
            if (!uploads.length) return json(res, 400, { ok: false, error: 'multipart 里没有带 filename 的文件部件' });
          } else {
            let parsed;
            try {
              parsed = JSON.parse(raw.toString('utf8') || '{}');
            } catch {
              return json(res, 400, { ok: false, error: '请求体不是合法 JSON（非 multipart 时须为 {files:[{dataBase64}]}）' });
            }
            const files = Array.isArray(parsed?.files) ? parsed.files : (parsed?.dataBase64 ? [parsed] : []);
            if (!files.length) return json(res, 400, { ok: false, error: '缺少 files（[{mime, dataBase64}]）' });
            uploads = files.map((f, i) => ({
              filename: String(f?.filename ?? `upload-${i + 1}`),
              contentType: String(f?.mime ?? ''),
              buffer: Buffer.from(String(f?.dataBase64 ?? ''), 'base64')
            }));
          }
          if (uploads.length > UPLOAD_MAX_FILES) {
            return json(res, 400, { ok: false, error: `一次最多上传 ${UPLOAD_MAX_FILES} 个文件` });
          }
        } catch (error) {
          return json(res, Number(error?.status) || 400, { ok: false, error: String(error?.message ?? error) });
        }
        const items = [];
        for (const up of uploads) {
          try {
            // V0 白名单（spec §2.3）：图片/音频放行，其余逐项拒绝（错误文案区分
            // 两类支持面）；拒绝不整批失败，与超限等既有逐项错误同一形状。
            const kind = uploadKindOf(up.buffer, up.contentType);
            if (!kind) {
              throw new Error(`不支持的文件类型（仅支持图片/音频，音频限 webm/ogg/wav/mp4/mpeg）：${up.filename || '(未命名)'}`);
            }
            const saved = await mediaPut(up.buffer, { mime: up.contentType });
            items.push({ ...saved, kind, url: `/api/media/${saved.id}` });
          } catch (error) {
            items.push({ filename: up.filename, error: String(error?.message ?? error) });
          }
        }
        return json(res, 200, {
          ok: items.every((it) => !it.error),
          count: items.filter((it) => !it.error).length,
          items
        });
      }
    },

    // ── 会话控制 ─────────────────────────────────────────────────────
    // 2026-10-31：GET /api/groups/:id/members 已删除。唯一调用方是记忆页的
    // 「拉取群成员列表（编辑备注）」按钮，私聊部署下永不渲染，按钮与弹窗已一并移除。
    // Q10 chatKey 收敛：七条 URL 正则一律接 'main' 新形态（存储键一律 'main'，store
    // 键盲——legacy 形态的 URL 也指向同一份 main.json；前端当前零调用方，纯 URL 兼容）。
    {
      method: 'POST', pattern: /^\/api\/chats\/(?:(group|private|web)_(\w+)|main)\/wake$/,
      handler: async ({ res, json }) => json(res, 410, { error: '已移除：不触发的消息现在会立即标为已读，无需手动唤醒' })
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(?:(group|private|web)_(\w+)|main)\/test-send$/,
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        // Q11：协议端直发路径随 QQ 身体归档摘除（legacy group/private_<id> 形态的
        // 白名单闸 + 直发语义一并死亡——白名单机制 Q4/Q7 已死，此为最后一处消费点，
        // §9-14-4① 路由侧闭环）；'main' 形态自 Q10 起恒 400（web 单一时间线无协议端
        // 发送目标，web 身体走 POST /api/web/send）。现全部形态统一 400。
        return json(res, 400, { error: 'QQ 身体已归档，无协议端测试发送目标；用 POST /api/web/send' });
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(?:(group|private|web)_(\w+)|main)\/mark-read$/,
      handler: async ({ res, json }) => json(res, 200, { ok: true, marked: store.drainUnread('main').length })
    },
    {
      // 清空某会话的全部消息（整体清除存档）
      method: 'POST', pattern: /^\/api\/chats\/(?:(group|private|web)_(\w+)|main)\/clear$/,
      handler: async ({ res, json }) => {
        const chatKey = 'main';
        const removed = store.clearChat(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      // 仅屏蔽（不删除）：把某会话全部未读标记为已读，不再触发回复
      method: 'POST', pattern: /^\/api\/chats\/(?:(group|private|web)_(\w+)|main)\/mute$/,
      handler: async ({ res, json }) => {
        const chatKey = 'main';
        const marked = store.markAllRead(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, marked });
      }
    },
    {
      // 部分清除：删除指定本地 id 的消息
      method: 'POST', pattern: /^\/api\/chats\/(?:(group|private|web)_(\w+)|main)\/delete-messages$/,
      handler: async ({ req, res, json }) => {
        const chatKey = 'main';
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少要删除的消息 id 列表（ids）' });
        const removed = store.removeByLocalIds(chatKey, ids);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, removed });
      }
    },
    {
      method: 'POST', pattern: '/api/pause',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) orchestrator.drainBacklogAfterResume();
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }
    },
    {
      method: 'DELETE', pattern: '/api/pause',
      handler: async ({ res, json }) => {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }
    },

    // ── 日志系统 ─────────────────────────────────────────────────────
    {
      // 最近的日志（UI 日志页签首次加载）
      method: 'GET', pattern: '/api/logs',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { logs: logger.recent(limit), level: logger.getLevel() });
      }
    },
    {
      // 调整最低落盘级别（debug/info/warn/error）
      method: 'POST', pattern: '/api/logs/level',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const level = String(body.level || 'info');
        logger.setLevel(level);
        return json(res, 200, { ok: true, level: logger.getLevel() });
      }
    },

    // ── 人格只读快照（Phase 9 / M1 · D40 只增不改）─────────────────────
    // 新 UI 状态栏（10s 轮询）与 M2 前额叶页群的数据源（phase9-plan.md §3）。
    // 全部经 person/* 前额叶 API 只读取数；任何子项缺失/损坏返回 null 而不是
    // 报错 —— 状态栏不该因一格数据挂掉。
    {
      method: 'GET', pattern: '/api/person/state',
      handler: async ({ res, json }) => {
        // 防御式取值：模块内部抛错（如状态文件损坏）→ 该子项 null，不冒泡成 500。
        const safe = (fn) => { try { return fn() ?? null; } catch { return null; } };
        // 「今日」判定：清债夜3 起与 life/prompt/executor 统一为**本地时区** dayKey
        // （评审 P3-12 时区双口径——原判定固定 UTC+8（"北京时间"尺），与 plan.dayKey
        // 生产端 executor.localDayKey 的本地口径跨时区错位；本机 UTC+8 下两者逐字节
        // 等价，行为零变化）。person/life 现为历史只读，plan 过期时 lifeToday=null。
        // localDayKey 复用 routes.js:33 已 import 的 executor 版本（单一口径，不建第二份）。
        const life = safe(() => personLife.read());   // 未写过/损坏 → null（life.read 自身已兜）
        // life-prose v2：今日 plan 走日期键（plansByDay 权威；plan 只作今天镜像）——
        // 避免昨晚写明日 plan 后 lifeToday 变 null/错日。
        const plan = safe(() => personLife.planForDay(localDayKey(Date.now())));
        const sleep = (life && typeof life === 'object') ? life.sleep : null;
        // 2026-11-21 数值清理：relationship/attitude 已整体丢弃（数值轴零消费方）；
        // lifeEnabled 供右栏区分"未开启"与"还没有安排"；botName 供 UI 用配置名指代她
        //（缺省"汐"）；avatarTs 供头像缓存击穿（自定义头像 mtime，未设置=0）。
        return json(res, 200, {
          mind: safe(() => personMind.snapshot()),
          lifeEnabled: getConfig().modules?.life?.enabled ?? true,
          botName: String(getConfig().persona?.botName ?? '').trim() || '汐',
          avatarTs: avatarCurrentTs(),
          lifeToday: plan,
          sleep: (sleep && typeof sleep === 'object')
            ? { asleep: Boolean(sleep.asleep), awakeUntil: Number(sleep.awakeUntil) || 0 }
            : null,
          now: Date.now()
        });
      }
    },
    {
      // 自定义头像读取（2026-11-21）：GET /api/avatar → data/avatar.<ext>（存在才 200，
      // 缺省 404——前端回落内置圆徽章 avatar-128.png）。ETag=mtime 供浏览器缓存协商。
      method: 'GET', pattern: '/api/avatar',
      handler: async ({ req, res, json }) => {
        const found = avatarCurrent();
        if (!found) return json(res, 404, { error: '未设置自定义头像' });
        const etag = `"${found.mtimeMs}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { ETag: etag });
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': found.mime,
          'Content-Length': found.buffer.length,
          'Cache-Control': 'no-cache',
          ETag: etag
        });
        res.end(found.buffer);
      }
    },
    {
      // 自定义头像上传（2026-11-21）：POST /api/person/avatar，multipart 单 file 部件
      // （复用 /api/web/upload 的解析工具），图片白名单（mime 或魔数），≤5MB，
      // 落 data/avatar.<ext>（先清其他扩展名变体，保证唯一真身）。
      method: 'POST', pattern: '/api/person/avatar',
      handler: async ({ req, res, json }) => {
        const body = await readRawBody(req, AVATAR_MAX_BYTES + 64 * 1024).catch((err) => {
          if (err?.expose) { json(res, err.status ?? 400, { error: String(err.message ?? err) }); return null; }
          throw err;
        });
        if (body === null) return;
        if (body.length > AVATAR_MAX_BYTES) return json(res, 413, { error: '头像过大（上限 5MB）' });
        const files = parseMultipartFiles(body, req.headers['content-type'] ?? '');
        const file = files[0];
        if (!file) return json(res, 400, { error: '没有收到文件（multipart 需要 file 部件）' });
        if (uploadKindOf(file.buffer, file.contentType) !== 'image') {
          return json(res, 415, { error: '只接受图片文件（png/jpg/webp/gif）' });
        }
        const ext = extOfAvatar(file);
        if (!ext) return json(res, 415, { error: '无法识别的图片格式' });
        avatarClearVariants(ext);
        fs.writeFileSync(path.join(DATA_DIR, `avatar.${ext}`), file.buffer);
        return json(res, 200, { ok: true, ts: avatarCurrentTs() });
      }
    },
    {
      // 自定义头像移除（恢复默认）：DELETE /api/person/avatar → 清全部变体。
      method: 'DELETE', pattern: '/api/person/avatar',
      handler: async ({ res, json }) => {
        avatarClearVariants('');
        return json(res, 200, { ok: true, ts: 0 });
      }
    },
    {
      // M2 卡片库数据源：全部记忆卡（按卡日期倒序）+ 现行长期事实。
      // cards() 天然按月文件升序、文件行序给出，这里排成最新在前供渲染。
      method: 'GET', pattern: '/api/person/cards',
      handler: async ({ res, json }) => {
        const safe = (fn, dflt) => { try { return fn() ?? dflt; } catch { return dflt; } };
        const cards = safe(() => personMemory.cards({}), []);
        cards.sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')));
        const facts = safe(() => personMemory.facts({ status: 'active' }), []);
        return json(res, 200, { cards, facts });
      }
    },

    // ── M2 前额叶页群（D43 · 只增不改）────────────────────────────────
    {
      // （15a 她的自我 / narrative 编辑端点已随 2026-11-21 self 面整体丢弃移除——
      //  narrative 运行期零写者、真实数据恒空、进提示词零字节，见 state-ownership v11。）
      // 15d 卡片库 · staging 原料分区（D43）：person/memory.staging() 各日原料。
      // V3 存储层 v2：staging 真身 = xunxi.db staging 表（原 person/staging/*.jsonl 已
      // .pre-storage-v2 归档）——「哪天有原料」走 memory.stagingDays()（DISTINCT day
      // 降序 = 文件时代的日文件名倒序；文件时代的 0 字节空日文件在 DB 下无行可依，
      // 不再列出——零信息量，见交接 drift）；条目读取复用 memory.staging(day)。
      method: 'GET', pattern: '/api/person/staging',
      handler: async ({ res, json }) => {
        let days = [];
        try {
          days = (personMemory.stagingDays() ?? []).map((day) => {
            let entries = [];
            try { entries = personMemory.staging(day) ?? []; } catch { entries = []; }
            return { day, entries };
          });
        } catch {
          days = [];   // 读不动（表异常）→ 空列表，与文件时代目录不存在同口径
        }
        return json(res, 200, { days });
      }
    },
    {
      // 15f 事件流历史（D43）：读 data/events.jsonl 尾部，倒序（最新在前）。
      // 复用 kernel/events 的 since(0, {limit})（剥 BOM + 坏行跳过 + 尾部截取），
      // 这里只做反转；limit 缺省 300、上限 1000（防一次性拖全文件进响应）。
      method: 'GET', pattern: '/api/events/recent',
      handler: async ({ url, res, json }) => {
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 300));
        let list = [];
        try { list = events.since(0, { limit }) ?? []; } catch { list = []; }
        const recent = [...list].reverse();   // since 升序 → 展示倒序
        return json(res, 200, { events: recent, limit });
      }
    },

    // ── 晚安整理按钮（night-plan-life §L1 · 2026-11-14）────────────────
    // 控制台 Sessions 页头「整理今晚记忆卡与日记」：提前关应用前手动触发当晚巩固——
    // 依次 cards runOnce（今日，mode 沿用 config.memory.writer.mode，runOnce/produceOutput
    // 内部自读，不在此传）→ diary.runDiary（force 强制写，绕行口径=按钮语义"所有者主动
    // 要求"，无晚安也可写——注释在 diary.js runDiary/writeGate，此处只传参）。
    // 鉴权：/api/* 分发层全检 authorize（app.js handleHttp，本端点不在豁免词表）。
    // 幂等口径（night-plan-life §L1）：重复点击=卡片同日替换（runOnce force 放行重跑，
    // writeCard 同日恒一张）+ 日记判重提示「今日已整理」而非报错（runDiary force 保留
    // maxPerDay 判重）。两步各自成功/失败如实返回，互不吞错。
    {
      method: 'POST', pattern: '/api/reflection/run-evening',
      handler: async ({ res, json }) => {
        const now = Date.now();
        const day = localDayKey(now);
        const tomorrow = shiftDayKey(day, 1);

        // 素材守卫：今天零消息就不重跑卡片——防止"空兜底卡把当日已有卡顶掉"
        //（runOnce force 会放行重跑，无消息日模型/兜底只能产出空卡；此时如实回跳过）。
        // 暂存笔记/事实不在此判（cards 的 buildTask 吃的是 messages+staging+facts+life，
        // 但兜底卡只从消息抽取；零消息日写卡只会是半空卡，按钮口径诚实优先）。
        let hasMaterial = false;
        let dayLastTs = 0;
        try {
          const { start, end } = dayBounds(day);
          for (const m of store.recent('main', { limit: 2000 })) {
            const ts = Number(m?.ts);
            if (ts >= start && ts < end) { hasMaterial = true; if (ts > dayLastTs) dayLastTs = ts; }
          }
        } catch { /* store 读不动时放行 runOnce 自判（它自己会产出失败/兜底，如实回报） */ }

        // ① 记忆卡：cards runOnce（今日）。失败不抛给 HTTP 500——按钮结果逐项如实。
        // 过期感知（2026-11-15 写卡追踪）：今日无卡 / 卡过期（写卡后又有对话，
        // writtenAt < 今日最后消息 ts；旧格式卡无 writtenAt 同视为需定稿——今晚是
        // 写卡追踪上线后的第一个晚安，存量白天版卡由按钮 force 定稿）→ 重跑；
        // 卡已是最新（writtenAt ≥ 今日最后消息）→ 跳过不烧 token，提示"今日已整理"。
        let card;
        if (!hasMaterial) {
          card = { ok: false, status: 'skipped', day, mode: null, reason: '今天还没有消息，暂时没有可整理的素材' };
        } else {
          const written = personMemory.cardWrittenAt(day);
          const stale = written == null || written < dayLastTs;
          if (!stale) {
            card = { ok: true, status: 'skipped', day, mode: null, reason: '今日已整理（之后没有新的对话）' };
          } else {
            try {
              const r = await reflectionRunOnce('cards', { chatKey: 'main', day, store, now, force: true });
              card = { ok: r.status !== 'failed', ...r };
            } catch (error) {
              card = { ok: false, status: 'failed', day, error: String(error?.message ?? error) };
            }
          }
        }

        // ② 私密日记：runDiary force（无晚安也可写；判重命中=「今日已整理」）。
        let diary;
        try {
          const r = await reflectionRunDiary({ store, now, source: 'evening-button', force: true });
          diary = { ok: r.wrote === true, ...r };
        } catch (error) {
          diary = { ok: false, wrote: false, error: String(error?.message ?? error) };
        }

        // ③ 明日日程（life-prose v2）：按钮=今天结束，立即备明天；不 force，
        // planExists(明天) 幂等——重复点击/30min tick 已生成时如实返回 skipped。
        let plan;
        try {
          const r = await reflectionRunOnce('life', {
            chatKey: 'main',
            day: tomorrow,
            materialDay: day,
            store,
            now
          });
          plan = { ok: r.status !== 'failed', ...r };
        } catch (error) {
          plan = { ok: false, status: 'failed', day: tomorrow, error: String(error?.message ?? error) };
        }

        return json(res, 200, { ok: true, day, planDay: tomorrow, card, diary, plan });
      }
    },

    // Q2（qq-exit Step 1）：空间只读状态端点已删除（M3 页群唯一成员，
    // 消费方 /qq 页随 QQ 载体摘除，视图原件移 legacy/frontend-views/）；
    // 空间状态数据文件本体与同名技能的处置在 Q5（Step 4）。
  ];
}
