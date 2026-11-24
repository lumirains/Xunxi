// 把 agent 的 Markdown 回复转成适合聊天气泡展示的纯文本。（自早期实现移植；
// QQ 时代的 splitForQQ 长度切分已随 2026-11-19 全库体检移除——零引用，见 内部文档 codebase-audit-20261119.md）

export function mdToPlain(md) {
  let s = String(md ?? '');
  // 代码块：保留内容，去掉围栏
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''));
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片/链接：保留文字，链接附在括号里（QQ 可点）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => (alt || url));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 粗体/斜体/删除线标记
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 标题符
  s = s.replace(/^#{1,6}\s+/gm, '');
  // 引用符
  s = s.replace(/^>\s?/gm, '');
  // 列表符
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  // 表格：按行保留文本
  s = s.split('\n').filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.includes('|') === false || /\S/.test(line.replace(/[\s:|-]/g, ''))).join('\n');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  // 折叠的连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
