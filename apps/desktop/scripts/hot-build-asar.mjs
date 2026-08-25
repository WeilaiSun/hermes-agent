#!/usr/bin/env node
/**
 * Hermes 桌面端「热构建」asar 脚本（2026-08-12，v3 流程）
 *
 * 用途：在 Hermes 桌面端【运行中】直接构建新的 app.asar + renderer，
 *       不需要关闭桌面端、不碰任何被运行中进程锁定的文件。
 *       构建产物是"新文件"，最后替换动作交给用户执行 hot-swap-asar.ps1。
 *
 * 用法：
 *   cd apps/desktop
 *   npm run build                    # 先构建 dist（或确认 dist 已是最新）
 *   node scripts/hot-build-asar.mjs  # 生成热更新包
 *
 * 产出：
 *   release/hot-update/app.asar.new           ← 新 asar（dist 按 asarUnpack 外置）
 *   release/hot-update/unpacked-dist/         ← 新 renderer（对应 app.asar.unpacked/dist）
 *
 * 然后让用户执行：
 *   powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/hot-swap-asar.ps1
 *
 * 原理：electron-builder 的 asarUnpack 规则（dist 整体外置、node 原生模块外置）
 *       会把 dist/ 整体外置到 app.asar.unpacked/dist/，app.asar 只有 ~8.5MB
 *       （主进程 + assets + public + package.json + dist 的索引占位）。
 *       这里用 @electron/asar createPackageWithOptions({unpackDir:'dist/**'})
 *       复刻完全一致的结构（实测 415 文件、顶层 4 项全等）。
 *
 * ⚠️ 铁律：本脚本只写"新文件"，绝不删/改 release/win-unpacked 下任何运行中
 *         被锁定的文件，也绝不杀任何进程（杀 Hermes.exe = 杀承载 agent 的宿主）。
 */

import { createPackageWithOptions } from '@electron/asar'
import { cpSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, '..')
const distDir = join(appRoot, 'dist')
const outDir = join(appRoot, 'release', 'hot-update')

function fail(msg) {
  console.error(`[hot-build] ✗ ${msg}`)
  process.exit(1)
}

// ---- 0. 前置检查 ----
if (!existsSync(join(distDir, 'index.html'))) {
  fail('dist/index.html 不存在 —— 请先运行 npm run build')
}
console.log(`[hot-build] dist OK: ${statSync(join(distDir, 'index.html')).size} bytes`)

// ---- 1. 组装打包目录（与 electron-builder "files" 一致：dist + assets + public + package.json）----
const stageDir = join(outDir, '.stage')
rmSync(stageDir, { recursive: true, force: true })
mkdirSync(stageDir, { recursive: true })

for (const name of ['dist', 'assets', 'public']) {
  const src = join(appRoot, name)
  if (!existsSync(src)) fail(`缺少 ${name}/ —— 不应发生`)
  cpSync(src, join(stageDir, name), { recursive: true })
}
cpSync(join(appRoot, 'package.json'), join(stageDir, 'package.json'))

// ---- 2. 打包 app.asar.new（复刻 electron-builder asarUnpack）----
const newAsar = join(outDir, 'app.asar.new')
rmSync(newAsar, { force: true })
await createPackageWithOptions(stageDir, newAsar, {
  unpackDir: 'dist/**' // 与 package.json build.asarUnpack 的 "dist/**" 对应
})
console.log(`[hot-build] ✓ app.asar.new 生成: ${statSync(newAsar).size} bytes`)

// ---- 3. 产物说明（renderer 在 @electron/asar 自动生成的 <out>.unpacked/ 里）----
const unpackedAuto = newAsar + '.unpacked'
if (!existsSync(join(unpackedAuto, 'dist'))) {
  fail('未找到 @electron/asar 生成的 .unpacked/dist —— 打包异常')
}
console.log(`[hot-build] ✓ unpacked renderer 生成: ${unpackedAuto}\\dist`)

// ---- 4. 清理 stage ----
rmSync(stageDir, { recursive: true, force: true })

console.log(`
[hot-build] ════════════════════════════════════════════════════
  热构建完成，共 2 个产物：
    1. ${newAsar}
    2. ${unpackedAuto}\\dist\\   （renderer，对应运行时的 app.asar.unpacked\\dist）
  （均是新文件，未触碰运行中的 win-unpacked，可随时安全重复执行）

  下一步：请用户执行替换命令（会关闭桌面端 → 替换 → 验证 → 重启）：
    powershell -NoProfile -ExecutionPolicy Bypass -File \\
      "F:\\Hermes\\HERMES_HOME\\hermes-agent\\apps\\desktop\\scripts\\hot-swap-asar.ps1"
[hot-build] ════════════════════════════════════════════════════`)
