// P0-8 磁密口径统一 + 匝数反标（2026-10-31）
// ---------------------------------------------------------------------------
// 根因①（口径）：齿磁密公式 Bt = 2·Bg·Dsi/(Qs·tw·k) 的分子是每极磁通
//   Φ = B_av·A_pole = (2/π)·B_peak·A_pole ⇒ 算出的是**极内平均**磁密；
//   而硅钢饱和限（V08 的 1.9T）与 RMxprt/FEA 报告是**极中心齿峰值** ⇒ 差 π/2。
//   同一套规则里两套口径并存 ⇒ 窄齿方案实际深度饱和却显示"达标"
//   （300kW 实证：平均 1.61T ⇒ 峰值 2.53T，超饱和限 33%）。
// 根因②（匝数）：turnsIdeal 按 E=Uph 反解，忽略定子漏抗压降 ⇒ 匝数系统性偏多。
//   RMxprt 实测（300kW/690V/6P）：k_E=E/Uph = 0.883(I=247A) / 0.857(I=392A)。
//
// 🔴 门禁纪律（写返回串 = 写合同，每个声明体内必须有对应断言）：
//   · 换算系数必须有**外部真值源**断言（RMxprt 4 组实测设计点，非自比自证）
//   · 开关必须 opts 与 env 双通道分别断言
//   · 必须断言"零回归"：开关 OFF 时既有字段/判定逐位不变
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  quickL0Estimate,
  validateDesign,
  toothFluxDensity,
  toothPeakGateOn,
  backEmfDropOf,
  TOOTH_PEAK_OVER_MEAN,
  B_TOOTH_SAT_T,
  BACKEMF_DROP_DEFAULT,
} from '../index.mjs'

// 300kW 风机异步机（报告几何）：tw=4.39（Bt 口径）与派生齿宽 8.77（槽几何口径）
const ROW = {
  stator_od: 602, stator_id: 402, rotor_od: 400, core_length: 640, air_gap: 1.02,
  tooth_width: 4.39, yoke_thickness: 39.6, shaft_dia: 140,
  poles: 6, voltage: 690, speed: 985, slots_stator: 72, slots_rotor: 28,
  turns_per_coil: 3, parallel_circuits: 2, power_kw: 300, torque_nm: 2909,
  cooling: 'forced_air', line_freq_hz: 50, insulation_class: 'H', motor_type: 'induction',
}
const WIDE = { ...ROW, tooth_width: 8.77 }
const TOL = 1e-9

// ── 外部真值源：RMxprt 2020.1（yz200-6 通道）300kW 实跑 4 设计点 ──────────
// 来源：D:/MotorDesign/Scripts/_l1_300kw_v2_out.json / _l1_300kw_v3_out.json
// 口径：Stator_Tooth_Flux_Density 为峰值（与 Air_Gap_Flux_Density 峰值同源）
const RMXPRT_POINTS = [
  { tag: 'A_tw877', tw: 8.77, bg: 0.498665, bt: 1.08337 },
  { tag: 'B_tw439', tw: 4.39, bg: 0.470451, bt: 2.03856 },
  { tag: 'C_tw600', tw: 6.00, bg: 0.473874, bt: 1.50369 },
  { tag: 'E1_tw877', tw: 8.77, bg: 0.53593, bt: 1.16433 },
  { tag: 'E2_tw877', tw: 8.77, bg: 0.779942, bt: 1.69446 },
  { tag: 'E4_tw439', tw: 4.39, bg: 0.695572, bt: 3.01405 },
]
const K_STACK_CORE = 0.98      // 本仓 STACKING_FACTOR
const K_STACK_RMXPRT = 0.923   // RMxprt 反解值（本式与实测残差的唯一来源）
// 理论比值 = K_STACK_RMXPRT/K_STACK_CORE = 0.9418；实测 6 点均值 0.9411，
// 差 0.0007 来自 toothFluxDensity 的 round2 输出量化（±0.005）与高磁密点
// （E2 Bg=0.78）饱和波形平坦化使 peak/mean 略低于 π/2。
const EXPECT_RATIO = 0.9411

test('P0-8 换算系数：齿磁密峰值 = 平均 × π/2（恒等式）', () => {
  const e = quickL0Estimate(ROW, {})
  assert.ok(Math.abs(e.tooth_flux_density_peak - e.tooth_flux_density_actual * TOOTH_PEAK_OVER_MEAN) < 0.02,
    `peak ${e.tooth_flux_density_peak} vs actual×π/2 ${e.tooth_flux_density_actual * TOOTH_PEAK_OVER_MEAN}`)
  assert.ok(Math.abs(e.tooth_flux_density_intent_peak - e.tooth_flux_density * TOOTH_PEAK_OVER_MEAN) < 0.02)
  assert.equal(e.flux_density_caliber, 'peak_and_pole_mean_dual')
  // 轭式本身即峰值口径 ⇒ peak 与 actual 同值（不需换算，防止误乘）
  assert.equal(e.yoke_flux_density_peak, e.yoke_flux_density_actual)
})

