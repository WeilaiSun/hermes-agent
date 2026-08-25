#!/usr/bin/env node
/**
 * sandbox-smoke.mjs — 新 asar 沙箱冒烟验证（升级流程专用，2026-08-25 v2）
 *
 * 目标：在替换真桌面之前，验证热构建的 app.asar 能启动、UI 渲染、不崩。
 * 原理：不复制 382MB 骨架——同盘 hardlink win-unpacked 的运行时文件（秒级，
 *       运行中的 exe 也能链接），沙箱目录只真实写入新 asar + unpacked dist，
 *       隔离启动（独立 userData + HERMES_HOME，官方 dev-mock 同款机制）。
 *
 * 用法（前置：hot-build-asar.mjs 已产出 release/hot-update/app.asar.new）：
 *   cd apps/desktop
 *   node scripts/sandbox-smoke.mjs            # 默认 60s 存活观察
 *   node scripts/sandbox-smoke.mjs --keep     # 保留沙箱目录供人工检查
 *
 * 产出：release/sandbox-smoke/<stamp>/  临时沙箱（默认结束即删）
 *
 * ⚠️ 铁律：本脚本绝不杀/碰运行中的 win-unpacked 进程，绝不改写真实
 *         resources/ 下任何文件。hardlink 不修改源文件，只增加目录项。
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(__dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const releaseDir = join(appRoot, 'release')
const winUnpacked = join(releaseDir, 'win-unpacked')
const hotUpdate = join(releaseDir, 'hot-update')

const KEEP = process.argv.includes('--keep')
const OBSERVE_SECONDS = 60

function fail(msg) {
  console.error(`[smoke] ✗ ${msg}`)
  process.exit(1)
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

// ---- 0. 前置检查 ----
const newAsar = join(hotUpdate, 'app.asar.new')
const newUnpacked = join(hotUpdate, 'app.asar.new.unpacked', 'dist')
if (!existsSync(newAsar)) fail('release/hot-update/app.asar.new 不存在 —— 先跑 node scripts/hot-build-asar.mjs')
if (!existsSync(newUnpacked)) fail('release/hot-update/app.asar.new.unpacked/dist 不存在')
if (!existsSync(join(winUnpacked, 'Hermes.exe'))) fail(`未找到 ${winUnpacked}\\Hermes.exe`)

console.log(`[smoke] 新包: ${statSync(newAsar).size} bytes (${statSync(newAsar).mtime.toISOString()})`)

// ---- 1. 建沙箱（hardlink 骨架，秒级）----
const sandboxRoot = join(releaseDir, 'sandbox-smoke')
mkdirSync(sandboxRoot, { recursive: true })
const sandbox = join(sandboxRoot, stamp())
console.log(`[smoke] hardlink 骨架 win-unpacked → ${sandbox}`)

function linkTree(srcDir, dstDir, { skipDirs = [], skipFiles = [] } = {}) {
  mkdirSync(dstDir, { recursive: true })
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name)
    const dst = join(dstDir, entry.name)
    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue
      linkTree(src, dst, { skipDirs, skipFiles })
    } else if (entry.isFile()) {
      if (skipFiles.includes(entry.name)) continue
      try {
        linkSync(src, dst)
      } catch (err) {
        if (err.code === 'EXDEV' || err.code === 'EPERM') {
          cpSync(src, dst) // 跨盘/不可链接 → 拷贝兜底（小文件）
        } else {
          throw err
        }
      }
    }
  }
}

const t0 = Date.now()
// 全部 hardlink；跳过旧 asar 产物（沙箱内换成新包）
linkTree(winUnpacked, sandbox, {
  skipFiles: ['app.asar', 'default_app.asar'],
  skipDirs: ['app.asar.unpacked'],
})
console.log(`[smoke] 骨架就绪 (${((Date.now() - t0) / 1000).toFixed(1)}s, hardlink)`)

// ---- 2. 装入新 asar ----
const sandboxResources = join(sandbox, 'resources')
mkdirSync(join(sandboxResources, 'app.asar.unpacked'), { recursive: true })
cpSync(newAsar, join(sandboxResources, 'app.asar'))
cpSync(newUnpacked, join(sandboxResources, 'app.asar.unpacked', 'dist'), { recursive: true })
console.log('[smoke] 新 asar + unpacked dist 已装入沙箱')

// ---- 3. 隔离启动 ----
const userDataDir = join(sandbox, '.smoke-user-data')
const hermesHome = join(sandbox, '.smoke-hermes-home')
mkdirSync(userDataDir, { recursive: true })
mkdirSync(hermesHome, { recursive: true })

// ⚠️ 路径给 Node/Electron 必须用 Windows 原生格式
const toWin = (p) => p.replace(/\//g, '\\')

const env = {
  ...process.env,
  HERMES_DESKTOP_USER_DATA_DIR: toWin(userDataDir),
  HERMES_HOME: toWin(hermesHome),
  HERMES_DESKTOP_IGNORE_EXISTING: '1',
  HERMES_DESKTOP_HERMES_ROOT: toWin(repoRoot),
  HERMES_DESKTOP_APP_NAME: 'HermesSmokeSandbox',
  HERMES_DESKTOP_CDP_PORT: '9223', // 与真桌面 dev-server 的 9222 错开
}
delete env.HERMES_DESKTOP_HERMES
// 沙箱内后端拿不到真 key 也不影响冒烟（UI 渲染验证不需要推理）
for (const k of Object.keys(env)) {
  if (/^(OPENAI|ANTHROPIC|GEMINI|DASHSCOPE|MOONSHOT|KIMI|DEEPSEEK|ZHIPU|ZAI)_API_KEY$/.test(k)) delete env[k]
}

console.log(`[smoke] 隔离启动 ${sandbox}\\Hermes.exe (存活观察 ${OBSERVE_SECONDS}s)`)
const t1 = Date.now()
const child = spawn(join(sandbox, 'Hermes.exe'), [], {
  cwd: sandbox,
  env,
  detached: true,
  stdio: 'ignore',
})
child.unref()

// ---- 4. 存活观察 + 渲染验证 ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, { label, timeoutMs, intervalMs = 1000 }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(intervalMs)
  }
  fail(`等待超时: ${label} (${timeoutMs / 1000}s)`)
}

const report = { startedAt: new Date().toISOString(), pid: child.pid, checks: {} }

// 4.1 进程启动并存活
await waitFor(() => {
  try { process.kill(child.pid, 0); return true } catch { return false }
}, { label: '沙箱进程启动', timeoutMs: 30_000 })
console.log(`[smoke] ✓ 进程已启动 (PID ${child.pid})`)

// 4.2 渲染验证：userData 里出现 Electron 渲染痕迹
const renderMarkers = [
  join(userDataDir, 'Local State'),
  join(userDataDir, 'window-state.json'),
  join(userDataDir, 'Sessions'),
]
await waitFor(() => renderMarkers.some(existsSync), { label: '渲染器初始化痕迹', timeoutMs: 30_000 })
console.log('[smoke] ✓ 渲染器初始化痕迹出现 (Local State / window-state)')

// 4.3 持续存活：观察期内进程不崩（Electron 主进程不会 fork-and-exit，pid 追踪有效）
for (let i = 0; i < OBSERVE_SECONDS; i += 5) {
  await sleep(5000)
  try { process.kill(child.pid, 0) } catch {
    fail(`沙箱进程在观察期内退出 (t+${((Date.now() - t1) / 1000).toFixed(0)}s)`)
  }
  process.stdout.write(`  存活 t+${i + 5}s\r`)
}
console.log('')
console.log(`[smoke] ✓ ${OBSERVE_SECONDS}s 存活观察通过`)

report.checks = {
  processStarted: true,
  rendererInitialized: true,
  aliveAfter60s: true,
}
report.passedAt = new Date().toISOString()

// ---- 5. 关闭 + 清理 ----
// ⚠️ 沙箱 Electron 会 spawn Python 后端子进程（与真桌面后端同 venv 路径，按
//    ExecutablePath 过滤杀不掉），必须用 taskkill /T 杀整棵进程树。
console.log('[smoke] 关闭沙箱进程树 (taskkill /T)...')
const killRes = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' })
if (killRes.status !== 0) console.log('[smoke] (taskkill 非零退出，可能进程已自行退出)')
await sleep(3000)

writeFileSync(join(sandbox, 'smoke-report.json'), JSON.stringify(report, null, 2))

if (KEEP) {
  console.log(`[smoke] --keep 模式：沙箱保留在 ${sandbox}（人工检查后删除）`)
} else {
  console.log('[smoke] 清理沙箱目录...')
  rmSync(sandbox, { recursive: true, force: true })
  console.log('[smoke] ✓ 沙箱已清理')
}

console.log(`
[smoke] ════════════════════════════════════════════════════
  冒烟验证 PASS ✅
    - 新 asar 可启动、渲染器初始化、${OBSERVE_SECONDS}s 不崩
    - 下一步：请用户执行替换命令（关UI→备份→替换→验证→重启）：
      powershell -NoProfile -ExecutionPolicy Bypass -File "${toWin(join(appRoot, 'scripts', 'hot-swap-asar.ps1'))}"
[smoke] ═══════════════════════════════════════════════════`)
