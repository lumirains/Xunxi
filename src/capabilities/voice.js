// 语音能力层（voice-walkie V1 · ASR 接入；V2 · TTS 语音条合成；设计=内部文档 asr-tts-call-mode-design.md §10.1，
// V0 规格预留接口=内部文档 asr-tts-v0-execution-spec.md §7）。
//
// 第三/第四批准引擎调用口（architecture-v3 §8.A 登记，"先登记后调用"；llm.embed 同款纪律——
// 调用方（orchestrator.submit 皮层入站路径 / web adapter 出站 tts 闭包）动态 import 本模块，
// import 期零网络零进程）。
//
// 语义（阶段指令 + call-mode §10.1/§10.2；W1 起显式开关 voice.asr.enabled 进 config）：
//   · 总开关 config.voice.asr.enabled（实现口径 = voice.enabled && asr.enabled!==false
//     && voice.asr.engine!=='off' && voice.asr.baseUrl 非空四合成）缺省 false = 零调用；
//     关闭态连字节都不读；asr.enabled 显式 false 时同样零调用（Settings 快捷开关）；
//   · baseUrl 空 = 引擎不可用，绝不回落主聊天 provider（memory.embedding B2 同款纪律）；
//   · 失败/超时/关闭一律返回 null，**不重试**——软依赖，调用方保持 '[语音]' 占位；
//   · 超时 15s（voice.asr.timeoutMs）：ffmpeg 转码与引擎请求共用同一 deadline；
//   · 音频字节只经 media-store 读取（E1：字节不进存档），临时文件一律 os.tmpdir()
//     且 finally 兜底清理，仓库内零落盘（git-commit-push 是 add -A）；
//   · 引擎 = whisper.cpp server gpu-local：POST {baseUrl}/v1/audio/transcriptions
//     （multipart：file + language），响应 {text}。whisper 只吃 wav——非 wav 先
//     ffmpeg 转 16k mono s16 wav；wav 原样直传（S0 探针件即 16k mono 口径；
//     非 16k wav 服务端拒收 → null → '[语音]'，浏览器录音 webm/ogg 恒走转码分支）；
//   · ffmpeg 解析顺序：env XUNXI_FFMPEG（绝对路径；旧名 QQ_AGENT_FFMPEG 兼容 fallback）> PATH 探测（image-compress.js
//     ensureFf 同款）。本夜间会话 PATH 无 ffmpeg（handoff §4-d），验收经 env 提供；
//   · 转写文本 trim 后原样注入（whisper 中文输出无标点=已知缺陷，所有者拍板不补
//     标点）；trim 后为空视为失败（=null，如纯静音/正弦波）；
//   · V3 通话上行（night-plan §2-T5）：transcribeWav(wavBytes) = 第三口的**字节直传
//     形态**（对齐第四口 synthesizeRaw 的流形态先例，非第五批准口）——通话层已把
//     PCM16/16k 帧攒成 wav（内存 Buffer），再过 media-store 读取就是绕路且违反
//     keepAudio=false（E1：通话音频不落 media-store 不落盘），故字节直 POST 引擎。
//     asr.available() = asrGate 同源探测（通话层区分"识别未开启"与"转写失败"）。
//   · W2 方言派发（night-plan-polish §2-W2 / 内部文档 voice-provider-plan.md）：第三/四
//     口内按 voice.{asr,tts}.dialect 选协议方言——'gpu-local'（缺省，现行为逐字节
//     不变）/ 'deepseek-tools'（/v1/tools/asr · /v1/tools/tts PCM 流）/ 'openai-compat'
//     （标准面）。**方言是实现细节，不新增批准口数**（白皮书 §0 对齐）；TTS_FROZEN
//     仅约束 gpu-local；apiKey 只进请求头零日志（plan §8）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConfig } from '../config.js';
import { read as mediaRead, put as mediaPut } from '../media-store.js';
import { detectAudioType } from '../image-type.js';

// ── W2 协议方言（内部文档 voice-provider-plan.md §1-§5）──────────────────────────
// 同一批准口（第三口 ASR / 第四口 TTS）内的协议选择器：'gpu-local'（现行为逐字节
// 不变的缺省值）| 'deepseek-tools'（官方 tools 协议）| 'openai-compat'（OpenAI Audio
// API 标准面）。显式 dialect 键非法 → fail-closed（闸 null 零调用），绝不瞎猜端点。
const DIALECTS = ['gpu-local', 'deepseek-tools', 'openai-compat'];

/** Bearer 鉴权头（apiKey 空 = 不带头——本地引擎从不鉴权；密钥任何路径不进日志）。 */
function authHeaders(apiKey) {
  const h = {};
  const k = String(apiKey ?? '').trim();
  if (k) h.authorization = `Bearer ${k}`;
  return h;
}

/**
 * 方言判定（单一事实源；engine-manager gateOf / call.js 下行双模同源口径）：
 * 显式 dialect 键优先（不在支持集 → null fail-closed）；缺省从 engine 键名派生
 * （engine 直接填方言名的配置形态，如 engine:'deepseek-tools'）；engine 非方言名
 * → 'gpu-local'（历史部署/缺省=现行为）。DEFAULT_CONFIG 不含 dialect 键（deepMerge
 * 会把缺省值变成"显式键"压掉 engine 名派生），故派生在运行时做。
 */
export function dialectOf(section) {
  const raw = String(section?.dialect ?? '').trim().toLowerCase();
  if (raw) return DIALECTS.includes(raw) ? raw : null;
  const eng = String(section?.engine ?? '').trim().toLowerCase();
  if (DIALECTS.includes(eng)) return eng;
  return 'gpu-local';
}

