/**
 * ensure-electron-dist.mjs — 保证 node_modules/electron/dist 是一「能跑」的 Electron 发行版。
 *
 * 为什么需要它（2026-10-22 实测）：
 *   1. `electron-builder --mac` 跑完会把 dist 里的 Electron.app 带走，只剩
 *      LICENSE / LICENSES.chromium.html / version → 之后 `npm run electron:dev`
 *      连窗口都开不起来，而且报错信息是「corrupted Electron dist」，看不出根因。
 *   2. 从 ~/Library/Caches/electron 的官方 zip 重新解压出来的那份，主二进制是
 *      linker-signed（flags=0x20002，无 CMS blob），在 Apple Silicon 上一执行就
 *      被内核 SIGKILL（exit 137）。打包产物能跑是因为 after-pack-sign.cjs 给它
 *      补过签名；开发态这份没人补，所以必须自己补一次 ad-hoc 签名。
 *
 * 因此这里做三件事：验（真跑一次 --version）→ 缺就解（ditto 从缓存 zip）→ 补签名。
 * 全程只动 node_modules/electron/dist，不碰任何用户数据。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const DIST = join(ROOT, 'node_modules', 'electron', 'dist');
const PKG = join(ROOT, 'node_modules', 'electron', 'package.json');

if (process.platform !== 'darwin') {
  console.log(`[electron-dist] 非 macOS（${process.platform}），跳过`);
  process.exit(0);
}

const electronVersion = JSON.parse(readFileSync(PKG, 'utf8')).version;
const binary = join(DIST, 'Electron.app', 'Contents', 'MacOS', 'Electron');

function probe() {
  if (!existsSync(binary)) return '缺 Electron.app';
  const r = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  if (r.error) return `执行失败：${r.error.message}`;
  if (r.status !== 0) return `退出码 ${r.status}${r.signal ? `（${r.signal}）` : ''}`;
  if (!String(r.stdout).includes(electronVersion)) {
    return `版本不符：报 ${String(r.stdout).trim()}，期望 ${electronVersion}`;
  }
  return '';
}

function findCacheZip() {
  const name = `electron-v${electronVersion}-darwin-${process.arch}.zip`;
  const roots = [
    join(homedir(), 'Library', 'Caches', 'electron'),
    join(ROOT, '.electron-cache'),
  ];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const hit = entry.isDirectory()
        ? join(dir, entry.name, name)
        : (entry.name === name ? join(dir, entry.name) : '');
      if (hit && existsSync(hit)) return hit;
    }
  }
  return '';
}

let reason = probe();
if (!reason) {
  console.log(`[electron-dist] 完好，可直接用于开发态（Electron ${electronVersion}）`);
  process.exit(0);
}

console.log(`[electron-dist] 不可用：${reason}；开始修复`);
const zip = findCacheZip();
if (!zip) {
  console.error(
    `[electron-dist] 本机没有 ${electronVersion} 的官方 zip，修不了。\n`
    + '  手动补一次（任选）：\n'
    + `    npx @electron/get electron-v${electronVersion}-darwin-${process.arch}.zip\n`
    + '    rm -rf node_modules/electron && npm install electron',
  );
  process.exit(1);
}
console.log(`[electron-dist] 用缓存解出：${zip}`);
const unzip = spawnSync('ditto', ['-x', '-k', zip, DIST], { stdio: 'inherit' });
if (unzip.status !== 0) {
  console.error(`[electron-dist] 解压失败（退出码 ${unzip.status}）`);
  process.exit(1);
}
const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', join(DIST, 'Electron.app')], {
  stdio: 'inherit',
});
if (sign.status !== 0) {
  console.error(`[electron-dist] ad-hoc 签名失败（退出码 ${sign.status}）`);
  process.exit(1);
}

reason = probe();
if (reason) {
  console.error(`[electron-dist] 修完仍不可用：${reason}`);
  process.exit(1);
}
console.log(`[electron-dist] 已恢复并 ad-hoc 签名，Electron ${electronVersion} 可用`);
