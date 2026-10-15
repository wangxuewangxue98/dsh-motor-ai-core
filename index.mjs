/**
 * @wangxue98/dsh-motor-ai-core —— 电机AI设计核心库
 * ============================================================
 * 这是一个共享核心包，包含 L0/L1/L2 层级共用的业务逻辑和工具函数。
 * 零 DSH Runtime 依赖，可被 Node 直接加载做离线验证。
 */

// Level Gate
export {
  LEVEL_ORDER,
  IMPLEMENTED_LEVELS,
  normalizeLevel,
  isLevelEnabled,
  assertLevelImplemented,
  tierOf,
} from './lib/level-gate.mjs'

// Motor Constants
export {
  LAMBDA_RANGE,
  LAMBDA_RANGE_DEFAULT,
  LAMBDA_RANGE_EXT,
  FRAME_SHIFT_THRESHOLDS,
  AIR_GAP_MIN,
  AIR_GAP_MAX,
  ID_OD_BOUNDS,
  idRatioByPoles,
  idRatio,
  PMSM_TYPES,
  isPmsmType,
  INDUCTION_TYPES,
  resolveMotorType,
  ANALOGY_OD_RATIO,
  SLOT_MAP,
  baseTurns,
  PMSM_SLOT_MAP,
  PMSM_DEFAULT_POLE_ARC,
  PMSM_DEFAULT_PM_THICK_MM,
  empiricalBaseSize,
  SIM_EFF,
  SIM_TEMP,
  LOSS_SPLIT,
  TORQUE_CONST,
  COOLING_COEFFICIENT,
  AMBIENT_TEMP_C,
  DEFAULT_COOLING,
  POLE_EFFICIENCY_FACTOR,
  STEINMETZ,
  COPPER_LOSS_K,
  COPPER_K_BINS,
  MECH_STRAY_RATIO,
  CURRENT_DENSITY_REF,
  J_DESIGN,
  WINDING_FACTOR,
  POWER_FACTOR_REF,
  ETA_REF_FOR_CURRENT,
  DEFAULT_CONNECTION,
  BACKEMF_TOL,
  SLOT_FILL_WARN,
  SLOT_FILL_MAX,
  FLUX_TARGET,
  STACKING_FACTOR,
  AIR_GAP_FLUX_DEFAULT,
  INSULATION_LIMITS,
  DEFAULT_INSULATION_CLASS,
  DEFAULT_LINE_FREQ_HZ,
  LINE_FREQ_MIN_HZ,
  LINE_FREQ_MAX_HZ,
  resolveLineFreqHz,
  HIGH_SPEED_RPM,
  AIR_GAP_MAX_HIGH_SPEED,
  MIN_ROTOR_YOKE_MM,
  FREQ_LIMITS,
  SLIP_MIN_TOL,
  FLUX_TOLERANCE,
  B_YOKE_WARN_T,
  B_YOKE_SAT_T,
  SLOT_ASPECT_RANGE,
  ID_RATIO_TOLERANCE,
  empiricalAirGap,
  toothWidth,
  yokeThickness,
  yokeThicknessForFlux,
  solveYokeAndFrame,
  shaftDia,
  rotorOd,
  lambdaRange,
  clamp,
  round1,
  round2,
  round3,
  round4,
  round5,
  fitLambdaWithinRange,
  TYPICAL_B_DELTA, TYPICAL_SIGMA, queryTypicalBLoading,
  TORQUE_OVERLOAD_FACTOR, TORQUE_OVERLOAD_FACTOR_DEFAULT, queryTorqueOverloadFactor,
} from './lib/motor-constants.mjs'

// Param Schema
export {
  L1_STRICT_REQUIRED,
  L1_MATRIX_FIELDS,
  PHYSICS_FIELDS,
  L1_OUTPUT_FIELDS,
  PARAM_SCHEMA,
  L0_NATIVE_FIELDS,
  L0_META_FIELDS,
  L1_MIRROR_FIELDS,
  L1_DIAG_FIELDS,
  HANDOFF_WHITELIST,
  SPEC_ALIASES,
  COOLING_ALLOWED,
  normalizeSpec,
  assertMatrixShape,
  pickL1Payload,
  buildHandoff,
  buildL0Result,
} from './lib/param-schema.mjs'

// Formula Engine
export {
  copperResistivity,
  computeTorque,
  computePowerKw,
  computeD2L,
  computeLambda,
  validateLambda,
  electricalFrequency,
  estimateCoreMassKg,
  estimateIronLoss,
  slotGeometryDerived,
  estimateCopperLoss,
  deriveElectricalClosure,
  estimateMechanicalLoss,
  estimateMechStrayLoss,
  efficiencyFromLosses,
  splitLosses,
  estimateTempRise,
  l1EfficiencyProxy,
  l1MaxTempProxy,
  quickL0Estimate,
  computeTorqueD2L,
  computeTorqueStress,
  deriveTorqueEnvelope,
} from './lib/formula-engine.mjs'

// Torque Resolver (P4 三级降级编排器)
export {
  l0TorqueEstimate,
  isSurrogateTorqueEnabled,
} from './lib/torque-resolver.mjs'

// Design Rules
export {
  RULE_CATALOG,
  ESCALATABLE_RULES,
  poleFlux,
  toothFluxDensity,
  toothWidthForFlux,
  yokeFluxDensity,
  airGapFluxActual,
  slotGeometry,
  ruleMargin,
  rangeMargin,
  solveTurnsPerCoil,
  validateDesign,
  validateDesignBatch,
} from './lib/design-rules.mjs'

// Applicability Gate
export {
  APPLICABILITY,
  assessApplicability,
  scenarioFromMatrix,
} from './lib/applicability-gate.mjs'

// Surrogate Engine
export {
  DEFAULT_CONFIDENCE_THRESHOLD,
  SUPPORTED_VERSION_PREFIXES,
  loadSurrogateModel,
  selectFamilySegment,
  extractFeatures,
  predictLinear,
  predictGBR,
  predictSurrogate,
  predictBatch,
  buildSurrogateResult,
} from './lib/surrogate-engine.mjs'

// Regression Gate
export {
  SIM_VALID_DOMAIN,
  inSimDomain,
  bandDeviationPt,
  evaluateCase,
  evaluateSuite,
  makeBaseline,
  compareBaseline,
} from './lib/regression-gate.mjs'

// Experience Upload (design_exp 脱敏回传)
export {
  DESIGN_EXP_SPEC_FIELDS,
  DESIGN_EXP_GEO_FIELDS,
  DESIGN_EXP_OUT_FIELDS,
  DESIGN_EXP_SPEC_CORE,
  DESIGN_EXP_FORBIDDEN,
  isSpecComplete,
  recIdOf,
  buildDesignExp,
  scanForbidden,
  getExperienceSink,
  logExperience,
  reportExperience,
  EXPERIENCE_TTL_MS,
  gcExperience,
} from './lib/experience-upload.mjs'

// Telemetry (脱敏聚合指标回传)
export {
  TELEM_FIELDS,
  classifyError,
  sanitizeTelemetry,
  readPendingRecords,
  aggregateUsage,
  attachSessionTelemetry,
  reportTelemetry,
} from './lib/telemetry.mjs'

// Usage Log
export {
  getUsageSink,
  logUsage,
} from './lib/usage-log.mjs'
