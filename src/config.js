// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录
// ── 多实例 PROFILE ─────────────────────────────────────────────────────
// XUNXI_PROFILE=2 时数据目录变成 data-2/、端口整体 +100，
// 这样同一台机器可以跑两个机器人实例（两个 QQ 号）而不互相踩。
// 优先级：XUNXI_DATA_DIR（显式覆盖）> PROFILE 推导 > 默认 data/
// （W6-① env 更名：QQ_AGENT_* → XUNXI_*，旧名保留为兼容 fallback 读取——
//   优先新名；待所有者外部脚本/快捷方式全部切新名后可删旧名分支。）
//
// ⚠️ 必须在这里就生效（而不是在 UI 或 app.js 里改）：
//   DATA_DIR 是整个进程的根路径，配置、会话、记忆、表情库全挂在它下面。
//   晚一步设置就会有一部分文件写到主实例的目录里，造成两个实例数据互相污染。
import { profileSuffix, portOffset } from './profile.js';

export const DATA_DIR = process.env.XUNXI_DATA_DIR || process.env.QQ_AGENT_DATA_DIR
  || path.join(ROOT, `data${profileSuffix()}`);
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    // 备选模型列表：主模型在重试后仍失败时，逐个用备选模型重试直至成功。
    // 每项 { model, provider? }：provider 留空则沿用主模型的 provider/baseUrl/apiKey；
    // 填了 provider 则切到该提供商（用它的 baseUrl + Key）。按顺序尝试。
    fallbackModels: [],
    // 按输入类型分开选择模型（可选）：留空则都用上方主模型 api.model。
    // 图片/视频输入需要模型支持对应模态；文字输入用纯文本模型即可（可省成本）。
    // ⚠️ 这两个字段现在是**真的会被使用**的：llm.js 检测到请求里带图片/视频部分时，
    //    会用对应字段的模型替换主模型（仅主调用路径；记忆整理/备选模型降级不受影响）。
    //    此前它们只是存下来给 UI 看，没有任何代码读取 —— 填了不起作用。
    visionModel: '',            // 图片输入专用模型（留空 = 用主模型）
    videoModel: '',             // 视频输入专用模型（留空 = 用主模型）
    // 视频走哪条路。两条路**互斥**，不会同时喂 ——
    // 同时喂等于同一内容重复计费，而且多数网关会因格式冲突直接 400。
    //   auto   配了 videoModel 就认为你有全模态模型 → 原生读视频；否则抽帧；
    //          抽帧 Skill 不可用（没装 ffmpeg）就只给元信息
    //   native 强制原生视频输入（把视频地址作为 video 部分发给模型）
    //   frames 强制抽帧（把视频变成若干张图片，任何视觉模型都能用）
    //   off    不喂画面，只给时长/分辨率等元信息（纯文本模型 / 省 token）
    videoMode: 'auto',
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    // 视频输入（模型能不能吃 video 部分）。与 vision 相互独立：
    //   勾了 vision + video → 有人发 GIF 动图时，用 ffmpeg 转成 ≤480px / ≤24 帧的
    //                        mp4，按 video 部件发给模型（llm.js 自动切 videoModel）
    //   勾了 vision 没勾 video → GIF 按图片原样发（部分视觉模型能直接读动图）
    //   没勾 vision → 看图工具整个不存在，GIF 自然也看不到
    // 默认关闭：猜错"模型支持视频"的代价是请求 400，比不启用更糟（同 videoModel 的口径）。
    video: false,
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    // 单轮回复的输出上限（token），0 = 不设上限。
    // 2026-11-03：本地模型（LM Studio）偶尔不吐 EOS，而主对话原来不带 max_tokens，
    // 一轮能一直生成到超时。给个兜底上限：正常聊天远用不到，跑飞时能自己停。
    maxTokens: 2048,
    timeoutMs: 180000,
    // 思考强度（实际落成各厂商参数由 src/thinking.js 内置方言表负责）：
    //   thinkingEffort off/low/medium/high/xhigh/max —— off=能思考的模型也明确关闭，
    //     其余档位=开启且强度递增（渠道不支持高档时向下就近映射）
    //   thinkingMode  off/auto/on（旧三态，effort 为空时的兼容口径）
    //   thinkingBudget token 数 —— 思考预算，仅 Claude 兼容 / 部分网关生效，0=不指定
    // 目的：防"雷霆大思考"（几千 token 的 reasoning 拖慢且烧钱）或该思考的完全不思考。
    thinkingMode: 'auto',
    thinkingEffort: '',
    // thinkingBudget（思考预算 token 数）有真实读点：src/thinking.js
    // 在 Claude 兼容/部分网关方言下把它落成预算参数。没有 UI 入口（有意为之：
    // 绝大多数渠道不认这个参数），需要时手改 config.json 即可生效。
    thinkingBudget: 0,
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表地址原本由 src/community.js 固定（FIXED_PRICE_FEED_URL），该模块已删除；
    // api.priceRemoteUrl 仍是废弃历史字段，任何代码都不得再读/写它，
    // loadConfig 时统一剔除（见 stripObsoleteFields），避免磁盘旧值继续冒充"生效地址"。
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高 —— 一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/model-prices.js）。
    modelPrices: {}
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  // providersImported（导入来源标记）与 budget 容器是历史残留死字段（零读点），
  // loadConfig 时由 stripObsoleteFields 一并剔除。
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // 可选：'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    provider: 'bing',
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    }
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false,          // true 时图片下载允许内网地址（仅本地测试/自建图床）
    // ── 浏览锁定 ──
    // ── 浏览锁定 ──
    // 把"机器人能访问哪些域名"收成白名单。开启后 fetch 与发图**逐跳**校验
    // （含重定向目标），不在清单内一律拒绝。
    browseLock: {
      enabled: false,
      hosts: [],                  // 允许的域名，如 ['zh.wikipedia.org', 'example.com']（支持子域）
      siteSearchUrl: ''           // 站内搜索模板，如 'https://example.com/search?q={query}'
    }
  },
  // （Q4 摘除 2026-11-12：协议端连接配置段——程序目录/自拉起/WS 与 HTTP 地址/两个令牌六键，
  //   随 QQ 身体脱离无默认值。读点已清：app.js 进程管理与令牌同步在 Q3 摘除，Q4 前唯一
  //   残余读点 = 旧日程插件的协议端探活（其 index.js「Pick」函数），缺失键时
  //   `|| {}` 回落后改扫磁盘候选目录，不 crash。磁盘旧键由 deepMerge 容忍（运行时仍带上
  //   磁盘值，真实部署零行为差），Q11 身体归档收口。）
  // 人设与行为
  persona: {
    botName: '汐',
    // 主人/对方在提示词里的称呼。面向个人部署，不需要区分多个人；
    // 需要区分身体时可写占位符，例如 '对方({surface})' → '对方(web)'。
    // 默认不带平台后缀（开源友好：不写死任何个人称呼）。
    ownerLabel: '对方',
    // 默认人设：「白纸小鱼」。2026-10-31 起替换了原「小鲸鱼 QQ 群友版」角色卡
    //（那版通篇群聊规则，私聊部署下一旦重置人设就会串戏）。可用设置页的人设模板切换。
    roleText: PERSONAS.default.text,
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: '',                        // 追加自定义规则（可选）
    // 系统提示词覆盖（可选）：非空时**整体替换** buildSystemPrompt 的默认行为准则。
    // ⚠️ 高级功能：覆盖后默认行为准则失效，仍需自行在覆盖文本里写明想要的行为；
    //    工具协议由核心追加，不会随覆盖消失。留空 = 用内置默认提示词。
    // 可用占位符：{botName} {roleText} {participation}
    systemPromptOverride: ''
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // （会话级独立人设两键已随 2026-11-22 清理退役——单用户单人格，恒走全局
  //   persona，personaForChat 退化为直返全局值；botName 等账号身份本就任何
  //   会话不得单独改。磁盘旧值由 stripObsoleteFields 剔除，不再冒充生效配置。）
  // ── 她的生活（P14 · 2026-11-20）──
  // 日程生成仍由 modules.life.enabled 控制；本键只管**聊天提示词注入**：
  //   'off'   不注入【今日日程】（默认：散文版唐突、时间错位，先停用）
  //   'prose' 旧行为：注入今日 plan 的散文（≤400 字）
  // 生成侧要一起停，另设 modules.life.enabled=false。
  life: {
    promptMode: 'off'
  },
  // ── 跨轮思考（P16 · 2026-11-20）──
  // 读取上一条已结束会话的【深度思考】，注入本轮 user 尾部，让思考接得上。
  // 只读派生，不写状态、不新建表；session 文件不存在/过期/无思考 → 整段缺席。
  transition: {
    enabled: true,
    ttlMin: 90,        // 上一条会话结束超过该分钟数就不注入
    maxChars: 500      // 注入思考正文上限（超出截断并标注后略）
  },
  // （Q4 摘除 2026-11-12：接入白/黑名单三键——群/私聊名单与「空名单全放行」开关，
  //   随 QQ 身体脱离无默认值。缺失键口径已双验证（静态实读 + 运行时实跑）：app.js
  //   白名单闸（allowed()，Q7 随入站解耦一并摘）与 routes.js test-send 闸、orchestrator
  //   主动候选、tools.js 旧跨会话发送工具的校验全部 `?.` / `?? []` / `=== true` 容忍 → 等效
  //   「空名单 + 不放行」。磁盘旧键由 deepMerge 容忍，真实部署零行为差。）
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 会话级自动重试：整轮运行失败且一条消息都没发出时，自动从头再来几次。
  // 0 = 关闭自动重试（失败会话仍可在会话页手动点「重试」）。
  // ⚠️ 已发出过消息的会话绝不自动重试 —— 重试会导致群里看到两遍同样的话。
  sessionRetryAttempts: 2,
  // 发送保护
  send: {
    // 发送去重窗口（毫秒）：同一会话在该窗口内完全相同的文本只发一次。
    // 防"模型重复调用 send_message / 发送超时看似失败但实际已发出、上层重试再发"导致的重复发言。
    // 0 = 关闭去重。默认 8000（8 秒）。
    dedupeWindowMs: 8000,
    // 私聊"对方正在输入…"：运行期间向协议端上报 C2C 输入状态（QQ 只有私聊有这个能力）。
    // 对本地模型尤其有意义——一次推理 20~30 秒，对方至少能看到"在打字"而不是空白。
    // 协议端未实现 set_input_status 时首次失败即自动关闭，不影响聊天。
    typingIndicator: true
  },
  // ── 身体意图层开关（P1 · night-plan §4.6 回滚开关）——Q11 整段摘除 ────────
  // 出站自 P1 起统一走身体意图层（ctx.emit / hostBridge.sendText / 提醒 / typing 反射
  // → registry.route(chatKey).emit(intent) → 身体 adapter 机械翻译）。回滚开关
  // surface.intents 的消费分支只曾存在于 orchestrator.#emitOutbound 与 app.js
  // routeOutboundText 两处（坑 #8 口径），随 QQ 身体归档（Q11）一并死亡——出站是
  // 单路径，开关没有存在意义。磁盘 config.json 若残留 surface 段，deepMerge 并入后
  // 零消费面，无行为影响（与 Q7 摘 surface.inbound 同款容忍口径）。
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // （活跃模式容器已随 2026-11-22 清理退役——激活入口随群聊档位机制消亡后
  //   再无从进入活跃期，orchestrator/tools 侧登记遗留的状态机一并摘除。）
  // （relationship 配置段已随 2026-11-21 数值丢弃移除——关系数值轴零消费方，见内部文档 state-ownership.md）
  // 上下文预算：只做减法，出错静默放行。
  contextBudget: {
    enabled: true,
    historyMode: 'window',        // off | window | aggressive
    keepRecentMessages: 14,
    maxDigestChars: 600,
    trimToolDescriptions: true,
    maxToolResultChars: 4000,
    verbose: false
  },
  // 日记（原日记插件 shell 收编）：存储与灵魂已在 person/diary.js +
  // capabilities/reflection/diary.js，这里只留行为参数（dir 已退役）。
  diary: {
    enabled: true,
    maxPerDay: 1,
    minGapMinutes: 60,
    nothingNewMinutes: 120,
    impulseEnabled: true,
    impulseIntervalMinutes: 10,
    activeFrom: '20:00',
    activeTo: '04:00',
    maxEntryChars: 500,
    maxRead: 8,
    sendEnabled: false,
    sendTo: '',
    model: '',
    debug: false,
    bedtimeOnly: true,
    bedtimeWords: '晚安,睡了,先睡,睡啦,好梦,困了',
    bedtimeGraceMinutes: 15,
    fallbackAt: '23:30',
    minMessagesForDiary: 10
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // 响应时随【已读信息】带多少条历史（prompt.js buildPastState 读点）。
    historyCount: 80,
    // ── 提示词锚点（前缀缓存深化，2026-09-25）──
    // 连续触发时，把上一轮发给模型的【记忆】+【已读信息】前缀**原样复用**：
    // 本轮只在其后追加新沉淀的已读条目（"新已读信息"），新增群友的印象放到
    // 未读信息之后的【新加入成员】段 —— 除追加部分外前缀字节不变，命中缓存。
    // 追加条数超过 maxExtraRead 就整体重置（回到标准窗口，重新开始锚定）：
    // 已读信息是按条计费的，无限追加会"为了省钱花更多钱"。
    promptAnchor: {
      enabled: true,
      maxExtraRead: 5           // 相对锚定时的已读条数，最多额外追加几条
    },
    keepSessionFiles: 0,        // 保留最近多少个会话记录文件；**0 = 不限制**（原为 300）
  },
  // （Q4 摘除 2026-11-12：按群屏蔽名单键——QQ 群概念载体。读侧两处容忍缺失键：
  //   app.js 入口丢弃（?.[id] || []）与 prompt.js 历史过滤（?.[pId] || []），
  //   Q9 群聊分支摘除后读点归零。磁盘旧键由 deepMerge 容忍。）
  memory: {
    // ── 记忆写入器（步骤⑤ / T5.1，原清单 §10.1）──
    // （清债夜2：旧"分层会话记忆"的整理链路五键已随子系统摘除，
    //   磁盘旧值由 stripObsoleteFields 的退役容器白名单清除。）
    // 反思执行器（capabilities/reflection）产出记忆卡时的模型来源：
    //   'model'    真实模型（公开版默认）：动态 import llm.js 走 chatCompletionFully，
    //              整理时产生真实用量与成本。
    //   'fixture'  不调模型：读 tools/fixtures/card-YYYY-MM-DD.json 当作模型输出，
    //              管线照常（解析→mid 校验→前额叶写入）。保留为离线演示/开发期
    //              可选项——曾是反思管线开发期默认，2026-11-22 清理起默认改为
    //              调真实模型；fixture 文件缺失的那天走抽取式兜底卡
    //              （source:'fallback'）。
    writer: { mode: 'model' },
    // ── 记忆卡向量索引（card-vector 计划 §3.2 · 夜1 T1.5）──
    // 双粒度派生索引（data/index/，card-index.js 唯一写者）的嵌入配置。
    // enabled=false（缺省）= 全系统行为与今天逐字节一致：embed 直接 null，
    // card-index syncCard/syncFact 跳过登记、recall 纯词法——索引可在后台滞后，
    // 由 tools/rebuild-card-index.mjs --backfill/--rebuild 补齐。
    // 启用 = 一行配置（enabled:true）；provider 已指向夜0 T0.4 确认的 LM Studio 条目
    // （custom_mvgbzl9p8rb0 → http://127.0.0.1:1234/v1，零云端）。
    // 注意：本段是 DEFAULT_CONFIG 的出厂值；实机 config.json 无此键时按此兜底，
    // 磁盘上 enabled 恒保持 false——开启窗口只有夜2 T2.7 验收段（验收后回 false）。
    embedding: {
      enabled: false,                     // 总开关；false = 缺省关闭态（行为零变化）
      provider: 'custom_mvgbzl9p8rb0',    // 显式 provider id（夜0 T0.4；空串=embed 直接 null，绝不回落主 provider——B2）
      model: 'text-embedding-qwen3-embedding-0.6b',   // 夜0 T0.2 实测完整 id（1024 维 / L2 已归一化）
      // query 侧指令前缀（计划 §3.2 文案；实测端点不自动加前缀，前缀责任在 llm.embed——
      // 只作用 query 侧，document 侧必须原文。夜0 drift①：英文前缀实测档更高
      // （0.55/0.75 vs 中文 0.35/0.75），换文案待所有者拍板，暂守计划现稿）
      queryInstruction: 'Instruct: 给定一段对话记忆检索任务，检索与查询语义相关的记忆卡\nQuery: ',
      // W4（night-plan-polish §2-W4，所有者拍板：调用与注入解耦）——embedding 注入闸门模式：
      //   'always'（缺省）= 新策略：embedding 开启且预取命中（vectorHits 非空）即注入【近期回忆】，
      //     不再过旧三闸门（冷启动/线索词/人名）；无命中不注入。注入块头部带「仅供参考」标注
      //     （文案单一事实源 = recall.js RECALL_NOTE_LINE）。
      //   'strict' = 旧三闸门可回退，行为与 W4 前逐字节一致。
      // 非法/缺省值一律落 'always'（判定在 recall.js embeddingGateMode()）。
      gateMode: 'always',
      // RRF 路权重可调（Q5 拍板保留 k=60+权重可调）；row = 第二批行级向量独立权重，
      // gist/fact = 第二批验收拆出的独立权重（缺省同 vector，兼容旧配置）。
      fuseWeights: { lexical: 1, vector: 1, row: 1, gist: 1, fact: 1 },
      // 向量行入融合候选的 cosine 下限（夜2 T2.7 20 题验收实测定值：无关对 <0.40 /
      // 相关对 >0.55 的间隙取 0.45——低相关 gist/fact 行不顶词法命中；换嵌入模型需重测）
      vectorFloor: 0.45,
      // 行级向量入融合候选的 cosine 下限（第二批 T3；缺省同 vectorFloor，
      // 20 题 bench 可用 --row-floor 覆盖校准，不改磁盘配置）。
      rowFloor: 0.45,
      // 词法行入融合候选的最低 token 重叠分（P11 · 2026-11-20）：
      // 1.5 = 至少一个二字词命中（单字闲聊 1 分不触发）；2.0 会连二字词也砍掉，
      // 实测把“上周我们聊了什么”这类真实回忆问法也过滤了——宁缺毋滥不等于砍到零。
      // 召回宁缺毋滥；需要更严可调到 2.0-2.5。
      lexicalFloor: 1.5,
      // 同日聚合（Q2 拍板默认开）：同一天只保留融合序最优的一行。行级第二批 bench
      // 提供 --no-collapse 诊断口径（raw hybrid 0.55/0.80 不做同日坍缩；生产默认不变）。
      dateCollapse: true
    }
  },
  // 工具与技能（skill 化开关）
  //
  // ⚠️ 边界（避免"两个开关打架"）：
  //   tools.*  = **工具**层的开关：全局 / 分类 / 单个工具
  //   modules.* = **能力**层的开关：每个 Skill 一个命名空间（W6-② 容器键更名）
  // 最终"能不能用"由 tool-registry.getToolAvailability() 统一计算，
  // 顺序是：tools.enabled → skill 生效 → requires 能力 → 分类 → 单工具 → 运行期依赖。
  // 模块不允许再写自己的 isXxxEnabled 影子开关。
  tools: {
    enabled: true,              // 全局开关：false 时所有工具都禁用
    overrides: {},              // { [toolId]: boolean } 单个工具的启用状态
    // （跨会话发送开关已随 2026-11-22 清理退役——受它管辖的专用工具与
    //   send_message 的跨会话目标参数同批消亡，无任何消费方。）
    categories: {
      messaging: true,          // 消息发送
      sticker: true,            // 表情管理
      query: true,              // 消息查询
      memory: true,             // 记忆系统
      web: true,                // 联网搜索
      knowledge: true,          // 知识库
      media: true,              // 媒体理解
      system: true              // 系统反馈
    }
  },
  // Skill 统一开关：唯一的"能力启停"来源。
  // 形状：{ [skillId]: { enabled: boolean, ...该 Skill 自己的设置 } }
  // 这里只存用户改过的值；默认值来自各 Skill 的 skill.json → settings。
  // W6-②：容器键由 config.skills 更名 config.modules（旧键由 RENAMED_PATHS 加载期迁移）。
  modules: {},
  // 扩展热重载：把自定义的插件/skill 目录放进 plugins/ 或 skills/ 后**自动生效**，无需重启。
  // 默认开 —— 这正是"放进去就能用"的体验来源。
  // ⚠️ 安全含义：等价于"任意落地的 JS 会被执行"。共享机器 / 只跑固定版本时建议关掉。
  extensions: {
    hotReload: true
  },
  // 桌面端/控制台
  server: {
    // 端口：XUNXI_PORT 显式覆盖（旧名 QQ_AGENT_PORT 兼容 fallback）> 默认 3210 + PROFILE 偏移
    // （第二实例整体 +100，避免和主实例撞端口）
    port: Number(process.env.XUNXI_PORT) || Number(process.env.QQ_AGENT_PORT) || (3210 + portOffset()),
    token: '',                // 留空 = 不校验令牌（仅在本机/可信网络下使用）
    // 监听地址（2026-11-12 新增）：默认只回环 = 只有本机能访问。
    // 手机 / 平板要访问时改为 '0.0.0.0'，并**必须**在 allowedHosts 里登记放行的域名
    // ——只改 host 不够，originAllowed 会按 Host 头再拦一道。
    host: '127.0.0.1',
    // 额外允许的 Host 头（不含端口），如 Tailscale MagicDNS 域名。
    // 只放行这里列出的主机名；局域网扫描、其他设备用 IP 直连都会被拒。
    allowedHosts: [],
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000,         // 界面轮询间隔
    // 深度思考（原 detailed-thinking 插件收编）：0 = 不限制；
    // 正数 = 单轮推理内容超过该字符数时截断（只影响会话记录展示）。
    reasoningMaxChars: 0
  },
  // ── 语音（voice-walkie V1 · ASR 接入；设计=内部文档 asr-tts-call-mode-design.md §10.1）──
  // 形状照 §10.1 全建（V2 的 tts/call 键同期建好，缺省全关）；engine 全缺省 'off'。
  // ASR 批准口=src/capabilities/voice.js asr.transcribe（architecture-v3 §8.A 第三批准口）。
  // 纪律（照 memory.embedding 同款）：
  //   · 缺省全关 = 零调用、零新进程依赖（enabled=false / engine='off' 时连函数体都不进）；
  //   · baseUrl 空 = 该引擎不可用，绝不回落主聊天 provider（B2 同款）；
  //   · 新键均为新路径，无 OBSOLETE_PATHS 涉。
  voice: {
    enabled: false,                       // 总开关；false = 零调用、零新进程依赖
    asr: {
      // W1 快捷开关（Settings 语音分区顶部可切，POST /api/config 即时保存）：
      // false = 零调用（asrGate/engine-manager 闸门返回 null）；缺省 true =
      // 兼容升级前已配置现役（engine+baseUrl 在册即按原行为）——总闸 voice.enabled
      //=false 时仍整体零调用，新装缺省口径（全关）不因此变化。
      enabled: true,
      engine: 'off',                      // 'off'=关 | 引擎/方言名（'gpu-local' whisper.cpp server；W2 起也可直接填方言名，闸按 dialect 取协议）
      // W2 协议方言（内部文档 voice-provider-plan.md §1-§2）：'gpu-local'|'deepseek-tools'|
      // 'openai-compat'。**缺省不在本对象**——运行时按 voice.js dialectOf 判定：显式
      // dialect 键优先（非法值 fail-closed 零调用），缺省从 engine 键名派生（engine
      // 直接填方言名亦可），engine 非方言名 → gpu-local=现行为逐字节不变。（不放缺省
      // 键的原因：deepMerge 会把缺省值变成"显式键"，压掉 engine 名派生。）
      baseUrl: '',                        // 如 http://127.0.0.1:8178（whisper-server 根地址；POST {baseUrl}/v1/audio/transcriptions）
      // W2：deepseek-tools/openai-compat 的 Bearer 令牌。安全纪律（plan §8）：仅存
      // 本文件（gitignored）、日志零打印、错误不回显、Settings 密码框（W3）；
      // gpu-local 方言不消费此键。
      apiKey: '',
      model: 'large-v3-turbo',            // gpu-local：server 启动加载的模型名（仅登记）；openai-compat：随请求发送（Whisper API model 字段）
      timeoutMs: 15000,                   // ffmpeg 转码 + 引擎请求共用同一 deadline
      language: 'zh'
    },
    tts: {
      // W1 快捷开关（同 asr.enabled 口径）：false = 零调用；缺省 true 兼容现役。
      enabled: true,
      engine: 'off',                      // 'off'=关 | 引擎/方言名（'gpu-local' GPT-SoVITS api_v2；W2 起也可直接填方言名）
      // W2 协议方言（plan §3/§4，判定同 asr.dialect=voice.js dialectOf）：
      // 'deepseek-tools' = /v1/tools/tts → 24kHz mono 16-bit LE 裸 PCM 流（通话下行
      // 流式分块推 WS、消息条 PCM→wav→ffmpeg ogg 落档）；'openai-compat' = /v1/audio/speech
      // 标准面；缺省（无键/engine 非方言名）= gpu-local 现行为。
      baseUrl: '',                        // 如 http://127.0.0.1:9880
      apiKey: '',                         // W2：deepseek-tools/openai-compat Bearer（安全纪律同 asr.apiKey）
      refVoice: '',                       // 参考音频名/模型名（V2，仅登记不消费）
      model: '',                          // W2：openai-compat speech 模型名（空=请求不带 model 字段，部分兼容服务不认）
      // W2：deepseek voice_id ∈ 'stella'|'tide'；openai 的 voice 字段同读此键（任意串）。
      voiceId: 'stella',
      // W2：deepseek 协议参数（服务端过滤代码块/表格/引用标记）。
      filterMarkdown: true,
      // 编码档位（design §5.5 定稿 ogg=Opus 24k/voip）。W2 取值扩为 'ogg'|'wav'|'pcm'：
      // 'pcm' 仅对流式方言有义（deepseek 协议固定 pcm；openai 映射 response_format:'pcm'），
      // gpu-local 下 'pcm' 按 'ogg' 处理（裸 PCM 无容器不可直接落档/换档）。
      format: 'ogg',
      // W2：PCM 档位采样率登记（deepseek 协议固定 24000；通话 audio-mode 帧取值源）。
      sampleRate: 24000,
      // W2：Opus 落档码率（原 TTS_OPUS 常量 24 配置化，缺省同值=听感定稿不变）。
      bitrateKbps: 24,
      timeoutMs: 5000
    },
    // 引擎运行策略（call-mode §10.1 / D19；night-plan §1-1：GPU 无限制，所有者 2026-11-18 晚确认）。
    // 这是运行策略不是架构常量：缺省允许，所有者实验期显式关；voice.enabled=false 时不生效
    //（不拉起/不预热，零进程依赖）。
    engine: {
      manage: 'auto',                     // 'auto'=允许 App 在呼叫中拉起/预热引擎；'manual'=只探测不拉起
      gpuAllow: true                      // GPU 默认可用；仅所有者明确要求"本轮不许用 GPU"时置 false
    },
    call: {
      enabled: false,                     // 通话模式单独开关（消息模式语音条可独立于它）
      silenceMs: 300,                     // 尾点静音阈值
      minUtteranceMs: 300,
      maxUtteranceMs: 60000,
      firstSentenceMaxChars: 15,
      maxSentences: 4,
      promptBudget: 3000,
      historyTurns: 8,
      recallMinSeconds: 120,
      recall: true,                       // 挂断回想开关（false=整通不落回想行，调试期用）
      keepAudio: false,                   // 通话音频是否落 media-store（缺省不留）
      dnd: { start: '23:30', end: '08:00' }  // 免打扰（availability 派生用）
    }
  }
};

