// v1.3.0 杠杆验证支持：规则裕度 / 杠杆反解 / 匝数自洽反解 / 温升代理标记
// 对应改进清单 P0-2（margin + headroom）与 P1-4（solve_turns 引擎侧）、P1-6（代理标注）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ruleMargin,
  rangeMargin,
  toothWidthForFlux,
  toothFluxDensity,
  yokeFluxDensity,
  solveTurnsPerCoil,
  deriveElectricalClosure,
  yokeThicknessForFlux,
  validateDesign,
  estimateCopperLoss,
  BACKEMF_TOL,
  SLOT_FILL_MAX,
  B_YOKE_SAT_T,
  FLUX_TARGET,
} from '../index.mjs'

test('ruleMargin: 上下限方向与越限符号（改进清单示例：1.62T vs 1.70T = +4.7%）', () => {
  const m = ruleMargin(1.62, 1.7, { unit: 'T' })
  assert.equal(m.margin_pct, 4.7)
  assert.equal(m.margin_abs, 0.08)
  assert.equal(m.better, 'lower')
  // 越限为负
  assert.ok(ruleMargin(1.85, 1.7, { unit: 'T' }).margin_pct < 0)
  // 下限约束（越大越好）：转子轭厚
  const low = ruleMargin(3, 5, { unit: 'mm', better: 'higher' })
  assert.equal(low.margin_abs, -2)
  assert.ok(low.margin_pct < 0)
  // 非有限输入不伪造
  assert.equal(ruleMargin(NaN, 1.7), null)
  assert.equal(ruleMargin(1, 'x'), null)
})

test('rangeMargin: 区间外取最近边、区间内为正', () => {
  const out = rangeMargin(5, 0.3, 1.2)
  assert.ok(out.margin_abs < 0, '区间外裕度为负')
  const inRange = rangeMargin(0.5, 0.3, 1.2)
  assert.ok(inRange.margin_abs > 0, '区间内裕度为正')
  assert.equal(rangeMargin(1, 2, 1), null, '非法区间返回 null')
})

test('toothWidthForFlux: 是 toothFluxDensity 的严格逆函数', () => {
  for (const [statorId, slots] of [[160, 36], [400, 36], [280, 48]]) {
    const w = toothWidthForFlux({ statorId, slotsStator: slots })
    const bt = toothFluxDensity({ statorId, toothWidth: w, slotsStator: slots })
    assert.ok(Math.abs(bt - FLUX_TARGET.tooth) < 0.02, `Dsi=${statorId} 反解齿宽 ${w} ⇒ Bt=${bt} 应≈目标`)
  }
  assert.equal(toothWidthForFlux({ statorId: 0, slotsStator: 36 }), null)
})

test('solveTurnsPerCoil: 与 deriveElectricalClosure 同源一致 + 可取整域全在容差内', () => {
  const base = {
    voltage: 380, speed: 240, poles: 6, statorId: 400, coreLength: 300,
    slotsStator: 36, parallelCircuits: 1,
  }
  const sol = solveTurnsPerCoil(base)
  const closure = deriveElectricalClosure({ ...base, airGap: 0.6 })
  assert.equal(sol.turns_ideal, closure.turns_per_coil_ideal, '理想匝数必须与闭环反推一致')
  assert.equal(sol.turns_int, closure.turns_per_coil, '整匝匝数必须一致')
  assert.ok(sol.integer_options.length >= 1, '至少存在一个容差内整数匝')
  for (const o of sol.integer_options) {
    assert.ok(o.dev_pct <= BACKEMF_TOL * 100 + 1e-6, `整数匝 ${o.turns} 偏差须在容差内`)
  }
  // 缺几何 → null（不伪造）
  assert.equal(solveTurnsPerCoil({ voltage: 380 }), null)
  // 三角接法相电压口径不同 ⇒ 匝数不同
  const delta = solveTurnsPerCoil({ ...base, connection: 'delta' })
  assert.ok(delta.turns_ideal > sol.turns_ideal, '角接相电压更高 ⇒ 匝数更多')
})

test('validateDesign: V08 判 failed 时带 margin，且 headroom 反解与 yokeThicknessForFlux 一致', () => {
  const row = {
    stator_od: 500, stator_id: 400, rotor_od: 396, shaft_dia: 120,
    core_length: 300, air_gap: 0.8, tooth_width: 12, yoke_thickness: 18,
    poles: 6, speed: 240, slots_stator: 36, slots_rotor: 0,
    parallel_circuits: 1, turns_per_coil: 8, peak_current: 400, voltage: 380,
  }
  const r = validateDesign(row)
  const v08 = r.issues.find((i) => i.rule === 'V08')
  assert.equal(v08.level, 'failed')
  assert.ok(v08.margin && v08.margin.margin_pct < 0, 'failed 必须带负裕度')
  const hr = r.metrics.leverage_headroom.V08
  assert.equal(hr.field, 'yoke_thickness')
  const bgActual = r.metrics.flux.air_gap_flux_actual_t
  const expectMin = yokeThicknessForFlux({
    statorId: 400, poles: 6, airGapFlux: bgActual, targetBy: B_YOKE_SAT_T,
  })
  assert.ok(Math.abs(hr.min_for_saturation_mm - expectMin) < 0.2,
    `headroom 反解 ${hr.min_for_saturation_mm} 应与 yokeThicknessForFlux(${expectMin}) 一致`)
})