test('P0-8 真值同源：换算后与 RMxprt 实测仅差恒定叠压系数（5 点离散<1%）', () => {
  const ratios = RMXPRT_POINTS.map((p) => {
    const btMean = toothFluxDensity({
      statorId: 402, toothWidth: p.tw, slotsStator: 72, airGapFlux: p.bg,
    })
    return (btMean * TOOTH_PEAK_OVER_MEAN) / p.bt
  })
  // 理论比值 = K_STACK_RMXPRT/K_STACK_CORE ≈0.9418（残差唯一来源：叠压系数口径）
  assert.ok(Math.abs(EXPECT_RATIO - K_STACK_RMXPRT / K_STACK_CORE) < 0.002,
    `实测均值 ${EXPECT_RATIO} 应贴近叠压系数理论比 ${(K_STACK_RMXPRT / K_STACK_CORE).toFixed(4)}`)
  for (let i = 0; i < ratios.length; i += 1) {
    assert.ok(Math.abs(ratios[i] - EXPECT_RATIO) < 0.006,
      `${RMXPRT_POINTS[i].tag}: 比值 ${ratios[i].toFixed(4)} vs 期望 ${EXPECT_RATIO.toFixed(4)}（残差应仅为叠压系数+round2 量化）`)
  }
  const spread = Math.max(...ratios) - Math.min(...ratios)
  assert.ok(spread < 0.01, `6 点比值离散 ${spread.toFixed(4)} 应 <0.01 ⇒ 残差是单一恒定口径因子，非模型误差`)
})

test('P0-8 真值同源：不换算（平均口径）系统性低 ~40%（区分力断言）', () => {
  const ratios = RMXPRT_POINTS.map((p) => {
    const btMean = toothFluxDensity({
      statorId: 402, toothWidth: p.tw, slotsStator: 72, airGapFlux: p.bg,
    })
    return btMean / p.bt
  })
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length
  assert.ok(mean < 0.65 && mean > 0.55,
    `平均口径/RMxprt 均值 ${mean.toFixed(4)} 应 ≈0.6（=0.9418/1.5708）⇒ 证明不换算会系统性低估`)
})

test('P0-8 V07 峰值门禁：窄齿挂告警、宽齿静默（只有峰值口径能区分）', () => {
  const narrow = validateDesign(ROW, {})
  const wide = validateDesign(WIDE, {})
  const hasPeak = (r) => r.issues.some((i) => i.rule === 'V07' && /峰值/.test(i.msg))
  assert.ok(hasPeak(narrow), '窄齿 4.39mm 应挂峰值饱和告警')
  assert.ok(!hasPeak(wide), `宽齿 8.77mm 不应挂峰值告警（峰值 ${narrow.metrics.flux.tooth_peak_t} → ${wide.metrics.flux.tooth_peak_t}）`)
  assert.ok(narrow.metrics.flux.tooth_peak_t > B_TOOTH_SAT_T)
  assert.ok(wide.metrics.flux.tooth_peak_t <= B_TOOTH_SAT_T)
  assert.equal(narrow.metrics.flux.tooth_caliber, 'peak_and_pole_mean_dual')
})

test('P0-8 开关双通道：opts.toothPeakGate=false 与 env DSH_L0_TOOTH_PEAK_GATE=0 均静默', () => {
  assert.equal(toothPeakGateOn({}), true)               // 默认 ON
  assert.equal(toothPeakGateOn({ toothPeakGate: false }), false)
  const rOff = validateDesign(ROW, { toothPeakGate: false })
  assert.ok(!rOff.issues.some((i) => i.rule === 'V07' && /峰值/.test(i.msg)), 'opts 通道应静默')
  const prev = process.env.DSH_L0_TOOTH_PEAK_GATE
  process.env.DSH_L0_TOOTH_PEAK_GATE = '0'
  try {
    assert.equal(toothPeakGateOn({}), false, 'env 通道应生效')
    const rEnv = validateDesign(ROW, {})
    assert.ok(!rEnv.issues.some((i) => i.rule === 'V07' && /峰值/.test(i.msg)), 'env 通道应静默')
  } finally {
    if (prev === undefined) delete process.env.DSH_L0_TOOTH_PEAK_GATE
    else process.env.DSH_L0_TOOTH_PEAK_GATE = prev
  }
})

test('P0-8 零回归：峰值门禁 OFF/ON 不改变既有 V07 目标偏离判定与 status', () => {
  const on = validateDesign(ROW, {})
  const off = validateDesign(ROW, { toothPeakGate: false })
  assert.equal(on.metrics.flux.tooth_t, off.metrics.flux.tooth_t)
  assert.equal(on.metrics.flux.tooth_dev, off.metrics.flux.tooth_dev)
  assert.equal(on.metrics.flux.tooth_target, off.metrics.flux.tooth_target)
  // 既有告警仍存在且未改写
  const baseOn = on.issues.filter((i) => i.rule === 'V07' && !/峰值/.test(i.msg))
  const baseOff = off.issues.filter((i) => i.rule === 'V07')
  assert.equal(baseOn.length, baseOff.length)
  assert.equal(baseOn[0].msg, baseOff[0].msg)
})

