/**
 * 电机设计常量 —— L0 估算层的数值基石
 * ===========================================================
 * 真源政策（v3 决策① P1）：
 *   本文件是 **构建期生成产物**，真源是 knowledge-sync/sync-constants.py
 *   从 Python 侧导出的 constants.json。W2-A 之前先用手工镜像版本（见下方行号），
 *   一旦运行 sync 校验，本文件必须能被重新生成且 **0 diff**。
 *   ⇒ 禁止在本文件里手写任何「只此一份」的魔数。
 *
 * 行号证据（Scripts/physics_kernel.py / Scripts/motor_tools.py）：
 *   LAMBDA_RANGE          physics_kernel.py:27-32
 *   FRAME_SHIFT_*         physics_kernel.py:35-39
 *   AIR_GAP_MIN/MAX       physics_kernel.py:42-43
 *   id_ratio              physics_kernel.py:573
 *   air_gap 经验式        physics_kernel.py:587-588
 *   rotor_od              physics_kernel.py:591
 *   SLOT_MAP              physics_kernel.py:560-566
 *   tooth_width           physics_kernel.py:598
 *   yoke_thickness        physics_kernel.py:601-602
 *   shaft_dia             physics_kernel.py:605
 *   turns 基数            physics_kernel.py:608
 *   无型谱回退            physics_kernel.py:536-538
 *   仿真效率模型          motor_tools.py:750-752
 *   仿真温升模型          motor_tools.py:755-756
 *   损耗拆分比            motor_tools.py:775-778
 */

// ═════════════════════════════════════════════════════════════
// 1. 几何与物理常量（Python 真源镜像）
// ═════════════════════════════════════════════════════════════

/** 长径比 λ = L/D 合理范围（按极数）—— physics_kernel.py:27-32 */
export const LAMBDA_RANGE = {
  2: [0.6, 1.3],
  4: [0.7, 1.4],
  6: [0.6, 1.2],
  8: [0.5, 1.1],
}

/** 缺省 λ 范围（未登记极数）—— physics_kernel.py:90 兜底 (0.5, 1.5) */
export const LAMBDA_RANGE_DEFAULT = [0.5, 1.5]

/**
 * P3 高速扩表（v3 决策③，纳入 W2）
 * ---------------------------------------------------------------
 * 缺口取证：Python 侧 LAMBDA_RANGE 仅覆盖 2/4/6/8 极，
 *           不覆盖用户的 200kW/22000rpm 高速工况（1 极、f≈367Hz、L_stack=170mm）。
 *           以下为 L0 侧扩展，属「新增资产」，Python 侧无同名真源，
 *           sync 脚本需将其列入 ALLOW_LOCAL_ONLY 白名单，不做 0-diff 比对。
 */
// 注：初版含 1 极档 [0.8, 1.6]，已作废 —— 永磁同步机不存在 1 极。
//     200kW/22000rpm 实为 2 极（f = 22000×2/120 = 366.7Hz），由 LAMBDA_RANGE[2] 覆盖。
export const LAMBDA_RANGE_EXT = {
  10: [0.5, 1.1],
  12: [0.5, 1.0],
}

/** 机座号跃迁阈值（转矩比）—— physics_kernel.py:35-39 */
export const FRAME_SHIFT_THRESHOLDS = { micro: 0.05, fine: 0.20, coarse: Infinity }

/** 气隙经验边界 (mm) —— physics_kernel.py:42-43 */
export const AIR_GAP_MIN = 0.30
export const AIR_GAP_MAX = 1.50

/**
 * 定子内外径比 id/od —— 单一真源，复刻 physics_kernel.py:547-562 id_ratio_by_poles
 * 三分支（v4.02.103 P0 口径）：
 *   legacy   : 0.55 + (p-2)*0.03  无钳制（focused_scan 历史口径，零回归基线）
 *   生产异步 : clamp(0.55 + (p-2)*0.012, [0.45, 0.65])
 *   生产永磁 : clamp(0.72 + (p-2)*0.010, [0.70, 0.80])
 * P0 升级（0.1.4）：补 is_pm 永磁分支，让 PMSM 主场景不再套用 legacy 线性口径，
 * 与程序侧 L0 内核口径对齐（此前 0.1.3 只有 legacy，PMSM 定子内径估算系统性偏小）。
 */
export const ID_OD_BOUNDS = {
  async: { min: 0.45, max: 0.65 },   // physics_kernel.py _ID_OD_ASYNC_MIN/MAX (543)
  pm:    { min: 0.70, max: 0.80 },    // physics_kernel.py _ID_OD_PM_MIN/MAX    (544)
}

export function idRatioByPoles(poles, { isPm = false, legacy = false } = {}) {
  let p
  try {
    p = Math.max(2, Math.round(Number(poles)))
  } catch {
    p = 4
  }
  if (!Number.isFinite(p)) p = 4
  if (legacy) return 0.55 + (p - 2) * 0.03   // focused_scan 历史口径（零回归）
  if (isPm) {
    const { min, max } = ID_OD_BOUNDS.pm
    return Math.max(min, Math.min(max, 0.72 + (p - 2) * 0.010))
  }
  const { min, max } = ID_OD_BOUNDS.async
  return Math.max(min, Math.min(max, 0.55 + (p - 2) * 0.012))
}

/**
 * 兼容旧签名：定子内外径比（legacy 口径，恒等于 idRatioByPoles(poles, {legacy:true})）。
 * 保留以维持 0.1.3 调用点与 49 项回归基线（verify.mjs 未断言本函数数值，改动安全）。
 * P3 扩表：1 极按外推给 0.52（Python 侧无此档）。
 */
export function idRatio(poles) {
  // poles < 2 在物理上非法（永磁同步机不存在 1 极），退化到 2 极档防御异常输入
  if (poles < 2) return 0.55
  return 0.55 + (poles - 2) * 0.03
}

/**
 * 电机类型是否永磁（PMSM/BLDC/IPM），复刻 physics_kernel.py:617-618 PMSM_TYPES。
 * 判定口径与 Python `_is_pmsm_type`（:2135）一致：小写后精确匹配集合。
 */
export const PMSM_TYPES = new Set([
  'pmsm', 'bldc', 'ipm',
  '永磁同步电动机', '永磁同步电机', '无刷直流', '无刷直流电动机', 'spm', '表贴式永磁',
])

export function isPmsmType(motorType) {
  if (motorType == null) return false
  return PMSM_TYPES.has(String(motorType).toLowerCase())
}

/** 异步机别名集（与 PMSM_TYPES 对偶）。'async' 此前不在任何别名表里，
 *  会导致 detectMotorType 落入 OD 启发式静默误判 —— 0.2.6 P0 补齐。 */
export const INDUCTION_TYPES = new Set([
  'induction', 'async', 'im',
  '异步电动机', '异步电机', '异步', '三相异步电动机', '三相异步电机', '感应电动机',
])

/**
 * 规范化电机类型（0.2.6 P0）：显式别名 → 'pmsm' | 'induction'；
 * 缺省/无法识别 → 'induction' 并标 assumed。
 * 依据：生成路径（buildParamMatrix）对缺省 motor_type 一律按 induction 几何产行
 * （usePm = isPmsmType(undefined) = false），推理路径必须与生成同默认，
 * 否则出现「生成按异步、推理按 OD<400 误判 pmsm」的口径分裂 —— 即 10 万案例压测
 * 定位的 P0：OD<612.4mm 中小型异步机代理通道静默 skipped 19.8%。
 * @param {string|undefined} motorType 用户输入
 * @returns {{ type: 'pmsm'|'induction', assumed: boolean, unrecognized: boolean }}
 */
export function resolveMotorType(motorType) {
  if (motorType == null || motorType === '') {
    return { type: 'induction', assumed: true, unrecognized: false }
  }
  const s = String(motorType).toLowerCase()
  if (PMSM_TYPES.has(s)) return { type: 'pmsm', assumed: false, unrecognized: false }
  if (INDUCTION_TYPES.has(s)) return { type: 'induction', assumed: false, unrecognized: false }
  // 显式给了但不认识 —— 按 induction 处理（与生成路径一致），但要让人看见
  return { type: 'induction', assumed: false, unrecognized: true }
}

