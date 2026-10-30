// P0-7 单一齿宽口径（2026-10-30）：槽几何消费 row.tooth_width
// 根因（300kW 方案实证）：Bt 公式吃 params.tooth_width（tw_axis 值 4.39），而
// slotGeometryDerived 无 tooth_width 入参、硬编码 π·Di/(2Qs)=8.77 ⇒ 同一次估算里
// 并存两个互斥齿宽：齿统一 8.77 ⇒ Bt=0.807T 挂；齿统一 4.39 ⇒ fill=0.330 挂。
// 「双达标」只在两公式解耦时存在，是解耦 Artifact。
// 开关：opts.slotTw / env DSH_L0_SLOT_TW，默认 OFF（零回归）。
// 🔴 门禁纪律：取值路径类断言必须构造"只有该路径能区分"的用例 —— 本文件用
//    tooth_width ≠ 派生齿宽的 300kW 行（4.39 vs 8.77），派生路径必不可能出同样的槽面积。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  quickL0Estimate,
  slotGeometryDerived,
  estimateCopperLoss,
  slotTwOn,
} from '../index.mjs'

// 300kW 风机异步机（报告几何）：tooth_width=4.39 与派生 8.77 显著不同
const ROW = {
  stator_od: 602, stator_id: 402, rotor_od: 400, core_length: 640, air_gap: 1.02,
  tooth_width: 4.39, yoke_thickness: 39.6, shaft_dia: 140,
  poles: 6, voltage: 690, speed: 985, slots_stator: 72, slots_rotor: 28,
  turns_per_coil: 3, parallel_circuits: 2, power_kw: 300, torque_nm: 2909,
  cooling: 'forced_air', line_freq_hz: 50, insulation_class: 'H', motor_type: 'induction',
}

const TOL = 1e-9

test('P0-7 开关默认 OFF（opts/env 双通道）', () => {
  assert.equal(slotTwOn({}), false)
  assert.equal(slotTwOn({ slotTw: true }), true)
  assert.equal(slotTwOn({ slotTw: false }), false)
})

test('P0-7 OFF：槽几何恒旧值（零回归）——面积/槽满率与派生齿宽 8.77 自洽', () => {
  const e = quickL0Estimate(ROW, {})
  assert.equal(e.slot_tw_caliber, 'legacy_derived')
  // 旧派生：slotDepth=0.6·(602−402)/2=60.0；meanDia=462；pitch=π·462/72=20.16；
  // twDerived=π·402/(2·72)=8.77 ⇒ slotWidth=11.39 ⇒ 毛槽=683.4
  const twD = (Math.PI * 402) / (2 * 72)
  const depth = Math.round((602 - 402) / 2 * 0.60 * 10) / 10
  const sw = Math.max(0, (Math.PI * (402 + depth)) / 72 - twD)
  assert.ok(Math.abs(e.slot_area_mm2 - sw * depth) < 0.05,
    `slot_area ${e.slot_area_mm2} vs 期望 ${sw * depth}`)
  assert.ok(Math.abs(e.slot_tooth_width_mm - Math.round(twD * 100) / 100) < TOL)
})

test('P0-7 OFF：estimateCopperLoss 不透传齿宽时 slotGeometryDerived 走派生', () => {
  const geo = slotGeometryDerived({ statorOd: 602, statorId: 402, coreLength: 640, slotsStator: 72, poles: 6 })
  assert.equal(geo.tooth_width_source, 'derived')
  const twD = Math.round((Math.PI * 402) / (2 * 72) * 100) / 100
  assert.equal(geo.tooth_width_used, twD)
})

test('P0-7 ON（opts）：槽几何消费 row.tooth_width=4.39（只有显式路径能得出此面积）', () => {
  const e = quickL0Estimate(ROW, { slotTw: true })
  assert.equal(e.slot_tw_caliber, 'explicit')
  assert.equal(e.slot_tooth_width_mm, 4.39)
  // 显式路径手算：depth=60.0，pitch=π·462/72=20.163 ⇒ sw=20.163−4.39=15.77 ⇒ 毛槽=946.3
  const depth = 60.0
  const sw = (Math.PI * (402 + depth)) / 72 - 4.39
  assert.ok(Math.abs(e.slot_area_mm2 - sw * depth) < 0.05,
    `slot_area ${e.slot_area_mm2} vs 期望 ${sw * depth}`)
  // 🔴 关键判据：槽几何齿宽 == Bt 公式齿宽（单一齿宽口径闭环）
  assert.equal(e.slot_tooth_width_mm, 4.39)
})