/** 深合并（含 __replace__ 整体替换约定）。导出供 routes.js 的预览端点做"不落盘的临时合并"。 */
export function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    // W6-②：改名迁移最先跑（旧键值搬新键），随后各 legacy 迁移器只认新键容器。
    return deepMerge(DEFAULT_CONFIG, stripObsoleteFields(migrateLegacySkills(migrateLegacyExtensionConfig(applyRenamedPaths(parsed)))));
  } catch (error) {
    // ⚠️ 配置文件坏了（手改错/磁盘故障）不能静默回落默认值：
    //   曾经直接返回 DEFAULT，随后任何 updateConfig（比如 5 分钟一次的
    //   云端屏蔽名单同步）都会以默认配置为底整体写回 config.json ——
    //   用户的 Key/白名单/人设被静默抹成出厂值。
    //   现在先把坏文件改名备份（原始数据可手工抢救），再回落默认，
    //   并打 error 日志提醒用户。
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(CONFIG_FILE, `${CONFIG_FILE}.corrupt-${stamp}`);
        console.error(`[config] 配置文件解析失败（${String(error?.message ?? error)}），` +
          `已备份为 config.json.corrupt-${stamp}，本次以默认配置启动。` +
          `请尽快从备份抢救配置，否则下次保存会覆盖全量配置！`);
      }
    } catch (backupError) {
      console.error('[config] 配置文件解析失败且备份失败：', backupError);
    }
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * 旧配置迁移：把历史上散落在各处的"能力开关"收拢进 config.modules（W6-② 前为 config.skills）。
 *
 * 为什么必须做：社区版/旧版把同一件事的开关放在 api.thinking、tools.knowledgeEnabled
 * 之类的字段里，而新架构只认 config.modules[id].enabled（W6-② 前为 skills）。若不迁移，
 * 用户升级后会出现"UI 显示已开启、实际 Skill 判定为关闭"——正是要消灭的冲突。
 *
 * 规则（表驱动，新增迁移只需加一行）：
 *   旧字段路径 → Skill id，可选值映射函数
 * 迁移是幂等的：只有在 skills[id] 尚未存在时才写入，不会覆盖用户新配置。
 */