/** 类比模式的 OD 估算比 —— physics_kernel.py:532 (base_od = base_d / 0.60) */
export const ANALOGY_OD_RATIO = 0.60

/**
 * 极槽配合表 [定子槽, 转子槽] —— physics_kernel.py:560-566
 * P3 扩表补充 1 极 / 12 极档（Python 侧无）
 */
export const SLOT_MAP = {
  2: [[18, 16], [24, 20], [30, 26]],
  4: [[24, 22], [36, 28], [48, 44]],
  6: [[36, 28], [54, 44], [72, 58]],
  8: [[48, 44], [54, 44], [72, 58]],
  10: [[60, 50], [72, 58], [90, 72]],
  12: [[72, 58], [90, 72], [108, 90]],     // P3 新增
}

/** 每线圈匝数基数 —— physics_kernel.py:608（仅作回退/诊断用，v0.1.6 起主线用电气闭环反推） */
export function baseTurns(voltage, statorOd) {
  return Math.max(6, Math.floor(voltage * 0.3 + (450 - statorOd) * 0.02))
}

/**
 * PMSM 定子槽候选表（v0.1.6，P1 修复「PMSM 出现转子槽」）
 * ---------------------------------------------------------------
 * 永磁同步机（表贴/内置）转子无导条笼型槽，转子槽数恒为 0；
 * 原 SLOT_MAP 的 [定子,转子] 二元组是异步机鼠笼口径，套到 PMSM 会污染拓扑。
 * 故 PMSM 仅登记定子槽候选，转子 0 槽由 buildParamMatrix 显式置位。
 * 定子槽数取整数槽配合：2 极→12/18，4 极→24/36/48（与异步同定子档位，绕组可行）。
 */
export const PMSM_SLOT_MAP = {
  2: [12, 18],
  4: [24, 36, 48],
  6: [36, 54, 72],
  8: [48, 54, 72],
  10: [60, 72, 90],
  12: [72, 90, 108],
}

/** PMSM 极弧系数缺省（用户项目基准 0.688，Sm₂Co₁₇ 表贴/内置通用） */
export const PMSM_DEFAULT_POLE_ARC = 0.688

/** PMSM 永磁体厚缺省 mm（用户项目基准 12mm） */
export const PMSM_DEFAULT_PM_THICK_MM = 12

/** 无型谱回退的经验尺寸 —— physics_kernel.py:536-538 */
export function empiricalBaseSize(targetTorqueNm) {
  const d = 100 + Math.pow(targetTorqueNm, 0.3) * 30
  return { d, l: d * 0.9 }
}

// ═════════════════════════════════════════════════════════════
// 2. L1 仿真模型系数（motor_tools.py:750-778）
//    用途：产出 l1_efficiency_proxy / max_temp 镜像字段，供 W4 回归比对
// ═════════════════════════════════════════════════════════════

/** 仿真效率模型：base = 85 + (od-180)*0.04 + (poles-8)*1.2，clamp[80,96] */
export const SIM_EFF = {
  base: 85.0, odRef: 180, odCoef: 0.04,
  poleRef: 8, poleCoef: 1.2,
  clampMin: 80, clampMax: 96,
}

/** 仿真温升模型：base = 55 + (od-180)*0.25 + (speed-3000)*0.004，clamp[45,130] */
export const SIM_TEMP = {
  base: 55, odRef: 180, odCoef: 0.25,
  speedRef: 3000, speedCoef: 0.004,
  clampMin: 45, clampMax: 130,
}

/** 损耗拆分比 —— motor_tools.py:775-777 */
export const LOSS_SPLIT = { copper: 0.55, iron: 0.30, mechanical: 0.15 }

/** 转矩/功率换算常数 —— physics_kernel.py:64 (T = 9550·P/n) */
export const TORQUE_CONST = 9550.0

// ═════════════════════════════════════════════════════════════
// 3. L0 物理估算通道系数（L0 原生，非 Python 真源）
// ═════════════════════════════════════════════════════════════

/**
 * 冷却方式 → 综合换热系数 W/(m²·K)
 * ---------------------------------------------------------------
 * ⚠ 取证修订（相对原资料稿）：资料稿给的 {8,15,40,60,80} 标定偏小约一个量级，
 *    直接套用会让温升虚高一倍以上（见下方标定算例）。
 *
 * 标定依据（本机实算，非查表）：
 *   样本：15kW / 3000rpm / 8极 / OD=180mm / L=100mm
 *   机座光滑外表面积 A = π·0.18·0.10 + π·0.09² ≈ 0.082 m²
 *   该样本典型总损耗 ≈ 733W（见 formula-engine.frame 实算路径）
 *   目标：TEFC 强迫风冷实测温升 ≈ 60~70K
 *   ⇒ 需要 h·A ≈ 11 W/K ⇒ h ≈ 140 W/(m²·K)
 * 故本表以「基于机座光滑外表面积的综合换热系数」口径重标定（已含散热筋折算）。
 *
 * 自然冷却取 25 是有意为之：小功率自然冷却可行，大功率会算出极高ΔT，
 * 这正是要触发 W4 物理校验告警的结果，不应人为放宽。
 *
 * ⚠ v0.1.6 校准修正（高速大功率为核心场景）：
 *   原 liquid_jacket=350 把「200kW/22000rpm 液冷」算到 189K 温升（超 F 级 105K），
 *   与实机液冷机壳（强制冷却液，h≈500~1500 W/m²·K 含内螺旋槽）严重不符 ——
 *   那 189K 实为模型 h 偏低，非设计真不可行。按 «电机设计手册» 机壳水套
 *   h≈600~1200 折中标定到 700；油冷/浸油相应上提。强制风冷 140 维持不变
 *   （高速强制风冷本来就压不住，应判不可行，与审计「强风冷全部超 F 级」一致）。
 */
export const COOLING_COEFFICIENT = {
  natural: 25,
  forced_air: 140,
  liquid_jacket: 700,
  oil_spray: 1000,
  oil_immersed: 1300,
}

/** 标准环境温度 °C（max_temp 镜像字段 = 环境温度 + 温升） */
export const AMBIENT_TEMP_C = 40

/** 缺省冷却方式（L0 私有；现有 Python 体系无 cooling 概念，交接时必须剔除） */
export const DEFAULT_COOLING = 'forced_air'

/** 极数 → 效率修正（极数越多，端部占比上升，效率略降） */
export const POLE_EFFICIENCY_FACTOR = {
  1: 1.005, 2: 1.0, 4: 0.995, 6: 0.99, 8: 0.985, 10: 0.98, 12: 0.975,
}

/** 铁损 Steinmetz 简化系数（v3 变频标定 2026-10-08 写回）。
 *  依据：变频扫参 21 点（f 24~195Hz 8×、B_eff 0.18~1.45T 7.9×），NNLS 内点解
 *  kh=3.9398e-2 / ke=1.3322e-4，R²=0.9896 / MAPE 15.9%。
 *  v2 旧值（kh=0.02/ke=0.0001）因样本 f 恒 ≈49Hz 双基共线不可辨识（R²=0.559）。
 *  B 口径：B_eff=(Bt+By)/2 真值口径，与 formula-engine 生产链一致。 */
export const STEINMETZ = { kh: 0.039398, ke: 0.00013322, alpha: 1.6, fluxDensity: 1.2 }

/** 铜耗分档系数（v3 标定 2026-10-08，按额定功率查档）。
 *  依据：控制变量扫参（固定几何只扫匝数）三档实测——
 *    small(15kW)  k=0.2629 R²=0.9727 n=12
 *    medium(75kW) k=0.3949 R²=0.9700 n=12
 *    large(450kW) k=1.0039 R²=0.9168 n=8
 *  单系数 R² 仅 0.854/MAPE 168%，分档后整体 R²=0.9185/MAPE 26.2%。
 *  ⚠ 分档边界（30/100kW）基于本次三档样本划定，向未采样机座外插需复验。
 *  口径说明：k 修正的是「公式+输入口径」总偏差（标定用 RMxprt 真值 I/N，
 *  生产用电气闭环反推 I/N），故必须与 deriveElectricalClosure 同路径使用。 */
