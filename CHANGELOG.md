# 更新日志

本项目的所有重大变更都记录在此文件中。

## [1.5.3] - 2026-10-30 — P0-7 单一齿宽口径：槽几何消费 row.tooth_width（默认 OFF）

> **根因（300kW 风机异步机方案实证）**：Bt 公式消费 `params.tooth_width`
> （tw_axis 反解值 4.39mm），而 `slotGeometryDerived` 无 tooth_width 入参、
> 硬编码 `π·Di/(2Qs)`=8.77mm ⇒ 同一次估算里并存两个互斥齿宽：
> 齿统一 8.77 ⇒ Bt=0.807T 挂；齿统一 4.39 ⇒ fill=0.330 挂 ——
> **Bt 与 fill「双达标」只在两公式解耦时存在，是解耦 Artifact 而非工程可行**。

### Added
- 开关 `opts.slotTw` / env `DSH_L0_SLOT_TW`（**默认 OFF，零回归**）。
  ON 时槽几何与 Bt 公式消费同一齿宽；OFF 恒为旧行为。
- `slotGeometryDerived` 可选 `toothWidth` 入参；返回值新增
  `tooth_width_used` / `tooth_width_source`（'explicit' | 'derived'）；
  非法值（≤0/NaN）自动回退派生路径。
- 输出行新增三字段：`slot_tooth_width_mm`（槽几何实际消费齿宽）、
  `slot_area_mm2`（外接矩形毛槽面积，诊断用）、`slot_tw_caliber`
  三态：`explicit`（row 值，与 Bt 同源）/ `derived_resolved`（row 未带，
  传解析后派生值，与 Bt 兜底同源）/ `legacy_derived`（开关 OFF，旧行为；
  此时若 row 带 tooth_width 即双齿宽并存）。

### 门禁
- 新增 `tests/slot-tw.test.mjs` **9/9**：开关双通道、OFF 零回归（面积逐位对旧公式）、
  显式路径「只有该路径能区分」判据（4.39 vs 8.77 手算面积）、fill 方向、
  env/opts 一致、无 row 齿宽兜底同源、直调透传/非法回退、
  跨 `SLOT_FILL_MAX` 可行性翻转。
- 反向破坏双路验证：拆调用点透传 ⇒ 3 红；拆 `slotGeometryDerived` 本体 ⇒ 5 红；
  恢复均回绿。全量 `npm test` 35/35。

## [1.5.2] - 2026-10-25 — 选项 C：异步机气隙磁密 Bg 按极数真值分档标定

> **性质：默认行为变更（需知情）。** 异步机（induction）设计意图 Bg 由恒定钢印 0.80T
> 改为按极数分档真值（2P=0.624 / 4P=0.621 / 6P=0.575 / 8P=0.557T），
> **全部异步机估计系统性下移 ~12%~30%**（理想匝数 +29%~44%、温升 +8~14K）。
> 一键回滚：`DSH_L0_BG_BINS=0` 或 `opts.bgBins=false`（零回归锚点已入 l0 门禁 ⑱）。
> pmsm 分档（2P=0.659 / 4P=0.724）与缺档极数回退 0.80 的行为不变。

### Added
- `AIR_GAP_FLUX_BY_POLES.induction` 分档表（此前为 null）：Y 系列清洁子集各极数中位。
  数据链：65 台 RMxprt 真值集 → 剔除 46 台退化解（出力 <70% 额定，合成绕组过匝
  ⇒ Bg 被压至 0.30~0.34T，是失败设计点非设计目标）与跨机型污染行 → 清洁子集 n=37
  （2/4/6/8 极各 17/5/10/5 台）→ 各极 `air_gap_flux_density` 中位。
- `bg_bins_caliber` 第三态 `explicit_override`：显式 `opts.airGapFlux` 优先于分档表，
  此前被误报为 `default_constant`（Traceability 缺口，非计算错误）。

### Changed
- 异步机 `airGapFluxForDesign` 命中 induction 分档（开关 `bgBinsOn` 默认 ON，
  env `DSH_L0_BG_BINS` / opts `bgBins` 可回退）。缺档极数（10/12 等）仍回退
  `AIR_GAP_FLUX_DEFAULT=0.80`，不外推。
- 意图口径 `air_gap_flux_density`/`tooth_flux_density` 与铁损 B_eff 口径随之
  按 B² 缩放铁耗（与 v3 铁损标定同口径，标定红线未动）；实际口径
  `*_flux_density_actual` 继续消费 winding-lock 校正（P2-A 不变）。