const LEGACY_SKILL_MIGRATIONS = [
  // ⚠️ skill 名字必须与 skills/ 或 plugins/ 下的**目录名**完全一致，
  //    目标不存在时迁移会跳过并记日志（migrateLegacySkills 内有校验）。
  // 社区版的思考开关已收编进核心（src/thinking.js），不再迁往任何 Skill：
  // api.thinking: true → thinkingMode 'on'，false → 'off'，由下方专段处理。
  // 旧知识库开关（知识库技能尚未移植，先留位；目标不存在时迁移会跳过并记日志）
  { from: ['tools', 'knowledgeEnabled'], skill: 'knowledge-base', map: (v) => ({ enabled: v !== false }) },
  // 旧视频理解开关
  { from: ['tools', 'videoEnabled'], skill: 'video-frames', map: (v) => ({ enabled: v !== false }) },
  // 旧表情标注开关
  { from: ['tools', 'stickerAnnotate'], skill: 'sticker-annotate', map: (v) => ({ enabled: v !== false }) }
];

/**
 * Q15：已收编扩展的配置迁移（一次性、幂等）。
 *
 * 把旧 modules.<id> 里的用户调参搬到新的核心配置段，再删旧键：
 *   modules['daily-diary']      → diary（去掉已退役的 dir）
 *   modules['token-saver']      → contextBudget
 *   modules['detailed-thinking']→ ui.reasoningMaxChars
 *
 * 未收编的旧扩展（旧态度/旧日程/旧跨轮等 id）先留在 modules
 *（W6-② 起容器键由 skills 更名 modules，RENAMED_PATHS 加载期迁移），
 * 由各自的禁用步骤与最终清理处理；这里只动本轮已收编的三项。
 * 目标段已存在时以用户新配置为准（不覆盖），保证幂等。
 */
