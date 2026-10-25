/**
 * 经验公式引擎 —— L0 毫秒级估算的计算核心
 * ===========================================================
 * 设计原则：
 *   1. **零依赖**：只用 Node 内置能力，可被 node 直接 import 做单测
 *   2. **确定性**：全部去除 Python 侧的 random 抖动（physics_kernel.py:587/608/609/629
 *      等处有 random），同一入参必得同一结果 —— L0 要能回归比对，抖动是死敌
 *   3. **双通道产出**：
 *        native  物理损耗通道（L0 原生 6 字段，有独立估算价值）
 *        proxy   L1 同口径去噪克隆（专供 W4 回归质量门比对）
 *
 * 取舍说明：为什么不直接照抄 _run_simulated？
 *   照抄会让 L0 退化成「L1 的复制品」，失去预筛层的独立信息量。
 *   保留两套并显式输出 proxy，既能排序一致，又能暴露两侧偏差 —— 这正是 W4 要的门。
 */

import {
  TORQUE_CONST, AIR_GAP_MIN, AIR_GAP_MAX, SIM_EFF, SIM_TEMP, LOSS_SPLIT,
  STEINMETZ, COOLING_COEFFICIENT, DEFAULT_COOLING, POLE_EFFICIENCY_FACTOR,
  COPPER_LOSS_K, COPPER_K_BINS, MECH_STRAY_RATIO,
  CURRENT_DENSITY_REF, FLUX_TARGET, STACKING_FACTOR, AMBIENT_TEMP_C,
  B_YOKE_SAT_T,
  J_DESIGN, WINDING_FACTOR, POWER_FACTOR_REF, ETA_REF_FOR_CURRENT,
  DEFAULT_CONNECTION, BACKEMF_TOL, SLOT_FILL_WARN, SLOT_FILL_MAX,
  SLOT_LINER_T_MM, SLOT_WEDGE_T_MM, SLOT_SHAPE_FILL, WIRE_COPPER_RATIO,
  queryPfEtaRef,
  AIR_GAP_FLUX_DEFAULT, AIR_GAP_FLUX_BY_POLES, INSULATION_LIMITS, DEFAULT_INSULATION_CLASS,
  COPPER_LOSS_K_BY_TYPE,
  lambdaRange, clamp, round1, round2, round3, round4, round5, yokeThickness,
  TYPICAL_B_DELTA, TYPICAL_SIGMA, queryTypicalBLoading,
  TORQUE_OVERLOAD_FACTOR, queryTorqueOverloadFactor,
} from './motor-constants.mjs'
import { buildL0Result } from './param-schema.mjs'

// v0.2.7 P1-3：公式通道是「未标定默认通道」（见 README「已知精度边界」——L0 损耗模型
// 尚未用 RMxprt 批量结果标定），其输出只能用于排序与相对比较，不能当绝对值采信。
// 故置信度用显式低于 1 的标记值，与代理通道的逐预测 confidence 区分，
// 不再恒为 1.0（否则下游误以为公式结果是高置信标定预测）。
const FORMULA_CHANNEL_CONFIDENCE = 0.5

// ── 2026-10-17 P0 改码开关（默认 ON = 新口径生效；置 0/'intent' 可回退旧行为做单变量对照）──
// 三项各自独立，便于逐项 toggle 证零回归：
//   DSH_L0_BG_CALIBER      'actual'(默认) | 'intent'   P0-1 磁密判据口径
//   DSH_L0_ENG_SLOT_FILL    '1'(默认) | '0'            P0-3 V15 用工程槽满率口径
//   DSH_L0_PF_ETA_BINS      '1'(默认) | '0'            P0-4 pf/η 分档
const ENV_ON = (v, dflt = true) => (v === undefined || v === '' ? dflt : !(v === '0' || String(v).toLowerCase() === 'false' || String(v).toLowerCase() === 'off'))
export const bgCaliberOf = (opts) => (opts?.bgCaliber ?? process.env.DSH_L0_BG_CALIBER ?? 'actual')
export const engSlotFillOn = (opts) => (opts?.engSlotFill ?? ENV_ON(process.env.DSH_L0_ENG_SLOT_FILL, true))
export const pfEtaBinsOn = (opts) => (opts?.pfEtaBins ?? ENV_ON(process.env.DSH_L0_PF_ETA_BINS, true))
//   DSH_L0_BG_BINS          '1'(默认) | '0'            P0-3 气隙磁密按极数分档（真值标定）
export const bgBinsOn = (opts) => (opts?.bgBins ?? ENV_ON(process.env.DSH_L0_BG_BINS, true))
//   DSH_L0_LOSS_TYPE_AWARE  '1'(默认) | '0'           P1-5 损耗标定系数按机型隔离
export const lossTypeAwareOn = (opts) => (opts?.lossTypeAware ?? ENV_ON(process.env.DSH_L0_LOSS_TYPE_AWARE, true))
//   DSH_L0_WINDING_LOCK     '1' | '0'(默认)           P2-A 绕组锁定：电气闭环尊重入参绕组
export const windingLockOn = (opts) => (opts?.windingLock ?? ENV_ON(process.env.DSH_L0_WINDING_LOCK, false))

/**
 * P2-A：有效绕组系数 kw_eff（E 平衡闭合用，默认 OFF 通道的标定常量）。
 * 65 台 RMxprt 真值反算 mean=0.697、CV=5.1%（output/p2_kw_eff.json）；
 * 与 WINDING_FACTOR=0.95（仅分布+短距）的差额主要为斜槽/斜极削弱。
 * 优先级：opts.kwEff > env DSH_L0_KW_EFF > KW_EFF_DEFAULT。
 * ⚠ 65 台样本中 6/8 极为 EMF 合成绕组（4 极为真实绕组 37 台），
 *   跨族泛化需真实冲片绕组复核（见 output/p2_bg_fix_plan_report.md §10）。
 */
export const KW_EFF_DEFAULT = 0.697
export const kwEffOf = (opts) => {
  const v = opts?.kwEff ?? process.env.DSH_L0_KW_EFF
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : KW_EFF_DEFAULT
}

/**
 * P0-3：解析出本行应使用的设计意图气隙磁密 Bg (T)。
 * 优先级：调用方显式 opts.airGapFlux > 极数分档（已标定机型+极数）> AIR_GAP_FLUX_DEFAULT。
 * pmsm 仅 2/4 极、induction 仅 2/4/6/8 极有真值支撑（见 AIR_GAP_FLUX_BY_POLES 注释），
 * 其余极数与非异步机回退 0.80T。开关 DSH_L0_BG_BINS 默认 ON（opts.bgBins 可覆盖）。
 */
export const airGapFluxForDesign = (poles, motorType, opts) => {
  if (!bgBinsOn(opts)) return AIR_GAP_FLUX_DEFAULT
  const mt = String(motorType ?? 'induction').toLowerCase()
  const bins = AIR_GAP_FLUX_BY_POLES[mt]        // pmsm 2/4、induction 2/4/6/8 有真值标定表（2026-10-25 选项 C）
  if (!bins) return AIR_GAP_FLUX_DEFAULT
  const v = bins[poles]
  return Number.isFinite(v) ? v : AIR_GAP_FLUX_DEFAULT
}