### Fixed
- `tests/leverage-margin.test.mjs` V14 fixture 订正：`turns_per_coil` 24→36。
  新分档下理想匝 10.6→13.79，原 24 的偏离降至 1.75×（<2× 阈值）不再触发 V14
  ⇒ 改为 36（偏离 2.61×，margin −40.7%），保持"匝数填错"检出能力。

### 数据诚信与边界（诚实披露）
- **污染证伪**：designs.db 标称 induction 的 4 极行 28/37 实为转子 44 槽 PMSM 签名
  （中位 0.708T 与 pmsm 表 0.724T 吻合即证），已剔除；真异步签名仅 9 行且为 660V
  工程设计（0.702T，电压等级不同）未并入。
- **清洁判据**：真值机输出功率 ≥70% 额定；退化解出力仅 6%~33%。
- **泛化边界**：6/8 极样本为 EMF 合成绕组（非真实冲片绕组），泛化需真实绕组复核
  （同 `KW_EFF_DEFAULT` 告诫）；2/4 极有真实冲片绕组佐证。
- **下游相互作用**：Bt 与 MD-SDE 门槛的联合影响未在本版量化，寻优链路升级时须复核。

### Tests
- core `scripts/verify_bg_bins_truth.mjs` 18/18（异步机条目改为"已启用分档"记录态）。
- core `tests/` 26/26。
- l0 `scripts/verify_bg_bins_calib.mjs`（C 主门禁，22 项：清洁子集中位同口径重算自证、
  MAPE 7.5% 优于钢印 2×、逐台消费命中、缺档回退、三态口径、env/opts 双通道、
  pmsm 零回归、零回归锚点）22/22。
- l0 `scripts/verify.mjs` 135/135（V17 电压缩放改实测比例校正、V08 构造 Bg 动态化、
  P0-3 异步机断言改独立标定态并补全 opts 通道实体断言——原返回串声称"双通道"
  但体内只有 env 断言，属虚假声明）。

## [1.5.1] - 2026-10-25 — peer 范围放宽（修复与 l0 并装的 ERESOLVE）

> **性质：纯元数据修复，代码零变化。** core 对 `@deepseek-ai/dsh` 零 import
> （lib/ index.mjs tests/ 全仓 grep 无命中），peer 声明纯名义。

### Fixed
- `peerDependencies.@deepseek-ai/dsh` 由 `>=0.1.2 <0.2.0` 放宽为 `>=0.1.2 <0.3.0`
  （与 l0 `dsh-motor-ai-l0` 的 peer 范围对齐）。此前 l0（peer `<0.3.0`）与 core
  （peer `<0.2.0`）并装时，npm 7+ 自动 peer 安装报 ERESOLVE 无法解析依赖树
  （tarball 功能自检实证：0.6.5/0.6.6 裸 `npm install` 均失败；DSH 受支持路径
  `dsh plugin add` 走 pnpm profile 不受影响，属存量缺陷，非 1.5.0 回归）。

## [1.5.0] - 2026-10-25 — P2-A 绕组锁定（winding-lock）：电气闭环尊重入参绕组 + E 平衡闭合

> **性质：新功能，默认 OFF 零回归。** 修复 `deriveElectricalClosure` 静默覆盖入参绕组
> （实测入参 turns_per_coil 6/24/144 输出逐位相同 ⇒ 入参从未被消费）。

### Added
- **winding-lock**（env `DSH_L0_WINDING_LOCK` / opts `windingLock`，默认 OFF）：lock ON 且传入
  `conductors_per_slot`（优先）或 `turns_per_coil` 时，`N = (Qs/3)·(cps/2)/a`（与 RMxprt 求解器
  口径一致）；E 平衡闭合 `Φ = Uph/(4.44·f·N·kw_eff)`，`Bg_locked = Φ/极距面积`；
  `bgForFlux = bg_locked ?? bg_actual ?? intent`（意图口径 By 与铁损 bEffIron 不动）。
- 新增导出 `windingLockOn` / `kwEffOf` / `KW_EFF_DEFAULT`（= 0.697，65 台 RMxprt 真值反算
  mean、CV 5.1%；与 `WINDING_FACTOR=0.95` 的差额为斜槽削弱）。kw_eff 通道优先级
  `opts.kwEff > env DSH_L0_KW_EFF > 0.697`。
- `deriveElectricalClosure` 回显 `winding_lock` / `n_phase_locked` / `turns_per_coil_locked`；
  `quickL0Estimate` 原生输出新增 `winding_lock` / `bg_locked_t` / `kw_eff_used` /
  `air_gap_flux_density_effective`（已登记 `L0_NATIVE_FIELDS`，防被白名单过滤）。