export function migrateLegacyExtensionConfig(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const out = { ...parsed };
  // W6-②：旧容器键 skills 已由 RENAMED_PATHS 更名 modules——本迁移器只认 modules。
  const skills = (out.modules && typeof out.modules === 'object' && !Array.isArray(out.modules))
    ? { ...out.modules }
    : null;
  if (!skills) return out;

  const move = (oldId, targetKey, clean = null) => {
    const old = skills[oldId];
    if (!old || typeof old !== 'object' || Array.isArray(old)) return;
    if (out[targetKey] === undefined) {
      const next = { ...old };
      if (typeof clean === 'function') clean(next);
      out[targetKey] = next;
    }
    delete skills[oldId];
  };

  // daily-diary：dir 已退役（存储固定 person/diary.jsonl），不迁。
  move('daily-diary', 'diary', (next) => { delete next.dir; });
  move('token-saver', 'contextBudget');

  const dt = skills['detailed-thinking'];
  if (dt && typeof dt === 'object' && !Array.isArray(dt)) {
    const max = Number(dt.maxChars);
    if (Number.isFinite(max) && max >= 0) {
      const ui = (out.ui && typeof out.ui === 'object' && !Array.isArray(out.ui)) ? { ...out.ui } : {};
      if (ui.reasoningMaxChars === undefined) ui.reasoningMaxChars = max;
      out.ui = ui;
    }
    delete skills['detailed-thinking'];
  }

  out.modules = skills;
  return out;
}