/** 铜电阻率 Ω·m @ FLUX_TARGET.temperatureC（用户现场口径 150°C） */
const RHO_CU_20 = 1.72e-8
const ALPHA_CU = 0.00393

/** 硅钢密度 kg/m³ */
const RHO_FE = 7650

/** 槽内铜填充率（典型槽满率 0.40~0.50） */
const SLOT_FILL_FACTOR = 0.45

/**
 * 端部单边伸出长度系数：end_ext ≈ 1.8·τ_p
 * 起因：原先的常量 1.35 倍端部系数在「少极数 + 短铁心」机器上严重低估绕组长度。
 *       少极数机器极距大 → 端部占比高，这是物理事实，不能用常数近似。
 */
const END_EXT_COEF = 1.8

/** 机械损耗标定系数：P_mech = K·(n/1000)²·(rotor_od/100)² (W) */
const MECH_LOSS_K = 5.0

export function copperResistivity(tempC = FLUX_TARGET.temperatureC) {
  return RHO_CU_20 * (1 + ALPHA_CU * (tempC - 20))
}

// ═════════════════════════════════════════════════════════════
// 1. 基础换算（严格对齐 Python 侧同名函数）
// ═════════════════════════════════════════════════════════════

/** T = 9550·P/n —— physics_kernel.py:63-67 */
export function computeTorque(powerKw, speedRpm) {
  if (!speedRpm || speedRpm <= 0) return 0
  return round2((TORQUE_CONST * powerKw) / speedRpm)
}

// ═════════════════════════════════════════════════════════════
// P1 转矩公式层（方法2 电磁负荷 / 方法3 切向应力）
// 真源：《L0扭矩计算方法比较》第二/三节。D 取定子内径（气隙直径，物理正确）。
// ═════════════════════════════════════════════════════════════

/** 电枢直径 D(m)：取定子内径；缺省按定子外径×0.6 派生（与 quickL0Estimate 同口径） */
function armatureDiameterM(params) {
  const dMm = params.stator_id ?? (params.stator_od ? params.stator_od * 0.6 : 0)
  return dMm / 1000
}
/** 铁心长 L(m) */
function coreLengthM(params) {
  return (params.core_length ?? 0) / 1000
}

/**
 * 方法2：电磁负荷法主力 T=(π/2)·Bδ·A·D²·L·kw·kFe·kSat
 * Bδ/A 取典型表（queryTypicalBLoading，按 motor_type×cooling 选段）。
 * kw=WINDING_FACTOR(0.95), kFe=STACKING_FACTOR(0.98), kSat=1.0。
 * @returns {{torque:number, torque_density:number, confidence:number, basis:string, loading:number}}
 */
export function computeTorqueD2L(params = {}, opts = {}) {
  const D = armatureDiameterM(params)
  const L = coreLengthM(params)
  if (D <= 0 || L <= 0) return { torque: 0, torque_density: 0, confidence: 0, basis: 'd2l', loading: 0 }
  const motorType = opts.motorType ?? params.motor_type ?? 'induction'
  const cooling = opts.cooling ?? params.cooling ?? DEFAULT_COOLING
  const tl = queryTypicalBLoading(motorType, cooling)
  const kw = WINDING_FACTOR
  const kFe = STACKING_FACTOR
  const kSat = 1.0
  const torque = (Math.PI / 2) * tl.bDelta * tl.loading * D * D * L * kw * kFe * kSat
  const volumeM3 = D * D * L
  return {
    torque: round2(torque),
    torque_density: volumeM3 > 0 ? Math.round(torque / volumeM3) : 0,
    confidence: FORMULA_CHANNEL_CONFIDENCE,
    basis: 'd2l',
    loading: round2(tl.loading),
  }
}

/**
 * 方法3：切向应力法 T=(π/2)·D²·L·σ
 * σ 取典型表；与方法2 数学等价（σ=Bδ·A），作交叉验证/降级备选。
 * @returns {{torque:number, torque_density:number, confidence:number, basis:string, sigma:number}}
 */
export function computeTorqueStress(params = {}, opts = {}) {
  const D = armatureDiameterM(params)
  const L = coreLengthM(params)
  if (D <= 0 || L <= 0) return { torque: 0, torque_density: 0, confidence: 0, basis: 'stress', sigma: 0 }
  const motorType = opts.motorType ?? params.motor_type ?? 'induction'
  const cooling = opts.cooling ?? params.cooling ?? DEFAULT_COOLING
  const tl = queryTypicalBLoading(motorType, cooling)
  const torque = (Math.PI / 2) * D * D * L * tl.sigma
  const volumeM3 = D * D * L
  return {
    torque: round2(torque),
    torque_density: volumeM3 > 0 ? Math.round(torque / volumeM3) : 0,
    confidence: FORMULA_CHANNEL_CONFIDENCE,
    basis: 'stress',
    sigma: tl.sigma,
  }
}

/**
 * 转矩包络派生（v1.2.0）—— 把「额定提供 / 最大提供 / 需求」三者合成可行性判据
 * ===========================================================
 * 物理量层级（不得混用）：
 *   需求扭矩 demand   = 9550·P/n            —— 规格，硬约束，conf 1.0
 *   额定提供 rated    = (π/2)·Bδ·A·D²·L·kw·kFe —— 典型电磁负荷下长期可输出（代理，低置信）
 *   最大提供 max      = rated × K（过载倍数）—— 短时可输出（代理，低置信）
 *
 * 判据（这是 L0 广筛最有价值的几何信号，此前完全缺失）：
 *   demand ≤ rated                 ⇒ ample          充裕（几何还有缩小空间）
 *   rated < demand ≤ max           ⇒ overload_only  仅短时过载可行，长期不行
 *   demand > max                   ⇒ undersized     几何偏小，必须放大机座
 *   demand=0 或 rated=0            ⇒ unknown        数据不足，不作判定（不伪造）
 *
 * @param {number} demandNm 需求扭矩（9550·P/n）
 * @param {number} capabilityRatedNm 额定可提供转矩
 * @param {string} [motorType]
 * @param {number} [overloadFactor] 覆盖倍率（>0 生效）
 */
export function deriveTorqueEnvelope(demandNm = 0, capabilityRatedNm = 0, motorType = 'induction', overloadFactor) {
  const k = (typeof overloadFactor === 'number' && overloadFactor > 0)
    ? overloadFactor
    : queryTorqueOverloadFactor(motorType)
  const max = capabilityRatedNm > 0 ? capabilityRatedNm * k : 0
  let feasibility = 'unknown'
  if (demandNm > 0 && capabilityRatedNm > 0) {
    if (demandNm <= capabilityRatedNm) feasibility = 'ample'
    else if (demandNm <= max) feasibility = 'overload_only'
    else feasibility = 'undersized'
  }
  return {
    torque_capability_max: round2(max),
    overload_factor: k,
    torque_margin: demandNm > 0 ? round3(max / demandNm) : 0,
    torque_margin_rated: demandNm > 0 ? round3(capabilityRatedNm / demandNm) : 0,
    torque_feasibility: feasibility,
  }
}

