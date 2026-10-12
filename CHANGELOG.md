# 更新日志

本项目的所有重大变更都记录在此文件中。

## [1.1.1] - 2026-10-12 — 🔧 补导出 `SLIP_MIN_TOL` + 仓库文档补齐

> **性质：补导出 + 文档。无行为变更。**

### 根因
- `motor-constants.mjs` 中新增的 `SLIP_MIN_TOL`（V16 变频滑差容差）未加入 `index.mjs` 的 re-export 块，
  包外消费者（`dsh-motor-ai-l0` 的验收脚本、第三方单测）引用该常量会直接 `SyntaxError`。
- 仓库此前缺少 `README.md` / `LICENSE` / `tests/`，`npm test`（指向 `tests/*.test.mjs`）实际不可用。

### 变更
- `index.mjs` 常量导出块补齐 `SLIP_MIN_TOL`。
- 新增 `README.md`（模块地图、转矩双字段口径、典型 Bδ/A/σ 表、频率与极数口径）。
- 新增 `LICENSE`（MIT，与 `package.json` 声明一致）。
- 新增 `tests/smoke.test.mjs`（8 项契约冒烟：9550 恒等式、频率下界、典型表回退、
  D²L/应力比值 = kw·kFe、双字段路由、不可用恒 0 不伪造、代理开关默认 OFF、V16 工频/VFD 分野）。

### 影响
- 纯导出与文档补充，`^1.1.0` 消费者自动覆盖；已发布的 1.1.0 行为不变。

## [1.1.0] - 2026-10-12 — ✨ VFD 低频边界放宽 + 转矩双字段三级降级（P2/P1/P4/P5）

> **性质：功能新增 + 缺陷修复。配合 `dsh-motor-ai-l0@0.4.0`。**

### 根因
- **P0-1 VFD 低频断崖**：`LINE_FREQ_MIN_HZ = 20` 把 12.5/15 Hz 等变频低速工况整批判死
  （实测 400kW/250rpm/6 极 @12.5Hz 船推：40 个候选全 failed，用户指定的 6 极被静默丢弃）。
- **转矩口径混乱**：L0 只有 `estimated_torque = torque_nm × D²L/D²L_base` 线性类比，
  实测最大偏离 523%；代理通道 `torque` 恒置 0；「规格转矩」与「几何可达能力」混为一谈。
- **缺电磁负荷公式层**：资料方法2（D²L 电磁负荷）与方法3（切向应力）在 JS 侧完全缺失，
  且无典型 Bδ/A 知识表可供取值。

### 变更
- **P0-1**：`LINE_FREQ_MIN_HZ` 20 → **5**；V16 规则在**显式传入 `line_freq_hz`（变频模式）**时
  引入滑差容差 `SLIP_MIN_TOL = 0.03`——同步转速落在 `[n×0.97, n]` 属临界可行，降级为 warning
  并给出频率微调建议；真正不可行者仍 fail。**工频（默认 50 Hz）口径保持不变。**
- **P2 知识表**：新增 `TYPICAL_B_DELTA` / `TYPICAL_SIGMA` + `queryTypicalBLoading(motorType, cooling)`，
  按 induction/pmsm × natural/forced_air/liquid_jacket 分档，A = σ/Bδ 派生，非法入参安全回退。
  **口径：σ 与 D 均按定子内径（气隙直径）**，典型值 ≈ 28 kPa 量级；误用定子外径会低估约 2~3×。
- **P1 公式层**：新增 `computeTorqueD2L`（方法2）与 `computeTorqueStress`（方法3）。
  两法比值恒等于 `kw·kFe`（实测 0.931），互为交叉校验。
- **P4 编排器**：新增 `lib/torque-resolver.mjs`，`l0TorqueEstimate` 输出双字段——
  `torque`（期望输出 = 规格 9550·P/n，conf 1.0）/ `torque_capability`（可达能力 =
  T1 代理 → T2 D²L → T2b 应力 → `unavailable` **恒 0 不伪造**）。
  T1 需 `DSH_L0_SURROGATE_TORQUE=1` 且置信度 ≥ 0.70，**默认关闭**。
- **P5 接线**：`L0_NATIVE_FIELDS` +5 白名单字段；`quickL0Estimate` 内联双字段；
  `buildSurrogateResult` 去除 `torque: 0` 硬置改走编排器；`index.mjs` 导出全部新符号。

### 架构约束
- **零循环依赖**：`torque-resolver` 单向依赖 `formula-engine`；公式通道在 `quickL0Estimate`
  内联计算双字段，仅代理通道走编排器。

### 影响
- 新增导出与字段均为**追加**，既有消费方零回归（l0 验收 115/115 全绿）。
- 已弃用：旧 `estimated_torque` 的 D²L 线性类比口径。


## [1.0.1] - 2026-10-10 — 🐛 补导出：`reportTelemetry` / `reportExperience`

> **性质：缺陷修复（配合 `dsh-motor-ai-l0@0.3.1`）。**

### 根因
- l0 抽 core 重构时，`index.mjs` 的 re-export 块漏导出 `reportTelemetry`（`lib/telemetry.mjs:205`）与 `reportExperience`（`lib/experience-upload.mjs:295`）。
- l0@0.3.0 入口残留 3 处本地 `./lib` 动态 import → 发布物缺 lib → DSH 启动崩溃；修复方案把 l0 的 3 处动态 import repoint 到本包，但本包未导出这两个函数会导致功能静默失效。

### 变更
- `index.mjs` re-export 块补齐 `reportTelemetry`（telemetry 块）与 `reportExperience`（experience-upload 块）。

### 影响
- 纯导出补充，无破坏性变更；`^1.0.0` 消费者自动覆盖。
