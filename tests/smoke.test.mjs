// core 冒烟测试：钉死跨版本不得漂移的公共契约
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  computeTorque,
  computeTorqueD2L,
  computeTorqueStress,
  queryTypicalBLoading,
  queryTorqueOverloadFactor,
  TORQUE_OVERLOAD_FACTOR,
  deriveTorqueEnvelope,
  l0TorqueEstimate,
  isSurrogateTorqueEnabled,
  validateDesign,
  LINE_FREQ_MIN_HZ,
  SLIP_MIN_TOL,
} from '../index.mjs'

test('computeTorque: 9550·P/n 恒等式', () => {
  // 15kW / 1460rpm → 98.12 N·m
  assert.equal(computeTorque(15, 1460), 98.12)
  assert.equal(computeTorque(15, 0), 0)
})

test('频率下界放宽到 5Hz（VFD 低频不再整批判死）', () => {
  assert.equal(LINE_FREQ_MIN_HZ, 5)
  assert.equal(SLIP_MIN_TOL, 0.03)
})

test('queryTypicalBLoading: 返回中值与区间，非法入参安全回退', () => {
  const t = queryTypicalBLoading('induction', 'forced_air')
  assert.ok(t.bDelta > 0 && t.loading > 0 && t.sigma > 0, '三项典型值均须为正')
  assert.ok(t.bDelta < 1.2, '气隙磁密应在合理量级 (T)')
  const bad = queryTypicalBLoading('__nope__', '__nope__')
  assert.ok(bad.bDelta > 0, '非法入参须回退到缺省而非抛错/归零')
})

test('computeTorqueD2L / computeTorqueStress: 比值恒等于 kw·kFe', () => {
  const p = { stator_id: 160, core_length: 130, motor_type: 'induction', cooling: 'forced_air' }
  const a = computeTorqueD2L(p)
  const b = computeTorqueStress(p)
  assert.ok(a.torque > 0 && b.torque > 0, '两法均须给出正转矩')
  const ratio = a.torque / b.torque
  assert.ok(Math.abs(ratio - 0.931) < 0.01, `比值应≈kw·kFe=0.931，实得 ${ratio.toFixed(4)}`)
  // 缺几何 → 归零且不伪造
  assert.equal(computeTorqueD2L({}).torque, 0)
})

test('l0TorqueEstimate: 有 P/n 时期望输出走规格恒等式', () => {
  const r = l0TorqueEstimate({ power_kw: 15, speed: 1460, stator_id: 160, core_length: 130 })
  assert.equal(r.torque, 98.12)
  assert.equal(r.torque_confidence, 1.0, '规格转矩置信度为 1.0')
  assert.ok(r.torque_capability > 0, '同时给出可达能力')
  assert.ok(['d2l', 'stress', 'unavailable'].includes(r.capability_source),
    `默认关闭代理时能力源应为公式或无，实得 ${r.capability_source}`)
})

test('l0TorqueEstimate: 无 P/n 时回退能力值，不可用则恒 0 不伪造', () => {
  const noPn = l0TorqueEstimate({ stator_id: 160, core_length: 130 })
  assert.ok(noPn.torque_confidence < 1.0, '无 P/n 时置信度必须下降')
  const empty = l0TorqueEstimate({})
  assert.equal(empty.torque, 0)
  assert.equal(empty.torque_capability, 0)
  assert.equal(empty.capability_source, 'unavailable')
})

test('isSurrogateTorqueEnabled: env 未开时默认 OFF（单变量对照基线）', () => {
  const before = process.env.DSH_L0_SURROGATE_TORQUE
  delete process.env.DSH_L0_SURROGATE_TORQUE
  assert.equal(isSurrogateTorqueEnabled({}), false)
  process.env.DSH_L0_SURROGATE_TORQUE = '1'
  assert.equal(isSurrogateTorqueEnabled({}), true)
  if (before === undefined) delete process.env.DSH_L0_SURROGATE_TORQUE
  else process.env.DSH_L0_SURROGATE_TORQUE = before
})

