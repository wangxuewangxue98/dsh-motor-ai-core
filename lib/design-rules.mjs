/**
 * 物理一致性校验规则引擎 —— W4 核心（motor_design_validate 的纯逻辑层）
 * ===========================================================
 * 存在理由：
 *   L0 是「广筛层」，参数矩阵由经验式批量派生，必然混入物理上不成立的组合
 *   （如槽宽为负、转子轭过薄、电频率越界）。若不先剔除就直接进估算与排序，
 *   TopN 会被这些"看起来效率高"的假方案污染 —— 预筛层的价值就是在这里。
 *
 * 设计原则：
 *   1. 纯函数、零依赖：可被 node 直接 import 做单测，与 DSH Runtime 无关
 *   2. 三级严重度：failed（必须剔除）/ warning（可保留但需知情）/ passed
 *   3. 每条规则都可追溯判据来源（常量名或 Python 行号），不允许裸魔数
 *   4. 可跳过：缺少必要输入时显式记入 skipped，绝不静默通过
 *
 * 字段真源：本模块只读 lib/param-schema.mjs 定义的 L1 形状字段，
 *           不引入任何新的参数命名。
 */

import {
  SLOT_MAP, PMSM_SLOT_MAP, idRatio, idRatioByPoles, isPmsmType, empiricalAirGap, AIR_GAP_MIN, AIR_GAP_MAX, airGapMax, HIGH_SPEED_RPM,
  FLUX_TARGET, STACKING_FACTOR, AIR_GAP_FLUX_DEFAULT,
  INSULATION_LIMITS, DEFAULT_INSULATION_CLASS, MIN_ROTOR_YOKE_MM,
  DEFAULT_LINE_FREQ_HZ, LINE_FREQ_MIN_HZ, LINE_FREQ_MAX_HZ, resolveLineFreqHz,
  FREQ_LIMITS, FLUX_TOLERANCE, SLOT_ASPECT_RANGE, ID_RATIO_TOLERANCE, SLIP_MIN_TOL,
  B_YOKE_WARN_T, B_YOKE_SAT_T, B_YOKE_SEVERE_T,
  SLOT_FILL_MAX, BACKEMF_TOL, WINDING_FACTOR,
  yokeThicknessForFlux,
  clamp, round1, round2, round3, round4,
} from './motor-constants.mjs'
import { validateLambda, quickL0Estimate, estimateCopperLoss, engSlotFillOn } from './formula-engine.mjs'

/**
 * V17 判据：理想每线圈匝数下界（v0.2.5 新增）
 * ---------------------------------------------------------------------------
 * 理想匝数 <1 ⇒ 圆线整匝绕组在该电压/频率/几何下物理无解。
 * 取 1.0 作界：低于 1 匝时取整必然向上，产生不可接受的量化偏差；
 * 略高于 1（如 1.05）时取整偏差仅 4.8%，仍属可实现，故不在此判死。
 * 与 lib/applicability-gate.mjs 的同名判据保持同一物理口径；
 * 此处刻意用字面量而非 import，避免 design-rules ↔ applicability-gate 循环依赖。
 */
const APPLICABILITY_MIN_IDEAL_TURNS = 1.0

/**
 * 规则裕度（v1.3.0 P0-2：杠杆验证的「调整空间」量化）
 * ---------------------------------------------------------------------------
 * 动机：规则引擎此前只给「爆/没爆」的布尔结论 ⇒ 微调杠杆（齿宽减 0.5mm、轭厚减 1mm、
 * 匝数加 1）只能盲试，无法规划调整步长。裕度把「离限值还有多远」显式量出来：
 *   margin_pct > 0 = 仍在限内（正值即可调整空间占限值的比例）；
 *   margin_pct < 0 = 已越限（绝对值即越限幅度）。
 *
 * @param {number} value 实际值
 * @param {number} limit 限值
 * @param {object} [o]
 * @param {string} [o.unit] 单位（如 'T' / 'mm' / 'K' / 'Hz'）
 * @param {'lower'|'higher'} [o.better] 限值方向：lower=上限约束（越小越好），higher=下限约束（越大越好）
 * @returns {{value:number, limit:number, unit:string, better:string,
 *            margin_abs:number, margin_pct:number|null}|null} 输入非有限数时返回 null
 */