### Fixed
- `design-rules.validateDesign` 的 `airGapFlux` 改走 `airGapFluxForDesign` 分档口径
  （与 formula-engine 主指标同源；显式 `opts.airGapFlux` 仍优先）。
- `tests/leverage-margin.test.mjs` 按 P1-5 铜耗机型隔离后的正确行为订正
  （异步 k 0.263→1.333 ⇒ 15kW 行温升超线确为真实告警，改用 11kW 健康形态）。

### Tests
- 全套 26/26 通过。65 台真值验收：lock OFF→ON，Bg MAPE 77.5%→4.7%、pearson 0.030→0.988；
  Bt pearson −0.027→0.961（验收脚本在 l0 仓 `dev-calib/accept_winding_lock.mjs`）。

## [1.4.0] - 2026-10-17 — P0 四项：磁密口径统一 / V08 严重档 / 工程槽满率 / 电流 pf-η 分档

> **性质：判定口径修正（会改变可行性与效率/温升数值）。** 依据《L0 插件程序深度分析与改进方案 v2》
> （2026-10-17）P0 四项。三项行为变更各带 env 回退开关（默认新口径），便于单变量对照。

### Added
- **P0-1 实际匝口径磁密**：`quickL0Estimate` 原生输出新增 `air_gap_flux_density_actual` /
  `tooth_flux_density_actual` / `yoke_flux_density_actual` / `bg_caliber`。
  `Bg_actual = Bg_intent·(N_ideal/N_int)`，与 `design-rules.mjs:266 airGapFluxActual` 同式
  （按匝比直接算，避免 formula-engine → design-rules 循环依赖）。
- **P0-2 V08 严重档**：新增常量 `B_YOKE_SEVERE_T = 1.7`；`By∈(1.7,1.9]` 判 warning 且打
  `severity:'severe'`，`metrics.flux.yoke_severe` 同步回显；>1.9T 仍 failed（判据未放宽）。
- **P0-3 工程槽满率**：新增 `slotAreaNet()` 与常量 `SLOT_LINER_T_MM=0.30` /
  `SLOT_WEDGE_T_MM=2.5` / `SLOT_SHAPE_FILL=0.62` / `WIRE_COPPER_RATIO=0.85`；
  `estimateCopperLoss` 新增 `slot_fill_engineering` / `slot_area_net_mm2` /
  `conductor_area_enameled_mm2` / `slot_fill_caliber`；V15 `metrics.slot_fill` 新增
  `ratio_net` / `caliber` / `area_net_mm2`。
- **P0-4 电流口径分档**：新增 `PF_ETA_BY_POWER` 与 `queryPfEtaRef({powerKw, motorType})`；
  原生输出新增 `eta_ref_for_current` / `pf_eta_source`（input|nameplate|typical|constant）。
- env 开关（默认新口径）：`DSH_L0_BG_CALIBER`（actual|intent）、`DSH_L0_ENG_SLOT_FILL`（1|0）、
  `DSH_L0_PF_ETA_BINS`（1|0）；导出 `bgCaliberOf` / `engSlotFillOn` / `pfEtaBinsOn`。

### Changed
- **P0-1（判定语义变化）**：`native.yoke_sat` 与 `feasible` 改用**实际匝口径**，与门禁 V08 一致。
  此前主指标按意图口径、门禁按实际口径 ⇒ 同一行「表格正常但门禁爆」。实测 200kW 矩阵
  10/10 行主指标与门禁判定完全一致。
- **P0-3（判定语义变化）**：V15 与 `native.feasible` 改用工程槽满率配 0.70/0.78 阈值。
  旧「裸铜净面积/外接矩形毛槽」实测 0.17~0.27，与工程阈值不可比 ⇒ 系统性漏判真实过槽满；
  工程口径约为旧值的 2.2~2.3 倍。V15 匝数 headroom 改为按判定用的取整值定界（±1 校正）。
- **P0-4（数值变化）**：异步机电流反推 pf/η 由恒 0.92/0.94 改为按功率分档。
  15kW 线电流 26.4A → **30.3A**（= Y160L-4 铭牌），11kW 19.3A → 22.6A（= Y160M-4 铭牌）。
  PMSM 不走分档表（其 pf 本就 0.90~0.95），保持 0.92/0.94。
  ⚠ 已实证：`COPPER_LOSS_K` 是拿 RMxprt **真值**电流/匝数拟合的
  （`scripts/calibrate_losses_v3.mjs:53`），故修正生产侧电流是向真值收敛，**k 不需重标定**。

