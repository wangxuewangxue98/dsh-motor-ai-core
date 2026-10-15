// v1.3.1 P2 杠杆验证增强测试：verdict 密度无关化 + 槽形族感知
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateDesign, slotFamilyInfo, SLOT_FAMILIES } from '../lib/design-rules.mjs'

const BASE = {
  stator_od: 210, stator_id: 136, rotor_od: 134.4, core_length: 160, air_gap: 0.8,
  poles: 4, slots_stator: 36, tooth_width: 6.8, yoke_thickness: 14, turns_per_coil: 11,
  parallel_circuits: 2, peak_current: 25, voltage: 380, speed: 1480, power_kw: 15,
  motor_type: 'induction',
}

test('P2-1 verdict_basis 存在且 density_independent=true', () => {
  const r = validateDesign(BASE, {})
  assert.ok(r.verdict_basis, 'verdict_basis 缺失')
  assert.equal(r.verdict_basis.density_independent, true, 'density_independent 必须为 true')
  assert.ok(Array.isArray(r.verdict_basis.drivers), 'drivers 必须为数组')
  // 每条 driver 必有 rule + level
  for (const d of r.verdict_basis.drivers) {
    assert.match(d.rule, /^V\d+$/, 'driver.rule 形态')
    assert.ok(['failed', 'warning'].includes(d.level), 'driver.level 形态')
  }
})

test('P2-1 failed 案例 drivers 精确追溯 V08', () => {
  const r = validateDesign({ ...BASE, yoke_thickness: 3 }, {})
  assert.equal(r.status, 'failed')
  const rules = r.verdict_basis.drivers.map((d) => d.rule)
  assert.ok(rules.includes('V08'), '轭饱和必须出现在 drivers')
  // 所有 drivers 都来自物理规则，绝不出现 density/负荷类伪规则
  for (const d of r.verdict_basis.drivers) {
    assert.match(d.rule, /^V\d+$/)
  }
})

test('P2-2 slot_family 回显（仅感知，零新增门禁）', () => {
  const r = validateDesign({ ...BASE, slot_family: 'pear' }, {})
  assert.equal(r.metrics.slot.slot_family, 'pear', 'slot_family 回显错误')
  assert.equal(r.metrics.slot.slot_family_label, '梨形半闭口槽', 'slot_family_label 回显错误')
  // 未知族名静默回落，不报错
  const r2 = validateDesign({ ...BASE, slot_family: 'weird_family' }, {})
  assert.equal(r2.metrics.slot.slot_family, 'weird_family')
  assert.equal(r2.metrics.slot.slot_family_label, null)
})

test('P2-2 slotFamilyInfo 查表 + SLOT_FAMILIES 结构', () => {
  assert.equal(slotFamilyInfo('pear')?.label, '梨形半闭口槽')
  assert.equal(slotFamilyInfo('PEAR')?.id, 'pear', '大小写应归一化')
  assert.equal(slotFamilyInfo(null), null, '空名必须回落 null')
  assert.equal(slotFamilyInfo('xxx'), null, '未知族必须回落 null')
  const keys = Object.keys(SLOT_FAMILIES)
  assert.ok(keys.length >= 5, '至少 5 个槽形族')
  for (const k of keys) {
    const f = SLOT_FAMILIES[k]
    assert.equal(f.id, k)
    assert.ok(Array.isArray(f.tooth_width_ratio) && f.tooth_width_ratio.length === 2,
      `${k} 的 tooth_width_ratio 必须是二元数组`)
    assert.ok(f.tooth_width_ratio[0] < f.tooth_width_ratio[1], `${k} 区间必须有序`)
    assert.ok(typeof f.label === 'string' && typeof f.typical_use === 'string')
  }
})