/** P = T·n/9550 —— motor_tools.py:760 */
export function computePowerKw(torqueNm, speedRpm) {
  return round2((torqueNm * speedRpm) / TORQUE_CONST)
}

/** D²L (m³) —— physics_kernel.py:70-74 */
export function computeD2L(dMm, lMm) {
  const d = dMm / 1000
  const l = lMm / 1000
  return Math.round(d * d * l * 1e6) / 1e6
}

/** λ = L/D —— physics_kernel.py:77-81 */
export function computeLambda(lMm, dMm) {
  if (!dMm || dMm <= 0) return 0
  return Math.round((lMm / dMm) * 1000) / 1000
}

/** λ 合理性校验 —— physics_kernel.py:84-98（返回结构保持一致） */
export function validateLambda(lMm, dMm, poles) {
  const lam = computeLambda(lMm, dMm)
  const [lo, hi] = lambdaRange(poles)
  const valid = lam >= lo && lam <= hi
  let advice = ''
  if (!valid) {
    advice = lam < lo
      ? `lambda=${lam} 偏小, 铁心过短或内径过大, 建议增加铁心长度`
      : `lambda=${lam} 偏大, 铁心过长或内径过小, 建议减小铁心长度或增大内径`
  }
  return { valid, lambda: lam, range: [lo, hi], advice }
}

/** 电频率 f = n·p/120 */
export function electricalFrequency(speedRpm, poles) {
  return (speedRpm * poles) / 120
}

// ═════════════════════════════════════════════════════════════
// 2. 损耗分解（L0 物理通道）
// ═════════════════════════════════════════════════════════════

/** 定子铁心质量估算 (kg) */
export function estimateCoreMassKg(statorOd, statorId, coreLength) {
  const areaMm2 = (Math.PI / 4) * (statorOd ** 2 - statorId ** 2)
  const volumeM3 = areaMm2 * 1e-6 * (coreLength / 1000)
  return round2(volumeM3 * RHO_FE * STACKING_FACTOR)
}

/** 铁损 P_fe —— Steinmetz 简化：p = kh·f·B^α + ke·f²·B² (W/kg) */
export function estimateIronLoss({
  speedRpm, poles, coreMassKg, fluxDensity = STEINMETZ.fluxDensity,
}) {
  const f = electricalFrequency(speedRpm, poles)
  const B = fluxDensity
  const perKg =
    STEINMETZ.kh * f * Math.pow(B, STEINMETZ.alpha) +
    STEINMETZ.ke * f * f * B * B
  return Math.round(perKg * coreMassKg)
}

/**
 * 槽几何派生（与设计规则一致口径）
 * 返回槽面积 mm² 与平均半匝长度 m（供铜损与槽满率共用）。
 */
export function slotGeometryDerived({ statorOd, statorId, coreLength, slotsStator, poles }) {
  const half = (statorOd - statorId) / 2
  const slotDepth = round1(half * 0.60)
  const meanDia = statorId + slotDepth
  const toothPitch = (Math.PI * meanDia) / slotsStator
  const toothWidth = (Math.PI * statorId) / (2 * slotsStator)
  const slotWidth = Math.max(0, toothPitch - toothWidth)
  const slotAreaMm2 = slotWidth * slotDepth
  const polePitchMm = (Math.PI * statorId) / (poles || 4)
  const meanTurnLength = (coreLength + 2 * END_EXT_COEF * polePitchMm) / 1000  // m
  return { slotDepth, slotWidth, slotAreaMm2, meanTurnLength }
}

/**
 * 槽有效面积（工程口径，2026-10-17 P0-3）
 * ---------------------------------------------------------------
 * 外接矩形毛槽 (slotWidth×slotDepth) 依次扣减：
 *   ① 形状系数 SLOT_SHAPE_FILL —— 梨形/梯形槽上窄下宽+圆角，并非满矩形
 *   ② 槽绝缘 SLOT_LINER_T_MM  —— 双边占宽、槽底占深
 *   ③ 槽楔   SLOT_WEDGE_T_MM  —— 占槽深
 * 返回可下线面积 mm²，与 SLOT_FILL_WARN/MAX 的工程口径配平。
 */
export function slotAreaNet({ slotWidth, slotDepth }) {
  const w = Math.max(0, (slotWidth ?? 0) - 2 * SLOT_LINER_T_MM)
  const d = Math.max(0, (slotDepth ?? 0) - SLOT_LINER_T_MM - SLOT_WEDGE_T_MM)
  return round1(w * d * SLOT_SHAPE_FILL)
}

/**
 * 铜损 P_cu —— 真实电流闭环（v0.1.6 修复 P0「电流装饰字段」）
 * ---------------------------------------------------------------
 * 旧版用固定电密常量 CURRENT_DENSITY_REF 近似，矩阵里的 peak_current 被完全忽略，
 * 导致「50A 峰值」与「200kW/380V 实需 ~496A」差 10 倍却无人发现。
 * 新版：给定 peak_current（矩阵已闭环反推），按设计电密 J_DESIGN 定线规，
 * 反算相电阻与铜损，并一并返回槽满率（几何可行性判据）。
 *
 * @returns {{
 *   copper_loss:number, slot_fill_ratio:number, slot_area_mm2:number,
 *   conductor_area_mm2:number, current_density:number,
 *   phase_resistance_ohm:number, line_current_rms:number, feasible:boolean
 * }}
 */
