// 前端构建驱动（Phase 9 M1 门禁用）：
//   node tools/build-frontend.mjs
// 为什么存在：门禁经 world.run("cmd", ["/c", 'cd /d "<路径>" && npm run build']) 时，
// JSON.stringify 的引号与 Node 对 cmd 参数的转义（\"）相互碰撞，cd 拿到带字面量
// 引号的路径 → Windows ERROR 123。本驱动用 Node 原生 spawnSync + cwd 选项，
// 完全绕开 cmd 的引号解析；vue-tsc 与 vite 都直接用 node 执行（不经 .cmd）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(HERE, '..', 'frontend');

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { cwd: FRONT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    console.error(`[${label}] 失败 (exit ${r.status})`);
    if (r.stdout) console.error(r.stdout.slice(-3000));
    if (r.stderr) console.error(r.stderr.slice(-3000));
    process.exit(r.status ?? 1);
  }
  return r;
}

if (!fs.existsSync(path.join(FRONT, 'package.json'))) {
  console.error(`frontend 目录不存在或缺少 package.json：${FRONT}`);
  process.exit(1);
}

// 与 frontend/package.json 的 build 脚本（vue-tsc -b && vite build）同口径，
// 但直接用 node 执行 JS 入口，绕开 .cmd 与 cmd.exe 的引号解析。
run(process.execPath, ['node_modules/vue-tsc/bin/vue-tsc.js', '-b'], 'vue-tsc');
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], 'vite');

if (!fs.existsSync(path.join(FRONT, 'dist', 'index.html'))) {
  console.error('dist/index.html 缺失');
  process.exit(1);
}
console.log('FRONTEND BUILD OK（vue-tsc + vite + dist 产物齐全）');