/** 上传白名单 mime（routes.js AUDIO_UPLOAD_MIME_RE 同源集合）→ ffmpeg 输入扩展名兜底
 *  （detectAudioType 认得出的容器优先用它的 ext；mp3 无魔数判据，走 mime 表）。 */
const MIME_EXT = {
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/mpeg': '.mp3'
};

/**
 * ASR 总开关（合成口径，见文件头）。可用返回 { baseUrl, timeoutMs, language, dialect,
 * apiKey, model }；不可用返回 null。缺省配置（enabled=false / engine='off' / baseUrl=''
 * / 方言非法）恒 null = 零调用。dialect 缺省 'gpu-local' = 现行为逐字节不变。
 */
function asrGate() {
  const cfg = getConfig();
  const v = cfg?.voice;
  const a = v?.asr;
  if (!v?.enabled || !a) return null;
  if (a.enabled === false) return null;   // W1 快捷开关：显式关=零调用（缺省 true 兼容现役）
  if (String(a.engine ?? 'off') === 'off') return null;
  const baseUrl = String(a.baseUrl ?? '').trim();
  if (!baseUrl) return null;   // B2：baseUrl 空 = 引擎不可用，绝不回落主聊天 provider
  const dialect = dialectOf(a);
  if (!dialect) return null;   // W2 fail-closed：显式方言键非法 → 零调用
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    timeoutMs: Number(a.timeoutMs) > 0 ? Number(a.timeoutMs) : 15000,
    language: String(a.language ?? 'zh').trim() || 'zh',
    dialect,
    apiKey: String(a.apiKey ?? ''),   // 安全纪律（plan §8）：只进请求头，零日志
    model: String(a.model ?? '').trim()   // gpu-local 仅登记；openai-compat 随请求发送
  };
}

// ── ffmpeg 探测（image-compress.js ensureFf 同款；env 显式路径优先）────────
let _ffmpeg = null;
let _ffmpegChecked = false;

function probe(cmd) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(false);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, 5000);
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

async function resolveFfmpeg() {
  if (_ffmpegChecked) return _ffmpeg;
  _ffmpegChecked = true;
  // 显式 env（夜间会话/便携部署：PATH 可能没有 ffmpeg——handoff §4-d）
  const envPath = String(process.env.XUNXI_FFMPEG ?? process.env.QQ_AGENT_FFMPEG ?? '').trim();
  if (envPath && fs.existsSync(envPath)) {
    _ffmpeg = envPath;
    return _ffmpeg;
  }
  for (const name of ['ffmpeg', 'ffmpeg.exe']) {
    if (await probe(name)) { _ffmpeg = name; break; }
  }
  return _ffmpeg;
}

/** ffmpeg 转 16k mono s16 wav。inputBytes → wav Buffer 或 null（失败/超时）。 */
async function toWav16kMono(ffmpeg, inputBytes, inputExt, deadline) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-asr-'));
  try {
    const inPath = path.join(dir, `in${inputExt || '.bin'}`);
    const outPath = path.join(dir, 'out.wav');
    fs.writeFileSync(inPath, inputBytes);
    const remain = Math.max(1000, deadline - Date.now());
    const ok = await new Promise((resolve) => {
      let done = false;
      const finish = (val) => { if (!done) { done = true; resolve(val); } };
      let child;
      try {
        child = spawn(ffmpeg, ['-y', '-i', inPath, '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le', '-f', 'wav', outPath],
          { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      } catch {
        return finish(false);
      }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, remain);
      child.on('error', () => { clearTimeout(timer); finish(false); });
      child.on('close', (code) => { clearTimeout(timer); finish(code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0); });
    });
    if (!ok) return null;
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ }
  }
}

/**
 * ASR 引擎请求主体（transcribe / transcribeWav 共用；按 asr.dialect 派发端点与参数，
 * plan §2）。失败返回 null，网络异常抛错由调用方 try/catch 收口（批准口纪律：失败
 * null 不重试）。
 *   · gpu-local：POST {baseUrl}/v1/audio/transcriptions，multipart file+language（现行为）；
 *   · deepseek-tools：POST {baseUrl}/v1/tools/asr，multipart 仅 file 字段（协议无
 *     language），Bearer 鉴权；协议限制 WAV|OggOpus ≤120s ≤8MiB —— 超限直接失败
 *     （null+warn），不静默截断；
 *   · openai-compat：POST {baseUrl}/v1/audio/transcriptions 标准面 file+language+model
 *     （model 取 voice.asr.model，空则不带字段），Bearer（apiKey 空不带头）。
 */