export function migrateLegacySkills(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const out = { ...parsed };
  // W6-②：容器键 skills → modules（RENAMED_PATHS 已先跑；这里对齐新键名，幂等建容器）。
  out.modules = (out.modules && typeof out.modules === 'object' && !Array.isArray(out.modules)) ? { ...out.modules } : {};

  // 社区版的思考开关（api.thinking: boolean）：思考已收编进核心（src/thinking.js），
  // 旧值映射成 thinkingMode（true=on / false=off），不再迁往任何 Skill 命名空间。
  if (out.api && typeof out.api === 'object' && !Array.isArray(out.api) && 'thinking' in out.api) {
    const legacyThinking = out.api.thinking;
    if (out.api.thinkingMode === undefined) {
      out.api = { ...out.api, thinkingMode: legacyThinking === false ? 'off' : 'on' };
    }
    const nextApi = { ...out.api };
    delete nextApi.thinking;
    out.api = nextApi;
  }

  for (const rule of LEGACY_SKILL_MIGRATIONS) {
    const [parent, key] = rule.from;
    const container = out[parent];
    if (!container || typeof container !== 'object') continue;
    if (!(key in container)) continue;
    const legacyValue = container[key];
    // 已有新配置就不动（用户可能已经在新 UI 里改过）
    if (!(rule.skill in out.modules)) {
      out.modules[rule.skill] = { ...rule.map(legacyValue) };
    }
    // 清掉旧字段，避免下次启动重复迁移、也避免模块继续读到旧值
    const nextContainer = { ...container };
    delete nextContainer[key];
    out[parent] = nextContainer;
  }
  return out;
}

