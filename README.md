# @wangxue98/dsh-motor-ai-core

电机 AI 设计**核心库** —— 公式引擎 / 设计规则 / 代理模型 / 转矩解析 / L0 原生契约，供 L0 预筛、L1 求解、L2 复核共享。

**零 DSH Runtime 依赖**：纯 ESM、零第三方运行时依赖，可离线加载、可独立单测。

- 包名：`@wangxue98/dsh-motor-ai-core`
- 当前版本：`1.2.0`
- 许可：MIT
- 上游消费方：[`dsh-motor-ai-l0`](https://www.npmjs.com/package/dsh-motor-ai-l0)（免费 L0 广筛）、`dsh-motor-ai`（完整版）

---

## 安装

```bash
npm i @wangxue98/dsh-motor-ai-core
```

```js
import { quickL0Estimate, validateDesign, l0TorqueEstimate } from '@wangxue98/dsh-motor-ai-core'
```

要求 Node ≥ 18（ESM）。

---

## 模块地图

| 文件 | 职责 |
|---|---|
| `lib/motor-constants.mjs` | 电磁/结构/热/绝缘全部经验常数与典型值表（含 `TYPICAL_B_DELTA` / `TYPICAL_SIGMA` / `queryTypicalBLoading`） |
| `lib/formula-engine.mjs` | 公式引擎：损耗拆分、效率、温升、D²L、λ、`quickL0Estimate`、转矩公式层 |
| `lib/design-rules.mjs` | 设计规则校验（V16 极数-转速同步 / V18 频率合法性 / V08 轭部饱和等）与 `RULE_CATALOG` |
| `lib/param-schema.mjs` | 参数归一化、L0 原生字段白名单、L1 交接白名单 |
| `lib/surrogate-engine.mjs` | 代理模型加载 / 分族路由 / 批量预测 / 结果装配 |
| `lib/torque-resolver.mjs` | **转矩三级降级编排器**（1.1.0 新增） |
| `lib/applicability-gate.mjs` | 适用性门禁（机型/功率段是否在本库能力域内） |
| `lib/level-gate.mjs` | L0/L1/L2 层级门禁 |
| `lib/regression-gate.mjs` | 回归门禁（与基线对比） |
| `lib/experience-upload.mjs` | 设计经验回灌 |
| `lib/telemetry.mjs` | 遥测上报 |
| `lib/usage-log.mjs` | 用量日志 |

模型数据：`models/l0_surrogate*.json`（随包发布，离线可用）。

---

## 转矩口径（1.1.0 重点）

L0 广筛中「转矩」是两个**不同物理量**，本库以**双字段**严格区分，禁止混用：

| 字段 | 含义 | 来源 | 置信度 |
|---|---|---|---|
| `torque` | **需求扭矩** —— 规格要求的额定转矩 | `9550·P(kW)/n(rpm)`（精确恒等式） | 1.0 |
| `torque_capability` | **额定提供** —— 该几何长期可输出的转矩估计 | 三级降级：代理(T1) → D²L 电磁负荷(T2) → 切向应力(T2b) | 0.5 / 按源 |
| `torque_capability_max` | **最大提供** —— 短时可输出的转矩 | `torque_capability × overload_factor` | 0.5 / 按源 |

三级降级编排器 `l0TorqueEstimate(params, opts)`：

```
期望输出 torque
  ├─ 有 P 与 n  → 9550·P/n（精确，conf 1.0）
  └─ 无 P 或 n  → 回退「可达能力」值（conf 降低，显式标注）

可达能力 torque_capability（额定提供）
  ├─ T1  代理模型（需 opts.surrogateTorque>0 且 conf≥0.70 且 env DSH_L0_SURROGATE_TORQUE=1）
  ├─ T2  D²L 电磁负荷法  T = (π/2)·Bδ·A·D²·L·kw·kFe·kSat
  ├─ T2b 切向应力法      T = (π/2)·D²·L·σ
  └─ unavailable → 0（**恒 0，不伪造**）
```

### 需求 vs 提供：三档可行性判据（1.2.0）

`deriveTorqueEnvelope(demandNm, capabilityRatedNm, motorType, overloadFactor?)` 把三者合成一个几何可行性信号：

| `torque_feasibility` | 条件 | 工程含义 |
|---|---|---|
| `ample` | 需求 ≤ 额定提供 | 充裕，几何还有缩小空间 |
| `overload_only` | 额定提供 < 需求 ≤ 最大提供 | 仅短时过载可行，长期不行 |
| `undersized` | 需求 > 最大提供 | 几何偏小，必须放大机座 |
| `unknown` | 需求或提供缺数据 | 不作判定（**不伪造**） |

边界含等号：需求 = 额定 ⇒ `ample`；需求 = 最大 ⇒ `overload_only`。
配套字段：`torque_margin`（最大/需求）、`torque_margin_rated`（额定/需求）。

**过载倍数 `TORQUE_OVERLOAD_FACTOR`**：`induction = 2.0`（GB/T 一般用途异步机最大转矩倍数下限）、`pmsm = 1.8`
（PMSM 短时过载受逆变器限流 + 永磁体不可逆去磁双重约束，取略低于异步机的保守值）。
⚠ **非本项目真值标定** —— `case_motors.max_torque / max_torque_ratio` 全表仅 1 行且 NULL。

**口径纪律（重要）**

- `D` 一律取**定子内径（气隙直径）**，不是定子外径。典型切向应力 σ ≈ 28 kPa 量级即为该口径；误用外径会低估约 2~3×。
- T1 代理转矩默认**关闭**（`DSH_L0_SURROGATE_TORQUE` 未设为 `1` 时不启用）——真值样本不足时宁可降级到公式，不用低质量代理。
- 交接给 L1（RMxprt）时必须用 **规格** `torque_nm`，不得用 `torque_capability` 当规格。
- 旧版「`estimated_torque = torque_nm × D²L/D²L_base` 线性类比」**已删除**（实测最大偏离 523%，字段不再产出）。
- 无 P/n（需求未知）时，`torque` 虽回退为能力值，但判据传 demand=0 ⇒ `unknown`，**不得自比自判 `ample`**。

---

## 典型 Bδ / A / σ 知识表（1.1.0 新增）

`queryTypicalBLoading(motorType, cooling)` 返回 `{ B_delta, A, sigma }`（中值 + 区间），按 `induction` / `pmsm` × `natural` / `forced_air` / `liquid_jacket` 分档。

用途：为 D²L 电磁负荷法（T2）与切向应力法（T2b）提供缺省电磁负荷取值。**这是 L0 广筛量级估计，不是设计承诺**，L1 求解后以真解为准。

---

## 频率与极数（1.1.0）

- `LINE_FREQ_MIN_HZ` 由 20 放宽到 **5**，使 VFD 低频工况（如 12.5 Hz 船推）不再被整批判死。
- V16 规则在**显式传入 `line_freq_hz`（变频模式）**时引入滑差容差 `SLIP_MIN_TOL = 0.03`：同步转速落在 `[n×0.97, n]` 属「临界可行」，降级为 warning 并给出频率微调建议；真正不可行（同步转速低于额定转速 3% 以上）仍然 fail。
- 工频（默认 50 Hz）口径**保持不变**，不受此放宽影响。

---

## 开发

```bash
node --test tests/*.test.mjs    # npm test
```

本库无构建步骤，`lib/` 下均为原生 ESM。改动会经 symlink 自动回流到消费方仓库，便于联调。

## 许可

MIT © 2026 wangxuewangxue98