async function asrPostWav(wavBytes, lang, asr, deadline) {
  const form = new FormData();
  let url = `${asr.baseUrl}/v1/audio/transcriptions`;
  if (asr.dialect === 'deepseek-tools') {
    // 协议限制（参考实现 speech.ts:16）：≤120s ≤8MiB。16k mono s16 = 32000 B/s。
    const dataLen = Math.max(0, wavBytes.length - 44);
    if (wavBytes.length > 8 * 1024 * 1024) {
      console.warn(`[voice] ASR deepseek-tools 音频超 8MiB 上限（${wavBytes.length}B）——按失败处理`);
      return null;
    }
    if ((dataLen / 32000) * 1000 > 120000) {
      console.warn(`[voice] ASR deepseek-tools 音频超 120s 上限（${Math.round((dataLen / 32000) * 1000)}ms）——按失败处理`);
      return null;
    }
    form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'recording.wav');
    url = `${asr.baseUrl}/v1/tools/asr`;
  } else {
    form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'audio.wav');
    form.append('language', lang);
    if (asr.dialect === 'openai-compat' && asr.model) form.append('model', asr.model);
  }
  const remain = Math.max(1000, deadline - Date.now());
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(asr.apiKey),   // FormData 的 content-type 由 fetch 自带 boundary
    body: form,
    signal: AbortSignal.timeout(remain)
  });
  if (!res.ok) {
    console.warn(`[voice] ASR HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
    return null;
  }
  const data = await res.json().catch(() => null);
  const text = String(data?.text ?? '').trim();
  if (!text) {
    console.warn('[voice] ASR 转写为空（静音/无语音）——按失败处理');
    return null;
  }
  return { text };   // 原样注入（不补标点——所有者拍板）；不重试
}

/**
 * ASR 转写一段已入库的音频媒体（voice.asr.transcribe，spec §7 预留接口）。
 * 关闭/未配置/超时/失败一律返回 null（调用方保持 '[语音]' 占位），绝不抛错打断主链路。
 * @param {string} mediaId media-store 内容哈希 id（16 位 hex）
 * @param {{ lang?: string }} [opts] 语言覆盖（缺省 config.voice.asr.language，再缺省 'zh'）
 * @returns {Promise<{ text: string } | null>}
 */
export async function transcribe(mediaId, opts = {}) {
  const asr = asrGate();
  if (!asr) return null;   // 关闭态：零字节读取零网络零进程（不记埋点——无尝试无耗时）
  const t0 = Date.now();   // W3 埋点壳：真实尝试（读媒体/转码/引擎请求全过程）耗时
  const out = await transcribeAttempt(mediaId, asr, opts);
  recordTranscribe(Date.now() - t0, out !== null);
  return out;
}

/** transcribe 本体（gate 由壳传入；成败耗时由壳记账）。 */
async function transcribeAttempt(mediaId, asr, opts = {}) {
  const deadline = Date.now() + asr.timeoutMs;
  try {
    // E1：字节只经 media-store（id 前缀定位）；id 非法/媒体不存在 → 抛错 → null。
    const { buffer, mime } = await mediaRead(mediaId);
    const sniffed = detectAudioType(buffer);
    const isWav = sniffed?.mime === 'audio/wav';
    let wavBytes = buffer;
    if (!isWav) {
      const ffmpeg = await resolveFfmpeg();
      if (!ffmpeg) {
        console.warn('[voice] ASR 音频非 wav 且找不到 ffmpeg（env XUNXI_FFMPEG 或 PATH）——跳过转写');
        return null;
      }
      const inputExt = sniffed?.ext || MIME_EXT[String(mime ?? '').toLowerCase()] || '.bin';
      wavBytes = await toWav16kMono(ffmpeg, buffer, inputExt, deadline);
      if (!wavBytes) {
        console.warn('[voice] ASR ffmpeg 转码失败/超时——跳过转写');
        return null;
      }
    }
    const lang = String(opts?.lang ?? '').trim() || asr.language;
    return await asrPostWav(wavBytes, lang, asr, deadline);
  } catch (err) {
    // 不重试（批准口纪律：失败 null——软依赖，'[语音]' 占位是常态路径）
    console.warn('[voice] ASR 失败：', err?.message ?? err);
    return null;
  }
}

/**
 * ASR 转写一段内存 wav/音频字节（voice.asr.transcribeWav，V3 通话上行流形态，
 * night-plan §2-T5）：通话层（src/voice/call.js）把 PCM16/16k/40ms 帧攒成整段 wav
 * 后直传本口——字节全程内存（E1：通话音频不落 media-store 不落盘，keepAudio=false），
 * 15s 超时同 asr.timeoutMs。RIFF 魔数在 → 原样直 POST（16k mono s16 由通话层保证）；
 * 非 wav 字节 → ffmpeg 转 16k mono（与 transcribe 同款分支，防御性兼容）。
 * 关闭/未配置/超时/失败一律返回 null，绝不抛错。
 * @param {Buffer|Uint8Array} wavBytes wav（或任意可转码音频）字节
 * @param {{ lang?: string }} [opts] 语言覆盖（缺省 config.voice.asr.language，再缺省 'zh'）
 * @returns {Promise<{ text: string } | null>}
 */
export async function transcribeWav(wavBytes, opts = {}) {
  const asr = asrGate();
  if (!asr) return null;   // 关闭态：零字节零网络零进程（不记埋点）
  const t0 = Date.now();   // W3 埋点壳
  const out = await transcribeWavAttempt(wavBytes, asr, opts);
  recordTranscribe(Date.now() - t0, out !== null);
  return out;
}

/** transcribeWav 本体（gate 由壳传入；成败耗时由壳记账）。 */
async function transcribeWavAttempt(wavBytes, asr, opts = {}) {
  const deadline = Date.now() + asr.timeoutMs;
  try {
    let wav = Buffer.isBuffer(wavBytes) ? wavBytes : Buffer.from(wavBytes ?? []);
    if (!wav.length) return null;
    const isWav = wav.length > 44 && wav.toString('ascii', 0, 4) === 'RIFF';
    if (!isWav) {
      const ffmpeg = await resolveFfmpeg();
      if (!ffmpeg) {
        console.warn('[voice] ASR 字节非 wav 且找不到 ffmpeg（env XUNXI_FFMPEG 或 PATH）——跳过转写');
        return null;
      }
      wav = await toWav16kMono(ffmpeg, wav, '.bin', deadline);
      if (!wav) {
        console.warn('[voice] ASR ffmpeg 转码失败/超时——跳过转写');
        return null;
      }
    }
    const lang = String(opts?.lang ?? '').trim() || asr.language;
    return await asrPostWav(wav, lang, asr, deadline);
  } catch (err) {
    console.warn('[voice] ASR（字节直传）失败：', err?.message ?? err);
    return null;
  }
}

/**
 * ASR 可用性探测（voice.asr.available，asrGate 同源布尔面）：通话层用它区分
 * "识别未开启"（引导文字输入，不白等 15s）与"转写失败"（没听清，可重试）。
 */
export function asrAvailable() {
  return asrGate() !== null;
}

// ═══════════════════════════════════════════════════════════════════════════
// V2 · TTS 语音条（第四批准口；handoff-voice-walkie §4-a 试听定稿，所有者
// 2026-11-17 听感冻结——**照抄不调优**；引擎=GPT-SoVITS api_v2 gpu-local）。
//
// 语义（architecture-v3 §8.A 第四批准口登记 + 阶段指令；W1 起显式开关 voice.tts.enabled 进 config）：
//   · 总开关 config.voice.tts.enabled（实现口径 = voice.enabled && tts.enabled!==false
//     && tts.engine!=='off' && tts.baseUrl 非空四合成，asrGate 同款；缺省 false = 零调用；
//     tts.enabled 显式 false 时同样零调用——Settings 快捷开关，通话中改关=下一句起纯文字）；
//   · baseUrl 空 = 引擎不可用，绝不回落主聊天 provider（B2 同款）；
//   · 失败/超时/关闭一律返回 null，**不重试**——调用方（web sender）该段纯文字继续，
//     不抛不整段失败；
//   · 单句超时 5s（voice.tts.timeoutMs）；**首调 warmup ≈5.9s 属预期**（S0 探针实测
//     7.45s 含首次 CUDA 编译）——首句可能按超时失败落纯文字，第二句起正常合成；
//   · **连续 3 次失败熔断至进程重启**：模块级计数（本进程存活期不再尝试——引擎
//     未起/死端口场景不至每条消息都白等一次超时）；
//   · **合成产物默认转 Opus 后落档**（2026-11-18 听感定稿，design §5.5：24kbps /
//     voip / ogg；一条 6.3s 语音 391KB→18KB）。voice.tts.format='wav' 可退回裸
//     wav；转码失败（ffmpeg 缺失/超时/输出非 Ogg）自动回落 wav —— 不记失败、
//     不动熔断计数，出声优先；
//   · 合成 wav 字节只进 media-store（E1：字节不进存档），返回内容哈希 id
//     ——**落档形态**（消息语音条）。通话流形态 synthesizeRaw（V2 主体，2026-11-18 起）：
//     字节不落档不落盘（内存 Buffer → WS 下行），voice.call.keepAudio 缺省 false
//     （call-mode §2.2）；熔断计数两形态**同源共用**（spec §2.3），通话层另有自己的
//     "连续 2 句失败 → 降级纯文字"判定（call.js），两层并存不打架；
//   · 权重加载：请求不带权重参数——v2ProPlus 由服务端 tts_infer.yaml custom 段
//     启动时加载（S0 handoff §4-c 实读：custom 段优先，default 配置即已训音色）。
//   · config.voice.tts.refVoice 仅登记不消费（asr.model 同款口径）：合成参数是
//     听感冻结的整组常量，单独换参考音频而不同步 prompt_text 会出错位配对。

/** GPT-SoVITS api_v2 /tts 请求参数（S0 handoff §4-a 试听定稿逐项照抄；prompt_text
 *  必须与参考音频内容一致，不可改写——voice.list 实查原文）。 */
// T7 起导出（engine-manager.js TTS 预热复用同一冻结组——单一事实源，防两处漂移）；
// 参数本体一字不动（night-plan §0"冻结组一字不动"）。
export const TTS_FROZEN = {
  ref_audio_path: 'D:\\Projects\\Datasets\\XunxiVoice\\voice\\warma-4.wav',
  prompt_text: '不过因为时隔半年，每半年的变化都有点大，所以每次的风格可能都不太一样。而这一期呢。',
  text_lang: 'zh',
  prompt_lang: 'zh',
  text_split_method: 'cut3',   // 按标点切+长度合并（评测单位=段落，试听记录 §三教训）
  speed_factor: 1.0,           // 禁止调整（0.92/0.88 两档实测被所有者否决）
  seed: 42,                    // 固定，便于 A/B
  top_k: 15,
  top_p: 1.0,
  temperature: 1.0,
  batch_size: 1,
  media_type: 'wav',
  streaming_mode: false
};

/**
 * TTS 总开关（合成口径，见上）。可用返回 { baseUrl, timeoutMs, dialect, apiKey,
 * voiceId, filterMarkdown, model, sampleRate }；不可用返回 null。
 * 缺省配置（engine='off' / baseUrl='' / 方言非法）恒 null = 零调用。
 * dialect 缺省 'gpu-local' = 现行为逐字节不变（真实 config.json 无此键）。
 */
function ttsGate() {
  const cfg = getConfig();
  const v = cfg?.voice;
  const t = v?.tts;
  if (!v?.enabled || !t) return null;
  if (t.enabled === false) return null;   // W1 快捷开关：显式关=零调用（缺省 true 兼容现役）
  if (String(t.engine ?? 'off') === 'off') return null;
  const baseUrl = String(t.baseUrl ?? '').trim();
  if (!baseUrl) return null;   // B2：baseUrl 空 = 引擎不可用，绝不回落主聊天 provider
  const dialect = dialectOf(t);
  if (!dialect) return null;   // W2 fail-closed：显式方言键非法 → 零调用
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    timeoutMs: Number(t.timeoutMs) > 0 ? Number(t.timeoutMs) : 5000,
    dialect,
    apiKey: String(t.apiKey ?? ''),           // 安全纪律（plan §8）：只进请求头，零日志
    voiceId: String(t.voiceId ?? '').trim() || 'stella',   // deepseek 'stella'|'tide' / openai voice 名
    filterMarkdown: t.filterMarkdown !== false,             // deepseek 协议参数，缺省 true
    model: String(t.model ?? '').trim(),                    // openai-compat speech 模型（空=不带 model 字段）
    sampleRate: Number(t.sampleRate) > 0 ? Number(t.sampleRate) : 24000   // PCM 档位采样率
  };
}

// ── 连续失败熔断（进程级，模块单例自然进程单例；重启即清零）──────────────
const TTS_BREAKER_THRESHOLD = 3;
let ttsFailStreak = 0;
let ttsBreakerOpen = false;

// ── W3 状态卡埋点（GET /api/voice/status 只读快照消费；纯观测零行为影响）──
// 上次一次**真实尝试**（闸门通过后的引擎请求）的耗时与成败：null=本进程还没试过。
// 关闭态/熔断态的零调用不记（没有耗时语义）；成功与失败都记（失败耗时同样有诊断价值）。
let lastSynth = null;       // TTS 合成（消息条 ttsCall / 流形态 ttsEngineCall / 下行 synthesizeRaw 任一）
let lastTranscribe = null;  // ASR 转写（mediaId transcribe / 字节直传 transcribeWav 任一）
function recordSynth(ms, ok) {
  lastSynth = { ms: Math.max(0, Math.round(ms)), ok: ok === true, at: Date.now() };
}
function recordTranscribe(ms, ok) {
  lastTranscribe = { ms: Math.max(0, Math.round(ms)), ok: ok === true, at: Date.now() };
}

// ── 下行编码档位（design §5.5 · 2026-11-18 所有者听感定稿）──────────────────
// 默认 Opus 24kbps / voip / ogg：与无损 A/B 无差别，体积 21×（6.3s：391KB→18KB）。
// 只改容器与码率——TTS_FROZEN 的合成参数（speed/seed/cut3/参考音频）一字不动。
// 16k 是带宽极端受限时的备选（听感亦无差别），12k 只作"老电话"音效备案，默认不用。
// W2：码率配置化（voice.tts.bitrateKbps，缺省 24=听感定稿值不变）。
const TTS_OPUS = { application: 'voip', timeoutMs: 5000 };

/** Opus 落档码率（voice.tts.bitrateKbps，缺省 24；非法值回落听感定稿值）。 */
function opusBitrateKbps() {
  const n = Number(getConfig()?.voice?.tts?.bitrateKbps);
  return n > 0 ? Math.round(n) : 24;
}

/** 落档编码：voice.tts.format='wav' 退回裸 wav，其余（缺省）一律 opus/ogg。
 *  W2 注：'pcm' 配置值在落档面按 'ogg' 处理（裸 PCM 无容器不可落档）。 */
function ttsEncoding() {
  const fmt = String(getConfig()?.voice?.tts?.format ?? 'ogg').trim().toLowerCase();
  return fmt === 'wav' ? 'wav' : 'ogg';
}

/**
 * wav 字节 → ogg/opus 字节；失败（ffmpeg 缺失/超时/输出异常）返回 null。
 * 临时文件一律 os.tmpdir()，finally 兜底清理（E1 纪律同 ASR 转码分支）。
 */
async function toOpus(wavBytes) {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    console.warn('[voice] TTS 转码需要 ffmpeg（env XUNXI_FFMPEG 或 PATH）——本次回落 wav');
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xunxi-tts-'));
  try {
    const inPath = path.join(dir, 'in.wav');
    const outPath = path.join(dir, 'out.ogg');
    fs.writeFileSync(inPath, wavBytes);
    const ok = await new Promise((resolve) => {
      let done = false;
      const finish = (val) => { if (!done) { done = true; resolve(val); } };
      let child;
      try {
        child = spawn(ffmpeg, [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', inPath,
          '-c:a', 'libopus', '-b:a', `${opusBitrateKbps()}k`,
          '-application', TTS_OPUS.application,
          '-f', 'ogg', outPath
        ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
      } catch {
        return finish(false);
      }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(false); }, TTS_OPUS.timeoutMs);
      child.on('error', () => { clearTimeout(timer); finish(false); });
      child.on('close', (code) => { clearTimeout(timer); finish(code === 0 && fs.existsSync(outPath)); });
    });
    if (!ok) return null;
    const out = fs.readFileSync(outPath);
    if (out.length < 4 || out.toString('ascii', 0, 4) !== 'OggS') return null;   // 容器魔数兜底
    return out;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不掩盖主结果 */ }
  }
}

/**
 * 落档/下行前编码：默认 Opus/ogg，失败回落 wav（出声优先，转码失败不计入熔断）。
 * @param {Buffer} wavBytes 引擎出料 wav（32k/16-bit/mono）
 * @param {''|'ogg'|'wav'} [format] 显式档位（synthesizeRaw 按通话信令换档用）；
 *        缺省（''）读 config.voice.tts.format——消息路径行为逐字节不变。
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
async function encodeForStore(wavBytes, format = '') {
  const fmt = format || ttsEncoding();
  if (fmt === 'wav') return { bytes: wavBytes, mime: 'audio/wav' };
  const ogg = await toOpus(wavBytes);
  if (ogg) return { bytes: ogg, mime: 'audio/ogg' };
  console.warn('[voice] TTS Opus 转码失败——本次回落 wav（不记失败）');
  return { bytes: wavBytes, mime: 'audio/wav' };
}

// ── W2 · PCM 工具件（deepseek-tools 方言产物 24kHz mono 16-bit LE）────────────
/** 裸 PCM16 → wav 容器封装（内存 44B 头；奇数字节截齐）。call.js pcmToWav16k 的
 *  参数化同款（rate 不固定 16k）。 */
function pcmToWav(pcm, sampleRate) {
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 24000;
  const dataLen = pcm.length - (pcm.length % 2);
  const out = Buffer.alloc(44 + dataLen);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataLen, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);       // fmt 块长
  out.writeUInt16LE(1, 20);        // PCM
  out.writeUInt16LE(1, 22);        // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);        // block align
  out.writeUInt16LE(16, 34);       // bits
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataLen, 40);
  if (dataLen > 0) Buffer.from(pcm.buffer, pcm.byteOffset, dataLen).copy(out, 44);
  return out;
}

/** ReadableStream 读全（Node fetch body）；错误向上抛（调用方按引擎失败计）。 */
async function readStreamAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      chunks.push(Buffer.from(value));
      total += value.length;
    }
  }
  return Buffer.concat(chunks, total);
}

/** openai-compat response_format 档位映射（plan §3）：ogg→opus（ogg 容器）、wav→wav。
 *  'pcm' 在落档/整段下行面不取（裸 PCM 无容器不可落档；通话下行 ogg 体积 20× 优）——
 *  上层已把 'pcm' 归一为 'ogg'。 */
function openaiResponseFormat(fmt) {
  return fmt === 'wav' ? 'wav' : 'opus';
}

/**
 * TTS 方言请求（纯请求体，不含闸/熔断——由两个包装层共用）：
 *   · gpu-local：POST {baseUrl}/tts {text, ...TTS_FROZEN} → wav 字节（RIFF 校验，现行为）；
 *   · deepseek-tools：POST {baseUrl}/v1/tools/tts {text, voice_id, format:'pcm',
 *     filter_markdown} Bearer → 24kHz mono 16-bit LE 裸 PCM 流（首帧即 200，读流
 *     不受单句超时约束——流一旦建立由消费方的整轮预算约束，plan §4）；
 *   · openai-compat：POST {baseUrl}/v1/audio/speech {model?, voice, input,
 *     response_format} Bearer → 音频字节（content-type 随档）。
 * 产物（引擎原样，未编码）：{ bytes, mime } | { stream, sampleRate }。
 * 任一失败抛错（包装层按引擎失败进熔断计数）。
 */
async function ttsEngineRequest(body, tts, fmt) {
  if (tts.dialect === 'deepseek-tools') {
    const res = await fetch(`${tts.baseUrl}/v1/tools/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(tts.apiKey) },
      body: JSON.stringify({
        text: body,
        voice_id: tts.voiceId,
        format: 'pcm',                 // 协议固定（参考实现 speech.ts:58）
        filter_markdown: tts.filterMarkdown
      }),
      signal: AbortSignal.timeout(tts.timeoutMs)   // 首字节超时
    });
    if (!res.ok) {
      console.warn(`[voice] TTS HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.body) throw new Error('deepseek-tools 响应无流（协议要求 PCM 流）');
    return { stream: res.body, sampleRate: tts.sampleRate };
  }
  if (tts.dialect === 'openai-compat') {
    const payload = { voice: tts.voiceId, input: body, response_format: openaiResponseFormat(fmt) };
    if (tts.model) payload.model = tts.model;   // 空=不带字段（部分兼容服务不认）
    const res = await fetch(`${tts.baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(tts.apiKey) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(tts.timeoutMs)
    });
    if (!res.ok) {
      console.warn(`[voice] TTS HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
      throw new Error(`HTTP ${res.status}`);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length) throw new Error('openai-compat 响应体为空');
    const mime = String(res.headers.get('content-type') ?? '').split(';')[0].trim()
      || (fmt === 'wav' ? 'audio/wav' : 'audio/ogg');
    return { bytes, mime };
  }
  // gpu-local（现行为逐字节不变：端点/参数/RIFF 校验）
  const res = await fetch(`${tts.baseUrl}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: body, ...TTS_FROZEN }),
    signal: AbortSignal.timeout(tts.timeoutMs)
  });
  if (!res.ok) {
    console.warn(`[voice] TTS HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 200)}`);
    throw new Error(`HTTP ${res.status}`);
  }
  const wav = Buffer.from(await res.arrayBuffer());
  if (!wav.length || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    // GPT-SoVITS 出错时可能 200 + JSON 体——RIFF 魔数兜底（media_type=wav 恒 RIFF）
    throw new Error('响应不是 wav 字节（RIFF 魔数不符）');
  }
  return { bytes: wav, mime: 'audio/wav' };
}