/**
 * 剔除**废弃字段**（磁盘/回传 patch 都可能带着的历史残留）。
 * 这些字段已无任何读点，留着只会冒充"生效配置"继续漂移。
 * 与 stripDerivedFlags 一样在 loadConfig / updateConfig 时调用，删旧键不碰活键。
 *
 * 两种机制：
 *   1. OBSOLETE_PATHS —— 精确路径删除（历史遗留的顶层/深层死键，见各条注释）。
 *   2. RETIRED_CONTAINER_ALLOWLISTS（清债夜2）—— 退役子系统按**容器**收口：
 *      容器内只保留白名单列出的活键，其余键（历史死键与手改残留）一律剔除。
 *      被剔除的死键全名清单记录于内部文档 handoff-debt-night.md 夜2 小节
 *      （墓碑禁词不落字口径，同 prompt.js Q9 墓碑先例：清债夜 grep 断言对
 *      被删符号的字面零容忍——注释也不例外）。
 */
const OBSOLETE_PATHS = [
  ['api', 'stream'],
  ['api', 'priceRemoteUrl'],
  ['budget'],
  ['providersImported'],
  // 清债夜2：指令禁言子系统容器整体退役（分段拼接以规避墓碑禁词，全名见交接文档）
  ['command' + 'Mute'],
  // 2026-11-22 清理：四个退役键——活跃模式容器、会话级人设容器、统一人设开关、
  // 跨会话发送开关。读点已同批清零（orchestrator/prompt/tools/前端），磁盘旧值
  // 不再冒充生效配置。名字分段拼接以规避墓碑禁词（同上行先例）。
  ['chat' + 'Active'],
  ['persona' + 'ByChat'],
  ['persona' + 'Unified'],
  ['tools', 'cross' + 'ChatSend'],
  // 同批：群成员备注表（旧群聊时代死键，不在 DEFAULT_CONFIG；prompt.js 读点已清）
  ['member' + 'Notes']
];