export function estimateCopperLoss({
  statorOd, statorId, coreLength, slotsStator, poles,
  peakCurrent, turnsPerCoil, parallelCircuits = 1, airGap = 0.6,
  currentDensityRef = J_DESIGN, windingFactor = WINDING_FACTOR,
  opts = null,   // P0-3 修复：开关的 opts 通道。此前函数内 engSlotFillOn() 无参调用，
                 // 导致调用方传入的 opts.engSlotFill 被静默丢弃（env 通道正常，故门禁未抓到）。
}) {
  const a = Math.max(1, parallelCircuits)
  const geo = slotGeometryDerived({ statorOd, statorId, coreLength, slotsStator, poles })
  if (geo.slotAreaMm2 <= 0) {
    return {
      copper_loss: 0, slot_fill_ratio: 0, slot_area_mm2: 0, conductor_area_mm2: 0,
      current_density: 0, phase_resistance_ohm: 0, line_current_rms: 0, feasible: false,
    }
  }
  const iRms = (peakCurrent ?? 0) / Math.SQRT2            // 峰值→有效值
  // 每支路导体电流 = I_rms / a；按设计电密定单根导线截面积
  const aWire = (iRms / a) / currentDensityRef            // mm²
  // 每相串联匝数 N = (Qs/3)·turns_per_coil / a
  const nPhase = ((slotsStator / 3) * (turnsPerCoil ?? 0)) / a
  // 槽满率（推导）：每槽导体铜面积 / 槽面积
  //   = 2·turns_per_coil·aWire / slotArea
  //   等价形式 turns_per_coil·I_rms / (a²·J·slotArea)
  const conductorArea = 2 * (turnsPerCoil ?? 0) * aWire   // 每槽铜面积 mm²（裸铜净面积）
  const slotFill = geo.slotAreaMm2 > 0 ? conductorArea / geo.slotAreaMm2 : 0
  // ---- P0-3 工程槽满率：导线含漆膜面积 / 槽有效面积 ----
  // 旧 slotFill 是「裸铜净面积 / 外接矩形毛槽」，与 SLOT_FILL_WARN/MAX（工程口径）不可比，
  // 实测同机仅 0.17~0.27 ⇒ V15 在错误口径上比较，系统性漏判真实过槽满。此处补工程口径。
  const slotAreaNetMm2 = slotAreaNet({ slotWidth: geo.slotWidth, slotDepth: geo.slotDepth })
  const enameledArea = conductorArea / WIRE_COPPER_RATIO        // 含漆膜的导线占面积
  const slotFillEng = slotAreaNetMm2 > 0 ? enameledArea / slotAreaNetMm2 : 0
  // 判定口径：env 开关默认 ON ⇒ 用工程槽满率；置 0 回退旧净/毛口径（单变量对照用）
  const fillForGate = engSlotFillOn(opts) ? slotFillEng : slotFill
  // 相电阻 R = ρ·N·l_mean / aWire
  const rho = copperResistivity()
  const rPhase = nPhase > 0 && aWire > 0
    ? (rho * nPhase * geo.meanTurnLength) / (aWire * 1e-6)   // aWire mm²→m²
    : 0
  const pCu = 3 * iRms * iRms * rPhase
  return {
    copper_loss: Math.round(pCu),
    slot_fill_ratio: round3(Math.max(0, slotFill)),          // 旧口径（裸铜净/毛槽），仅作诊断
    slot_fill_engineering: round3(Math.max(0, slotFillEng)), // P0-3 工程口径（含漆膜/槽有效面积）
    slot_fill_caliber: engSlotFillOn(opts) ? 'engineering' : 'net_over_gross',
    slot_area_mm2: geo.slotAreaMm2,
    slot_area_net_mm2: slotAreaNetMm2,
    conductor_area_mm2: round1(conductorArea),
    conductor_area_enameled_mm2: round1(enameledArea),
    current_density: round2(currentDensityRef),
    phase_resistance_ohm: round4(rPhase),
    line_current_rms: round1(iRms),
    feasible: fillForGate <= SLOT_FILL_MAX,
  }
}

/**
 * 电气闭环反推（v0.1.6 核心修复）
 * ---------------------------------------------------------------
 * 给定电压/转速/极数/几何，反推自洽的：
 *   - 电频率 f = n·p/120
 *   - 每相串联匝数 N（使反电势 E ≈ 相电压 Uph）
 *   - 每线圈匝数 turns_per_coil = round(N·a·3/Qs)
 *   - 峰值电流 I_peak（由功率 P = √3·U·I·pf·η 反推）
 *   - 反电势 E 与 |E−Uph| 偏差（门禁用）
 *   - 设计电密 J、功率因数 pf
 *
 * 反电势：E ≈ 4.44·f·N·Φ·kdp，Φ = 2·Bg·Dsi·L/p（poleFlux 口径，含 2/π 平均因子）
 * 相电压：星接 Uph = U/√3（DEFAULT_CONNECTION=star）
 *
 * @returns {object} 见下；任何几何缺项返回 null（供调用方 skipped）
 */
export function deriveElectricalClosure({
  voltage, speed, poles, statorId, coreLength, airGap = 0.6,
  slotsStator, parallelCircuits = 1, airGapFlux = AIR_GAP_FLUX_DEFAULT,
  connection = DEFAULT_CONNECTION, windingFactor = WINDING_FACTOR,
  powerKw = null, pf = POWER_FACTOR_REF, eta = ETA_REF_FOR_CURRENT,
  // P2-A 绕组锁定（默认 off，env DSH_L0_WINDING_LOCK / opts.windingLock）：
  // 入参绕组（conductors_per_slot 优先，turns_per_coil 兜底）不再被重算匝数覆盖，
  // 改由入参匝数经 E 平衡闭合反推磁通 Φ_locked / Bg_locked。
  windingLock = false, turnsPerCoilIn = null, conductorsPerSlotIn = null,
  kwEff = KW_EFF_DEFAULT,
}) {
  if (![voltage, speed, poles, statorId, coreLength, slotsStator].every((v) => Number.isFinite(v) && v > 0)) {
    return null
  }
  const a = Math.max(1, parallelCircuits)
  const f = (speed * poles) / 120
  const uph = connection === 'delta' ? voltage : voltage / Math.SQRT2 / Math.sqrt(1.5) // 星接 Uph=U/√3
  const phi = (2 * airGapFlux * (statorId / 1000) * (coreLength / 1000)) / poles  // Wb/极
  if (f <= 0 || phi <= 0) return null
  const nPhase = uph / (4.44 * f * phi * windingFactor)
  // v0.2.5 P1：区分「理想匝数」与「整匝匝数」
  //   理想匝数 turnsIdeal = N·a·3/Qs 是连续量，由电压/频率/几何唯一确定；
  //   实际绕组只能用整数匝 ⇒ turnsPerCoil = max(1, round(turnsIdeal))。
  //   原实现只输出整匝值并让 V14 拿它反算 E 再判 ±10%，等于「用自己量化过的值
  //   校验自己的量化误差」——当 turnsIdeal<1 时被钳到 1 匝，E 必然大幅偏离 Uph，
  //   V14 结构性自证失败（实测 200kW/22000rpm 理想 0.716 匝→钳成 1 匝→E 偏差 39.8%）。
  //   故此处同时输出理想匝数与量化偏差，交由 V14（自洽性）与 V17（离散度）分别判据。
  const turnsIdeal = (nPhase * a * 3) / slotsStator
  // P2-A 绕组锁定：入参绕组有效时，turns_per_coil 输出入参值（不再被 round(turnsIdeal) 覆盖）。
  // 入参匝数归一为每相串联匝数（双层）：conductors_per_slot 优先（求解器口径，每槽总导体数），
  //   turns_per_coil 兜底（标准语义=每线圈匝数）。两者皆缺 ⇒ lock 不生效，回落旧行为。
  let nPhaseLocked = null
  let turnsPerCoilLocked = null
  if (windingLock) {
    const cps = Number(conductorsPerSlotIn)
    const tpc = Number(turnsPerCoilIn)
    if (Number.isFinite(cps) && cps > 0) {
      nPhaseLocked = ((cps / 2) * slotsStator) / (3 * a)     // = (Qs/3)·(cps/2)/a
      turnsPerCoilLocked = cps / 2
    } else if (Number.isFinite(tpc) && tpc > 0) {
      nPhaseLocked = (tpc * slotsStator) / (3 * a)           // = (Qs/3)·tpc/a
      turnsPerCoilLocked = tpc
    }
  }
  const turnsPerCoil = turnsPerCoilLocked !== null
    ? Math.max(1, Math.round(turnsPerCoilLocked))
    : Math.max(1, Math.round(turnsIdeal))
  const turnsQuantDev = turnsIdeal > 0 ? Math.abs(turnsPerCoil - turnsIdeal) / turnsIdeal : 1
  const backEmf = 4.44 * f * nPhase * phi * windingFactor
  const backEmfOk = Math.abs(backEmf - uph) / uph <= BACKEMF_TOL

  // P2-A：E 平衡闭合 —— 用入参匝数与 kw_eff 反推每极磁通与气隙磁密。
  // Φ = Uph/(4.44·f·N·kw_eff)；Bg = Φ/Ag，Ag = π·Di·L/(2·pp)（mm→m）。
  let phiLocked = null
  let bgLocked = null
  if (nPhaseLocked !== null && nPhaseLocked > 0) {
    const pp = Math.max(1, Math.round(poles / 2))
    phiLocked = uph / (4.44 * f * nPhaseLocked * kwEff)
    const agM2 = (Math.PI * (statorId / 1000) * (coreLength / 1000)) / (2 * pp)
    bgLocked = phiLocked / agM2
  }

  // 电流由功率反推（缺功率则用 design 电密估算，仅作回退）
  let peakCurrent = null
  if (Number.isFinite(powerKw) && powerKw > 0) {
    const iRms = powerKw * 1000 / (Math.sqrt(3) * voltage * pf * eta)
    peakCurrent = round1(iRms * Math.SQRT2)
  }

  return {
    freq_hz: round1(f),
    connection,
    phase_voltage: round1(uph),
    flux_per_pole_wb: round5(phi),
    turns_per_phase: round2(nPhase),
    turns_per_coil: turnsPerCoil,
    turns_per_coil_ideal: round3(turnsIdeal),
    turns_quant_dev: round3(turnsQuantDev),
    turns_rounded_up: turnsPerCoil > turnsIdeal + 1e-9,
    parallel_circuits: a,
    back_emf_v: round1(backEmf),
    back_emf_ok: backEmfOk,
    back_emf_dev: round3(Math.abs(backEmf - uph) / uph),
    peak_current: peakCurrent,
    line_current_rms: peakCurrent !== null ? round1(peakCurrent / Math.SQRT2) : null,
    power_factor: pf,
    current_density: J_DESIGN,
    // P2-A 绕组锁定回显（供溯源/门禁）
    winding_lock: nPhaseLocked !== null,
    turns_per_coil_locked: turnsPerCoilLocked !== null ? round2(turnsPerCoilLocked) : null,
    n_phase_locked: nPhaseLocked !== null ? round2(nPhaseLocked) : null,
    flux_per_pole_locked_wb: phiLocked !== null ? round5(phiLocked) : null,
    bg_locked_t: bgLocked !== null ? round3(bgLocked) : null,
    kw_eff: round3(kwEff),
  }
}