/** 引擎失败记账（熔断计数 + 日志；密钥零回显）。 */
function ttsFailRecord(err) {
  ttsFailStreak += 1;
  if (ttsFailStreak >= TTS_BREAKER_THRESHOLD && !ttsBreakerOpen) {
    ttsBreakerOpen = true;
    console.warn(`[voice] TTS 连续 ${ttsFailStreak} 次失败，熔断至进程重启（本次原因：${err?.message ?? err}）`);
  } else {
    console.warn('[voice] TTS 失败：', err?.message ?? err);
  }
}

/**
 * TTS 方言调用（闸 → 熔断 → 请求 → 成功清零熔断），返回**引擎产物**（未编码）：
 * gpu-local/openai → {bytes, mime}；deepseek → {stream, sampleRate}（synthesizeRaw
 * 的 PCM 流形态直接透传此产物）。关闭/未配置/超时/失败/熔断一律返回 null。
 */
async function ttsEngineCall(text, fmt = 'ogg') {
  const tts = ttsGate();
  if (!tts) return null;   // 关闭态：零网络零字节
  if (ttsBreakerOpen) return null;   // 熔断态：至进程重启不再尝试（"连续 3 次失败"口径）
  const body = String(text ?? '').trim();
  if (!body) return null;   // 调用方 bug（调用方已滤空）——不算引擎失败，不进熔断计数
  const t0 = Date.now();   // W3 埋点：真实尝试（含读流/编码全过程）耗时
  try {
    const product = await ttsEngineRequest(body, tts, fmt);
    ttsFailStreak = 0;
    ttsBreakerOpen = false;
    recordSynth(Date.now() - t0, true);
    return product;
  } catch (err) {
    ttsFailRecord(err);
    recordSynth(Date.now() - t0, false);
    return null;   // 不重试（批准口纪律：失败 null——该段纯文字是常态回退）
  }
}