export function ruleMargin(value, limit, { unit = '', better = 'lower' } = {}) {
  if (![value, limit].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  const headroomAbs = better === 'lower' ? limit - value : value - limit
  const denom = Math.abs(limit)
  return {
    value: round2(value),
    limit: round2(limit),
    unit,
    better,
    margin_abs: round2(headroomAbs),
    margin_pct: denom > 0 ? round1((headroomAbs / denom) * 100) : null,
  }
}

/**
 * 区间裕度：值离区间边界的距离（取最近一边；区间外为负）
 * 用于双侧约束（气隙 [min,max]、长径比、槽宽深比、匝数偏离带）。
 */
export function rangeMargin(value, lo, hi, { unit = '' } = {}) {
  if (![value, lo, hi].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  if (!(hi > lo)) return null
  const toLo = value - lo
  const toHi = hi - value
  const nearest = Math.abs(toLo) <= Math.abs(toHi) ? toLo : toHi
  return {
    value: round2(value),
    range: [round2(lo), round2(hi)],
    unit,
    margin_abs: round2(nearest),
    margin_pct: round1((nearest / (hi - lo)) * 100),
  }
}

/**
 * 齿宽反解（toothFluxDensity 的逆函数）—— v1.3.0 新增
 * 推导：Bt = 2·Bg·Dsi / (Qs·bt·k_stack)  ⇒  bt = 2·Bg·Dsi / (Qs·Bt_target·k_stack)
 * 用途：V07 的杠杆反解——「齿宽最少要多少才能把齿磁密压到目标值」。
 */
export function toothWidthForFlux({
  statorId, slotsStator, airGapFlux = AIR_GAP_FLUX_DEFAULT, targetBt = FLUX_TARGET.tooth,
}) {
  if (!(statorId > 0) || !(slotsStator > 0) || !(targetBt > 0)) return null
  return round1((2 * airGapFlux * statorId) / (slotsStator * targetBt * STACKING_FACTOR))
}

/**
 * 每线圈匝数自洽反解 —— v1.3.0 新增（P1-4 solve_turns 的引擎侧）
 * ---------------------------------------------------------------------------
 * 从 V14/V17 规则块中抽出，供「绕组匝数杠杆」直接提问：
 *   给定电压/转速/几何，自洽匝数是多少？可取整域（反电势偏差在容差内的整数匝）有哪些？
 *
 * 与 lib/formula-engine.mjs 的 deriveElectricalClosure 同源同口径
 * （E = 4.44·f·N·Φ·kw，Φ = 2·Bg·Dsi·L/p，星接 Uph = U/√3），
 * 但本函数**不依赖功率/电流**，纯电气几何闭环 ⇒ 缺 peak_current 也能反解。
 *
 * @returns {{f_hz:number, uph_v:number, phi_wb:number, n_phase_ideal:number,
 *            turns_ideal:number, turns_int:number, quant_dev:number,
 *            e_ideal_v:number, e_int_v:number, dev_int:number,
 *            integer_options: Array<{turns:number, back_emf_v:number, dev_pct:number}>}|null}
 */
export function solveTurnsPerCoil({
  voltage, speed, poles, statorId, coreLength, slotsStator,
  parallelCircuits = 1, airGapFlux = AIR_GAP_FLUX_DEFAULT,
  connection = 'star', windingFactor = WINDING_FACTOR,
}) {
  if (![voltage, speed, poles, statorId, coreLength, slotsStator]
    .every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    return null
  }
  const a = Math.max(1, parallelCircuits)
  const f = (speed * poles) / 120
  const uph = connection === 'delta' ? voltage : voltage / Math.SQRT2 / Math.sqrt(1.5)
  const phi = (2 * airGapFlux * (statorId / 1000) * (coreLength / 1000)) / poles
  if (!(f > 0) || !(phi > 0) || !(uph > 0)) return null
  const nPhase = uph / (4.44 * f * phi * windingFactor)
  const turnsIdeal = (nPhase * a * 3) / slotsStator
  const turnsInt = Math.max(1, Math.round(turnsIdeal))
  const quantDev = turnsIdeal > 0 ? Math.abs(turnsInt - turnsIdeal) / turnsIdeal : 1
  const eIdeal = 4.44 * f * nPhase * phi * windingFactor
  const emfAt = (t) => {
    const nPh = ((slotsStator / 3) * t) / a
    return 4.44 * f * nPh * phi * windingFactor
  }
  const eInt = emfAt(turnsInt)
  const devInt = Math.abs(eInt - uph) / uph
  // 可取整域：枚举理想匝附近的整数匝，反电势偏差在容差内即「可实现」
  const integerOptions = []
  const lo = Math.max(1, Math.floor(turnsIdeal) - 2)
  const hi = Math.ceil(turnsIdeal) + 2
  for (let t = lo; t <= hi; t += 1) {
    const e = emfAt(t)
    const dev = Math.abs(e - uph) / uph
    if (dev <= BACKEMF_TOL) {
      integerOptions.push({ turns: t, back_emf_v: round1(e), dev_pct: round1(dev * 100) })
    }
  }
  return {
    f_hz: round1(f),
    uph_v: round1(uph),
    phi_wb: round4(phi),
    n_phase_ideal: round2(nPhase),
    turns_ideal: round3(turnsIdeal),
    turns_int: turnsInt,
    quant_dev: round3(quantDev),
    e_ideal_v: round1(eIdeal),
    e_int_v: round1(eInt),
    dev_int: round3(devInt),
    integer_options: integerOptions,
  }
}

/** 规则目录 —— 供文档、UI、测试三方共用，避免"规则存在但没人知道" */
export const RULE_CATALOG = [
  { id: 'V01', name: '几何链自洽', severity: 'failed', needs: 'stator_od/stator_id/rotor_od/shaft_dia' },
  { id: 'V02', name: '气隙与转子外径一致', severity: 'failed', needs: 'stator_id/rotor_od/air_gap' },
  { id: 'V03', name: '定子内外径比', severity: 'warning', needs: 'stator_od/stator_id/poles' },
  { id: 'V04', name: '长径比 λ', severity: 'warning', needs: 'core_length/stator_id/poles' },
  { id: 'V05', name: '极槽配合', severity: 'warning', needs: 'poles/slots_stator/slots_rotor' },
  { id: 'V06', name: '极数合法性与并联支路整除', severity: 'failed', needs: 'poles/parallel_circuits/slots_stator' },
  { id: 'V07', name: '齿部磁密', severity: 'warning', needs: 'stator_id/tooth_width/slots_stator/poles' },
  { id: 'V08', name: '轭部磁密', severity: 'failed', needs: 'stator_id/yoke_thickness/poles' },
  { id: 'V09', name: '槽形几何', severity: 'failed', needs: 'stator_od/stator_id/tooth_width/slots_stator' },
  { id: 'V10', name: '电频率', severity: 'warning', needs: 'speed/poles' },
  { id: 'V11', name: '转子轭厚度', severity: 'failed', needs: 'rotor_od/shaft_dia' },
  { id: 'V12', name: '温升限值', severity: 'warning', needs: 'power_kw 或 torque_nm（+ 冷却方式）' },
  { id: 'V14', name: '反电势自洽性', severity: 'failed', needs: 'voltage/speed/poles/stator_id/core_length/slots_stator/parallel_circuits/turns_per_coil' },
  { id: 'V15', name: '槽满率可行性', severity: 'failed', needs: 'stator_od/stator_id/slots_stator/poles/peak_current/turns_per_coil/parallel_circuits' },
  { id: 'V16', name: '极数-转速同步一致性', severity: 'failed', needs: 'speed/poles' },
  { id: 'V17', name: '匝数整量化可行性', severity: 'failed', needs: 'voltage/speed/poles/stator_id/core_length/slots_stator/parallel_circuits' },
  { id: 'V18', name: '电源频率合法性', severity: 'failed', needs: 'line_freq_hz' },
]

/** 可在 config 中把严重度提升为 failed 的规则（默认 warning） */
export const ESCALATABLE_RULES = ['V03', 'V04', 'V05', 'V07', 'V08', 'V10', 'V12']

/**
 * 每极磁通 Φ (Wb)
 * ---------------------------------------------------------------
 * ⚠ 关键因子：气隙磁密沿圆周按正弦分布，一个极距内的 **平均值** 才是磁通，
 *   B_avg = (2/π)·B_peak。极面积 = (π·Dsi/p)·L，故
 *       Φ = (2/π)·B_peak · (π·Dsi/p) · L = 2·B_peak·Dsi·L / p
 *   初版漏掉了 2/π（直接用 B_peak × 极面积），导致磁密被高估 π/2≈1.57 倍，
 *   表现为「齿磁密 1.63T vs 现场目标 1.02T」的假性冲突。修正后自洽。
 */
export function poleFlux({ statorId, coreLength, poles, airGapFlux = AIR_GAP_FLUX_DEFAULT }) {
  if (!(statorId > 0) || !(coreLength > 0) || !(poles > 0)) return null
  return (2 * airGapFlux * (statorId / 1000) * (coreLength / 1000)) / poles
}

/**
 * 齿部磁密反算
 * 推导：每极下齿数 = Qs/p，单齿截面 = bt · L · k_stack
 *       Bt = Φ / [(Qs/p) · bt · L · k_stack] = 2·B_gap·Dsi / (Qs·bt·k_stack)
 *
 * 自洽性检验（W4 修正后）：本仓库齿宽沿用 physics_kernel.py:598
 *   bt = π·Dsi/(2·Qs)（齿宽 = 半个齿距），代入得
 *       Bt = 4·B_gap / (π·k_stack) ≈ 1.30 · B_gap
 *   取 B_gap=0.80T ⇒ Bt ≈ 1.04T —— 与用户现场口径「齿磁密 1.02T」吻合到 2%，
 *   说明齿宽定义与磁密目标本就是同一套假设，初版的 1.63T 纯属 2/π 遗漏所致。
 */
export function toothFluxDensity({ statorId, toothWidth, slotsStator, airGapFlux = AIR_GAP_FLUX_DEFAULT }) {
  if (!(statorId > 0) || !(toothWidth > 0) || !(slotsStator > 0)) return null
  return round2(
    (2 * airGapFlux * statorId) / (slotsStator * toothWidth * STACKING_FACTOR)
  )
}

/**
 * 轭部磁密反算
 * 推导：轭中每侧磁通 = Φ/2，轭截面 = yoke · L · k_stack
 *       By = (Φ/2) / (yoke·L·k_stack) = B_gap·Dsi / (p·yoke·k_stack)
 */
export function yokeFluxDensity({ statorId, yokeThickness, poles, airGapFlux = AIR_GAP_FLUX_DEFAULT }) {
  if (!(statorId > 0) || !(yokeThickness > 0) || !(poles > 0)) return null
  return round2(
    (airGapFlux * statorId) / (poles * yokeThickness * STACKING_FACTOR)
  )
}

/**
 * 气隙磁密（实际值反解）—— v0.2.5 新增，对应改进方案 P2
 * ---------------------------------------------------------------------------
 * 为什么要引入两个口径：
 *   AIR_GAP_FLUX_DEFAULT=0.80T 是**设计意图**磁密（经验标定值，用于反推匝数）。
 *   但匝数必须取整 ⇒ 实际绕组匝数 N_int ≠ 理想 N。
 *   由于 E = 4.44·f·N·Φ·kw，在 N_int 下要让 E 仍等于 Uph，
 *   实际气隙磁密必然偏离设计意图：Bg_actual = Bg_intent · (N_ideal / N_int)。
 *
 *   v0.2.4 及之前 V07/V08 一律用「设计意图 0.80T」判齿/轭磁密，于是出现
 *   **同一物理量两个口径**：V14 按实际匝数算出 E 偏差 39.8%，
 *   V08 却按意图匝数算出 By 完全正常 —— 自相矛盾，且系统性低估实际磁密。
 *
 *   铁芯真正承受的磁密由**实际匝数**决定，故 V07/V08 改用 Bg_actual 判定。
 *
 * @param {object} p
 * @param {number} p.voltageV    线电压 V
 * @param {number} p.speedRpm    转速 rpm
 * @param {number} p.poles       极数
 * @param {number} p.statorId    定子内径 mm
 * @param {number} p.coreLength  铁心长 mm
 * @param {number} p.slotsStator 定子槽数
 * @param {number} p.parallelCircuits 并联支路
 * @param {number} p.turnsPerCoil **实际整数**每线圈匝数
 * @param {number} [p.airGapFlux] 设计意图磁密 T，缺省 AIR_GAP_FLUX_DEFAULT
 * @param {string} [p.connection] 'star'|'delta'
 * @returns {number|null} 实际气隙磁密 T；输入不足时返回 null（调用方回退设计意图值）
 */
export function airGapFluxActual({
  voltageV, speedRpm, poles, statorId, coreLength,
  slotsStator, parallelCircuits, turnsPerCoil,
  airGapFlux = AIR_GAP_FLUX_DEFAULT, connection = 'star',
}) {
  const vals = [voltageV, speedRpm, poles, statorId, coreLength, slotsStator, turnsPerCoil]
  if (!vals.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) return null
  const f = (speedRpm * poles) / 120
  const uph = connection === 'delta' ? voltageV : voltageV / Math.SQRT2 / Math.sqrt(1.5)
  const aEff = Math.max(1, parallelCircuits)
  const nPhase = ((slotsStator / 3) * turnsPerCoil) / aEff
  if (f <= 0 || nPhase <= 0 || uph <= 0) return null
  const phi = uph / (4.44 * f * nPhase * WINDING_FACTOR)          // Wb/极
  const bg = (phi * poles) / (2 * (statorId / 1000) * (coreLength / 1000))
  return Number.isFinite(bg) && bg > 0 ? bg : null
}

/** 槽形派生：槽深按 physics_kernel.py:601 的 0.60 系数，槽宽 = 齿距 - 齿宽 */
export function slotGeometry({ statorOd, statorId, toothWidth, slotsStator }) {
  const half = (statorOd - statorId) / 2
  const slotDepth = round1(half * 0.60)
  const toothPitch = (Math.PI * statorId) / slotsStator
  const slotWidth = round2(toothPitch - toothWidth)
  return {
    slot_depth: slotDepth,
    tooth_pitch: round2(toothPitch),
    slot_width: slotWidth,
    aspect: slotDepth > 0 ? round2(slotWidth / slotDepth) : null,
  }
}

/**
 * v1.3.1 P2-2：槽形族（校验层族感知，不取代 RMxprt 几何求解）
 * ---------------------------------------------------------------
 * 设计杠杆「槽形」并非连续标量，而是一组离散的工程族。每个族有典型齿宽比
 * （齿宽/齿距）经验区间与适用场景。本表只做「族识别 + 经验约束回显」，
 * 不新增任何 failed 门禁——硬门禁仍是 V09 几何链自洽与 SLOT_ASPECT_RANGE。
 * 真正的族级「拧哪个杠杆影响什么」知识见 l0 杠杆知识库（P2-3）。
 */
export const SLOT_FAMILIES = {
  pear: {
    id: 'pear',
    label: '梨形半闭口槽',
    tooth_width_ratio: [0.42, 0.55],
    typical_use: '小功率异步/永磁，散下圆线绕组，工艺性好',
    notes: 'rounded-bottom semi-closed；槽口窄、漏抗大、齿部磁密易偏高',
  },
  trapezoid: {
    id: 'trapezoid',
    label: '梯形半开口槽',
    tooth_width_ratio: [0.50, 0.62],
    typical_use: '中功率异步，成型绕组',
    notes: '半开口；下线空间优于梨形，齿磁密适中',
  },
  rectangular: {
    id: 'rectangular',
    label: '开口矩形槽',
    tooth_width_ratio: [0.55, 0.70],
    typical_use: '中大型 / 成型绕组 / Hairpin 扁线',
    notes: 'open slot；槽满率高、漏抗小，但齿谐波与热应力需专项评估',
  },
  rounded_trapezoid: {
    id: 'rounded_trapezoid',
    label: '斜肩梨形槽',
    tooth_width_ratio: [0.45, 0.58],
    typical_use: '高速永磁，兼顾强度与下线',
    notes: 'rounded-shoulder；高强度齿根，适合高转速离心载荷',
  },
  closed: {
    id: 'closed',
    label: '闭口槽',
    tooth_width_ratio: [0.40, 0.52],
    typical_use: '罩极 / 微特电机，低噪声',
    notes: 'closed slot；齿谐波小但下线困难、铜耗偏高',
  },
}

/** 槽形族查表：返回归一化后的族信息或 null（未知族名静默回落） */
export function slotFamilyInfo(name) {
  if (name == null || typeof name !== 'string') return null
  const key = String(name).toLowerCase().trim()
  return SLOT_FAMILIES[key] ?? null
}

/**
 * 单个方案的物理一致性校验
 * @param {object} row 参数行（L1 形状；power_kw/torque_nm/cooling 为可选）
 * @param {object} [opts]
 * @param {number} [opts.airGapFlux]        气隙磁密基准 T，默认 0.80
 * @param {string} [opts.insulationClass]   绝缘等级 B/F/H，默认 F
 * @param {string[]} [opts.escalate]        需要提升为 failed 的规则 id
 * @param {boolean} [opts.includeThermal]   是否执行温升校验（需功率信息），默认 true
 * @returns {{status:'passed'|'warning'|'failed', issues: object[], checked: number,
 *            skipped: string[], metrics: object}}
 */
export function validateDesign(row, opts = {}) {
  const issues = []
  const skipped = []
  const metrics = {}
  // v1.3.0 P0-2：杠杆反解收集器（V07 齿宽 / V08 轭厚 / V15 匝数的「还可调整量」）
  const headroom = {}
  const escalate = new Set(opts.escalate ?? [])
  let status = 'passed'

  // extra：可附 margin（裕度）/ proxy（代理值标记）等结构化佐证，随 issue 一起输出
  const fail = (rule, msg, extra) => {
    issues.push({ rule, level: 'failed', msg, ...(extra ?? {}) })
    status = 'failed'
  }
  const warn = (rule, msg, extra) => {
    if (escalate.has(rule)) { fail(rule, msg, extra); return }
    issues.push({ rule, level: 'warning', msg, ...(extra ?? {}) })
    if (status !== 'failed') status = 'warning'
  }
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

  const statorOd = num(row?.stator_od)
  const statorId = num(row?.stator_id)
  const rotorOd = num(row?.rotor_od)
  const shaftDia = num(row?.shaft_dia)
  const coreLength = num(row?.core_length)
  const airGap = num(row?.air_gap)
  const toothWidth = num(row?.tooth_width)
  const yokeThickness = num(row?.yoke_thickness)
  const poles = num(row?.poles)
  const speed = num(row?.speed)
  const slotsStator = num(row?.slots_stator)
  const slotsRotor = num(row?.slots_rotor)
  const parallel = num(row?.parallel_circuits)
  const turns = num(row?.turns_per_coil)
  const peakCurrent = num(row?.peak_current)
  const airGapFlux = num(opts.airGapFlux) ?? AIR_GAP_FLUX_DEFAULT

  // ---- v0.2.5 P2：磁密判据改用「实际气隙磁密」（可回退到设计意图口径）----
  // 默认启用实际值口径（bgCaliber: 'actual'）；传 'intent' 可回到 v0.2.4 行为，
  //   便于对外口径对齐与历史对比。opts.airGapFlux 显式给定时以调用方为准。
  // P0-1：与 formula-engine 主指标共用同一开关（含 env），保证「表格口径 == 门禁口径」
  const bgCaliber = opts.bgCaliber ?? process.env.DSH_L0_BG_CALIBER ?? 'actual'
  const bgActual = (bgCaliber === 'actual' && num(opts.airGapFlux) === null)
    ? airGapFluxActual({
      voltageV: num(row?.voltage), speedRpm: speed, poles,
      statorId, coreLength, slotsStator, parallelCircuits: parallel ?? 1,
      turnsPerCoil: turns, airGapFlux, connection: row?.connection,
    })
    : null
  // 实际值反解不出来（缺电压/匝数等）时回退设计意图值，行为与旧版一致
  const airGapFluxForRules = bgActual ?? airGapFlux

  // ---- V01 几何链自洽 ----
  if ([statorOd, statorId, rotorOd, shaftDia].every((v) => v !== null)) {
    metrics.geometry_chain = { stator_od: statorOd, stator_id: statorId, rotor_od: rotorOd, shaft_dia: shaftDia }
    if (!(statorOd > statorId)) fail('V01', `定子外径 ${statorOd} ≤ 内径 ${statorId}，几何不成立`)
    else if (!(statorId > rotorOd)) fail('V01', `定子内径 ${statorId} ≤ 转子外径 ${rotorOd}，无气隙空间`)
    else if (!(rotorOd > shaftDia)) fail('V01', `转子外径 ${rotorOd} ≤ 轴径 ${shaftDia}`)
    else if (!(shaftDia > 0)) fail('V01', `轴径 ${shaftDia} 非正`)
  } else {
    skipped.push('V01')
  }

  // ---- V02 气隙边界 + 转子外径一致性 ----
  if (airGap !== null && statorId !== null && rotorOd !== null) {
    const gapMax = airGapMax(speed)
    const highSpeed = typeof speed === 'number' && speed >= HIGH_SPEED_RPM
    metrics.air_gap = airGap
    metrics.air_gap_max = gapMax
    if (airGap < AIR_GAP_MIN || airGap > gapMax) {
      fail('V02', `气隙 ${airGap}mm 越出 [${AIR_GAP_MIN}, ${gapMax}]${highSpeed ? '（高速档）' : ''}`,
        { margin: rangeMargin(airGap, AIR_GAP_MIN, gapMax, { unit: 'mm' }) })
    }
    const expectedRotor = round1(statorId - 2 * airGap)
    const delta = Math.abs(expectedRotor - rotorOd)
    metrics.rotor_od_expected = expectedRotor
    if (delta > 0.5) {
      fail('V02', `转子外径 ${rotorOd} 与 内径-2×气隙 (${expectedRotor}) 相差 ${round1(delta)}mm`,
        { margin: ruleMargin(delta, 0.5, { unit: 'mm' }) })
    }
    if (statorOd !== null && !highSpeed) {
      // 经验气隙式是按常规转速标定的；高速工况加大气隙是主动设计选择，
      // 拿常规经验值去比会全部误报，故高速档跳过该项。
      const empirical = empiricalAirGap(statorOd)
      metrics.air_gap_empirical = empirical
      if (airGap < empirical * 0.7) {
        warn('V02', `气隙 ${airGap}mm 小于经验值 ${empirical}mm 的 70%，制造困难且齿槽转矩大`,
          { margin: ruleMargin(airGap, empirical * 0.7, { unit: 'mm', better: 'higher' }) })
      } else if (airGap > empirical * 1.5) {
        warn('V02', `气隙 ${airGap}mm 大于经验值 ${empirical}mm 的 1.5 倍，磁负荷不足`,
          { margin: ruleMargin(airGap, empirical * 1.5, { unit: 'mm' }) })
      }
    }
  } else {
    skipped.push('V02')
  }

  // ---- V03 定子内外径比 ----
  if (statorOd !== null && statorId !== null && poles !== null) {
    const ratio = round2(statorId / statorOd)
    // P0（0.1.4）：PMSM 场景按 is_pm 生产口径给期望比（0.72+0.010(p−2) 钳[0.70,0.80]），
    // 与 param-matrix 生成端同口径；缺省/异步仍走 legacy（0.55+0.03(p−2)），零回归。
    const usePm = isPmsmType(row?.motor_type)
    const expected = usePm ? idRatioByPoles(poles, { isPm: true }) : idRatio(poles)
    metrics.id_ratio = { actual: ratio, expected, is_pm: usePm }
    const dev = Math.abs(ratio - expected)
    if (dev > ID_RATIO_TOLERANCE.fail) {
      warn('V03', `内外径比 ${ratio} 严重偏离经验值 ${expected}（差 ${round2(dev)}），槽满率与轭部空间不可信`,
        { margin: ruleMargin(dev, ID_RATIO_TOLERANCE.fail) })
    } else if (dev > ID_RATIO_TOLERANCE.warn) {
      warn('V03', `内外径比 ${ratio} 偏离经验值 ${expected}（差 ${round2(dev)}）`,
        { margin: ruleMargin(dev, ID_RATIO_TOLERANCE.warn) })
    }
  } else {
    skipped.push('V03')
  }

  // ---- V04 长径比 λ ----
  if (coreLength !== null && statorId !== null && poles !== null) {
    const lam = validateLambda(coreLength, statorId, poles)
    metrics.lambda = { value: lam.lambda, range: lam.range, valid: lam.valid }
    if (!lam.valid) warn('V04', lam.advice || `λ=${lam.lambda} 越出 ${lam.range.join('~')}`,
      { margin: rangeMargin(lam.lambda, lam.range[0], lam.range[1]) })
  } else {
    skipped.push('V04')
  }

  // ---- V05 极槽配合 + 每极每相槽数 ----
  if (poles !== null && slotsStator !== null) {
    const usePm = isPmsmType(row?.motor_type)
    // PMSM（v0.1.6）：转子无笼型槽，slots_rotor 恒为 0，只校验定子槽是否在 PMSM_SLOT_MAP；
    // 异步/缺省：沿用 SLOT_MAP 的 [定子,转子] 二元组配对校验。
    const statorCandidates = usePm
      ? (PMSM_SLOT_MAP[poles] ?? [])
      : (SLOT_MAP[poles] ?? []).map(([s]) => s)
    metrics.pole_slot = {
      poles, slots_stator: slotsStator, slots_rotor: slotsRotor,
      is_pmsm: usePm, registered: statorCandidates.includes(slotsStator),
    }
    if (statorCandidates.length && !statorCandidates.includes(slotsStator)) {
      warn('V05', `定子槽数 ${slotsStator} 不在 ${poles}极登记组合 ${JSON.stringify(statorCandidates)} 内${usePm ? '（PMSM 定子槽表）' : ''}`)
    } else if (!statorCandidates.length) {
      warn('V05', `极数 ${poles} 无登记槽配合表，无法判定`)
    }
    const q = slotsStator / (poles * 3)
    metrics.q_slots_per_pole_per_phase = round2(q)
    if (Math.abs(q - Math.round(q)) > 1e-9) {
      warn('V05', `每极每相槽数 q=${q} 非整数（分数槽绕组），需核查绕组系数与齿槽转矩`)
    }
    // 仅异步机核查定转子槽差（PMSM 转子 0 槽，不做此判据）
    if (!usePm && slotsRotor !== null && slotsStator !== null) {
      const diff = Math.abs(slotsStator - slotsRotor)
      metrics.slot_diff = diff
      if (diff === 0) warn('V05', '定转子槽数相同，易产生同步附加转矩与起动死点')
    }
  } else {
    skipped.push('V05')
  }

  // ---- V06-a 极数合法性（v0.2.5 新增，与并联支路判据同组但独立判定）----
  // 独立于下方 parallel 分支：极数是否合法与是否给并联支路无关，
  // 若并入 a|p 分支，则未填 parallel_circuits 的行会整段跳过极数校验（防御纵深缺口）。
  //
  // 物理依据：交流电机定子绕组产生 2p 极主磁场，p 为极对数 ⇒ 极数必为正偶数。
  // 3/5/7/9 极在常规正弦分布绕组下不存在（分数槽/奇极特殊绕组可做，但需专门设计，
  // 不在 L0 估算域内）。异步机与同步机（PMSM 表贴/内置）同受此约束。
  if (poles !== null) {
    metrics.poles = poles
    if (!Number.isInteger(poles)) {
      fail('V06', `极数 ${poles} 必须为整数`)
    } else if (poles < 2) {
      fail('V06', `极数 ${poles} 非法：电机至少 2 极（1 极/0.5 极仅存在于特殊直驱电机）`)
    } else if (poles % 2 !== 0) {
      fail('V06', `极数 ${poles} 为奇数，物理不存在：交流绕组产生 2p 极主磁场，极数必为偶数`
        + `（3/5/7/9 极需专门分数槽绕组设计，不在 L0 估算域）；最近合法极数为 ${poles - 1} 或 ${poles + 1}`)
    }
  } else {
    skipped.push('V06')
  }

  // ---- V06 并联支路数整除极数 + a ≤ q（每极每相槽数） ----
  if (poles !== null && parallel !== null) {
    metrics.parallel_circuits = parallel
    if (!(parallel > 0)) fail('V06', `并联支路数 ${parallel} 非正`)
    else if (poles % parallel !== 0) {
      fail('V06', `并联支路数 ${parallel} 不能整除极数 ${poles}，绕组无法均分`)
    } else if (slotsStator !== null) {
      // 补充判据（0.1.7-P1）：整数槽绕组要求 a ≤ q = Qs/(3p)。
      // 实证：p=4/Qs=36 ⇒ q=3，a∈{1,2} 合法而 a=3/4 非法（3∤4 或 a>q），
      // 旧实现只查 a|p 会放行 a=4 这类不可实现设计。
      // 分数槽（q 非整数）支路分配规则不同，不在本判据范围，交由上层绕组校验处理。
      const q = slotsStator / (3 * poles)
      metrics.q_slots_per_pole_per_phase = Math.round(q * 100) / 100
      if (Number.isInteger(q) && parallel > q) {
        fail('V06', `并联支路数 ${parallel} > 每极每相槽数 q=${q}（Qs=${slotsStator} / (3×${poles})），支路无法在槽内分配`)
      }
    }
  } else {
    skipped.push('V06')
  }

  // ---- V07 齿部磁密 ----
  // v0.2.5 P2：改用实际气隙磁密（铁芯真正承受的值），而非设计意图值
  const bt = toothFluxDensity({ statorId, toothWidth, slotsStator, airGapFlux: airGapFluxForRules })
  if (bt !== null) {
    const dev = Math.abs(bt - FLUX_TARGET.tooth) / FLUX_TARGET.tooth
    metrics.flux = {
      ...(metrics.flux ?? {}),
      tooth_t: bt, tooth_target: FLUX_TARGET.tooth, tooth_dev: round2(dev),
      air_gap_flux_intent_t: round2(airGapFlux), air_gap_flux_actual_t: round2(airGapFluxForRules),
      bg_caliber: bgCaliber,
    }
    // v1.3.0 P0-2：齿宽杠杆反解——按目标齿磁密的最低齿宽（Bt=2·Bg·Dsi/(Qs·bt·k_stack) 逆函数）
    const btMinWidth = toothWidthForFlux({
      statorId, slotsStator, airGapFlux: airGapFluxForRules, targetBt: FLUX_TARGET.tooth,
    })
    if (btMinWidth !== null && toothWidth !== null) {
      headroom.V07 = {
        field: 'tooth_width',
        current_mm: toothWidth,
        min_for_target_mm: btMinWidth,
        adjustable_mm: round2(toothWidth - btMinWidth),
        note: `齿宽低于 ${btMinWidth}mm 将使齿磁密超过目标 ${FLUX_TARGET.tooth}T（按实际气隙磁密 ${round3(airGapFluxForRules)}T 反解）`,
      }
    }
    if (dev > FLUX_TOLERANCE.fail) {
      warn('V07', `齿磁密 ${bt}T 偏离目标 ${FLUX_TARGET.tooth}T 达 ${Math.round(dev * 100)}%（半齿距齿宽下 Bt≈1.30·B_gap，可反推所需 B_gap=${round2(bt / 1.30)}T）`,
        { margin: rangeMargin(bt, FLUX_TARGET.tooth * (1 - FLUX_TOLERANCE.fail), FLUX_TARGET.tooth * (1 + FLUX_TOLERANCE.fail), { unit: 'T' }) })
    } else if (dev > FLUX_TOLERANCE.warn) {
      warn('V07', `齿磁密 ${bt}T 偏离目标 ${FLUX_TARGET.tooth}T 达 ${Math.round(dev * 100)}%`,
        { margin: rangeMargin(bt, FLUX_TARGET.tooth * (1 - FLUX_TOLERANCE.warn), FLUX_TARGET.tooth * (1 + FLUX_TOLERANCE.warn), { unit: 'T' }) })
    }
  } else {
    skipped.push('V07')
  }

  // ---- V08 轭部磁密（v0.1.7：硬门禁，超饱和直接 failed）----
  // Bj 公式与齿磁密同源、物理正确；所谓「失真」是此前仅 warn、未能剔除饱和轭部候选。
  // 硅钢饱和磁感 Bs≈2.0~2.1T，工作磁密上限取 B_YOKE_SAT_T=1.9T：超过即轭部无法承载该磁通。
  // 同时保留对目标 0.82T 的偏离预警（dev），但饱和判据优先于目标偏离。
  const by = yokeFluxDensity({ statorId, yokeThickness, poles, airGapFlux: airGapFluxForRules })
  if (by !== null) {
    const dev = Math.abs(by - FLUX_TARGET.yoke) / FLUX_TARGET.yoke
    metrics.flux = {
      ...(metrics.flux ?? {}),
      yoke_t: by, yoke_target: FLUX_TARGET.yoke, yoke_dev: round2(dev),
      yoke_sat: by > B_YOKE_SAT_T,
      yoke_severe: by > B_YOKE_SEVERE_T && by <= B_YOKE_SAT_T,  // P0-2 严重档
    }
    // v1.3.0 P0-2：轭厚杠杆反解——按硅钢饱和极限的最低轭厚（By=Bg·Dsi/(p·yoke·k_stack) 逆函数）
    const yokeMin = yokeThicknessForFlux({
      statorId, poles, airGapFlux: airGapFluxForRules, targetBy: B_YOKE_SAT_T,
    })
    if (yokeMin !== null && yokeThickness !== null) {
      headroom.V08 = {
        field: 'yoke_thickness',
        current_mm: yokeThickness,
        min_for_saturation_mm: yokeMin,
        adjustable_mm: round2(yokeThickness - yokeMin),
        note: `轭厚低于 ${yokeMin}mm 将使轭磁密超过硅钢饱和极限 ${B_YOKE_SAT_T}T（按实际气隙磁密 ${round3(airGapFluxForRules)}T 反解）`,
      }
    }
    if (by > B_YOKE_SAT_T) {
      // 轭部超过硅钢饱和极限：磁通无法由该轭厚承载，设计不可行（需加大定子外径/轭厚或降低气隙磁密）
      fail('V08', `轭磁密 ${by}T 超过硅钢饱和极限(${B_YOKE_SAT_T}T)，轭部将深度饱和、无法承载该磁通；`
        + `需加大定子外径/轭厚，或降低气隙磁密 B_gap（实际 ${round3(airGapFluxForRules)}T`
        + `${bgActual !== null ? `，设计意图 ${airGapFlux}T` : ''}）`,
        { margin: ruleMargin(by, B_YOKE_SAT_T, { unit: 'T' }) })
    } else if (by > B_YOKE_SEVERE_T) {
      // P0-2 补 1.5T(warn) 与 1.9T(sat) 之间缺失的中间档：1.7T 起硅钢进入 B-H 膝部，
      // 励磁电流与铁损显著恶化，但尚未到「轭部无法承载该磁通」的硬失败 ⇒ warning + severity 标记。
      // V08 属 ESCALATABLE_RULES，被 escalate 时仍升级为 failed，行为不变。
      warn('V08', `轭磁密 ${by}T 达严重档(>${B_YOKE_SEVERE_T}T)：已进入硅钢 B-H 曲线膝部，`
        + `励磁电流与铁损显著恶化；距饱和极限 ${B_YOKE_SAT_T}T 仅余 ${round2(B_YOKE_SAT_T - by)}T`,
        { severity: 'severe', margin: ruleMargin(by, B_YOKE_SEVERE_T, { unit: 'T' }) })
    } else if (by > B_YOKE_WARN_T) {
      warn('V08', `轭磁密 ${by}T 偏高(>${B_YOKE_WARN_T}T)，轭部接近饱和，铁损与温升将恶化`,
        { margin: ruleMargin(by, B_YOKE_WARN_T, { unit: 'T' }) })
    } else if (dev > FLUX_TOLERANCE.fail) {
      warn('V08', `轭磁密 ${by}T 偏离目标 ${FLUX_TARGET.yoke}T 达 ${Math.round(dev * 100)}%`,
        { margin: rangeMargin(by, FLUX_TARGET.yoke * (1 - FLUX_TOLERANCE.fail), FLUX_TARGET.yoke * (1 + FLUX_TOLERANCE.fail), { unit: 'T' }) })
    } else if (dev > FLUX_TOLERANCE.warn) {
      warn('V08', `轭磁密 ${by}T 偏离目标 ${FLUX_TARGET.yoke}T 达 ${Math.round(dev * 100)}%`,
        { margin: rangeMargin(by, FLUX_TARGET.yoke * (1 - FLUX_TOLERANCE.warn), FLUX_TARGET.yoke * (1 + FLUX_TOLERANCE.warn), { unit: 'T' }) })
    }
  } else {
    skipped.push('V08')
  }

  // ---- V09 槽形几何 ----
  const slotFamily = row?.slot_family ?? null
  if (statorOd !== null && statorId !== null && toothWidth !== null && slotsStator !== null) {
    const geo = slotGeometry({ statorOd, statorId, toothWidth, slotsStator })
    metrics.slot = geo
    // v1.3.1 P2-2：槽形族回显（仅作校验层族感知，不新增门禁；族级经验约束见 l0 杠杆知识库 P2-3）
    if (slotFamily != null) {
      const fam = slotFamilyInfo(slotFamily)
      metrics.slot.slot_family = fam?.id ?? String(slotFamily)
      metrics.slot.slot_family_label = fam?.label ?? null
    }
    if (!(geo.slot_depth > 0)) {
      fail('V09', `槽深 ${geo.slot_depth}mm 非正（内外径差过小）`)
    } else if (geo.slot_width <= 0) {
      fail('V09', `槽宽 ${geo.slot_width}mm ≤ 0：齿宽 ${toothWidth}mm 不小于齿距 ${geo.tooth_pitch}mm，无下线空间`,
        { margin: ruleMargin(toothWidth, geo.tooth_pitch, { unit: 'mm' }) })
    } else if (geo.aspect !== null && (geo.aspect < SLOT_ASPECT_RANGE[0] || geo.aspect > SLOT_ASPECT_RANGE[1])) {
      warn('V09', `槽宽深比 ${geo.aspect} 越出 ${SLOT_ASPECT_RANGE.join('~')}（${geo.slot_width}×${geo.slot_depth}mm）`,
        { margin: rangeMargin(geo.aspect, SLOT_ASPECT_RANGE[0], SLOT_ASPECT_RANGE[1]) })
    }
  } else {
    skipped.push('V09')
  }

  // ---- V10 电频率 ----
  if (speed !== null && poles !== null) {
    const f = round1((speed * poles) / 120)
    metrics.freq_hz = f
    if (f > FREQ_LIMITS.fail) {
      warn('V10', `电频率 ${f}Hz 越出常规适用域 ${FREQ_LIMITS.fail}Hz，铁损/集肤/变频器需专项评估`,
        { margin: ruleMargin(f, FREQ_LIMITS.fail, { unit: 'Hz' }) })
    } else if (f > FREQ_LIMITS.warn) {
      warn('V10', `电频率 ${f}Hz 高于 ${FREQ_LIMITS.warn}Hz，需核查高频铁损与集肤效应`,
        { margin: ruleMargin(f, FREQ_LIMITS.warn, { unit: 'Hz' }) })
    }
  } else {
    skipped.push('V10')
  }

  // ---- V11 转子轭厚度 ----
  if (rotorOd !== null && shaftDia !== null) {
    const yoke = round1((rotorOd - shaftDia) / 2)
    metrics.rotor_yoke_mm = yoke
    if (yoke < MIN_ROTOR_YOKE_MM) {
      fail('V11', `转子轭厚 ${yoke}mm < ${MIN_ROTOR_YOKE_MM}mm，磁路与机械强度不可靠`,
        { margin: ruleMargin(yoke, MIN_ROTOR_YOKE_MM, { unit: 'mm', better: 'higher' }) })
    }
  } else {
    skipped.push('V11')
  }

  // ---- V12 温升限值（需功率信息，缺省跳过而非静默通过）----
  const hasPower = num(row?.power_kw) !== null || num(row?.torque_nm) !== null
  if (opts.includeThermal === false) {
    skipped.push('V12')
  } else if (!hasPower) {
    skipped.push('V12')
  } else {
    try {
      const est = quickL0Estimate(row, {
        efficiencyCap: opts.efficiencyCap,
        maxTempClamp: opts.maxTempClamp,
        fluxDensity: opts.fluxDensity,
      })
      const rise = est.temp_rise
      const cls = opts.insulationClass ?? DEFAULT_INSULATION_CLASS
      const limit = INSULATION_LIMITS[cls] ?? INSULATION_LIMITS[DEFAULT_INSULATION_CLASS]
      metrics.thermal = {
        temp_rise_k: rise, insulation_class: cls, limit_k: limit,
        total_loss_w: est.total_loss, cooling: row?.cooling ?? null,
        // v1.3.0 P1-6：温升是热负荷法**代理值**（散热面积未计散热筋、损耗三项欠标定），
        // 历史实测与真值相关性极弱 ⇒ 显式打标，防止把「杠杆降温 5K」当设计依据。
        is_proxy: true,
        efficiency_raw: est.efficiency_raw ?? est.efficiency ?? null,
        proxy_note: '温升为热负荷法代理值，仅作量级判断；定论须过 L1/L2 热模型',
      }
      // ⚠ V12 默认只 warn，不 fail —— 依据：L0 温升模型尚未标定
      //   （散热面积未计散热筋、损耗三项仍欠标定，见 quality gate 的 DEBT 清单）。
      //   未标定的模型一旦判 failed，会把矩阵整批判死（实测 40/40 全 failed），
      //   预筛层就失去意义。需要硬剔除时用 escalate: ['V12'] 显式升级。
      if (rise > limit) {
        warn('V12', `温升 ${rise}K 超过 ${cls} 级限值 ${limit}K（冷却 ${row?.cooling ?? '默认'}）[模型未标定，结论供参考]`,
          { margin: ruleMargin(rise, limit, { unit: 'K' }), proxy: true })
      } else if (rise > limit * 0.8) {
        warn('V12', `温升 ${rise}K 已达 ${cls} 级限值 ${limit}K 的 80%，余量不足`,
          { margin: ruleMargin(rise, limit, { unit: 'K' }), proxy: true })
      }
    } catch (err) {
      warn('V12', `温升校验执行失败: ${String(err?.message ?? err)}`)
    }
  }

  // ---- V14 反电势自洽性（P0 门禁，v0.2.5 语义修正）----
  // ⚠ v0.2.5 订正 —— 原实现是**逻辑循环**：
  //   它拿行内 turns_per_coil 反算 E，再要求 |E−Uph|/Uph ≤ BACKEMF_TOL。
  //   但行内 turns 是 deriveElectricalClosure 用同一组 Uph/Φ 反推后再取整的结果，
  //   V14 实际在「用自己量化过的匝数校验自己的量化误差」，
  //   而不是在校验「手填矩阵的匝数与电压/频率是否自洽」。
  //   后果：理想匝数 <1 时被 Math.max(1,·) 钳到 1 匝 ⇒ E 必然大幅偏离 Uph
  //   （实测 200kW/22000rpm：理想 0.716 匝 → 钳成 1 匝 → E 306.6V vs 219.4V，偏差 39.8%），
  //   无论参数如何合理都必然 failed ⇒ 该规则在高速/低压工况结构性失效。
  //
  // v0.2.5 修正为两段职责分离：
  //   V14（本规则）= **自洽性**：给定几何与电压，能否选出使 E≈Uph 的匝数。
  //       用理想（连续）匝数算 E，偏差必≈0 ⇒ 矩阵正常路径恒通过；
  //       若行内匝数偏离理想值过多（例如手填矩阵填了 3 匝），才判 failed。
  //       真正的「物理上无解」移交 V17 判。
  //   V17（新增）  = **可实现性**：理想匝数是否落在整数可达区间内。
  if (statorId !== null && coreLength !== null && poles !== null && slotsStator !== null
      && turns !== null && parallel !== null && num(row?.voltage) !== null && speed !== null) {
    // v1.3.0 P1-4：匝数反解抽为独立函数 solveTurnsPerCoil（solve_turns 模式共用），
    // 本处改为调用；判据逻辑与 v1.2.0 完全一致（同源公式，零行为变化）。
    const sol = solveTurnsPerCoil({
      voltage: num(row.voltage), speed, poles, statorId, coreLength, slotsStator,
      parallelCircuits: parallel, airGapFlux, connection: row?.connection,
    })
    // ⚠ solveTurnsPerCoil 输出为 snake_case（与指标口径一致），此处解构须逐键对齐，
    //   错配会静默产出 NaN（JSON 里显示为 null）并跳过 V14 判据——曾踩中。
    // ⚠ sol 可为 null（如 poles=0 ⇒ f=0 无效输入）：v1.2.0 内联计算时为 NaN 静默跳过，
    //   此处保持等价语义——跳过 V14/V17 而不是抛错炸掉整份校验报告（V06 门禁回归实证）。
    if (!sol) {
      skipped.push('V14')
      skipped.push('V17')
    } else {
    const {
      turns_ideal: turnsIdeal, turns_int: turnsInt, quant_dev: quantDev,
      e_int_v: eInt, dev_int: devInt,
    } = sol
    const selfConsistent = turnsIdeal > 0 && Number.isFinite(turnsIdeal)

    metrics.back_emf = {
      // e_v 保留为整匝口径 E（与 v0.2.4 同名同义，避免下游/文档断链）
      e_v: round1(eInt),
      e_ideal_v: sol.e_ideal_v, e_int_v: sol.e_int_v, uph_v: sol.uph_v,
      dev: round3(devInt), ok: devInt <= BACKEMF_TOL,
      turns_ideal: round3(turnsIdeal), turns_int: turnsInt, turns_quant_dev: round3(quantDev),
      // v1.3.0 P1-4：可取整域——反电势偏差在容差内的整数匝集合（绕组杠杆的直接答案）
      integer_options: sol.integer_options,
    }

    // V14：行内匝数与理想匝数的偏离 —— 只抓「填错」，不抓「量化」
    // ⚠ v0.2.5 二次修正：理想匝 <1 时整匝钳位必然造成 >2× 偏离（0.497→1 即 2.01×），
    //   此时报 V14 属于**重复归因**（同一物理事实 V17 已更准确地判为「整匝绕组无解」），
    //   且会让调用方误以为「参数填错」而去改本来正确的电压/几何。
    //   故 V14 仅在理想匝 ≥1（不存在钳位放大）时判「填错」。
    if (selfConsistent && turnsIdeal >= APPLICABILITY_MIN_IDEAL_TURNS) {
      const rowTurnsIdealRatio = turnsIdeal > 0 ? turns / turnsIdeal : Infinity
      // 行内匝数偏离理想值 >2 倍（向上）或 <0.5 倍（向下）才算「填错」
      if (rowTurnsIdealRatio > 2 || rowTurnsIdealRatio < 0.5) {
        fail('V14', `绕组匝数与电压/频率不自洽：行内 ${turns} 匝/线圈，`
          + `按本几何(${round1(statorId)}mm内径/${round1(coreLength)}mm铁心长/${poles}极/${slotsStator}槽)`
          + `与 ${round1(num(row.voltage))}V/${round1(speed)}rpm 反推的理想值应为 ${round3(turnsIdeal)} 匝/线圈`
          + `（偏离 ${round2(rowTurnsIdealRatio)}×）`,
          { margin: rangeMargin(rowTurnsIdealRatio, 0.5, 2, { unit: '×' }) })
      }
    }

    // V17：整匝量化可行性
    // ⚠ v0.2.5 二次修正：判据**不能只看「理想匝 <1」**。
    //   理想 0.995 匝取整到 1 匝，偏差仅 0.5% —— 这是完全可实现的正常设计，
    //   按「<1 即无解」会把它误杀（实测误杀 63 行中的绝大部分）。
    //   真正的物理无解判据是**取整后的反电势偏差超出容差**：
    //   理想匝越接近 0，向上取整的相对放大越剧烈（0.5 匝→1 匝即 +100%）。
    //   故改为：偏差 > BACKEMF_TOL 才判 failed（物理不可实现），
    //   偏差在容差内但理想匝 <1 者给出 warning（提示已触到整匝下限）。
    if (turnsIdeal < APPLICABILITY_MIN_IDEAL_TURNS && devInt > BACKEMF_TOL) {
      fail('V17', `理想每线圈匝数仅 ${round3(turnsIdeal)} 匝（<1），圆线整匝绕组无解：`
        + `要达到 ${round1(sol.uph_v)}V 相电压需要每线圈 ${round3(turnsIdeal)} 匝，`
        + `取整到 1 匝后反电势升至 ${round1(eInt)}V（偏差 ${(devInt * 100).toFixed(1)}%）。`
        + `可行方向：① 升压（匝数∝U，690V 时匝数翻 ${round2(690 / Math.max(1, num(row.voltage)))}倍）`
        + `；② 降频增极（f=n·p/120，匝数∝1/f）；③ 加大 Dsi·L 以提高每极磁通 Φ；`
        + `④ 改用分数槽/小截面绕组（超出 L0 整数匝模型能力）`,
        { margin: ruleMargin(devInt, BACKEMF_TOL) })
    } else if (turnsIdeal < APPLICABILITY_MIN_IDEAL_TURNS) {
      warn('V17', `理想每线圈匝数 ${round3(turnsIdeal)} 匝已贴近整匝下限（1 匝），`
        + `取整后反电势 ${round1(eInt)}V（偏差 ${(devInt * 100).toFixed(1)}%，仍在容差内可实现）；`
        + `继续降压/升速/减极会迅速逼近无解区`,
        { margin: ruleMargin(devInt, BACKEMF_TOL) })
    } else if (quantDev > BACKEMF_TOL) {
      warn('V17', `整匝量化偏差 ${(quantDev * 100).toFixed(1)}%：理想 ${round3(turnsIdeal)} 匝 → 取整 ${turnsInt} 匝，`
        + `反电势 ${round1(eInt)}V vs 相电压 ${round1(sol.uph_v)}V（偏差 ${(devInt * 100).toFixed(1)}%），`
        + `细调电压或磁密可改善`,
        { margin: ruleMargin(quantDev, BACKEMF_TOL) })
    }
    } // end if (sol)
  } else {
    skipped.push('V14')
    skipped.push('V17')
  }

  // ---- V15 槽满率可行性（P0 门禁）----
  // 给定 peak_current 与 turns_per_coil 反算槽满率，> SLOT_FILL_MAX 判几何不可实现。
  if (statorOd !== null && statorId !== null && slotsStator !== null && poles !== null
      && peakCurrent !== null && turns !== null && parallel !== null) {
    const cu = estimateCopperLoss({
      statorOd, statorId, coreLength: coreLength ?? 80, slotsStator, poles,
      peakCurrent, turnsPerCoil: turns, parallelCircuits: parallel, airGap: airGap ?? 0.6,
    })
    // ---- P0-3：判定改用**工程口径**槽满率 ----
    // 旧判据拿「裸铜净面积/外接矩形毛槽」（实测 0.17~0.27）去比工程阈值 0.70/0.78，
    // 二者口径不可比 ⇒ 系统性漏判真实过槽满。现按含漆膜导线面积 / 槽有效面积判。
    // 旧比值仍回显为 ratio_net 供对照；env DSH_L0_ENG_SLOT_FILL=0 可回退旧判据。
    const useEng = engSlotFillOn()
    const fillGate = useEng ? (cu.slot_fill_engineering ?? cu.slot_fill_ratio) : cu.slot_fill_ratio
    metrics.slot_fill = {
      ratio: fillGate,
      ratio_net: cu.slot_fill_ratio,                 // 旧口径（裸铜净/毛槽），仅诊断
      caliber: useEng ? 'engineering' : 'net_over_gross',
      area_mm2: cu.slot_area_mm2,
      area_net_mm2: cu.slot_area_net_mm2,
      max: SLOT_FILL_MAX,
    }
    // v1.3.0 P0-2：匝数杠杆反解——槽满率与匝数严格成正比
    //   （conductorArea = 2·turns·aWire，aWire 由电流定、与匝数无关）
    //   ⇒ turns_max = turns·SLOT_FILL_MAX/fill 是精确逆解（定电流/几何下）。
    if (fillGate > 0 && turns !== null) {
      let turnsMax = Math.floor((turns * SLOT_FILL_MAX) / fillGate)
      // P0-3：判定用的是 round3 之后的槽满率，而逆解用的是未取整比值 ⇒ 边界可能差 1 匝
      // （实测 turns_max=16、17 匝处取整值恰为 0.780，不再 >0.78，逆解与判据自相矛盾）。
      // 故以「判定值」为准做 ±1 校正，保证 turns_max 处不越限、turns_max+1 处必越限。
      const fillAtTurns = (t) => {
        const c = estimateCopperLoss({
          statorOd, statorId, coreLength: coreLength ?? 80, slotsStator, poles,
          peakCurrent, turnsPerCoil: t, parallelCircuits: parallel, airGap: airGap ?? 0.6,
        })
        return (useEng ? (c.slot_fill_engineering ?? c.slot_fill_ratio) : c.slot_fill_ratio) ?? 0
      }
      for (let g = 0; g < 3 && turnsMax > 1 && fillAtTurns(turnsMax) > SLOT_FILL_MAX; g++) turnsMax -= 1
      for (let g = 0; g < 3 && turnsMax >= 1 && fillAtTurns(turnsMax + 1) <= SLOT_FILL_MAX; g++) turnsMax += 1
      headroom.V15 = {
        field: 'turns_per_coil',
        current: turns,
        max_for_slot_fill: turnsMax,
        adjustable: turnsMax - turns,
        note: `槽满率∝匝数（定电流/几何下严格线性）：匝数超过 ${turnsMax} 将使槽满率越限 ${SLOT_FILL_MAX}`
          + `（${useEng ? '工程口径' : '旧净/毛口径'}）`,
      }
    }
    if (fillGate > SLOT_FILL_MAX) {
      fail('V15', `槽满率 ${fillGate} > ${SLOT_FILL_MAX}（${useEng ? '工程' : '净/毛'}口径：槽有效面积 `
        + `${useEng ? cu.slot_area_net_mm2 : cu.slot_area_mm2}mm² 放不下 ${turns}匝×${peakCurrent}A 导体，需增大机座或降电流）`,
        { margin: ruleMargin(fillGate, SLOT_FILL_MAX) })
    } else if (fillGate > 0.70) {
      warn('V15', `槽满率 ${fillGate} 偏高（>0.70，${useEng ? '工程' : '净/毛'}口径），下线困难且温升裕度小`,
        { margin: ruleMargin(fillGate, 0.70) })
    }
  } else {
    skipped.push('V15')
  }

  // ---- V18 电源频率合法性（v0.2.5 新增）----
  // f_line 直接决定 n_sync=120·f/p，是 V16 的自变量。若输入非法（乱填/越界），
  // resolveLineFreqHz 会静默回落 50Hz —— 那会让 V16 拿"错误的频率"去判超同步，
  // 属静默违约。故显式立条：非法频率必须报出，而不是悄悄换值。
  const rawLineFreq = [row?.line_freq_hz, opts.lineFreqHz].find((v) => v !== undefined && v !== null)
  if (rawLineFreq !== undefined) {
    const fReq = num(rawLineFreq)
    if (fReq === null) {
      fail('V18', `电源频率 ${JSON.stringify(rawLineFreq)} 非数值，无法计算同步转速（缺省将按 ${DEFAULT_LINE_FREQ_HZ}Hz 判，可能误判超同步）`)
    } else if (fReq < LINE_FREQ_MIN_HZ || fReq > LINE_FREQ_MAX_HZ) {
      fail('V18', `电源频率 ${fReq}Hz 越界（合法区间 ${LINE_FREQ_MIN_HZ}~${LINE_FREQ_MAX_HZ}Hz）：` +
        `过低则同步转速不足、高速工况不可能，过高则多为量纲/笔误（如误填电频率 400Hz 当工频）`)
    } else {
      metrics.line_freq_hz = fReq
    }
  } else {
    metrics.line_freq_hz = DEFAULT_LINE_FREQ_HZ
  }

  // ---- V16 极数-转速同步一致性（超同步拦截，P0 门禁）----
  // 异步电动机额定转速必须低于同步转速 n_sync = 120·f_line/p（转差为正才能输出转矩）；
  // 若 n_sync ≤ 额定转速 ⇒ 转差 ≤ 0（超同步），异步机无法作为电动机运行（只能作发电机/制动）。
  // 同步机（PMSM/BLDC/IPM）无转差概念，本规则不适用，显式跳过。
  // v0.2.5：f_line 不再硬编码 50Hz，改由 resolveLineFreqHz() 解析（行内 line_freq_hz > opts.lineFreqHz > 50Hz）。
  // 原硬编码导致 4 极机在 1500rpm（=120×50/4）形成「断崖」，而该转速在 60Hz 下是 6 极机正常同步点。
  // v0.4.0（P0-1 续）：VFD/变频工况（显式传 line_freq_hz）下对**同步边界**放宽 ——
  //   当 n_sync 落在 [n·(1−SLIP_MIN_TOL), n]（滑差 < 3%）属「临界可行」：驱动频率本可微调，
  //   把频率略调高即可获得正常转差（如 12.5Hz→12.9Hz 把 6 极@250rpm 从滑差 0 拉到 ~3%）。
  //   此时降级为 warning + 频率微调建议，不再整批判死（这正是 400kW 船推 6 极@12.5Hz 此前被误杀的根因）。
  //   滑差更小（n_sync ≤ n·(1−SLIP_MIN_TOL)）才是真不可行（如 8 极@12.5Hz n_sync=187.5 < 242.5）。
  //   工频（未显式传 line_freq_hz，按 50Hz）维持原严格口径：n_sync ≤ n 直接判 failed
  //   （对应 4 极@1500rpm@50Hz 同步点断崖，必须保留）。
  if (speed !== null && poles !== null) {
    const isPm = isPmsmType(row?.motor_type)
    if (isPm) {
      skipped.push('V16')
    } else {
      const lineFreqHz = resolveLineFreqHz(row, opts)
      metrics.line_freq_hz = lineFreqHz
      const nSync = (120 * lineFreqHz) / poles
      metrics.sync_speed_rpm = round1(nSync)
      // VFD 模式判定：行内或 opts 显式提供了电源频率（变频驱动），放宽同步边界；
      // 工频（均无）维持严格口径。
      const vfdMode = (row?.line_freq_hz !== undefined && row?.line_freq_hz !== null)
        || (opts?.lineFreqHz !== undefined && opts?.lineFreqHz !== null)
      const slipMin = vfdMode ? SLIP_MIN_TOL : 0
      if (nSync <= speed * (1 - slipMin)) {
        // 真不可行：同步转速比额定转速低太多，即使最小滑差也凑不出转矩
        const recommendedPole = Math.max(2, Math.floor((120 * lineFreqHz) / speed - 1e-6) || 2)
        fail('V16', `极数 ${poles} 与转速 ${speed}rpm 不同步：同步转速 ${round1(nSync)}rpm ≤ 额定转速×${(1 - slipMin).toFixed(2)}，` +
          `异步机转差≤0（超同步），无法作为电动机运行；该转速档应选 ${recommendedPole} 极` +
          `（n_sync=${(120 * lineFreqHz) / recommendedPole}rpm，f_line=${lineFreqHz}Hz）`,
          { margin: ruleMargin(nSync, speed, { unit: 'rpm', better: 'higher' }) })
      } else if (vfdMode && nSync <= speed) {
        // 临界可行：滑差 < SLIP_MIN_TOL，提示微调驱动频率而非判废
        const freqForSlip = round1((speed * poles / 120) * (1 + SLIP_MIN_TOL))
        warn('V16', `极数 ${poles} 在 ${lineFreqHz}Hz 下同步转速 ${round1(nSync)}rpm 仅略高于额定 ${speed}rpm` +
          `（滑差 < ${(SLIP_MIN_TOL * 100).toFixed(0)}%，贴近同步点），属临界可行：` +
          `把驱动频率略调高至约 ${freqForSlip}Hz 即可获得正常转差；` +
          `6 极@250rpm 类 VFD 工况按此处理，不再整批判死。`)
      }
    }
  } else {
    skipped.push('V16')
  }

  // ---- V13 每线圈匝数下限（附在 V06 组，不单独占号）----
  // v0.1.6：闭环反推可能给出 turns_per_coil=1（380V/高频低匝数场景，hairpin 扁线绕组可行），
  // 故下限改为 <1（仅排除真正不可实现的 0/负匝数），不再误报 1 匝方案。
  if (turns !== null && turns < 1) {
    fail('V06', `每线圈匝数 ${turns} < 1，绕组不可实现`)
  }

  // v1.3.0 P0-2：杠杆反解块（V07 齿宽 / V08 轭厚 / V15 匝数的「还可调整量」）
  if (Object.keys(headroom).length) metrics.leverage_headroom = headroom

  // v1.3.1 P2-1：verdict 密度无关化——显式声明 status 仅由物理规则驱动
  // density_independent 让调用方一眼确认：任何密度/负荷类指标（功率密度、转矩密度、
  // 采样密度自检）都只参与排序与提示，绝不反向改写「合格/不合格」判定。
  const verdictBasis = {
    drivers: issues
      .filter((i) => i.level === 'failed' || i.level === 'warning')
      .map((i) => ({ rule: i.rule, level: i.level })),
    density_independent: true,
    note: 'status 仅由 V01~V18 物理规则驱动；密度/负荷类指标只参与排序与提示，绝不参与合格判定',
  }

  return {
    status,
    verdict_basis: verdictBasis,
    issues,
    checked: RULE_CATALOG.length - skipped.length,
    skipped,
    metrics,
    params_summary: {
      stator_od: statorOd, stator_id: statorId, rotor_od: rotorOd,
      core_length: coreLength, air_gap: airGap, poles, slots_stator: slotsStator,
      slots_rotor: slotsRotor, speed,
    },
  }
}

/**
 * 批量校验并按状态分组
 * @param {object[]} rows
 * @param {object} [opts] 同 validateDesign
 * @returns {{passed: object[], warning: object[], failed: object[],
 *            summary: {total, passed, warning, failed}, reports: object[]}}
 */
export function validateDesignBatch(rows, opts = {}) {
  const reports = []
  const passed = []
  const warning = []
  const failed = []

  for (let i = 0; i < (rows?.length ?? 0); i += 1) {
    const row = rows[i]
    let report
    try {
      report = { index: i, ...validateDesign(row, opts) }
    } catch (err) {
      report = {
        index: i, status: 'failed',
        issues: [{ rule: 'V00', level: 'failed', msg: `校验执行异常: ${String(err?.message ?? err)}` }],
        checked: 0, skipped: [], metrics: {}, params_summary: {},
      }
    }
    reports.push(report)
    const item = { index: i, params: row, report }
    if (report.status === 'failed') failed.push(item)
    else if (report.status === 'warning') warning.push(item)
    else passed.push(item)
  }

  return {
    passed, warning, failed, reports,
    summary: {
      total: rows?.length ?? 0,
      passed: passed.length,
      warning: warning.length,
      failed: failed.length,
    },
  }
}

export default {
  RULE_CATALOG, ESCALATABLE_RULES,
  poleFlux, toothFluxDensity, toothWidthForFlux, yokeFluxDensity, slotGeometry,
  ruleMargin, rangeMargin, solveTurnsPerCoil,
  validateDesign, validateDesignBatch,
}
