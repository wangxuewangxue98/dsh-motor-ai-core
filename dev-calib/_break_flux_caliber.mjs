/**
 * P0-8 反向破坏验证（2026-10-31）
 * ---------------------------------------------------------------------------
 * 纪律（来自 P0-7 教训）：
 *   ① 每个场景独立 patch → 立即跑门禁 → 立即 restore；
 *   ② restore() **绝不删备份**（多场景复用；否则第二次 restore 静默失效）；
 *   ③ 每个场景必须"变红"，且场景结束后必须"回绿" ⇒ 证明门禁有区分力。
 * 用法：node dev-calib/_break_flux_caliber.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const FILES = {
  fe: 'lib/formula-engine.mjs',
  dr: 'lib/design-rules.mjs',
}
const NODE = process.execPath
const TEST = 'tests/flux-caliber.test.mjs'

const backups = new Map()
const backup = (f) => {
  if (!backups.has(f)) backups.set(f, readFileSync(ROOT + f, 'utf8'))
}
const restore = (f) => {
  if (backups.has(f)) writeFileSync(ROOT + f, backups.get(f), 'utf8')
}
const patch = (f, from, to) => {
  backup(f)
  const src = readFileSync(ROOT + f, 'utf8')
  if (!src.includes(from)) throw new Error(`[${f}] 未找到破坏锚点: ${from.slice(0, 60)}`)
  writeFileSync(ROOT + f, src.replace(from, to), 'utf8')
}
const runGate = () => {
  try {
    const out = execFileSync(NODE, ['--test', TEST], { cwd: ROOT, encoding: 'utf8' })
    const pass = Number(/# pass (\d+)/.exec(out)?.[1] ?? 0)
    const fail = Number(/# fail (\d+)/.exec(out)?.[1] ?? 0)
    return { pass, fail, ok: fail === 0 }
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '')
    const pass = Number(/# pass (\d+)/.exec(out)?.[1] ?? 0)
    const fail = Number(/# fail (\d+)/.exec(out)?.[1] ?? 0)
    return { pass, fail, ok: false }
  }
}
const runAll = () => {
  try {
    const out = execFileSync(NODE, ['--test', 'tests/*.test.mjs'], { cwd: ROOT, encoding: 'utf8' })
    return { pass: Number(/# pass (\d+)/.exec(out)?.[1] ?? 0), fail: Number(/# fail (\d+)/.exec(out)?.[1] ?? 0) }
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '')
    return { pass: Number(/# pass (\d+)/.exec(out)?.[1] ?? 0), fail: Number(/# fail (\d+)/.exec(out)?.[1] ?? 0) }
  }
}

const SCENARIOS = [
  {
    id: 'S1 去掉 π/2 换算（peak 直接取平均口径）',
    patch: () => patch(FILES.fe,
      'round2(toothBActualRaw * TOOTH_PEAK_OVER_MEAN)',
      'round2(toothBActualRaw)'),
    undo: () => restore(FILES.fe),
  },
  {
    id: 'S2 V07 峰值门禁分支恒不执行',
    patch: () => patch(FILES.dr, 'if (toothPeakGateOn(opts)) {', 'if (false) {'),
    undo: () => restore(FILES.dr),
  },
  {
    id: 'S3 k_E 开关失效（恒返回默认 1.0）',
    patch: () => patch(FILES.fe,
      'return Number.isFinite(n) && n > 0 && n <= 1 ? n : BACKEMF_DROP_DEFAULT',
      'return BACKEMF_DROP_DEFAULT'),
    undo: () => restore(FILES.fe),
  },
  {
    id: 'S4 轭磁密被误乘 π/2（口径串台）',
    patch: () => patch(FILES.fe,
      'yoke_flux_density_peak: yokeBActual,',
      'yoke_flux_density_peak: round2(yokeBActualRaw * TOOTH_PEAK_OVER_MEAN),'),
    undo: () => restore(FILES.fe),
  },
  {
    id: 'S5 意图口径峰值字段漏换算',
    patch: () => patch(FILES.fe,
      'tooth_flux_density_intent_peak: round2(toothBraw * TOOTH_PEAK_OVER_MEAN),',
      'tooth_flux_density_intent_peak: round2(toothBraw),'),
    undo: () => restore(FILES.fe),
  },
]

console.log('══ P0-8 反向破坏验证 ══')
const base = runGate()
console.log(`基线：${base.pass} 绿 / ${base.fail} 红 ${base.ok ? '✓' : '✗ 基线不绿，先修再破坏'}`)
if (!base.ok) process.exit(1)

let allRed = true
for (const s of SCENARIOS) {
  s.patch()
  const r = runGate()
  const red = !r.ok && r.fail > 0
  if (!red) allRed = false
  console.log(`${red ? '✓' : '✗'} ${s.id} → ${r.pass} 绿 / ${r.fail} 红 ${red ? '(如期变红)' : '(⚠ 未变红：门禁无区分力)'}`)
  s.undo()
}

const after = runGate()
const full = runAll()
console.log(`恢复后门禁：${after.pass} 绿 / ${after.fail} 红 ${after.ok ? '✓ 回绿' : '✗ 未回绿'}`)
console.log(`全量回归：${full.pass} 绿 / ${full.fail} 红 ${full.fail === 0 ? '✓' : '✗'}`)
console.log(allRed && after.ok && full.fail === 0 ? '\n结论：全部场景如期变红、恢复回绿 ✓' : '\n结论：存在未变红或未回绿 ✗')
process.exit(allRed && after.ok && full.fail === 0 ? 0 : 1)