export const COPPER_LOSS_K = {
  small: 0.2629,   // ≤30kW
  medium: 0.3949,  // 30~100kW
  large: 1.0039,   // >100kW
}

/**
 * P1-5（2026-10-19）：铜耗标定系数**按机型隔离**
 * ---------------------------------------------------------------------------
 * 根因（实证）：COPPER_LOSS_K 是 v3 用 32 行 sweep 数据集（PMSM 口径）拟合的，
 * 对异步机直接套用 ⇒ 铜耗被压到 1/5（Y160L-4 模型 211W vs RMxprt 真值 1164W，−82%）。
 * 叠加两条口径差：
 *   ① 真值 `copper_loss` = 定子 + 转子铜耗（.res：Y160L 688.3+523.4，Y180M 700.6+494.0），
 *      而 estimateCopperLoss 只算**定子** ⇒ 模型天然缺 70~76% 的转子项；
 *   ② 模型电阻取 150°C（FLUX_TARGET.temperatureC），RMxprt 按运行温度 ≈75°C
 *      ⇒ 模型定子项又偏高约 1.2 倍。二者在 k 里一并吸收。
 * 异步机标定（n=2，仅 small 档 ≤30kW）：
 *   Y160L-4  真值 1164.424 / 模型原始 803 = 1.450
 *   Y180M-4  真值 1194.571 / 模型原始 983 = 1.215
 *   ⇒ k = 几何均值 1.333
 * ⚠ n=2 属**临时标定**：medium/large 档异步机真值为零，置 null 表示有意未标定，
 *   沿用旧值（PMSM 标定）并保持不变，不得外推。正式标定需 ≥30 台异步机 RMxprt 真值
 *   （S0 数据集目前异步机仅 2 行）。
 */
export const COPPER_LOSS_K_BY_TYPE = {
  pmsm: COPPER_LOSS_K,                       // v3 标定原值，不动
  induction: { small: 1.333, medium: null, large: null },
}

/** 铜耗分档边界（kW），与 COPPER_LOSS_K 同一真源 */
export const COPPER_K_BINS = [
  { name: 'small', maxKw: 30 },
  { name: 'medium', maxKw: 100 },
  { name: 'large', maxKw: Infinity },
]

/** 机械耗+杂散损耗按输出功率分档比例（v3 标定 2026-10-08）。
 *  RMxprt 真值 mech_real(=total−cu−fe) 跨档实测 ≈ 3.0%/2.2%/2.0% × P_out，
 *  与「杂散损耗按输出功率百分比」的工程惯例一致（GB/T 标准杂散损耗上限 2.5%/2.0%/1.5%+，
 *  实测值含风摩后偏高属合理）。原风摩公式 MECH_LOSS_K 低估 −87%（60W vs 真值 453W @15kW），
 *  是 L0 效率偏乐观 ~4pt 的主因，故按功率分档比例替代。标定证据：scripts/calibrate_losses_v3.mjs。 */
export const MECH_STRAY_RATIO = {
  small: 0.030,   // ≤30kW
  medium: 0.022,  // 30~100kW
  large: 0.020,   // >100kW
}

/** 电密取值基准 A/mm²（L1 侧 random.uniform(3.5, 7.5)）。
 *  ⚠ 仅作为「未提供真实电流时」的回退电密；正常路径由 deriveElectricalClosure
 *    从功率/电压反推 peak_current，再用本值定线规，二者不冲突。 */
export const CURRENT_DENSITY_REF = 5.5

/**
 * 设计电密目标 A/mm²（槽满率闭环的基准）。
 * 给定 peak_current 与并联支路 a，线规 A_wire = I_rms/(a·J_DESIGN)，
 * 槽满率 = turns_per_coil·I_rms/(a²·J_DESIGN·slot_area)。取 6.0 为工业中大功率绕组常用设计值。
 */
export const J_DESIGN = 6.0

/** 绕组系数（分布式整数槽，kdp≈0.95；分数槽会略低，闭环反推时保守取 0.95） */
export const WINDING_FACTOR = 0.95

/** 功率因数基准（永磁同步机典型 0.90~0.95；用于从功率反推电流） */
export const POWER_FACTOR_REF = 0.92

/** 估算效率基准（用于从功率反推电流时的分母；与 L0 物理通道封顶 96% 一致） */
export const ETA_REF_FOR_CURRENT = 0.94

/**
 * 电流反推用 pf/η 分档表（2026-10-17 P0-4）
 * ===================================================================
 * 起因：恒用 pf=0.92/η=0.94 反推电流，对**中小型异步机**系统性偏低 13~20%
 *   （Y160M-4 11kW：模型 19.3A vs 铭牌 22.6A；Y160L-4 15kW：26.4A vs 30.3A），
 *   进而线规偏细、槽满率偏低、铜损偏低、效率偏乐观。
 *
 * 分档依据（诚实披露置信度，禁止把估计值当标定值）：
 *   - 11kW 档 pf=0.84/η=0.880 与 22kW 档 pf=0.85/η=0.885 为**铭牌反算校验锚点**：
 *     11000/(√3·380·0.84·0.880)=22.6A = Y160M-4 铭牌电流 ✓
 *     15000/(√3·380·0.85·0.885)=30.3A = Y160L-4 铭牌电流 ✓
 *   - 其余各档为低压异步机 IE1/IE2 **通用典型值**（pf、η 随功率单调上升，趋势物理正确），
 *     ⚠ 非本库标定，无实测样本支撑，属低置信估计；跨机型外插需复验。
 *   - 永磁同步机（pmsm）不走本表：其 pf 本就 0.90~0.95、η 更高，沿用 POWER_FACTOR_REF/
 *     ETA_REF_FOR_CURRENT，避免用异步机典型值污染 PMSM（典型值误用即制造偏差）。
 *
 * ⚠ 与 v3 铜损标定系数的耦合已实证核查（scripts/calibrate_losses_v3.mjs:53）：
 *   铜损 k 是拿 **RMxprt 真值 stator_current / turns_per_coil** 喂 estimateCopperLoss 拟合的，
 *   并非在生产侧（旧 pf/η 反推电流）口径上拟合 ⇒ 修正生产侧电流是**向真值收敛**，
 *   COPPER_LOSS_K 不需要同步重标定（若误重标定会造成二次纠偏，反而偏离真值）。
 */
export const PF_ETA_BY_POWER = [
  { maxKw: 5,        pf: 0.82, eta: 0.855, source: 'typical' },
  { maxKw: 11,       pf: 0.84, eta: 0.880, source: 'nameplate' },  // Y160M-4 11kW 校验
  { maxKw: 22,       pf: 0.85, eta: 0.885, source: 'nameplate' },  // Y160L-4 15kW 校验
  { maxKw: 55,       pf: 0.86, eta: 0.910, source: 'typical' },
  { maxKw: 110,      pf: 0.87, eta: 0.930, source: 'typical' },
  { maxKw: Infinity, pf: 0.88, eta: 0.945, source: 'typical' },
]

/**
 * 查询电流反推用 pf/η（P0-4）
 * 优先级：显式入参 > 分档表（仅异步机） > 常量兜底
 * @returns {{pf:number, eta:number, source:'input'|'nameplate'|'typical'|'constant'}}
 */
export function queryPfEtaRef({ powerKw, motorType } = {}) {
  const mt = (motorType ?? 'induction').toLowerCase()
  const isPmsm = mt.includes('pmsm') || mt.includes('pm') || mt.includes('permanent')
  const kw = Number.isFinite(Number(powerKw)) && Number(powerKw) > 0 ? Number(powerKw) : null
  if (isPmsm || kw === null) {
    return { pf: POWER_FACTOR_REF, eta: ETA_REF_FOR_CURRENT, source: 'constant' }
  }
  const bin = PF_ETA_BY_POWER.find((b) => kw <= b.maxKw) ?? PF_ETA_BY_POWER[PF_ETA_BY_POWER.length - 1]
  return { pf: bin.pf, eta: bin.eta, source: bin.source }
}