/**
 * 引擎产物 → {bytes, mime}（落档/整段下行档位，plan §5；按方言分派——**gpu-local
 * 引擎 wav 必须走 encodeForStore**（ogg 档位是 §5.5 听感定稿，不透传裸 wav））：
 *   · PCM 流（deepseek）：读全（失败抛错=引擎失败，进调用方熔断计数）→ pcmToWav
 *     （24k mono s16）→ encodeForStore（ffmpeg 由 24k wav 直接转 Opus——容器自带
 *     采样率，无需重采样；ffmpeg 缺失/失败回落 wav 现语义）；
 *   · gpu-local 字节（引擎 wav）→ encodeForStore（现行为链）；
 *   · openai 字节：已是请求档（opus→ogg / wav）→ 原样透传（mime 缺失兜底按请求档推）。
 */
async function productToStoreBytes(product, fmt, dialect) {
  if (product?.stream) {
    const pcm = await readStreamAll(product.stream);
    if (pcm.length < 2) throw new Error('PCM 流为空（0 样本）');
    return encodeForStore(pcmToWav(pcm, product.sampleRate), fmt);
  }
  const bytes = product?.bytes;
  if (!bytes || !bytes.length) throw new Error('TTS 产物字节为空');
  if (dialect === 'gpu-local') return encodeForStore(bytes, fmt);
  const mime = String(product?.mime ?? '');
  if (mime.startsWith('audio/')) return { bytes, mime };
  return { bytes, mime: fmt === 'wav' ? 'audio/wav' : 'audio/ogg' };
}