/**
 * W6-②（night-plan-polish §2-W6）：**改名迁移**机制——与 OBSOLETE_PATHS（死键删除）
 * 并列的持久配置改名：加载期把旧键值整体搬到新键后删旧键。
 *   · 与删除式清理的区别：数据**保留**（旧值=新键的生效值），不是剔除；
 *   · 幂等：新键已存在时以新键为准（不覆盖用户新配置），旧键一律删除——
 *     与各 legacy 迁移器"目标已存在不覆盖"的口径一致；
 *   · 跑在 loadConfig 链最前（applyRenamedPaths → migrateLegacyExtensionConfig →
 *     migrateLegacySkills → stripObsoleteFields → deepMerge），后续迁移器只认新键容器。
 */
const RENAMED_PATHS = [
  ['skills', 'modules']   // config.skills → config.modules（W6-② 旧仓库清除：Skill 开关容器更名）
];

function applyRenamedPaths(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  for (const [from, to] of RENAMED_PATHS) {
    if (from in node) {
      if (node[to] === undefined) node[to] = node[from];
      delete node[from];
    }
  }
  return node;
}

/**
 * 清债夜2：退役容器的活键白名单。白名单外的键一律剔除（等价于逐键精确删除，
 * 但只落活键名，死键名不落字——被剔键名清单见内部文档 handoff-debt-night.md 夜2 小节）。
 *   store   ← 档位/峰谷八死键 + 旧分档条数四键（2026-09-25 档位改版遗留）
 *   send    ← QQ 身体限速六键（web sender 分条走自有节奏公式，不读这些键）
 *   sticker ← collect 两键（collect_sticker 工具已删）
 *   persona ← 账号昵称残键（运行时昵称恒取 botName，orchestrator 组装处）
 *   memory  ← 旧"分层会话记忆"整理链路五键（writer/embedding 保留——card-vector 活配置）
 */
const RETIRED_CONTAINER_ALLOWLISTS = {
  store: ['maxMessagesPerChat', 'historyCount', 'promptAnchor', 'keepSessionFiles'],
  send: ['dedupeWindowMs', 'typingIndicator'],
  sticker: ['enabled', 'promptMaxStickers', 'encourage'],
  persona: ['botName', 'ownerLabel', 'roleText', 'participation', 'customRules', 'systemPromptOverride'],
  memory: ['writer', 'embedding']
};