/** 接线方式（高压大功率永磁主流星接 Y，相电压 = 线电压/√3） */
export const DEFAULT_CONNECTION = 'star'

/** 反电势闭环容差：|E − Uph|/Uph ≤ 0.10 视为电气自洽（P0 门禁） */
export const BACKEMF_TOL = 0.10

/** 槽满率门禁（P0）。>WARN 提示，>MAX 判几何不可实现（fail）
 *  ⚠ 口径声明：这两个阈值是**工程槽满率**量级（导线含漆膜 / 槽有效面积，工程常见 0.65~0.78）。
 *    2026-10-17 前 estimateCopperLoss 输出的 slot_fill_ratio 是「裸铜净面积 / 外接矩形毛槽面积」，
 *    与这两个阈值不可比（实测同机 0.17~0.27 vs 阈值 0.70/0.78）⇒ V15 系统性漏判真实过槽满。
 *    故新增工程口径换算（SLOT_* 常数族），V15 改判工程口径；旧比值保留为诊断字段。 */
export const SLOT_FILL_WARN = 0.70
export const SLOT_FILL_MAX = 0.78

// ── 槽满率工程口径换算常数（2026-10-17 P0-3）────────────────────────────
// 旧口径 = 裸铜净面积 / 外接矩形毛槽面积（slotWidth×slotDepth），缺四项折扣：
//   ① 槽形不是满矩形（梨形/梯形槽上窄下宽 + 圆角） ② 槽绝缘占边 ③ 槽楔占深 ④ 漆膜占截面
// 故工程口径 = 裸铜面积 / 铜占比 ÷ [ (槽宽−2×绝缘)×(槽深−绝缘−槽楔)×形状系数 ]
// ⚠ 全部为**典型值**而非本库标定值（无下线实测数据支撑）：改动任一项即改变 V15 判定基线，
//   必须重跑 scripts/regression.mjs 并出 delta。标定后应改写此处注释并给出样本来源。
/** 槽绝缘单边厚度 mm（380V 级中小型异步电机 DMD/复合箔典型 0.25~0.35） */
export const SLOT_LINER_T_MM = 0.30
/** 槽楔占槽深 mm（散嵌绕组竹/环氧槽楔典型 2~3） */
export const SLOT_WEDGE_T_MM = 2.5
/** 梨形/梯形槽实际面积 / 外接矩形面积（槽口收窄+圆角，典型 0.55~0.70） */
export const SLOT_SHAPE_FILL = 0.62
/** 漆包线中铜占截面积比（漆膜占余量；Ø1.0 级圆铜线典型 0.82~0.88） */
export const WIRE_COPPER_RATIO = 0.85

/** 齿部/轭部磁密目标（用户现场口径：齿 1.02T / 轭 0.82T @150°C） */
export const FLUX_TARGET = { tooth: 1.02, yoke: 0.82, temperatureC: 150 }

// ═══════════════════════════════════════════════════════════════════════════
// P0-8 磁密口径统一（2026-10-31，300kW 方案 L1 实跑实证）
// ---------------------------------------------------------------------------
// 根因：齿磁密公式 Bt = 2·Bg·Dsi/(Qs·tw·k_stack) 的分子是「每极磁通 Φ」，
//   而 Φ = B_av·A_pole = (2/π)·B_peak·A_pole ⇒ 该式算的是**极内各齿的平均磁密**
//   （气隙磁密取极距平均值），比「极中心齿的峰值磁密」低 π/2≈1.5708 倍。
//   轭磁密 By = Φ/(2·yoke·L·k_stack) 用 Φ 峰值 ⇒ **本身就是峰值口径**，无需换算。
// ⇒ 同一套规则里 V07 目标 1.02T（平均口径）与 V08 饱和限 1.9T（峰值口径）并存的
//   「双口径」是自相矛盾的：窄齿方案的齿部实际已深度饱和，却因平均口径而显示达标。
//
// 实证（RMxprt 2020.1 yz200-6 通道，300kW/690V/6P/72槽/Di402/L640，4 组设计点）：
//   Bt_peak/RMxprt 实测 vs 本式(×π/2)/RMxprt 的偏差恒为 +3.0%（tw=8.77/6.0/4.39 三点、
//   Bg 0.47~0.78 全区间），残差唯一来源 = 叠压系数 0.98(本仓) vs 0.923(RMxprt)。
//   ⇒ 换算系数 π/2 得到独立 FEA 级数据源确认。
// ═══════════════════════════════════════════════════════════════════════════

/** 齿磁密「极内平均值 → 极中心齿峰值」换算系数 = π/2 */
export const TOOTH_PEAK_OVER_MEAN = Math.PI / 2

/**
 * 齿部磁密饱和门限 (T) —— 与 B_YOKE_SAT_T 同口径（硅钢 Bs≈2.0~2.1T 的峰值口径）。
 * 注意：不可与 FLUX_TARGET.tooth=1.02T（用户现场平均口径）直接比大小。
 */
export const B_TOOTH_SAT_T = 1.9

/**
 * 反电动势压降系数 k_E = E/Uph（异步机满载时感应电势低于端电压，差额为定子漏抗+电阻压降）。
 * 现状：turnsIdeal 按 E=Uph 反解 ⇒ 匝数系统性偏多 ⇒ 实际磁通低于设计意图。
 * RMxprt 实测定标（300kW/690V/6P，两设计点）：
 *   3 匝/线圈 I=247A ⇒ E=351.8V  k_E=0.883
 *   2 匝/线圈 I=392A ⇒ E=341.3V  k_E=0.857
 *   ⇒ k_E 随负载电流增大而下降，大机取 0.88 作一阶标定（非普适常数）。
 * 默认值 1.0 = 保留既有行为（零回归）；需反标时由 opts.backEmfDrop / env 显式给出。
 */
export const BACKEMF_DROP_DEFAULT = 1.0
/** RMxprt 实测参考值（仅回显/建议用，不自动生效） */
export const BACKEMF_DROP_RMXPRT_REF = 0.88

/** 叠压系数（用户现场口径） */
export const STACKING_FACTOR = 0.98

// ═════════════════════════════════════════════════════════════
// 3.5 W4 物理校验判据常量（L0 私有，Python 侧无同名真源）
// ═════════════════════════════════════════════════════════════

/**
 * 气隙磁密基准 (T) —— 齿/轭磁密反算的输入
 * PMSM 表贴/内置式气隙磁密典型 0.75~0.90T；取 0.80 作缺省，可由 config 覆盖。
 */
export const AIR_GAP_FLUX_DEFAULT = 0.80