test('validateDesign: V15 匝数 headroom 是精确逆解（turns_max 不越限，+1 越限）', () => {
  const row = {
    stator_od: 300, stator_id: 200, rotor_od: 197, shaft_dia: 60,
    core_length: 200, air_gap: 0.6, tooth_width: 8, yoke_thickness: 25,
    poles: 4, speed: 1460, slots_stator: 36, slots_rotor: 28,
    parallel_circuits: 1, turns_per_coil: 20, peak_current: 30, voltage: 380,
  }
  const r = validateDesign(row)
  const hr = r.metrics.leverage_headroom?.V15
  assert.ok(hr, 'V15 headroom 必须产出')
  const at = (turns) => estimateCopperLoss({
    statorOd: row.stator_od, statorId: row.stator_id, coreLength: row.core_length,
    slotsStator: row.slots_stator, poles: row.poles, peakCurrent: row.peak_current,
    turnsPerCoil: turns, parallelCircuits: row.parallel_circuits, airGap: row.air_gap,
  })
  assert.ok(at(hr.max_for_slot_fill).slot_fill_ratio <= SLOT_FILL_MAX,
    `turns_max=${hr.max_for_slot_fill} 处槽满率不得越限`)
  assert.ok(at(hr.max_for_slot_fill + 1).slot_fill_ratio > SLOT_FILL_MAX,
    `turns_max+1=${hr.max_for_slot_fill + 1} 处槽满率应越限（证明是精确边界）`)
})

test('validateDesign: V12 温升打代理标记 + back_emf 带可取整域', () => {
  const row = {
    stator_od: 300, stator_id: 200, rotor_od: 197, shaft_dia: 60,
    core_length: 200, air_gap: 0.6, tooth_width: 8, yoke_thickness: 25,
    poles: 4, speed: 1460, slots_stator: 36, slots_rotor: 28,
    parallel_circuits: 1, turns_per_coil: 20, peak_current: 30, voltage: 380,
    power_kw: 15, cooling: 'forced_air', motor_type: 'induction',
  }
  const r = validateDesign(row)
  assert.equal(r.metrics.thermal.is_proxy, true, '温升必须显式标记为代理值')
  assert.match(r.metrics.thermal.proxy_note, /仅作量级判断/)
  const v12 = r.issues.find((i) => i.rule === 'V12')
  if (v12) assert.equal(v12.proxy, true, 'V12 issue 也必须带 proxy 标记')
  assert.ok(Array.isArray(r.metrics.back_emf.integer_options), 'back_emf 必须带可取整域')
})

test('validateDesign: V14 抓「匝数填错」且指标为数值型（防 snake/camel 错配静默 NaN）', () => {
  // turns_per_coil=24 vs 理想 ~10.6 ⇒ 偏离 >2× ⇒ V14 failed
  // （本用例是 solveTurnsPerCoil 重构的回归守卫：错配曾使 V14 整段静默跳过）
  const row = {
    stator_od: 260, stator_id: 160, rotor_od: 159.2, shaft_dia: 48,
    core_length: 130, air_gap: 0.4, tooth_width: 7.1, yoke_thickness: 22,
    poles: 4, speed: 1460, slots_stator: 36, slots_rotor: 28,
    parallel_circuits: 1, turns_per_coil: 24, peak_current: 40, voltage: 380,
    power_kw: 15, cooling: 'forced_air', motor_type: 'induction',
  }
  const r = validateDesign(row)
  const v14 = r.issues.find((i) => i.rule === 'V14')
  assert.equal(v14?.level, 'failed', '行内匝数偏离理想 >2× 必须判 V14 failed')
  assert.ok(v14.margin && v14.margin.margin_pct < 0, 'V14 须带负裕度')
  const be = r.metrics.back_emf
  for (const k of ['e_v', 'e_ideal_v', 'e_int_v', 'uph_v', 'dev', 'turns_ideal', 'turns_quant_dev']) {
    assert.equal(typeof be[k], 'number', `back_emf.${k} 必须是数（防键名错配产出 NaN→null）`)
  }
  assert.equal(typeof be.turns_int, 'number')
})

test('validateDesign: 通过态不误伤（margin 只加在 issue 上，不改变 status 语义）', () => {
  // 一组 healthy 异步机参数：不得因新增字段被判 failed
  const row = {
    stator_od: 260, stator_id: 160, rotor_od: 159.2, shaft_dia: 48,
    core_length: 130, air_gap: 0.4, tooth_width: 7.1, yoke_thickness: 32,
    poles: 4, speed: 1460, slots_stator: 36, slots_rotor: 28,
    parallel_circuits: 1, turns_per_coil: 11, peak_current: 40, voltage: 380,
    power_kw: 15, cooling: 'forced_air', motor_type: 'induction',
  }
  const r = validateDesign(row)
  assert.equal(r.status, 'passed', `healthy 行应通过，实得 ${r.status}: ${JSON.stringify(r.issues)}`)
})
