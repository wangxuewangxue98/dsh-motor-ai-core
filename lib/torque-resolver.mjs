/**
 * 转矩三级降级编排器（P4）—— L0 转矩唯一解算入口（surrogate 通道）
 * ===========================================================
 * 设计原则：
 *   1. 双字段分离 —— 区分「期望输出（排序口径）」与「可达能力（可行性口径）」，
 *      二者物理含义不同，不得混用：
 *        · 期望输出 torque/torque_density/torque_source/torque_confidence
 *          = spec 9550·P/n（精确, conf 1.0）→ 无 P/n 时回退能力估计
 *        · 可达能力 torque_capability/capability_source/capability_confidence
 *          = surrogate(T1) → d2l(T2) → stress(T2b) → unavailable(恒0不伪造)
 *   2. 诚实边界 —— 期望输出里 spec 是规格级精确值，只有它可作 RMxprt 规格；
 *      能力估计是广筛代理（低置信），绝不当作规格承诺。
 *   3. 灰度安全 —— T1(surrogate) 受 env DSH_L0_SURROGATE_TORQUE 门控（默认 OFF）；
 *      当前代理模型无 torque 目标（P3 真值缺失），T1 恒不命中 → 自动降级 T2/T3。
 *   4. 零循环依赖 —— 仅 import formula-engine 的纯函数，不回引调用方。
 *
 * 说明：公式通道(quickL0Estimate) 内联实现同款双字段（不 import 本模块，避免环），
 *      本模块专供 surrogate 通道（buildSurrogateResult）使用，承载 T1 代理注入逻辑。
 */

import {
  computeTorque,
  computeTorqueD2L,
  computeTorqueStress,
  computePowerKw,
} from './formula-engine.mjs'

const ENV_SURROGATE_TORQUE = 'DSH_L0_SURROGATE_TORQUE'
const SURROGATE_CONF_MIN = 0.70

function round2(x) { return Math.round(x * 100) / 100 }
function round3(x) { return Math.round(x * 1000) / 1000 }

/** env 开关：DSH_L0_SURROGATE_TORQUE 默认 OFF（接受 1/true/on/yes）；opts 可覆盖 */
export function isSurrogateTorqueEnabled(opts = {}) {
  if (opts?.surrogateTorqueEnabled !== undefined) return !!opts.surrogateTorqueEnabled
  const v = (typeof process !== 'undefined' && process.env) ? process.env[ENV_SURROGATE_TORQUE] : undefined
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

function volumeM3(params) {
  const d = (params.stator_id ?? (params.stator_od ? params.stator_od * 0.6 : 0)) / 1000
  const l = (params.core_length ?? 0) / 1000
  return d > 0 && l > 0 ? d * d * l : 0
}

/**
 * 三级降级解算
 * @param {object} params {power_kw, speed, stator_id, stator_od, core_length, poles, torque_nm, motor_type, cooling}
 * @param {object} [opts] {surrogateTorque, surrogateConfidence, surrogateTorqueEnabled, motorType, cooling, powerKw}
 * @returns {{torque,torque_density,torque_source,torque_confidence,torque_capability,capability_source,capability_confidence}}
 */
export function l0TorqueEstimate(params = {}, opts = {}) {
  const powerKw = params.power_kw ?? opts.powerKw
  const speed = params.speed
  const specTorque = (powerKw && speed > 0) ? computeTorque(powerKw, speed) : 0
  const vol = volumeM3(params)

  // ---- 可达能力链 T1 → T2 → T2b ----
  let capability = 0
  let capSource = 'unavailable'
  let capConf = 0
  const sTorque = opts?.surrogateTorque
  const sConf = opts?.surrogateConfidence ?? 0
  if (isSurrogateTorqueEnabled(opts) && sTorque > 0 && sConf >= SURROGATE_CONF_MIN) {
    // T1 命中：代理转矩（仅 env ON 且高置信真值可用时）
    capability = sTorque
    capSource = 'surrogate'
    capConf = round3(sConf)
  } else {
    // T2 方法2（电磁负荷）优先
    const d2l = computeTorqueD2L(params, opts)
    if (d2l && d2l.torque > 0) {
      capability = d2l.torque
      capSource = 'd2l'
      capConf = d2l.confidence
    } else {
      // T2b 方法3（切向应力）兜底
      const st = computeTorqueStress(params, opts)
      if (st && st.torque > 0) {
        capability = st.torque
        capSource = 'stress'
        capConf = st.confidence
      }
    }
  }

  // ---- 期望输出（排序口径）----
  let torque
  let source
  let confidence
  if (specTorque > 0) {
    torque = specTorque
    source = (params.torque_nm !== undefined) ? 'spec' : 'power_speed'
    confidence = 1.0
  } else if (capability > 0) {
    torque = capability
    source = capSource
    confidence = capConf
  } else {
    torque = 0
    source = 'insufficient_data'
    confidence = 0
  }

  const torqueDensity = (torque > 0 && vol > 0) ? Math.round(torque / vol) : 0

  return {
    torque: round2(torque),
    torque_density: torqueDensity,
    torque_source: source,
    torque_confidence: round3(confidence),
    torque_capability: round2(capability),
    capability_source: capSource,
    capability_confidence: round3(capConf),
  }
}

export default {
  l0TorqueEstimate,
  isSurrogateTorqueEnabled,
  ENV_SURROGATE_TORQUE,
  SURROGATE_CONF_MIN,
}