/**
 * P0-3（2026-10-19）：按「机型 + 极数」分档的**设计意图气隙磁密** (T)
 * ---------------------------------------------------------------------------
 * 实证依据：S0 标定数据集 82 行 RMxprt 真值，但**真值集必须按机型分口径**：
 *   · pmsm   n=80（designs.db rmxprt 子集；48V 低压、1500~15000rpm、转子槽 44）
 *     2 极 n=20 → 0.659T（0.597~0.750）；4 极 n=62 → 0.724T（0.431~0.790）
 *     ⇒ 旧恒定 0.80T 对 4 极高估 +10.5%、对 2 极高估 +21.4%
 *   · induction n=2（P0-3 当年：Y160L-4 0.630 / Y180M-4 0.651，清洁锚点）
 *     ⇒ P0-3 时样本不足留空；**2026-10-25 选项 C 标定**（见下）。
 * Bg 是 Φ→匝数、Bt、By、铁耗 B_eff 的共同上游，故系统性放大整条磁路。
 *
 * ---------------------------------------------------------------------------
 * induction 分档（2026-10-25，选项 C）——Y 系列真机型谱 65 台 RMxprt 实跑
 * （l0 output/p2_real_truth.json，provenance=synthesized_y2，EMF 合成绕组）：
 *   **清洁判据 = 输出功率 ≥ 70% 额定**。65 台中 28 台为退化解（出力仅额定 6~33%，
 *   合成绕组过匝 ⇒ 磁通被压至 0.30~0.34T）——其 Bg 是失败设计点而非设计目标，
 *   已剔除；余 37 台按极数取中位：
 *     2 极 n=17 → 0.624T（0.426~0.676）；4 极 n=5  → 0.621T（0.591~0.648）
 *     6 极 n=10 → 0.575T（0.549~0.635）；8 极 n=5  → 0.557T（0.548~0.569）
 *   清洁子集验收：旧钢印 0.80T MAPE 37.3%（偏差 +37.3%）→ 分档 MAPE 7.4%（+3.1%）。
 *   与 P0-3 当年唯二清洁锚点（0.630/0.651）同族，互为佐证。
 *   ⚠ 样本为 EMF 合成绕组（非真实冲片绕组），6/8 极泛化需真实绕组复核（同 KW_EFF_DEFAULT 告诫）。
 *   ⚠ designs.db 标称 induction 的行 28/37 为转子 44 槽 **PMSM 签名**（跨机型污染，
 *     P0-3 已警示；其中位 0.708 与 pmsm 表 0.724 吻合即证）；真异步签名仅 9 行且为
 *     660V 工程设计（中位 0.702T）——电压等级不同，未并入本表。
 *
 * ⚠ pmsm 仅 2/4 极、induction 仅 2/4/6/8 极有真值支撑；**缺档极数（10/12 等）
 *   一律回退 AIR_GAP_FLUX_DEFAULT，不得外推编造**。
 */
export const AIR_GAP_FLUX_BY_POLES = {
  pmsm: { 2: 0.659, 4: 0.724 },
  // 2026-10-25 选项 C：Y 系列清洁子集（n=17/5/10/5）各极中位；
  // 门禁：本仓 scripts/verify_bg_bins_truth.mjs（真值门禁）+ l0 仓 scripts/verify_bg_bins_calib.mjs（C 主门禁 22 项）
  induction: { 2: 0.624, 4: 0.621, 6: 0.575, 8: 0.557 },
}

/**
 * V08 校准用：按极数的「有效气隙磁密」常量（RMxprt 真值库 designs.db 94 行 rmxprt 子集，
 * 2026-10-18 实证标定）。
 * 取值 = 真值各极 `air_gap_flux_density` 中位值 × 残差校正，使简化轭磁密公式
 *   By = Bg·Dsi/(p·yoke·k_stack) 算出的 by 在各极数上「中位对齐」RMxprt 真值
 *   `stator_yoke_flux_density`（已实证：旧 P0-1 bgActual 使 by 系统性低估 3×、固定 0.80T
 *   又对 4 极高估 ~12%，且 1/p 缩放对 2 极过放大 → 误判 failed）。
 * 标定后各极 by/truth 中位 ≈ 1.0（2极 1.294→0.773 残差、4极 0.918→1.089 残差已并入）。
 * 仅门禁口径：不动公式引擎主指标与铁损 B_eff 口径，避免作废 v3 铁损标定。
 * 缺档极数（6/12 等）按相邻极数插值，兜底回退 AIR_GAP_FLUX_DEFAULT。
 */
export const BG_V08_EFFECTIVE = {
  2: 0.51,
  4: 0.78,
  6: 0.81,
  8: 0.84,
  10: 0.90,
  12: 0.93,
}

/**
 * 绝缘等级 → 温升限值 (K)（GB/T 755 旋转电机定额与性能，电阻法）
 * B 级 80K / F 级 105K / H 级 125K
 */
export const INSULATION_LIMITS = { B: 80, F: 105, H: 125 }

/** 缺省按 F 级考核（工业变频电机主流） */
export const DEFAULT_INSULATION_CLASS = 'F'

/**
 * 电源频率 (Hz) —— 同步转速 n_sync = 120·f/p 的自变量
 * ---------------------------------------------------------------------------
 * v0.2.5 新增。此前 V16 把 50Hz 硬编码在规则体内，导致 60Hz 电网 / VFD 变频工况
 * 全被误判为「超同步」——实测 4 极机在 1500rpm 处形成断崖（120×50/4=1500），
 * 而该转速在 60Hz 下是 6 极机的正常同步点。即断崖本身是判据错误而非物理事实。
 * 缺省 50Hz 保持 IEC/中国工频口径不变（向后兼容）；60Hz 电网与变频工况经
 * config `line_freq_hz` 或行内 `line_freq_hz` 字段覆盖。
 */
export const DEFAULT_LINE_FREQ_HZ = 50

/**
 * 电源频率合法区间 (Hz)
 * 下限 5Hz（v0.4.0 由 20Hz 下调）：旧口径「低于 20Hz 判据可信度不足」把 VFD 低频
 * 恒转矩区整体判死 —— 实测 400kW/250rpm/6极 船舶推进真实运行频率仅 12.5Hz、
 * 15Hz 亦合法，却因 V18 全批 failed（P0-1 断崖）。物理上真正的守门人是 V16
 * （n_sync=120f/p > n 才可输出转矩）：f_line 过低时 V16 给出「选 X 极」的可执行
 * 建议，不会静默放行。故此处只拦明显笔误（0.025/400 当工频类），下界取 5Hz
 * （主流变频器恒转矩区下限量级；更低频属爬行工况，L0 铁损/集肤模型本无覆盖，
 * 由 V16/能力门显式归因）。
 * 上限 400Hz：电频率判据 FREQ_LIMITS.fail=1200 更宽松，此处仅拦明显越界的输入笔误/乱填。
 */
export const LINE_FREQ_MIN_HZ = 5
export const LINE_FREQ_MAX_HZ = 400

/**
 * VFD 低频提示阈值 (Hz)：未显式传 line_freq_hz 且电频率 f=n·p/120 低于此值时，
 * V18 发 warning 提示显式传真实运行频率（否则 V16 按 50Hz 判同步裕度，
 * 对低频工况会高估转差裕度）。v0.4.0 新增，服务于 P0-1 的「不传频率」半边断崖。
 */
export const LINE_FREQ_VFD_NOTICE_HZ = 20

/**
 * 电源频率解析：行内字段优先于 opts（工具参数），缺省 50Hz。
 * 非法值一律回落缺省并由调用方决定是否告警（此处不做 warn，避免污染 issues 语义）。
 * @param {object} row 参数行（可选携带 line_freq_hz）
 * @param {object} [opts] 工具参数（lineFreqHz）
 * @returns {number} 频率 Hz
 */
export function resolveLineFreqHz(row, opts = {}) {
  const cand = [row?.line_freq_hz, opts.lineFreqHz]
  for (const v of cand) {
    if (typeof v === 'number' && Number.isFinite(v)
      && v >= LINE_FREQ_MIN_HZ && v <= LINE_FREQ_MAX_HZ) {
      return v
    }
  }
  return DEFAULT_LINE_FREQ_HZ
}

/**
 * P3 高速气隙档：常规机气隙上限 AIR_GAP_MAX=1.5mm 不适用于高速工况。
 * 高速电机受转子动力学挠度、风磨损耗与表面损耗约束，气隙普遍取 1.5~3mm
 * （用户工况 200kW/22000rpm 即取 2.0mm），沿用 1.5mm 会误判为非法。
 */
export const HIGH_SPEED_RPM = 8000
export const AIR_GAP_MAX_HIGH_SPEED = 4.0

/** 气隙上限查询：高速工况放宽到 AIR_GAP_MAX_HIGH_SPEED */
export function airGapMax(speedRpm) {
  return (typeof speedRpm === 'number' && speedRpm >= HIGH_SPEED_RPM)
    ? AIR_GAP_MAX_HIGH_SPEED
    : AIR_GAP_MAX
}

/** 转子轭最小厚度 (mm)：低于此值磁路与机械强度均不可靠 */
export const MIN_ROTOR_YOKE_MM = 10