/**
 * TTS 主体（gate → 熔断 → 方言请求 → 编码到落档/整段档位 → 成功清零熔断）。
 * 落档形态（synthesize）与整段流形态（synthesizeRaw 的 gpu-local/openai 支）共用；
 * **不落档**——mediaPut 在 synthesize 包装层做（spec §2.3：synthesize = ttsCall → mediaPut）。
 * 关闭/未配置/超时/失败/熔断一律返回 null，绝不抛错。
 * @param {string} text 待合成的段落文本（调用方已归一非空）
 * @param {''|'ogg'|'wav'} [format] 编码档位（缺省读 config.voice.tts.format）
 * @returns {Promise<{ bytes: Buffer, mime: string } | null>}
 */
async function ttsCall(text, format = '') {
  const tts = ttsGate();
  const fmt = format || ttsEncoding();
  if (!tts) return null;   // 关闭态：零网络零字节
  if (ttsBreakerOpen) return null;   // 熔断态：至进程重启不再尝试（"连续 3 次失败"口径）
  const body = String(text ?? '').trim();
  if (!body) return null;   // 调用方 bug（调用方已滤空）——不算引擎失败，不进熔断计数
  const t0 = Date.now();   // W3 埋点：真实尝试（引擎请求 + 编码落档档位全过程）耗时
  try {
    const product = await ttsEngineRequest(body, tts, fmt);
    const encoded = await productToStoreBytes(product, fmt, tts.dialect);
    ttsFailStreak = 0;
    ttsBreakerOpen = false;
    recordSynth(Date.now() - t0, true);
    return encoded;
  } catch (err) {
    ttsFailRecord(err);
    recordSynth(Date.now() - t0, false);
    return null;   // 不重试（批准口纪律：失败 null——该段纯文字是常态回退）
  }
}

