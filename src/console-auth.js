// 控制台令牌认证辅助（E6 · 白皮书 §7.9「单用户 ≠ 无认证」/ night-plan-pwa R2）。
//
// 三通道（authorize 的裁决顺序）：cookie（新增）> x-console-token 头 > token='' 免检。
// ⚠️ 旧 ?token= query 通道按白皮书 E6 **明文移除**——query 会进访问日志、浏览器历史
//    与 Referer 头，是凭证泄露面；本模块刻意不提供任何 query 相关工具。
//
// 只放纯逻辑（不 import config/http）——app.js（authorize/keyEndpointAllowed 的
// cookie 通道）与 routes.js（POST /api/auth/login 的校验与下发）两个消费者共享
// 同一份 cookie 名与比较口径，避免两处漂移。
import crypto from 'node:crypto';

/** 配对令牌 cookie 名。值侧 encodeURIComponent 编码（token 可能含 ; 空格等非法字符）。 */
export const CONSOLE_COOKIE = 'xunxi_console_token';

/**
 * 从请求 Cookie 头解析控制台令牌值。
 * 只认 `xunxi_console_token=<value>` 一个键；无头/无形/未编码残留 → ''。
 * 不做签名校验——cookie 由服务端 Set-Cookie 下发且 HttpOnly，浏览器侧伪造
 * 等价于"猜中令牌明文"，安全性同 header 通道（都是凭值比对）。
 */
export function consoleCookieOf(req) {
  const raw = String(req?.headers?.cookie ?? '');
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (name !== CONSOLE_COOKIE) continue;
    try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return ''; }
  }
  return '';
}

/** Set-Cookie 值：HttpOnly（JS 不可读）+ SameSite=Strict（跨站请求不带）+ Path=/（全站有效）。 */
export function consoleCookieValue(token) {
  return `${CONSOLE_COOKIE}=${encodeURIComponent(String(token))}; HttpOnly; SameSite=Strict; Path=/`;
}

/**
 * 登录端点的令牌校验：双侧 SHA-256 摘要后 crypto.timingSafeEqual。
 *
 * 为什么不直接逐字节循环比较：普通比较在第一个失配字节即返回，攻击者可按
 * "响应耗时逐位爆破"（时序侧信道）。timingSafeEqual 恒定时，但它要求等长输入，
 * 而先比长度本身就泄露"长度是否相等"这一比特——对本地单用户程序的配对令牌，
 * 长度并非必须保护的秘密，不过摘要后比较（恒 32 字节、恒定时）连这一比特都不
 * 泄露，实现同样只有三行，故取更强口径。
 */
export function consoleTokenMatches(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(expected ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}