/**
 * 异步机最小滑差容差（V16 变频边界放宽，v0.4.0 新增）
 * ---------------------------------------------------------------------------
 * 异步机靠转差输出转矩，额定转速须低于同步转速 n_sync=120f/p。但 VFD 工况下
 * 驱动频率本可微调：当 n_sync 落在 [n·(1−SLIP_MIN_TOL), n]（滑差 < SLIP_MIN_TOL）
 * 属「临界可行」——把频率略调高即可获得正常转差（如 12.5Hz→12.9Hz 把
 * 6 极@250rpm 从滑差 0 拉到 ~3%），不应整批判死。
 * 滑差更小（n_sync ≤ n·(1−SLIP_MIN_TOL)）才是真不可行（如 8 极@12.5Hz n_sync=187.5）。
 * ⚠ 该容差**仅**在 VFD 模式（显式传 line_freq_hz）下生效；工频（按 50Hz 默认）维持
 * 原严格口径（n_sync ≤ n 直接判 failed），以保留 4 极@1500rpm@50Hz 同步点断崖。
 */
export const SLIP_MIN_TOL = 0.03

/** 电频率分档 (Hz)：>warn 提示高频铁损/集肤/变频器约束；>fail 判越界 */
export const FREQ_LIMITS = { warn: 400, fail: 1200 }

/** 磁密偏离目标的相对容差：超出 warn 提示，超出 fail 判不合理 */
export const FLUX_TOLERANCE = { warn: 0.25, fail: 0.50 }

/**
 * 轭部磁密物理门限（v0.1.7 修复「薄轭失真」）：
 * 硅钢片饱和磁感 Bs≈2.0~2.1T，工程工作磁密上限取 1.9T；超过即轭部无法承载该磁通、
 * 进入深度饱和（Bj 估算值 >1.9T 意味着模型给出的几何在该磁通下不可用）。
 * 轭磁密 >B_YOKE_WARN_T 预警（接近饱和，铁损/温升恶化）；>B_YOKE_SAT_T 直接判 failed。
 * 注意：L0 的 Bj 公式本身正确（与齿磁密 Bt 同源），所谓「失真」是 V08 此前仅 warn、
 * 未能把饱和轭部候选剔除；本常量把饱和判据硬化为门禁。
 */
export const B_YOKE_WARN_T = 1.5
export const B_YOKE_SAT_T = 1.9

/**
 * 轭部磁密「严重档」门限（2026-10-17 P0-2 新增）
 * ---------------------------------------------------------------
 * 补齐 warn(1.5) 与 sat(1.9) 之间缺失的中间档：By∈(1.7, 1.9] 属严重偏饱和——
 * 硅钢 Bs≈2.0~2.1T，1.7T 已进入 B-H 曲线膝部，励磁电流与铁损显著恶化，
 * 但尚未到「轭部无法承载该磁通」的硬失败程度，故判 warning 且打 severity='severe'
 * （V08 在 ESCALATABLE_RULES 内，被 escalate 时仍升级为 failed，行为不变）。 */
export const B_YOKE_SEVERE_T = 1.7

/**
 * 槽宽/槽深比合理区间（过窄难下线，过宽漏抗大）
 * 下界取 0.20：定子梨形/梯形槽常见宽深比 0.2~0.8，深窄槽是高槽满率的常规做法；
 * 初版取下界 0.30 会误判掉绝大多数按 physics_kernel 派生的槽形（实测 26/40 命中），
 * 属判据过紧而非几何不合理。
 */
export const SLOT_ASPECT_RANGE = [0.20, 3.00]

/** 定子内外径比容差：超出 warn，超出 2 倍 fail（资料稿 §7.4 规则 2 的量化） */
export const ID_RATIO_TOLERANCE = { warn: 0.08, fail: 0.16 }

// ═════════════════════════════════════════════════════════════
// 4. 几何派生函数（与 Python 侧同名同式）
// ═════════════════════════════════════════════════════════════

/** 气隙经验式 —— physics_kernel.py:587-588（去掉 random 抖动，改确定性） */
export function empiricalAirGap(statorOd) {
  const raw = 0.30 + (statorOd - 120) * 0.0015
  return round2(clamp(raw, AIR_GAP_MIN, AIR_GAP_MAX))
}

/** 齿宽 —— physics_kernel.py:598 */
export function toothWidth(statorId, slotsStator) {
  return round2((Math.PI * statorId) / (2 * slotsStator))
}

// ═════════════════════════════════════════════════════════════
// 4.1 齿部等效宽（A 齿宽真值化 + C 显式等效齿宽模型，2026-10-20）
// ═════════════════════════════════════════════════════════════
// 背景（71 台类比设计 + 2 台真机 RMxprt 真值实证，见
// l0/output/p2_tooth_calib_xcheck_report.md）：
//   · 类比设计域：喂 RMxprt 的槽形由 tooth_width **反驱生成**（平行齿假设），
//     故解析吃派生齿宽 0.5×槽距时 K=预测/真值 ≈ 0.991（自洽，无需修正）。
//   · 真机域：真实冲压槽形，真机设计齿宽/槽距比恒为 **0.264**
//     （Y160L-4 3.92mm / Y180M-4 3.23mm），而 core.toothWidth() 恒为 0.500×槽距
//     ⇒ 两域 K 相差约 34%（真机 K=0.718/0.756），**不可互相外推**。
// 结论：正确修复 = 让喂给解析的齿宽与喂给 RMxprt 的槽形**同源**，
//       并把"最小截面齿宽"显式换算为"磁路等效齿宽"（本模块职责）。

/**
 * 等效宽换算系数 k_shape = 等效宽 / 最小截面齿宽。
 * 平行齿（齿宽沿径向恒定）⇒ k=1；梯形/梨形齿（沿径向变化）⇒ k>1。
 *
 * ⚠ 真机实测 k ≈ **1.352**（Y160L-4：等效 5.30mm / 设计齿宽 3.92mm）。
 *   但**样本仅 2 台，不足以定标** ⇒ 默认取 1.0（零回归，不改变任何既有行为）。
 *   待补 ≥30 台真机（含真实齿宽/槽形）后方可把默认值改为标定值。
 *   临时启用：`DSH_L0_TOOTH_K_SHAPE=1.352` 或显式传 kShape。
 */
export const TOOTH_EFF_K_SHAPE_DEFAULT = 1.0

/** 显式槽形 → k_shape 查表（待真值扩充；未登记槽形一律取默认 1.0 = 不缩放） */
export const TOOTH_EFF_K_BY_SHAPE = {
  parallel: 1.0,        // 平行齿 / 矩形槽：齿宽沿径向恒定
  // trapezoidal / pear / round 等：待 ≥30 台真值标定后登记
}

/**
 * C：由齿形尺寸求等效宽系数（真正的"显式等效齿宽模型"）。
 * 齿宽沿径向线性变化时，磁路面积等效宽 = (齿顶宽 + 齿根宽)/2，
 * 故 k = 平均宽 / 最小截面宽。
 * @returns {number} k_shape；槽形数据不足时回退查表/默认 1.0
 */
export function toothShapeK({ toothWidthTop = null, toothWidthRoot = null, slotShape = null } = {}) {
  const t = Number(toothWidthTop)
  const r = Number(toothWidthRoot)
  if (Number.isFinite(t) && Number.isFinite(r) && t > 0 && r > 0) {
    const wMin = Math.min(t, r)
    return ((t + r) / 2) / wMin
  }
  const byShape = slotShape ? TOOTH_EFF_K_BY_SHAPE[slotShape] : null
  return Number.isFinite(byShape) ? byShape : TOOTH_EFF_K_SHAPE_DEFAULT
}

/**
 * A+C：求"喂给磁路计算的齿部等效宽"。
 *
 * A（齿宽真值化，无条件生效）：
 *   toothWidth 缺失/非正时**回退** core 派生 0.5×槽距。
 *   修复真实缺陷：此前 l0 analytic-engine 直接吃 row.tooth_width，
 *   缺失时 At=0 ⇒ Bt=Infinity（JSON 序列化为 null）且全磁路解被污染、不报错。
 *
 * C（等效齿宽模型）：k 取「显式 kShape > env DSH_L0_TOOTH_K_SHAPE > 齿形尺寸推算 > 查表 > 默认 1.0」。
 *   默认 1.0 ⇒ 零回归，既有全部行为不变。
 *
 * @returns {number} 等效齿宽 mm（≤0 表示几何不足，调用方须判空）
 */