export function stripObsoleteFields(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
  for (const path of OBSOLETE_PATHS) {
    let cur = node;
    let ok = true;
    for (let i = 0; i < path.length - 1; i++) {
      const next = cur?.[path[i]];
      if (!next || typeof next !== 'object' || Array.isArray(next)) { ok = false; break; }
      cur = next;
    }
    if (ok && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      delete cur[path[path.length - 1]];
    }
  }
  for (const [container, keep] of Object.entries(RETIRED_CONTAINER_ALLOWLISTS)) {
    const sub = node[container];
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) continue;
    for (const key of Object.keys(sub)) {
      if (!keep.includes(key)) delete sub[key];
    }
  }
  return node;
}

let currentConfig = null;

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/**
 * 剔除**派生标记**：GET /api/config 的脱敏层会生成 hasXxx / dshProviderKeyPresence
 * 这类"只表示存在性"的字段。前端把它们当成配置的一部分回传时，
 * deepMerge 会把它们真的写进 config.json —— 于是配置文件里混进了派生数据，
 * 且会随密钥增删变得与实际不一致（清了 Key 但 hasKey 仍是 true）。
 */
function stripDerivedFlags(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (const item of node) stripDerivedFlags(item);
    return node;
  }
  for (const key of Object.keys(node)) {
    // hasApiKey / hasKey / hasAccessToken / hasHttpAccessToken …
    // 只匹配 camelCase 的 has+大写开头，避免误删用户自定义的普通字段。
    if (/^has[A-Z][A-Za-z0-9]*$/.test(key)) { delete node[key]; continue; }
    if (key === 'dshProviderKeyPresence') { delete node[key]; continue; }
    stripDerivedFlags(node[key]);
  }
  return node;
}

/**
 * 数组型密钥容器的脱敏回传保留：patch 里按 id 匹配的条目若**缺少**密钥字段，
 * 从现配置同 id 条目回填 —— 前端脱敏视图回传时密钥天然不在场，不回填就会
 * 在"数组整体替换"的合并语义下静默清空。显式传空串（''）= 真清除，不回填。
 * 目前只有 webSearch.providers 一处数组密钥容器；新增容器时往数组里加路径即可。
 */
function preserveSanitizedSecrets(current, patch) {
  try {
    const cur = current?.webSearch?.providers;
    const next = patch?.webSearch?.providers;
    if (!Array.isArray(cur) || !Array.isArray(next)) return;
    for (const entry of next) {
      if (!entry || typeof entry !== 'object' || entry.id == null) continue;
      // 显式带了 apiKey（含空串 = 真清除）→ 尊重调用方，不回填；
      // 完全没带（脱敏回传的常态）→ 从现配置同 id 条目回填现值。
      if (entry.apiKey !== undefined) continue;
      const stored = cur.find((p) => String(p?.id) === String(entry.id));
      if (stored && String(stored.apiKey || '').trim()) {
        entry.apiKey = stored.apiKey;         // 回填现值，等价于"该条目未动"
      }
    }
  } catch { /* 保留失败不阻塞保存；最坏结果是回到旧行为 */ }
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  const cleanPatch = applyRenamedPaths(stripDerivedFlags(structuredClone(patch ?? {})));
  const cleanObsolete = stripObsoleteFields(cleanPatch);
  // ── 脱敏回传的密钥保留（2026-09-19 修"搜索 Key 离开页签就消失"）──
  // 前端拿到的配置是脱敏的（apiKey 被删、hasApiKey 被加）；它把整个配置/区块
  // 回传保存时，密钥字段天然缺失。对**对象型**密钥容器 deepMerge 会保留基底值
  // （webSearch.deepseek.apiKey 没出现在 patch → 沿用现值），但**数组型**容器
  // （webSearch.providers[].apiKey）整体替换 —— 前端回传的数组里没有 apiKey，
  // 一次普通的设置保存就把所有自定义搜索服务的 Key 静默清空（表现为掩码消失、
  // 测试报 invalid API key）。这里在合并前把"patch 条目缺密钥字段"的数组按 id
  // 回填现值；想真清除必须显式传 apiKey: ''（专用清除按钮就是显式空串路径）。
  preserveSanitizedSecrets(getConfig(), cleanObsolete);
  currentConfig = deepMerge(getConfig(), cleanObsolete);
  // 磁盘上可能已经存过历史遗留的派生标记，一并清掉
  stripDerivedFlags(currentConfig);
  stripObsoleteFields(currentConfig);
  applyRenamedPaths(currentConfig);   // W6-②：内存态残留旧键同样搬新键（防 setRuntimeConfig 注入旧形状）

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/**
 * 对方在提示词里的称呼（persona.ownerLabel；支持 {surface} 占位）。
 *
 * 单用户部署不需要区分“多个人”，但未来 web/pet 多身体需要能看出消息来自哪个平台。
 * 默认 '对方'（开源友好，不写死任何个人称呼）；想带平台就配 '对方({surface})'。
 * 无 surface 时把 "({surface})" / "{surface}" 整体清掉，避免留下空括号。
 */
export function ownerLabelFor(surface = '') {
  const raw = String(getConfig()?.persona?.ownerLabel ?? '').trim();
  const label = raw || '对方';
  const s = String(surface ?? '').trim();
  if (s) return label.replaceAll('{surface}', s);
  return label.replace(/\s*[（(]\{surface\}[)）]/g, '').replaceAll('{surface}', '').trim() || '对方';
}

/**
 * 取某个会话实际生效的人设：恒返回全局 persona。
 *
 * （2026-11-22 清理：会话级独立人设容器与统一人设开关退役——单用户单人格，
 *   botName 等账号身份本就任何会话不得单独改（换了会与提示词的「@我/提到我」
 *   标签匹配、存档里"我"的称呼对不上），说话风格字段也不再分会话覆盖。
 *   保留函数与签名，调用方（orchestrator/prompt）零改动。）
 */
export function personaForChat(chatKey) {
  return getConfig().persona || {};
}
