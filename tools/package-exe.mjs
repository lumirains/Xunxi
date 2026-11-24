// package-exe.mjs —— 打包桌面版发行目录（所有者自用脚本，可作参考）
//
// 做什么：
//   1. 用已验证的 electron 运行时（仓库外层目录的 exe/dll/pak）+ 当前 git 源码树
//      + node_modules + frontend/dist，组装独立发行目录（exe 直读 resources/app）。
//   2. 用 rcedit 给发行版 exe 写入品牌图标与版本信息——否则 Electron 运行时 exe
//      会继续挂着旧项目名/旧版权（图标、CompanyName、FileDescription 都是烙在
//      PE 资源段里的，复制文件不会改）。
//   3. 剔除：data/（私有数据）、docs/（内部档案）、.git、frontend/node_modules。
//
// 不变量：**发行包里的 resources/app 必须与公开仓库逐文件一致**——所以源码取自
// `git archive HEAD`（tracked 干净树），而不是工作区。
//
// 用法：node tools/package-exe.mjs   （下面三个路径常量按机器改）
// 输出：D:/Projects/QQAgent/Xunxi-dev-package/Xunxi/
//
// 注意：本脚本会先删除整个 Xunxi-dev-package 目录（含上一次的发行 zip）。
import {
  readFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync, cpSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const RUNTIME = 'D:/Projects/QQAgent/Xunxi';                    // electron 运行时所在（exe 同级）
const APP = 'D:/Projects/QQAgent/Xunxi-public-prep/Xunxi';      // 源码树（= 公开仓库，git 仓库根）
const OUTROOT = 'D:/Projects/QQAgent/Xunxi-dev-package';
const OUT = OUTROOT + '/Xunxi';
const APP_OUT = OUT + '/resources/app';
const EXE_NAME = 'Xunxi.exe';

// 发行版 exe 的元信息（图标与版本信息都要显式写，否则沿用旧项目身份）
const BRAND = {
  productName: 'Xunxi',
  fileDescription: 'Xunxi 浔汐 · 私人 AI 伴侣',
  companyName: 'lumirains',
  internalName: 'Xunxi',
  originalFilename: EXE_NAME,
  // MIT 双署名：qq-agent 原始作者与 Xunxi 改造者都要保留
  legalCopyright: 'Copyright © 2026 Kondius (qq-agent 原始作者) · lumirains (Xunxi 改造与维护) · MIT License',
  comments: '一个运行在自己电脑上的私人 AI 伴侣',
};

// 版本号从 package.json 取，"0.1.0-dev" → "0.1.0.0"（Windows 要四段数值）
const pkg = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8'));
const numericVersion = (v) => {
  const core = String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  return [...core, 0, 0].slice(0, 4).join('.');
};

// rcedit：优先用仓库里的 node_modules，其次找运行时目录旁的；都没有就跳过（不阻断打包）
function resolveRcedit() {
  const candidates = [
    path.join(APP, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe'),
    path.join(APP, 'node_modules', 'rcedit', 'bin', 'rcedit.exe'),
    'D:/Projects/QQAgent/Xunxi/resources/app/node_modules/rcedit/bin/rcedit-x64.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

// 1) 清输出（连同上一次的发行 zip）
rmSync(OUTROOT, { recursive: true, force: true });
mkdirSync(APP_OUT, { recursive: true });

// 2) 运行时白名单（顶层文件 + locales/）
const RT_FILES = readdirSync(RUNTIME).filter((f) => {
  const st = statSync(path.join(RUNTIME, f));
  if (st.isDirectory()) return f === 'locales';
  if (f === EXE_NAME) return true;
  return /\.(dll|pak|dat|bin|json|rtf|txt|html)$/i.test(f) && !/desktop-school/i.test(f);
});
for (const f of RT_FILES) {
  const src = path.join(RUNTIME, f);
  const dst = path.join(OUT, f);
  if (statSync(src).isDirectory()) cpSync(src, dst, { recursive: true });
  else cpSync(src, dst);
}
console.log('runtime files:', RT_FILES.join(', '));

// 3) 源码树 = git archive（tracked 干净树，与公开仓库一致）
//    先落成临时 tar 再解包：Windows 上 git archive | tar 的管道不稳。
const tarPath = OUTROOT + '/_app.tar';
execSync(`git -C "${APP}" archive -o "${tarPath}" HEAD`, { stdio: 'inherit' });
execSync(`tar -xf "${tarPath}" -C "${APP_OUT}"`, { stdio: 'inherit' });
rmSync(tarPath, { force: true });

// 4) 运行时依赖：根 node_modules（含 vendor electron-ABI 内建）+ frontend/dist
cpSync(path.join(APP, 'node_modules'), path.join(APP_OUT, 'node_modules'), { recursive: true });
cpSync(path.join(APP, 'frontend', 'dist'), path.join(APP_OUT, 'frontend', 'dist'), { recursive: true });

// 5) 给 exe 写图标与版本信息
const exePath = path.join(OUT, EXE_NAME);
const rcedit = resolveRcedit();
const iconPath = path.join(APP, 'assets', 'icon.ico');
if (rcedit && existsSync(iconPath)) {
  execSync(`"${rcedit}" "${exePath}"`
    + ` --set-icon "${iconPath}"`
    + ` --set-version-string CompanyName "${BRAND.companyName}"`
    + ` --set-version-string ProductName "${BRAND.productName}"`
    + ` --set-version-string FileDescription "${BRAND.fileDescription}"`
    + ` --set-version-string InternalName "${BRAND.internalName}"`
    + ` --set-version-string OriginalFilename "${BRAND.originalFilename}"`
    + ` --set-version-string LegalCopyright "${BRAND.legalCopyright}"`
    + ` --set-version-string Comments "${BRAND.comments}"`
    + ` --set-file-version ${numericVersion(pkg.version)}`
    + ` --set-product-version ${numericVersion(pkg.version)}`, { stdio: 'inherit' });
  console.log('exe icon + version info written:', numericVersion(pkg.version));
} else {
  console.warn('[warn] rcedit 或 icon.ico 未找到，发行版 exe 将保留运行时原有图标/版本信息');
  console.warn('       装 rcedit：npm i -D rcedit   （或在 APP/node_modules/rcedit 可见时重跑）');
}

// 6) 确认无敏感物
const banned = ['data', '.git', 'docs'];
for (const b of banned) {
  if (existsSync(path.join(APP_OUT, b))) { console.error('SENSITIVE PATH REMAINS:', b); process.exit(1); }
}
if (existsSync(path.join(OUT, 'data'))) { console.error('top-level data remains'); process.exit(1); }

// 7) 大小报告
let total = 0;
const walk = (d) => { for (const f of readdirSync(d)) { const st = statSync(path.join(d, f)); if (st.isDirectory()) walk(path.join(d, f)); else total += st.size; } };
walk(OUT);
console.log('package assembled:', OUT);
console.log('package size:', (total / 1048576).toFixed(1), 'MB');