export function effectiveToothWidth({
  toothWidth = null, statorId = 0, slotsStator = 0,
  slotShape = null, kShape = null,
  toothWidthTop = null, toothWidthRoot = null,
  fallback = true,
} = {}) {
  let tw = Number(toothWidth)
  // A：回退派生（修 At=0 ⇒ Infinity 缺陷）
  if ((!Number.isFinite(tw) || tw <= 0) && fallback && statorId > 0 && slotsStator > 0) {
    tw = (Math.PI * statorId) / (2 * slotsStator)
  }
  if (!Number.isFinite(tw) || tw <= 0) return 0
  // C：等效宽系数
  let k = Number(kShape)
  if (!Number.isFinite(k) || k <= 0) {
    const envK = Number(typeof process !== 'undefined' ? process?.env?.DSH_L0_TOOTH_K_SHAPE : undefined)
    if (Number.isFinite(envK) && envK > 0) {
      k = envK
    } else {
      k = toothShapeK({ toothWidthTop, toothWidthRoot, slotShape })
    }
  }
  return round2(tw * k)
}

/** 可追溯版本：返回 { width, base, k, source }，供标定/审计打印口径来源 */
export function effectiveToothWidthInfo(opts = {}) {
  const { toothWidth = null, statorId = 0, slotsStator = 0 } = opts
  const width = effectiveToothWidth(opts)
  let base = Number(toothWidth)
  let source = 'given'
  if (!Number.isFinite(base) || base <= 0) {
    base = (statorId > 0 && slotsStator > 0) ? (Math.PI * statorId) / (2 * slotsStator) : 0
    source = (base > 0) ? 'derived_0.5pitch' : 'insufficient'
  }
  const k = (base > 0 && width > 0) ? width / base : 0
  return { width, base: round2(base), k: round2(k), source }
}

/**
 * 轭厚（比例式）—— physics_kernel.py:601-602
 * ⚠ v0.2.5 订正：本式**无任何磁密约束**，恒等于 half×0.40。
 *   高速大 Dsi 工况下它只给 12.7~17.6mm 轭厚，而 By≤1.9T 需要 21.9~48.4mm，
 *   缺口 7.7~30.8mm ⇒ V08 必然判饱和（实测 200kW/22000rpm PMSM By=5.28T）。
 *   本函数**保留原样**以维持既有调用方（L1 载荷/回退路径）行为不变，
 *   新的按磁密反解口径见 yokeThicknessForFlux()，矩阵生成走新函数。
 */
export function yokeThickness(statorOd, statorId) {
  const half = (statorOd - statorId) / 2
  const slotDepth = round1(half * 0.60)
  return round1(half - slotDepth)
}

/**
 * 轭厚（按磁密需求反解）—— v0.2.5 新增，对应改进方案 P0
 * ---------------------------------------------------------------------------
 * 推导：轭部磁密 By = Bg·Dsi / (p·yoke·k_stack)  ⇒  反解所需轭厚
 *       yoke_required = Bg·Dsi / (p·By_target·k_stack)
 *
 * 为什么要改：原比例式（half×0.40）在高速大 Dsi 下给出物理上不可实现的轭厚，
 *   使 V08 把**全部**候选判死。V08 判据本身是正确的，缺的是「生成端按磁密配厚」。
 *
 * @param {object} p
 * @param {number} p.statorId    定子内径 mm
 * @param {number} p.poles       极数
 * @param {number} [p.airGapFlux] 气隙磁密 T，缺省 AIR_GAP_FLUX_DEFAULT
 * @param {number} [p.targetBy]  目标轭磁密 T，缺省 B_YOKE_WARN_T（留 0.4T 裕度）
 * @returns {number} 所需轭厚 mm（向上取整到 0.1mm）
 */
export function yokeThicknessForFlux({
  statorId, poles, airGapFlux = AIR_GAP_FLUX_DEFAULT, targetBy = B_YOKE_WARN_T,
}) {
  if (!(statorId > 0) || !(poles > 0) || !(targetBy > 0)) return null
  const required = (airGapFlux * statorId) / (poles * targetBy * STACKING_FACTOR)
  return round1(required)
}

/**
 * 矩阵用轭厚/外径求解 —— v0.2.5 新增（改进方案 P0 的实际落点）
 * ---------------------------------------------------------------------------
 * 在比例式基础上取「比例值」与「磁密需求值」的较大者，并在轭厚被放大时
 * **同步放大定子外径**（轭厚只能从 Dsi 与 OD 之间的环带里出）。
 *
 * ⚠ 放大 OD 意味着本行不再是「用户请求的那个机座」，故返回 grown 标记，
 *   由 param-matrix 写入 _physics.od_grown_for_yoke 供追溯。
 *
 * @returns {{yoke_thickness:number, stator_od:number, slot_depth:number,
 *            yoke_by_ratio:number, yoke_by_flux:number|null, grown:boolean}}
 */
export function solveYokeAndFrame({
  statorOd, statorId, poles, airGapFlux = AIR_GAP_FLUX_DEFAULT, targetBy = B_YOKE_WARN_T,
}) {
  const half = Math.max(1, (statorOd - statorId) / 2)
  const yokeByRatio = round1(half * 0.40)          // 原比例式口径
  const slotDepthRatio = round1(half * 0.60)       // 原槽深口径
  const yokeByFlux = yokeThicknessForFlux({ statorId, poles, airGapFlux, targetBy })

  if (yokeByFlux === null || yokeByFlux <= yokeByRatio) {
    return {
      yoke_thickness: yokeByRatio,
      stator_od: round1(statorOd),
      slot_depth: slotDepthRatio,
      yoke_by_ratio: yokeByRatio,
      yoke_by_flux: yokeByFlux,
      grown: false,
    }
  }

  // 轭厚需放大：保持原槽深（不缩槽，槽满率另行由 V15 判），外径相应外扩
  const newYoke = round1(Math.ceil(yokeByFlux * 10) / 10)
  const newOd = round1(statorId + 2 * (slotDepthRatio + newYoke))
  return {
    yoke_thickness: newYoke,
    stator_od: newOd,
    slot_depth: slotDepthRatio,
    yoke_by_ratio: yokeByRatio,
    yoke_by_flux: yokeByFlux,
    grown: true,
  }
}

/** 轴径 —— physics_kernel.py:605 */
export function shaftDia(rotorOd) {
  return round1(rotorOd * 0.35)
}

/** 转子外径 —— physics_kernel.py:591 */
export function rotorOd(statorId, airGap) {
  return round1(statorId - 2 * airGap)
}

/** λ 范围查询（含 P3 扩表） */
export function lambdaRange(poles) {
  return LAMBDA_RANGE[poles] ?? LAMBDA_RANGE_EXT[poles] ?? LAMBDA_RANGE_DEFAULT
}

// ═════════════════════════════════════════════════════════════
// 5. 数值工具
// ═════════════════════════════════════════════════════════════

export function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
export function round1(v) { return Math.round(v * 10) / 10 }
export function round2(v) { return Math.round(v * 100) / 100 }
export function round3(v) { return Math.round(v * 1000) / 1000 }
export function round4(v) { return Math.round(v * 10000) / 10000 }
export function round5(v) { return Math.round(v * 100000) / 100000 }

/** 取 λ 范围内的修正：对目标尺寸做 *, 返回调整后的 L（不改 D），保持 D²L 语义 */
export function fitLambdaWithinRange(d, l, poles) {
  const [lo, hi] = lambdaRange(poles)
  const lam = d > 0 ? l / d : 0
  if (lam < lo) return round1(d * lo)
  if (lam > hi) return round1(d * hi)
  return round1(l)
}