test('P0-7 ON：fill 口径切换可观测 —— 同行 fill 显著低于 OFF（齿宽 4.39 ⇒ 槽更大）', () => {
  const off = quickL0Estimate(ROW, {})
  const on = quickL0Estimate(ROW, { slotTw: true })
  assert.ok(on.slot_area_mm2 > off.slot_area_mm2,
    `ON 面积 ${on.slot_area_mm2} 应大于 OFF ${off.slot_area_mm2}`)
  assert.ok(on.slot_fill_engineering < off.slot_fill_engineering,
    `ON fill ${on.slot_fill_engineering} 应小于 OFF ${off.slot_fill_engineering}`)
})

test('P0-7 ON（env）：DSH_L0_SLOT_TW=1 与 opts 等价（双通道一致）', () => {
  process.env.DSH_L0_SLOT_TW = '1'
  try {
    const e = quickL0Estimate(ROW, {})
    assert.equal(e.slot_tw_caliber, 'explicit')
    assert.equal(e.slot_tooth_width_mm, 4.39)
    const eOff = quickL0Estimate(ROW, { slotTw: false })   // opts 显式关闭压过 env
    assert.equal(eOff.slot_tw_caliber, 'legacy_derived')
  } finally {
    delete process.env.DSH_L0_SLOT_TW
  }
})

test('P0-7 ON 但 row 无 tooth_width：derived_resolved（数值与旧口径一致，Bt 兜底同源）', () => {
  const { tooth_width: _tw, ...rowNoTw } = ROW
  const e = quickL0Estimate(rowNoTw, { slotTw: true })
  assert.equal(e.slot_tw_caliber, 'derived_resolved')
  const legacy = quickL0Estimate(rowNoTw, {})
  assert.ok(Math.abs(e.slot_area_mm2 - legacy.slot_area_mm2) < 0.05,
    '无 row 齿宽时 ON/OFF 数值应一致（兜底同源）')
})

test('P0-7 estimateCopperLoss 直调：显式齿宽透传 + 非法值回退派生', () => {
  const cu = estimateCopperLoss({
    statorOd: 602, statorId: 402, coreLength: 640, slotsStator: 72, poles: 6,
    peakCurrent: 500, turnsPerCoil: 3, parallelCircuits: 2, toothWidth: 4.39,
  })
  assert.equal(cu.tooth_width_used, 4.39)
  assert.equal(cu.tooth_width_source, 'explicit')
  const cuBad = estimateCopperLoss({
    statorOd: 602, statorId: 402, coreLength: 640, slotsStator: 72, poles: 6,
    peakCurrent: 500, turnsPerCoil: 3, parallelCircuits: 2, toothWidth: -1,
  })
  assert.equal(cuBad.tooth_width_source, 'derived')
})

test('P0-7 可行性联动：槽满率判据消费切换后的 fill（跨 SLOT_FILL_MAX 翻转）', () => {
  // 用大电流把 fill 推过上限：齿 8.77（小槽）⇒ fill>0.78 不可行；
  // 齿 4.39（大槽）⇒ fill<0.78 可行 ⇒ feasible 随口径翻转（证明门禁消费切换后口径）
  const base = { statorOd: 602, statorId: 402, coreLength: 640, slotsStator: 72, poles: 6, peakCurrent: 750, turnsPerCoil: 3, parallelCircuits: 2 }
  const off = estimateCopperLoss({ ...base })
  const on = estimateCopperLoss({ ...base, toothWidth: 4.39 })
  assert.ok(off.slot_fill_engineering > 0.78, `OFF fill ${off.slot_fill_engineering} 应 >0.78`)
  assert.ok(on.slot_fill_engineering <= 0.78, `ON fill ${on.slot_fill_engineering} 应 ≤0.78`)
  assert.equal(off.feasible, false)
  assert.equal(on.feasible, true)
})