/** 机械损耗 —— 风磨+轴承经验标定（旧公式，仅保留向后兼容；
 *  生产链已改用 estimateMechStrayLoss，本函数低估 −87% 详见 MECH_STRAY_RATIO 注释） */
export function estimateMechanicalLoss({ speedRpm, rotorOdMm }) {
  if (!speedRpm || speedRpm <= 0) return 0
  return Math.round(
    MECH_LOSS_K * Math.pow(speedRpm / 1000, 2) * Math.pow(rotorOdMm / 100, 2)
  )
}

/** 机械耗+杂散损耗 —— 按输出功率分档比例（v3 标定 2026-10-08）。
 *  RMxprt 真值（total−cu−fe，含杂散）跨档 ≈ 3.0%/2.2%/2.0% × P_out。
 *  15kW 实测：公式 453W vs 真值 453W（旧公式仅 60W）。 */
export function estimateMechStrayLoss({ powerKw }) {
  if (!powerKw || powerKw <= 0) return 0
  const frame = COPPER_K_BINS.find((b) => powerKw <= b.maxKw)?.name ?? 'large'
  return Math.round(powerKw * 1000 * (MECH_STRAY_RATIO[frame] ?? 0.02))
}

/** 由输出功率与总损耗反推效率 (%) */
export function efficiencyFromLosses(powerOutputKw, totalLossW) {
  const pOut = powerOutputKw * 1000
  return round2((pOut / (pOut + totalLossW)) * 100)
}

/** 损耗按 L1 拆分比分解 —— motor_tools.py:775-777 */
export function splitLosses(totalLossW) {
  return {
    copper_loss: round1(totalLossW * LOSS_SPLIT.copper),
    iron_loss: round1(totalLossW * LOSS_SPLIT.iron),
    mechanical_loss: round1(totalLossW * LOSS_SPLIT.mechanical),
  }
}

// ═════════════════════════════════════════════════════════════
// 3. 温升
// ═════════════════════════════════════════════════════════════

/**
 * L0 原生温升 ΔT (K) —— 热负荷法
 * ΔT = P_loss / (h · A)，A 取机座光滑外表面积 + 端盖半面积
 */
export function estimateTempRise({ statorOd, coreLength, cooling }, totalLossW) {
  const h = COOLING_COEFFICIENT[cooling] ?? COOLING_COEFFICIENT[DEFAULT_COOLING]
  const odM = statorOd / 1000
  const lM = coreLength / 1000
  const lateral = Math.PI * odM * lM
  const endCap = Math.PI * (odM / 2) ** 2
  const area = lateral + endCap
  if (area <= 0) return 0
  return round1(totalLossW / (h * area))
}

// ═════════════════════════════════════════════════════════════
// 4. L1 同口径克隆（供 W4 回归比对）
// ═════════════════════════════════════════════════════════════

/**
 * L1 仿真效率去噪克隆 —— motor_tools.py:750-752
 *   base_eff = 85 + (od-180)·0.04 + (poles-8)·1.2，Python 侧另有 ±1.5 噪声
 */
/**
 * 未封顶效率的物理硬上界（v0.2.4）
 * 仅作数值保险：物理模型不可能算出 >100% 的效率，取 99.9 以防浮点/极端输入溢出。
 * 注意与 efficiencyCap 的区别：cap 是「与 L1 同口径」的口径约定，此值是物理边界。
 */
const RAW_EFF_MAX = 99.9

export function l1EfficiencyProxy({ statorOd, poles }, clampMax = SIM_EFF.clampMax) {
  const base =
    SIM_EFF.base +
    (statorOd - SIM_EFF.odRef) * SIM_EFF.odCoef +
    (poles - SIM_EFF.poleRef) * SIM_EFF.poleCoef
  return round2(clamp(base, SIM_EFF.clampMin, clampMax))
}

/**
 * L1 仿真最高温去噪克隆 —— motor_tools.py:755-756
 *   base_temp = 55 + (od-180)·0.25 + (speed-3000)·0.004，Python 侧另有 [-5,+8] 噪声
 * 注意单位：这里是 **°C（绝对温度）**，与 L0 原生 temp_rise 的 K（温升）不是同一口径。
 */