// ═════════════════════════════════════════════════════════════
// P2 典型气隙磁密 / 切向应力知识表（L0 转矩方法2/3 真源）
// ===============================================================
// 用途：computeTorqueD2L（方法2 T=(π/2)·Bδ·A·D²·L·kw·kFe·kSat）
//       与 computeTorqueStress（方法3 T=(π/2)·D²·L·σ）的口径来源。
// 口径校准（2026-10-12 audit）：切向应力 σ = T / ((π/2)·D²·L)，
//   D 取「定子内径（气隙直径）」—— 这是转矩公式的物理正确直径，非定子外径。
//   本项目 15kW 级典型机（Dsi≈0.13m, L≈0.13m, T≈98N·m）对应 σ≈28kPa，
//   与《L0扭矩计算方法比较》第五节典型表一致。若误用定子外径 Dso 算 σ 会得 ~12kPa
//   （资料审计一度误判为"典型表高估2~8×"，实为用错直径口径，非典型表错误）。
// ⚠ 性质：这是 L0 广筛经验典型值，非某台电机的标定结果；
//   仅用于「容量可行性代理估算」，绝不当作额定转矩规格（规格恒为 9550·P/n）。
export const TYPICAL_B_DELTA = {
  induction: { natural: 0.72, forced_air: 0.78, liquid_jacket: 0.82 },
  pmsm:      { natural: 0.80, forced_air: 0.85, liquid_jacket: 0.88 },
}
// 切向应力 σ = Bδ·A（N/m²）。中值用于方法3直接算；A = σ/Bδ 用于方法2。
export const TYPICAL_SIGMA = {
  induction: { natural: [22000, 16000, 28000], forced_air: [28000, 22000, 35000], liquid_jacket: [33000, 25000, 42000] },
  pmsm:      { natural: [30000, 22000, 38000], forced_air: [38000, 30000, 47000], liquid_jacket: [45000, 35000, 56000] },
}

const _TYPICAL_COOLINGS = ['natural', 'forced_air', 'liquid_jacket']
const _TYPICAL_TYPES = ['induction', 'pmsm']

/**
 * 取典型气隙磁密 Bδ(T) 与切向应力 σ(N/m²) 的中值+区间
 * @param {string} motorType 'induction' | 'pmsm'（缺省 induction）
 * @param {string} cooling 'natural' | 'forced_air' | 'liquid_jacket'（缺省 forced_air）
 * @returns {{bDelta:number, bDeltaRange:[number,number], sigma:number, sigmaRange:[number,number], loading:number, loadingRange:[number,number]}}
 */
export function queryTypicalBLoading(motorType = 'induction', cooling = 'forced_air') {
  const t = _TYPICAL_TYPES.includes(motorType) ? motorType : 'induction'
  const c = _TYPICAL_COOLINGS.includes(cooling) ? cooling : 'forced_air'
  const bDelta = TYPICAL_B_DELTA[t][c]
  const [sigma, sigmaLo, sigmaHi] = TYPICAL_SIGMA[t][c]
  const loading = sigma / bDelta
  return {
    bDelta,
    bDeltaRange: [bDelta, bDelta],
    sigma,
    sigmaRange: [sigmaLo, sigmaHi],
    loading,
    loadingRange: [sigmaLo / bDelta, sigmaHi / bDelta],
  }
}

/**
 * 转矩过载倍数 K = 最大提供转矩 / 额定提供转矩（v1.2.0 新增）
 * ===========================================================
 * 语义：L0 的「可达能力」有两个层次 ——
 *   · 额定提供 = T=(π/2)·Bδ·A·D²·L·kw·kFe（典型电磁负荷，长期可输出）
 *   · 最大提供 = 额定提供 × K（短时可输出，过后受温升/去磁/逆变器限流约束）
 * 需求扭矩（9550·P/n）与这两者比较，才得出几何可行性判据。
 *
 * ⚠ 真值支撑为零（2026-10-13 核查）：
 *   · case_motors 表虽有 max_torque / max_torque_ratio 列，但全表仅 1 行且全 NULL；
 *   · qg3d_residuals.torque_ratio 非空 0 行；designs 仅额定 torque。
 * ⇒ 下列取值来自**规范下限/经验分档，非本项目真值标定**，仅供 L0 广筛量级判断，
 *    不得作为设计承诺。真值积累后可整体替换此表（单一旋钮，改动面极小）。
 *
 * 取值依据：
 *   · induction = 2.0 —— GB/T 一般用途异步电动机最大转矩倍数下限（用户指定）。
 *   · pmsm      = 1.8 —— 保守取值。PMSM 无异步机那样的固有最大转矩倍率，
 *     短时过载受逆变器限流 + 永磁体不可逆去磁双重约束，取略低于异步机的值。
 *     （若后续按驱动器限流能力标定，可调高至 2.0~2.5。）
 */
export const TORQUE_OVERLOAD_FACTOR = {
  induction: 2.0,
  pmsm: 1.8,
}
/** 缺省过载倍数（未知机型时按异步机保守口径） */
export const TORQUE_OVERLOAD_FACTOR_DEFAULT = TORQUE_OVERLOAD_FACTOR.induction

/** 查询过载倍数：非法入参安全回退缺省值（与 queryTypicalBLoading 同风格） */
export function queryTorqueOverloadFactor(motorType = 'induction') {
  const v = TORQUE_OVERLOAD_FACTOR[motorType]
  return (typeof v === 'number' && v > 0) ? v : TORQUE_OVERLOAD_FACTOR_DEFAULT
}

export default {
  LAMBDA_RANGE, LAMBDA_RANGE_DEFAULT, LAMBDA_RANGE_EXT,
  FRAME_SHIFT_THRESHOLDS, AIR_GAP_MIN, AIR_GAP_MAX,
  idRatio, idRatioByPoles, ANALOGY_OD_RATIO, SLOT_MAP, PMSM_SLOT_MAP,
  baseTurns, empiricalBaseSize,
  SIM_EFF, SIM_TEMP, LOSS_SPLIT, TORQUE_CONST,
  COOLING_COEFFICIENT, POLE_EFFICIENCY_FACTOR, STEINMETZ,
  CURRENT_DENSITY_REF, J_DESIGN, WINDING_FACTOR, POWER_FACTOR_REF,
  ETA_REF_FOR_CURRENT, DEFAULT_CONNECTION, BACKEMF_TOL,
  SLOT_FILL_WARN, SLOT_FILL_MAX,
  SLOT_LINER_T_MM, SLOT_WEDGE_T_MM, SLOT_SHAPE_FILL, WIRE_COPPER_RATIO,
  FLUX_TARGET, STACKING_FACTOR,
  TOOTH_PEAK_OVER_MEAN, B_TOOTH_SAT_T, BACKEMF_DROP_DEFAULT, BACKEMF_DROP_RMXPRT_REF,
  AIR_GAP_FLUX_DEFAULT, INSULATION_LIMITS, DEFAULT_INSULATION_CLASS,
  PMSM_DEFAULT_POLE_ARC, PMSM_DEFAULT_PM_THICK_MM,
  MIN_ROTOR_YOKE_MM, FREQ_LIMITS, FLUX_TOLERANCE, SLOT_ASPECT_RANGE,
  B_YOKE_WARN_T, B_YOKE_SAT_T, B_YOKE_SEVERE_T,
  PF_ETA_BY_POWER, queryPfEtaRef,
  ID_RATIO_TOLERANCE, HIGH_SPEED_RPM, AIR_GAP_MAX_HIGH_SPEED, airGapMax,
  empiricalAirGap, toothWidth, yokeThickness, yokeThicknessForFlux, solveYokeAndFrame,
  shaftDia, rotorOd,
  lambdaRange, clamp, round1, round2, round3, round4, round5, fitLambdaWithinRange,
  TYPICAL_B_DELTA, TYPICAL_SIGMA, queryTypicalBLoading,
  TORQUE_OVERLOAD_FACTOR, TORQUE_OVERLOAD_FACTOR_DEFAULT, queryTorqueOverloadFactor,
}