/**
 * TTS 合成一段文本为**通话下行流形态**（voice.tts.synthesizeRaw，第四批准口的流形态，
 * 非第五批准口——design §11-#18 原文"voice.speak 复用第四口"）。night-plan §0 2026-11-18
 * 裁定：下行 = 整段 ogg（Opus 24k/voip）经 WS 二进制下发；客户端 decode 失败发
 * {type:'audio-format',value:'wav'} 换档。字节不落档不落盘（E1 通话形态），共用
 * ttsGate / TTS_FROZEN / 熔断 / 5s 超时，encodeForStore 复用（ogg 24k）。
 * W2 产物双形态（plan §4，按 tts.dialect 派发）：
 *   · deepseek-tools → { stream: ReadableStream, sampleRate }（协议固定 PCM 流；
 *     opts.format 不生效——协议 format:'pcm' 固定写死）；call.js 下行 = 流分块推 WS；
 *   · gpu-local / openai-compat → { bytes, mime }（整段 ogg/wav，现行为；openai 的
 *     'pcm' 请求档按 'ogg' 落——通话下行取 Opus 20× 体积优势，裸 PCM 无容器亦不可
 *     直接换档播放，plan §4 表）；
 *   · 关闭/失败/熔断 → null。
 * @param {string} text 待合成的段落文本（调用方已归一非空）
 * @param {{ format?: 'ogg'|'wav' }} [opts] 缺省 'ogg'（Opus 24k/voip，§5.5 定稿档）
 * @returns {Promise<{ bytes: Buffer, mime: string } | { stream: ReadableStream, sampleRate: number } | null>}
 */
