// package-exe.mjs —— 打包桌面版（所有者 2026-11-21）
// 用已验证的 electron 运行时（仓库外层目录的 exe/dll/pak）+ 当前 git 源码树
//   + node_modules + frontend/dist，组装独立发行目录（exe 直读 resources/app）。
// 剔除：data/（私有数据）、docs/（内部档案）、.git、frontend/node_modules。
// 用法：node tools/package-exe.mjs   （三个路径常量按机器改）
// 输出：D:/Projects/QQAgent/Xunxi-dev-package/Xunxi/
// 剔除：data/（私有数据）、docs/（内部档案）、.git、frontend/node_modules、_archive
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const RUNTIME = 'D:/Projects/QQAgent/Xunxi';          // electron 运行时所在（exe 同级）
const APP = 'D:/Projects/QQAgent/Xunxi/resources/app'; // 源码树（git 仓库根）
const OUT = 'D:/Projects/QQAgent/Xunxi-dev-package/Xunxi';

// 1) 清输出
rmSync('D:/Projects/QQAgent/Xunxi-dev-package', { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// 2) 运行时白名单（顶层文件 + locales/）
const RT_FILES = readdirSync(RUNTIME).filter((f) => {
  const st = statSync(path.join(RUNTIME, f));
  if (st.isDirectory()) return f === 'locales';
  if (f === 'Xunxi.exe') return true;
  return /\.(dll|pak|dat|bin|json|rtf|txt|html)$/i.test(f) && !/desktop-school/i.test(f);
});
for (const f of RT_FILES) {
  execSync(`cp -r "${path.join(RUNTIME, f)}" "${OUT}"`);
}
console.log('runtime files:', RT_FILES.join(', '));

// 3) 源码树 = git archive（tracked 干净树）
const APP_OUT = path.join(OUT, 'resources', 'app');
mkdirSync(APP_OUT, { recursive: true });
const APP_OUT_POSIX = '/' + APP_OUT.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1'.toLowerCase() === 'd' ? 'd' : (m) => m[1].toLowerCase());
// 直接把 D:/ → /d/：
const posix = (p) => '/' + p[0].toLowerCase() + p.slice(2).replace(/\\/g, '/');
execSync(`git -C "${APP}" archive HEAD | tar -x -C "${posix(APP_OUT)}"`);
// git archive 不含 data/node_modules/dist（untracked）——docs/ 私档在 tracked 里，删掉
rmSync(path.join(APP_OUT, 'docs'), { recursive: true, force: true });

// 4) 运行时依赖：根 node_modules（含 vendor electron-ABI 内建）+ frontend/dist
execSync(`cp -r "${path.join(APP, 'node_modules')}" "${path.join(APP_OUT, 'node_modules')}"`);
execSync(`cp -r "${path.join(APP, 'frontend', 'dist')}" "${path.join(APP_OUT, 'frontend', 'dist')}"`);

// 5) 确认无敏感物
const banned = ['data', '.git', 'docs'];
for (const b of banned) {
  if (existsSync(path.join(APP_OUT, b))) { console.error('SENSITIVE PATH REMAINS:', b); process.exit(1); }
}
if (existsSync(path.join(OUT, 'data'))) { console.error('top-level data remains'); process.exit(1); }
console.log('package assembled:', OUT);

// 6) 大小报告
let total = 0;
const walk = (d) => { for (const f of readdirSync(d)) { const st = statSync(path.join(d, f)); if (st.isDirectory()) walk(path.join(d, f)); else total += st.size; } };
walk(OUT);
console.log('package size:', (total / 1048576).toFixed(1), 'MB');