### Fixed
- V15 匝数 headroom 边界因 `round3` 取整差 1 匝，与判据自相矛盾（turns_max 不越限但 +1 也不越限）。
- **P0-3 开关的 opts 通道被静默丢弃**：`estimateCopperLoss` 内部以 `engSlotFillOn()` 无参调用，
  `design-rules.mjs:854` 的 `useEng` 同样无参 ⇒ 调用方传入的 `opts.engSlotFill` 完全不生效
  （env 通道正常，故只测 env 的门禁未抓到）。修复：`estimateCopperLoss` 新增解构字段 `opts`，
  三处调用改 `engSlotFillOn(opts)`；`quickL0Estimate` 与 `validateDesign` 均透传 opts。
  发现途径：tarball 功能自检（首次打包后从解包目录实跑 P0 四项断言）。

### Tests
- `tests/leverage-margin.test.mjs`：V15 headroom 断言改为按判定口径取值；新增
  「P0-3 反向守卫」（旧口径漏判的过槽满必须被工程口径抓到）；healthy 行 fixture 的
  peak_current 40→32（原 40A 配 11 匝工程口径实为 0.804，本就过槽满，旧口径漏判）。
- 新增「P0-3 开关双通道」用例：**env 与 opts 两条通道分别断言**（不只测 env），
  覆盖 `estimateCopperLoss` / `validateDesign`（metrics.slot_fill.caliber + ratio + headroom 备注）
  / `quickL0Estimate`（native.slot_fill_caliber）三条路径；并做反向破坏验证
  （改回 `engSlotFillOn()` 无参 ⇒ 该用例变红）。全套 26/26 通过。

## [1.3.1] - 2026-10-15 — P2：verdict 密度无关化 + 槽形族感知

> **性质：输出增强 + 规则层族感知；status/issues 合格判定语义零变化。**

### Added
- **verdict 密度无关化**（`validateDesign` 返回 `verdict_basis`）：`status`（passed/warning/failed）
  仅由 V01~V18 物理规则驱动，显式声明 `density_independent: true` 并列出 `drivers`
  （触发 verdict 的 rule+level）；l0 侧 `density_check` 自检（DENSITY_NOT_CONVERGED）只以
  warning 进入 `warnings`，永不改写 `summary.failed`。动机：杜绝「密度/负荷类指标」被误当作
  合格判据（历史上曾被当作门禁，导致假绿灯）。
- **槽形族感知**（`SLOT_FAMILIES` 常量 + `slotFamilyInfo(name)` 查询函数）：
  梨形/梯形半开口/开口矩形/斜肩梨形/闭口槽五族，每族含 `tooth_width_ratio` 经验区间、
  `typical_use`、`notes`。V09 块在识别到 `slot_family` 入参时回显
  `metrics.slot.slot_family`（id）+ `slot_family_label`（中文名）；未知族静默回落不报错。
- `index.mjs` 新增导出：`SLOT_FAMILIES` / `slotFamilyInfo`。

### Tests
- `tests/p2-leverage.test.mjs`（新，4 用例）：verdict_basis 存在 + density_independent=true；
  failed 案例 drivers 精确追溯 V08；slot_family 回显（含未知族）；slotFamilyInfo 查表 + 结构。
  全套 24/24 通过。

## [1.3.0] - 2026-10-15 — 🔧 杠杆验证支持：规则裕度 / 杠杆反解 / 匝数自洽反解 / 温升代理标注

> **性质：纯新增能力 + 输出增强。规则判据（status/issues）语义零变化；issue 对象新增可选
> `margin`/`proxy` 键，metrics 新增 `leverage_headroom`/`thermal.is_proxy`/`back_emf.integer_options`。**

### Added
- **规则裕度** `ruleMargin(value, limit, {unit, better})` / `rangeMargin(value, lo, hi, {unit})`
  （`design-rules.mjs`）：把「离限值还有多远」显式量化——`margin_pct > 0` = 仍在限内。
  V02/V03/V04/V07/V08/V09/V10/V11/V12/V14/V15/V16/V17 触发的 issue 均带 `margin`
  （示例：`Bt=1.62T vs 限值 1.70T ⇒ margin_pct=+4.7`）。动机：微调杠杆此前只能盲试。
- **杠杆反解块** `metrics.leverage_headroom`（v1.3.0 P0-2）：
  - `V07`：`toothWidthForFlux()`——按目标齿磁密反解**最低齿宽**（`toothFluxDensity` 的严格逆函数）
  - `V08`：`yokeThicknessForFlux({targetBy: B_YOKE_SAT_T})`——按硅钢饱和极限反解**最低轭厚**
  - `V15`：`turns_max`——槽满率与匝数严格成正比（`conductorArea=2·turns·aWire`，aWire 与匝数无关）
    ⇒ 精确逆解；`adjustable` 即「还能加几匝」