export async function synthesizeRaw(text, opts = {}) {
  const raw = String(opts?.format ?? 'ogg').trim().toLowerCase() || 'ogg';
  const fmt = raw === 'wav' ? 'wav' : 'ogg';   // 'pcm' 请求档在下行面归一为 'ogg'（见上注）
  const tts = ttsGate();
  if (tts && tts.dialect === 'deepseek-tools') {
    return ttsEngineCall(text, fmt);   // PCM 流形态（熔断/闸/超时同源）
  }
  return ttsCall(text, fmt);           // 整段形态（现行为）
}

/**
 * 重置 TTS 熔断（幂等）。专供 engine-manager 在**引擎被重新拉起并预热成功后**调用：
 * 熔断原口径是"至进程重启"，但 D19 允许 App 在呼叫中拉起引擎——引擎回来了、进程却没重启，
 * 不重置的话这一整通（乃至之后所有消息语音）都会一直走纯文字，属于口径冲突。
 * 只由"确认引擎可用"的装配层调用，不在失败路径自愈，避免掩盖真实故障。
 */
export function resetTtsBreaker() {
  const wasOpen = ttsBreakerOpen;
  ttsFailStreak = 0;
  ttsBreakerOpen = false;
  return wasOpen;
}

/**
 * 语音运行态只读快照（W3 状态卡，routes.js GET /api/voice/status 消费）：
 * TTS 熔断态/失败连击 + 上次合成/转写耗时（{ ms, ok, at } | null）。纯模块态读取，
 * 零网络零进程——引擎探针不在此做（engine-manager probeEngines 是探测的唯一入口，
 * 与 owned 登记表同源）。
 */
export function voiceRuntimeSnapshot() {
  return {
    ttsBreakerOpen: ttsBreakerOpen === true,
    ttsFailStreak,
    lastSynth: lastSynth ? { ...lastSynth } : null,
    lastTranscribe: lastTranscribe ? { ...lastTranscribe } : null
  };
}

/**
 * TTS 合成一段文本为语音条（voice.tts.synthesize，第四批准口的落档包装）。
 * 关闭/未配置/超时/失败/熔断一律返回 null（调用方该段纯文字继续），绝不抛错打断发送链。
 * 成功 = 编码后字节落 media-store（E1）→ { mediaId, mime }（id=16 位 hex 内容哈希）。
 * mime 默认 audio/ogg（Opus 24k，§5.5）；format='wav' 或转码失败时回 audio/wav。
 * W2 三方言兼容（plan §5）：gpu-local = 现行为逐字节不变（引擎 wav → encodeForStore
 * → mediaPut）；deepseek-tools = PCM 流读全 → pcmToWav(24k) → encodeForStore →
 * mediaPut（流中途失败=引擎失败进熔断计数）；openai-compat = 响应字节（opus/wav）
 * 原样落档（content-type 随响应）。
 * @param {string} text 待合成的段落文本（调用方已归一非空）
 * @returns {Promise<{ mediaId: string, mime: string } | null>}
 */
export async function synthesize(text) {
  const encoded = await ttsCall(text);   // 档位缺省 = config.voice.tts.format（原行为）
  if (!encoded) return null;
  try {
    const saved = await mediaPut(encoded.bytes, { mime: encoded.mime });
    return { mediaId: saved.id, mime: encoded.mime };
  } catch (err) {
    // 落档失败（存储侧，非引擎失败）——返回 null 该段纯文字，不重试
    console.warn('[voice] TTS mediaPut 失败：', err?.message ?? err);
    return null;
  }
}

/** 批准口形状（spec §7 + §8.A 第三/四口；W2 方言派发 plan §1-§5）：
 *  voice.asr.transcribe(mediaId,{lang}) → {text}|null；
 *  voice.asr.transcribeWav(wavBytes,{lang}) → {text}|null（V3 通话上行字节直传形态，不落档）；
 *  voice.asr.available() → boolean（asrGate 同源探测）；
 *  voice.tts.synthesize(text) → { mediaId, mime } | null（落档形态，三方言兼容）；
 *  voice.tts.synthesizeRaw(text,{format}) → { bytes, mime }（gpu-local/openai 整段）
 *    | { stream, sampleRate }（deepseek PCM 流形态）| null（通话流形态，不落档）。 */
export const voice = { asr: { transcribe, transcribeWav, available: asrAvailable }, tts: { synthesize, synthesizeRaw } };