export function l1MaxTempProxy({ statorOd, speed }, clampRange = [SIM_TEMP.clampMin, SIM_TEMP.clampMax]) {
  const base =
    SIM_TEMP.base +
    (statorOd - SIM_TEMP.odRef) * SIM_TEMP.odCoef +
    (speed - SIM_TEMP.speedRef) * SIM_TEMP.speedCoef
  return round1(clamp(base, clampRange[0], clampRange[1]))
}

// ═════════════════════════════════════════════════════════════
// 5. L0 主估算
// ═════════════════════════════════════════════════════════════

/**
 * 单次 L0 估算 —— 返回「L0 原生 + L1 镜像」双字段结果（v3 决策②）
 *
 * @param {object} params 单行参数，须为 L1_MATRIX_FIELDS 形状（另加 power_kw/cooling）
 * @param {object} [opts]
 * @param {number} [opts.efficiencyCap=96]  效率封顶，默认对齐 _run_simulated L752
 * @param {[number,number]} [opts.maxTempClamp=[45,130]] 镜像 max_temp 钳位（对齐 L756）
 * @returns {object} 双字段结果行
 */
export function quickL0Estimate(params, opts = {}) {
  const efficiencyCap = opts.efficiencyCap ?? SIM_EFF.clampMax
  const maxTempClamp = opts.maxTempClamp ?? [SIM_TEMP.clampMin, SIM_TEMP.clampMax]
  const cooling = params.cooling ?? DEFAULT_COOLING
  // v0.2.5：绝缘等级取值改为「行内字段优先，opts 兜底」。
  // 取证根因：此前只读 opts.insulationClass，而矩阵行携带的是 params.insulation_class
  // ⇒ 行内等级从未被消费，B 级(80K) 用户一律按 F 级(105K) 考核且无任何告警。
  const insulationClass = String(
    params.insulation_class ?? params.insulationClass ?? opts.insulationClass ?? DEFAULT_INSULATION_CLASS,
  ).toUpperCase()
  const insulationValid = Object.prototype.hasOwnProperty.call(INSULATION_LIMITS, insulationClass)

  const powerKw = params.power_kw ?? computePowerKw(params.torque_nm ?? 0, params.speed)
  const poles = params.poles
  const statorOd = params.stator_od
  const statorId = params.stator_id ?? round1(statorOd * 0.6)
  const coreLength = params.core_length ?? 80
  const slotsStator = params.slots_stator ?? 36
  const rotorOdMm = params.rotor_od ?? round1(statorId - 2 * (params.air_gap ?? 0.6))
  const airGap = params.air_gap ?? 0.6
  const parallelCircuits = params.parallel_circuits ?? 1
  const turnsPerCoil = params.turns_per_coil ?? 6
  const peakCurrent = params.peak_current

  // ---- P0-4：电流反推用 pf/η（分档缺省 + 显式覆盖；env 默认 ON）----
  // 旧行为恒用 pf=0.92/η=0.94 反推电流，对中小型异步机系统性偏低 13~20%
  // （Y160M-4 19.3A vs 铭牌 22.6A）⇒ 线规偏细、槽满率与铜损偏低、效率偏乐观。
  // 优先级：params/opts 显式值 > 分档表（仅异步机）> 常量兜底。
  const pfEtaDefault = queryPfEtaRef({ powerKw, motorType: params.motor_type })
  const _pfIn = Number.isFinite(Number(params.power_factor)) ? Number(params.power_factor)
    : (Number.isFinite(Number(opts.pf)) ? Number(opts.pf) : null)
  const _etaIn = Number.isFinite(Number(params.efficiency_ref)) ? Number(params.efficiency_ref)
    : (Number.isFinite(Number(opts.eta)) ? Number(opts.eta) : null)
  const pfEta = pfEtaBinsOn(opts)
    ? {
      pf: _pfIn ?? pfEtaDefault.pf,
      eta: _etaIn ?? pfEtaDefault.eta,
      source: (_pfIn !== null || _etaIn !== null) ? 'input' : pfEtaDefault.source,
    }
    : { pf: POWER_FACTOR_REF, eta: ETA_REF_FOR_CURRENT, source: 'constant' }

  // ---- 电气闭环（v0.1.6）----
  // P2-A：绕组锁定（默认 off）。lock ON 且入参绕组有效时，deriveElectricalClosure
  //   不再用重算匝数覆盖入参，改由入参匝数经 E 平衡闭合反推 Bg_locked。
  const closure = deriveElectricalClosure({
    voltage: params.voltage ?? 380,
    speed: params.speed, poles, statorId, coreLength, airGap,
    slotsStator, parallelCircuits,
    // P0-3：极数分档 Bg（真值标定）。显式 opts.airGapFlux 优先。
    airGapFlux: opts.airGapFlux ?? airGapFluxForDesign(poles, params.motor_type, opts),
    powerKw,
    pf: pfEta.pf,
    eta: pfEta.eta,
    // P2-A：绕组入参透传（仅 lock ON 时被消费；OFF 时全部忽略，零回归）
    windingLock: windingLockOn(opts),
    turnsPerCoilIn: params.turns_per_coil ?? null,
    conductorsPerSlotIn: params.conductors_per_slot ?? null,
    kwEff: kwEffOf(opts),
  })
  const effTurns = closure?.turns_per_coil ?? turnsPerCoil
  const effCurrent = closure?.peak_current ?? peakCurrent

  // ---- 损耗三项 ----
  const coreMassKg = estimateCoreMassKg(statorOd, statorId, coreLength)
  // 铁耗等效磁密（v3 标定 2026-10-08）：B_eff=(Bt+By)/2 真值口径，与
  // scripts/calibrate_losses_v3.mjs 的标定口径严格一致（变频样本 f 8×/B 7.9× 双基辨识）。
  // 此前恒用 STEINMETZ.fluxDensity=1.2T ⇒ 铁耗不随设计变化，R² 无法收敛。
  // toothB/yokeB 计算因此前移（原先在铁耗之后只为输出可追溯值）。
  // P0-3：极数分档 Bg（真值标定 pmsm 2P=0.659/4P=0.724；induction 2P=0.624/4P=0.621/6P=0.575/8P=0.557；其余回退 0.80）。
  // 铁耗 B_eff 仍走**意图口径** bEffIron（与 v3 铁损标定同口径），故 Bg 分档会同步
  // 按 B² 缩放铁耗 —— 效果已在 82 行真值集上量化（见 scripts/verify_bg_bins_truth.mjs）。
  const airGapFlux = opts.airGapFlux ?? airGapFluxForDesign(poles, params.motor_type, opts)
  const toothWidthMm = params.tooth_width ?? round2((Math.PI * statorId) / (2 * slotsStator))
  const toothBraw = (2 * airGapFlux * statorId) / (slotsStator * toothWidthMm * STACKING_FACTOR)
  const yokeBraw = (airGapFlux * statorId) / (poles * (params.yoke_thickness ?? yokeThickness(statorOd, statorId)) * STACKING_FACTOR)
  const bEffIron = Math.max(0.05, (toothBraw + yokeBraw) / 2)   // 防退化负值/零
  // ---- P0-1：实际匝口径气隙磁密 ----
  // 铁芯真正承受的磁密由**整数匝**决定：Bg_actual = Bg_intent·(N_ideal/N_int)。
  // 与 design-rules.mjs:266 airGapFluxActual 同源同式；此处按匝比直接算，避免
  // formula-engine → design-rules 循环依赖（design-rules 已 import 本模块）。
  // ⚠ 铁损 B_eff 仍走意图口径 bEffIron：v3 铁损标定就是在意图口径上拟合的，
  //   擅自改口径等于作废标定（k_h/k_e 需重标定后才能动）。
  const bgCaliber = bgCaliberOf(opts)
  const turnsIdealEff = closure?.turns_per_coil_ideal ?? null
  const bgActual = (bgCaliber === 'actual'
    && Number.isFinite(turnsIdealEff) && turnsIdealEff > 0 && effTurns > 0)
    ? airGapFlux * (turnsIdealEff / effTurns)
    : null
  // P2-A：lock 生效时 Bg_locked（入参绕组 E 平衡闭合）优先于 bgActual（意图 Bg×匝比）
  //   —— 前者用 kw_eff 标定常量直接闭合，不经过"意图 Bg → 匝比"二级传导。
  const bgLocked = closure?.bg_locked_t ?? null
  const bgForFlux = bgLocked ?? bgActual ?? airGapFlux
  const yokeThk = params.yoke_thickness ?? yokeThickness(statorOd, statorId)
  const toothBActualRaw = (2 * bgForFlux * statorId) / (slotsStator * toothWidthMm * STACKING_FACTOR)
  const yokeBActualRaw = (bgForFlux * statorId) / (poles * yokeThk * STACKING_FACTOR)
  const pIron = estimateIronLoss({
    speedRpm: params.speed, poles, coreMassKg,
    fluxDensity: opts.fluxDensity ?? bEffIron,
  })
  const cu = estimateCopperLoss({
    statorOd, statorId, coreLength, slotsStator, poles,
    peakCurrent: effCurrent, turnsPerCoil: effTurns, parallelCircuits, airGap,
    opts,   // P0-3：把开关的 opts 通道透传下去
  })
  // 铜耗分档系数（v3 标定 2026-10-08）：档内模型形状正确（R² 0.92~0.97），
  // 档间幅度差 3.8× ⇒ 按额定功率查档修正。k 修正「公式+输入口径」总偏差，
  // 必须与上方电气闭环同路径使用。标定证据：scripts/calibrate_losses_v3.mjs。
  const frameName = COPPER_K_BINS.find((b) => powerKw <= b.maxKw)?.name ?? 'large'
  // P1-5：铜耗标定系数按机型隔离（异步机 n=2 临时标定 k=1.333；未标定档位沿用旧值，不外推）。
  const mtLoss = String(params.motor_type ?? 'induction').toLowerCase()
  const kTable = lossTypeAwareOn(opts) ? (COPPER_LOSS_K_BY_TYPE[mtLoss] ?? COPPER_LOSS_K) : COPPER_LOSS_K
  const kCu = Number.isFinite(kTable?.[frameName]) ? kTable[frameName] : (COPPER_LOSS_K[frameName] ?? 1)
  const pCopper = cu.copper_loss * kCu
  // 机械耗+杂散（v3 标定 2026-10-08）：RMxprt 真值含杂散跨档 ≈2.0~3.0%×P_out，
  // 旧风摩公式低估 −87%，是效率偏乐观 ~4pt 主因。档位与铜耗共用 COPPER_K_BINS。
  const pMech = estimateMechStrayLoss({ powerKw })
  const totalLossW = pIron + pCopper + pMech

  // ---- 效率（物理通道，再按极数与封顶修正）----
  const poleFactor = POLE_EFFICIENCY_FACTOR[poles] ?? 0.98
  const rawEff = efficiencyFromLosses(powerKw, totalLossW) * poleFactor
  const efficiency = round2(Math.min(efficiencyCap, Math.max(SIM_EFF.clampMin, rawEff)))
  // v0.2.4：efficiencyCap 存在的意义是「与 L1 同口径」，不是物理真值。
  // 大机座整批触顶时 efficiency 全被压成同一个数 ⇒ TopN 排序失去区分度（450kW 实测 10/10 触顶）。
  // 故额外保留未封顶真值供排序使用，并打触顶标记，让调用方知道 efficiency 是"钳位显示值"。
  const efficiencyRaw = round2(clamp(rawEff, SIM_EFF.clampMin, RAW_EFF_MAX))
  const efficiencyCapped = rawEff > efficiencyCap + 1e-9

  // ---- 温升（物理通道，含液冷标定修正）----
  const tempRise = estimateTempRise({ statorOd, coreLength, cooling }, totalLossW)
  const tempLimit = INSULATION_LIMITS[insulationClass] ?? INSULATION_LIMITS[DEFAULT_INSULATION_CLASS]
  const thermalOk = tempRise <= tempLimit
  // ---- 磁密（齿/轭）可追溯输出 ----
  // （airGapFlux/toothWidthMm 已前移至损耗段 —— 铁耗 B_eff 口径需要，见上方注释）
  const toothB = round2(toothBraw)
  const yokeB = round2(yokeBraw)
  const toothBActual = round2(toothBActualRaw)
  const yokeBActual = round2(yokeBActualRaw)
  // v0.1.7：轭部饱和判据（Bj 超硅钢饱和极限 ~1.9T ⇒ 轭部无法承载磁通，设计不可行）
  // P0-1：判据改用**实际匝口径**（与质量门 V08 一致）。此前主指标按意图口径判、
  // 门禁按实际口径判 ⇒ 同一行结果出现「表格正常但门禁爆」的自相矛盾。
  const yokeSat = (bgActual !== null ? yokeBActualRaw : yokeBraw) > B_YOKE_SAT_T

  // ---- 可行性判定（P0 门禁聚合）----
  const backEmfOk = closure?.back_emf_ok ?? true
  // P0-3：判定用工程口径槽满率（与 SLOT_FILL_WARN/MAX 的工程阈值配平）；
  // env 关闭时回退旧「裸铜净/毛槽」口径做单变量对照。
  const slotFillOk = (engSlotFillOn(opts) ? (cu.slot_fill_engineering ?? cu.slot_fill_ratio) : cu.slot_fill_ratio)
    <= SLOT_FILL_MAX
  const feasible = backEmfOk && slotFillOk && thermalOk && !yokeSat

  // ---- 转矩双字段（P4/P5 三级降级编排 · 公式通道内联）----
  // 期望输出（排序口径）= spec 9550·P/n（精确, conf 1.0）；
  // 可达能力（可行性口径）= d2l(方法2) → stress(方法3) 物理代理，低置信。
  const torque = params.torque_nm ?? computeTorque(powerKw, params.speed)
  const volumeM3 = (statorOd / 1000) ** 2 * (coreLength / 1000)
  const torqueDensity = volumeM3 > 0 ? Math.round(torque / volumeM3) : 0
  const _d2l = computeTorqueD2L(params, { cooling })
  const torqueCapability = _d2l.torque > 0 ? _d2l.torque : computeTorqueStress(params, { cooling }).torque
  const capabilitySource = _d2l.torque > 0 ? 'd2l' : (torqueCapability > 0 ? 'stress' : 'unavailable')
  // 需求 vs 提供：合成「额定提供 → 最大提供(×K) → 可行性判据」包络
  const envelope = deriveTorqueEnvelope(torque, torqueCapability, params.motor_type ?? 'induction')

  const native = {
    efficiency,
    efficiency_raw: efficiencyRaw,
    efficiency_capped: efficiencyCapped,
    torque: round2(torque),
    temp_rise: tempRise,
    total_loss: totalLossW,
    torque_density: torqueDensity,
    torque_source: (params.torque_nm !== undefined)
      ? 'spec' : ((powerKw && params.speed) ? 'power_speed' : 'insufficient_data'),
    torque_confidence: (params.torque_nm !== undefined || (powerKw && params.speed)) ? 1.0 : 0,
    torque_capability: round2(torqueCapability),
    capability_source: capabilitySource,
    capability_confidence: torqueCapability > 0 ? FORMULA_CHANNEL_CONFIDENCE : 0,
    // ---- v1.2.0 转矩包络：额定提供 → 最大提供(×K) → 需求可行性判据 ----
    torque_capability_max: envelope.torque_capability_max,
    overload_factor: envelope.overload_factor,
    torque_margin: envelope.torque_margin,
    torque_margin_rated: envelope.torque_margin_rated,
    torque_feasibility: envelope.torque_feasibility,
    prediction_source: 'formula',
    // ---- v0.1.6 可追溯诊断字段（让报告「每值给公式」）----
    electrical_frequency_hz: closure?.freq_hz ?? round1((params.speed * poles) / 120),
    air_gap_flux_density: airGapFlux,
    // P0-3 可追溯：本行 Bg 走的是显式覆盖 / 极数分档真值 / 缺省常量
    bg_bins_caliber: (opts.airGapFlux !== undefined && Number.isFinite(Number(opts.airGapFlux)))
      ? 'explicit_override'
      : (bgBinsOn(opts)
        && Number.isFinite(AIR_GAP_FLUX_BY_POLES[String(params.motor_type ?? 'induction').toLowerCase()]?.[poles]))
        ? 'poles_binned_truth' : 'default_constant',
    tooth_flux_density: toothB,
    yoke_flux_density: yokeB,
    // ---- P0-1 实际匝口径（与质量门 V08 同口径，供主指标与门禁对齐）----
    air_gap_flux_density_actual: bgActual !== null ? round3(bgActual) : null,
    tooth_flux_density_actual: toothBActual,
    yoke_flux_density_actual: yokeBActual,
    bg_caliber: bgCaliber,
    // ---- P2-A 绕组锁定回显（默认 off；lock ON 时实际口径改走 bg_locked）----
    winding_lock: closure?.winding_lock ?? false,
    bg_locked_t: bgLocked !== null ? round3(bgLocked) : null,
    kw_eff_used: closure?.kw_eff ?? null,
    air_gap_flux_density_effective: round3(bgForFlux),
    // ---- P0-3 工程槽满率 ----
    slot_fill_engineering: cu.slot_fill_engineering,
    slot_fill_caliber: cu.slot_fill_caliber,
    slot_area_net_mm2: cu.slot_area_net_mm2,
    // ---- P0-4 电流口径回显（让下游知道本行电流是按哪组 pf/η 反推的）----
    eta_ref_for_current: pfEta.eta,
    pf_eta_source: pfEta.source,
    yoke_sat: yokeSat,
    current_density: cu.current_density,
    power_factor: closure?.power_factor ?? POWER_FACTOR_REF,
    slot_fill_ratio: cu.slot_fill_ratio,
    back_emf_v: closure?.back_emf_v ?? null,
    back_emf_ok: backEmfOk,
    thermal_rise_k: tempRise,
    thermal_limit_k: tempLimit,
    insulation_class: insulationClass,
    // v0.2.5：非法绝缘等级不得静默按 F 级考核 —— 显式标记，交接方可拒绝消费
    insulation_class_valid: insulationValid,
    insulation_class_effective: insulationValid ? insulationClass : DEFAULT_INSULATION_CLASS,
    // v0.2.5：生效电源频率。V16/V18 的自变量，随行可见便于下游核对
    // （此前 V16 硬编码 50Hz，结果行无从判断是工频判还是 50Hz 假设判）
    ...(Number.isFinite(Number(params.line_freq_hz))
      || Number.isFinite(Number(opts.lineFreqHz))
      ? { line_freq_hz: Number.isFinite(Number(params.line_freq_hz))
        ? Number(params.line_freq_hz) : Number(opts.lineFreqHz) }
      : {}),
    peak_current: effCurrent,
    turns_per_coil: effTurns,
    parallel_circuits: parallelCircuits,
    feasible,
    verdict: feasible ? 'feasible' : (thermalOk ? 'infeasible_geometry' : 'infeasible_thermal'),
  }

  // ---- L1 镜像字段（可消费）：全部取自 L0 物理通道，保证同一行结果内部自洽 ----
  const proxyEff = Math.min(efficiencyCap, l1EfficiencyProxy({ statorOd, poles }))
  const mirrorPowerKw = computePowerKw(native.torque, params.speed)

  const mirror = {
    max_temp: round1(clamp(AMBIENT_TEMP_C + tempRise, maxTempClamp[0], maxTempClamp[1])),
    power: mirrorPowerKw,
    ...splitLosses(totalLossW),
    solve_mode: 'l0',
    // ---- 诊断列（不可被下游消费，仅供 W4 回归判定偏差）----
    l1_efficiency_proxy: proxyEff,
    l1_temp_proxy: l1MaxTempProxy({ statorOd, speed: params.speed }, maxTempClamp),
  }

  return buildL0Result({ params, native, mirror, confidence: FORMULA_CHANNEL_CONFIDENCE })
}

export default {
  computeTorque, computePowerKw, computeD2L, computeLambda, validateLambda,
  electricalFrequency, estimateCoreMassKg, estimateIronLoss, estimateCopperLoss,
  estimateMechanicalLoss, estimateMechStrayLoss, efficiencyFromLosses, splitLosses, estimateTempRise,
  l1EfficiencyProxy, l1MaxTempProxy, quickL0Estimate, copperResistivity,
  slotGeometryDerived, deriveElectricalClosure, slotAreaNet,
  computeTorqueD2L, computeTorqueStress,
  bgCaliberOf, engSlotFillOn, pfEtaBinsOn, bgBinsOn, airGapFluxForDesign,
  windingLockOn, kwEffOf, KW_EFF_DEFAULT,
}