- **匝数自洽反解** `solveTurnsPerCoil({voltage, speed, poles, statorId, coreLength, slotsStator, ...})`
  （从 V14/V17 规则块抽出，判据逻辑不变）：输出理想匝数/整匝匝数/量化偏差/反电势偏差，
  以及**可取整域** `integer_options`（反电势偏差在 `BACKEMF_TOL` 内的整数匝集合）。
  与 `deriveElectricalClosure` 同源同口径，但不依赖功率/电流（缺 peak_current 也能反解）。
  V14 块改为调用本函数（零行为变化），`metrics.back_emf` 增补 `integer_options`。

### Changed
- **V12 温升代理标注**（P1-6）：`metrics.thermal.is_proxy = true` + `proxy_note`
  （「热负荷法代理值，仅作量级判断」），V12 issue 带 `proxy: true`。
  依据：L0 温升模型未标定（历史实测与真值相关性极弱），须防把「杠杆降温 5K」当设计依据。
- `metrics.thermal` 增补 `efficiency_raw`（sweep 指标曲线用）。
- `index.mjs` 新增导出：`toothWidthForFlux` / `ruleMargin` / `rangeMargin` / `solveTurnsPerCoil`。

### Fixed
- `validateDesign` V14/V17 区块的 destructure 曾错配 snake/camel 键名（静默 NaN）——
  已在 `tests/leverage-margin.test.mjs` 增加数值型断言 + V14 回归用例看守。

### Tests
- `tests/leverage-margin.test.mjs`（新，9 用例）：裕度语义、逆函数一致性、V08/V15 headroom
  精确边界（turns_max 不越限 / +1 越限）、V14 抓填错、健康行不误伤。全套 20/20 通过。

## [1.2.0] - 2026-10-13 — 🎯 转矩三档包络：需求 / 额定提供 / 最大提供 + 可行性判据

> **性质：新增能力字段 + 判据 + 清残留。旧字段语义收窄（torque_capability 明确为「额定提供」）。**

### Added
- **过载倍数表** `TORQUE_OVERLOAD_FACTOR`（`motor-constants.mjs`）：
  `induction = 2.0`（GB/T 一般用途异步机最大转矩倍数下限）、`pmsm = 1.8`
  （PMSM 无固有最大转矩倍率，短时过载受逆变器限流 + 永磁体不可逆去磁双重约束，取略低于异步机的保守值）。
  配套 `queryTorqueOverloadFactor(motorType)`（非法入参安全回退缺省 2.0）。
  ⚠ **非真值标定**：`case_motors.max_torque / max_torque_ratio` 全表仅 1 行且 NULL；
  `qg3d_residuals.torque_ratio` 非空 0 行。真值积累后可整体替换此表（单一旋钮）。
- **包络派生** `deriveTorqueEnvelope(demandNm, capabilityRatedNm, motorType, overloadFactor)`（`formula-engine.mjs`），
  产出 `torque_capability_max` / `overload_factor` / `torque_margin` / `torque_margin_rated` / `torque_feasibility`。
- **三档可行性判据** `torque_feasibility`：
  `ample`（需求 ≤ 额定提供）/ `overload_only`（额定 < 需求 ≤ 最大）/ `undersized`（需求 > 最大）/ `unknown`（缺数据，不伪造）。
  边界含等号：需求=额定 ⇒ ample，需求=最大 ⇒ overload_only。
- 编排器 `l0TorqueEstimate` 透传包络字段；无 P/n（需求未知）时传 demand=0 ⇒ `unknown`，**不自比自判 ample**。
- 白名单 `L0_NATIVE_FIELDS` +5（`torque_capability_max/overload_factor/torque_margin/torque_margin_rated/torque_feasibility`）；
  `PHYSICS_FIELDS` 以包络字段替换已删除的 `estimated_torque`。
- 冒烟测试 +3 项（过载倍数表 / 三档边界含等号与缺数据 / 编排器透传与不自比自判），共 11 项。

### Changed
- `torque_capability` 语义**收窄并钉死**为「额定提供」（典型电磁负荷下长期可输出），
  不再是含糊的「可达能力」；「最大提供」由新增的 `torque_capability_max` 承担。
- `capability_confidence`：能力不可得时为 `0`（此前恒 0.5，会误导下游以为有估计）。

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