test('V16: 工频同步点断崖严格拦截，VFD 同工况降级为提示', () => {
  const base = {
    motor_type: 'induction', poles: 4, speed: 1500, power_kw: 15,
    stator_od: 260, stator_id: 160, core_length: 130,
  }
  const v16 = (r) => (r.issues ?? []).find(i => i.rule === 'V16')

  // 工频（不显式传 line_freq_hz）：同步转速 1500 = 额定转速，转差 0 ⇒ 必须判失败
  const mains = validateDesign({ ...base })
  assert.equal(v16(mains)?.level, 'failed', '工频口径下同步点必须判失败')

  // VFD（显式传 line_freq_hz）：落在滑差容差内 ⇒ 降级为提示 + 频率微调建议
  const vfd = validateDesign({ ...base, line_freq_hz: 50 })
  assert.equal(v16(vfd)?.level, 'warning', 'VFD 模式下同一工况应为临界可行提示')
  assert.match(v16(vfd)?.msg ?? '', /Hz/, '提示须给出频率微调建议')
})

test('v1.2.0 转矩包络：过载倍数表取值（异步 2.0 / PMSM 1.8，非标定）', () => {
  assert.equal(TORQUE_OVERLOAD_FACTOR.induction, 2.0, '异步机过载倍数取 GB/T 下限 2.0')
  assert.equal(TORQUE_OVERLOAD_FACTOR.pmsm, 1.8, 'PMSM 受逆变器限流+去磁约束取 1.8')
  assert.equal(queryTorqueOverloadFactor('induction'), 2.0)
  assert.equal(queryTorqueOverloadFactor('pmsm'), 1.8)
  assert.equal(queryTorqueOverloadFactor('unknown_type'), 2.0, '非法机型安全回退缺省')
})

test('v1.2.0 转矩包络：三档判据边界 + 缺数据不得伪造', () => {
  // rated=100, K=2.0 ⇒ max=200
  assert.equal(deriveTorqueEnvelope(80, 100, 'induction').torque_feasibility, 'ample')
  assert.equal(deriveTorqueEnvelope(100, 100, 'induction').torque_feasibility, 'ample', '需求=额定 ⇒ ample')
  assert.equal(deriveTorqueEnvelope(150, 100, 'induction').torque_feasibility, 'overload_only')
  assert.equal(deriveTorqueEnvelope(200, 100, 'induction').torque_feasibility, 'overload_only', '需求=最大 ⇒ overload_only')
  assert.equal(deriveTorqueEnvelope(250, 100, 'induction').torque_feasibility, 'undersized')
  // 缺数据不得伪造判据
  assert.equal(deriveTorqueEnvelope(0, 100, 'induction').torque_feasibility, 'unknown')
  assert.equal(deriveTorqueEnvelope(100, 0, 'induction').torque_feasibility, 'unknown')
  assert.equal(deriveTorqueEnvelope(100, 0, 'induction').torque_capability_max, 0)
  // PMSM 走自身倍率：190 > 100×1.8=180 ⇒ undersized
  const pm = deriveTorqueEnvelope(190, 100, 'pmsm')
  assert.equal(pm.torque_capability_max, 180)
  assert.equal(pm.torque_feasibility, 'undersized')
})

test('v1.2.0 编排器透传包络字段，且无 P/n 时不自比自判', () => {
  const r = l0TorqueEstimate({ power_kw: 15, speed: 1460, stator_id: 160, core_length: 130, motor_type: 'induction' })
  assert.equal(r.torque, 98.12, '期望输出=规格 9550·P/n')
  assert.ok(r.torque_capability_max > r.torque_capability, '最大提供必须大于额定提供')
  assert.equal(r.overload_factor, 2.0)
  assert.ok(['ample', 'overload_only', 'undersized'].includes(r.torque_feasibility))

  // 无 P/n：torque 回退为能力值，此时不得自比自判 ample
  const noPn = l0TorqueEstimate({ stator_id: 160, core_length: 130, motor_type: 'induction' })
  assert.equal(noPn.torque_feasibility, 'unknown', '需求未知必须 unknown')
})
