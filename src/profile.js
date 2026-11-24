// Profile identity is deliberately limited to a numeric instance id.
// W6-①：env 更名 QQ_AGENT_PROFILE → XUNXI_PROFILE（旧名兼容 fallback，优先新名）。
const rawProfile = String(process.env.XUNXI_PROFILE ?? process.env.QQ_AGENT_PROFILE ?? '').trim();

export const PROFILE_ID = /^\d+$/.test(rawProfile) ? rawProfile : '';

export function isSecondary() {
  return PROFILE_ID !== '';
}

export function profileSuffix() {
  return isSecondary() ? `-${PROFILE_ID}` : '';
}

export function dataDirName() {
  return `data${profileSuffix()}`;
}

export function portOffset() {
  // 每个实例偏移 PROFILE_ID * 100：#2 → +100、#3 → +200。
  // 恒 100 的旧实现会让 #2 和 #3 的 HTTP/WS 端口互撞。
  return isSecondary() ? Number(PROFILE_ID) * 100 : 0;
}

export function describeInstance() {
  return isSecondary() ? `Xunxi #${PROFILE_ID}` : 'Xunxi';
}