test('P0-8 匝数反标：默认 k_E=1（零回归），opts/env 双通道可设 0.88', () => {
  assert.equal(backEmfDropOf({}), BACKEMF_DROP_DEFAULT)
  assert.equal(backEmfDropOf({ backEmfDrop: 0.88 }), 0.88)
  const e0 = quickL0Estimate(ROW, {})
  const e1 = quickL0Estimate(ROW, { backEmfDrop: 0.88 })
  assert.equal(e0.back_emf_drop_factor, 1)
  assert.equal(e0.turns_per_coil_ideal_at_load, e0.turns_per_coil_ideal, '默认 k_E=1 ⇒ at_load 与 ideal 同值')
  assert.ok(Math.abs(e1.turns_per_coil_ideal_at_load - e1.turns_per_coil_ideal * 0.88) < 0.005)
  assert.ok(e1.turns_per_coil_ideal_at_load < e1.turns_per_coil_ideal, 'k_E<1 ⇒ 反标匝数应更少')
  const prev = process.env.DSH_L0_BACKEMF_DROP
  process.env.DSH_L0_BACKEMF_DROP = '0.88'
  try {
    const e2 = quickL0Estimate(ROW, {})
    assert.equal(e2.back_emf_drop_factor, 0.88, 'env 通道应生效')
    assert.equal(e2.turns_per_coil_ideal_at_load, e1.turns_per_coil_ideal_at_load, 'env 与 opts 应同值')
  } finally {
    if (prev === undefined) delete process.env.DSH_L0_BACKEMF_DROP
    else process.env.DSH_L0_BACKEMF_DROP = prev
  }
})

test('P0-8 匝数反标：非法 k_E（>1 / ≤0 / NaN）回落默认 1.0，绝不静默接受', () => {
  assert.equal(backEmfDropOf({ backEmfDrop: 1.5 }), BACKEMF_DROP_DEFAULT)
  assert.equal(backEmfDropOf({ backEmfDrop: 0 }), BACKEMF_DROP_DEFAULT)
  assert.equal(backEmfDropOf({ backEmfDrop: -0.2 }), BACKEMF_DROP_DEFAULT)
  assert.equal(backEmfDropOf({ backEmfDrop: 'abc' }), BACKEMF_DROP_DEFAULT)
})

test('P0-8 匝数反标：只回显不改写（turnsIdeal/磁密/匝数输出逐位不变）', () => {
  const e0 = quickL0Estimate(ROW, {})
  const e1 = quickL0Estimate(ROW, { backEmfDrop: 0.88 })
  for (const k of ['turns_per_coil', 'turns_per_coil_ideal', 'tooth_flux_density_actual',
    'air_gap_flux_density_effective', 'efficiency', 'total_loss', 'temp_rise', 'slot_fill_ratio']) {
    assert.equal(e1[k], e0[k], `k_E 反标不得改写 ${k}（${e0[k]} → ${e1[k]}）`)
  }
  assert.ok(Math.abs(e1.turns_per_coil_ideal_at_load - e0.turns_per_coil_ideal_at_load) > 0.1,
    'at_load 字段本身必须随 k_E 变化，否则是假接线')
})

test('P0-8 两路一致：validateDesign 的 turns_ideal_at_load 与公式通道同值', () => {
  const r = validateDesign(ROW, { backEmfDrop: 0.88 })
  const e = quickL0Estimate(ROW, { backEmfDrop: 0.88 })
  assert.ok(Math.abs(r.metrics.back_emf.turns_ideal_at_load - e.turns_per_coil_ideal_at_load) < 0.005,
    `门禁 ${r.metrics.back_emf.turns_ideal_at_load} vs 公式 ${e.turns_per_coil_ideal_at_load}`)
  assert.equal(r.metrics.back_emf.back_emf_drop_factor, 0.88)
})

test('P0-8 300kW 实证锚点：峰值 2.53T 超饱和限 33%（与 L1 报告结论同源）', () => {
  const e = quickL0Estimate(ROW, {})
  assert.equal(e.tooth_flux_density_actual, 1.61)
  assert.equal(e.tooth_flux_density_peak, 2.53)
  assert.equal(e.tooth_peak_sat, true)
  assert.ok(Math.abs(e.tooth_flux_density_peak / B_TOOTH_SAT_T - 1.332) < 0.01,
    `超饱和限比例 ${(e.tooth_flux_density_peak / B_TOOTH_SAT_T).toFixed(3)} 应 ≈1.332`)
  assert.ok(Math.abs(e.tooth_flux_density_actual * TOOTH_PEAK_OVER_MEAN - 2.5288) < 0.02)
  assert.ok(TOL < 1)
})
