// Public surface of `@dostertags/sii-auditor` (ADR-043).
//
// Grouped by module, in the order the nightly loop uses them. Types are exported alongside their
// implementations so a consumer wires the loop without reaching into subpaths.

// --- shared vocabulary ---
export {
  AuditorError,
  ConfidentialityError,
  EvaluationError,
  IntegrityError,
  NotImplemented,
} from './errors.js';
export { citations, contentHash, instant, isGrounded } from './provenance.js';
export type {
  ArtifactProvenance,
  ContentHash,
  DerivedProvenance,
  Instant,
  NormativaProvenance,
  Provenance,
} from './provenance.js';
export {
  SALT_BYTES,
  SALT_STORE_KEY,
  assertNoIdentifiers,
  scanForIdentifiers,
  taxpayerKey,
} from './confidential.js';
export type { Leak, TaxpayerKey } from './confidential.js';
export { SUBJECTS_FILE, loadSalt, loadSubjects } from './subjects.js';

export { stableStringify } from './json.js';

// --- ingest ---
export { recordingDriver, recordingSession } from './ingest/recording-driver.js';
export type { RecordingContext } from './ingest/recording-driver.js';
export type { FetchManifest, Transport } from './ingest/manifest.js';
// The composition root that makes any existing `core` task evidence-backed — usable on its own,
// with none of the rest of this package (ADR-043 §I1).
export { createRecordingRuntime, deriveRunId } from './ingest/runtime.js';
export type { RecordingRuntime, RecordingRuntimeOptions } from './ingest/runtime.js';

// --- store ---
export type { ArtifactQuery, ArtifactStore } from './store/artifacts.js';
export type {
  AnyEntity,
  Communication,
  ElectronicInvoice,
  Entity,
  EntityKind,
  FormLine,
  Giro,
  JournalEntry,
  LedgerEntry,
  Observacion,
  Period,
  PeriodKey,
  SwornStatement,
  TaxReturnForm,
  Taxpayer,
  TaxpayerRef,
} from './store/entities.js';
export { entityId } from './store/normalized.js';
export type { EntityFilter, NormalizedStore } from './store/normalized.js';
export {
  DEFAULT_STORE_ROOT,
  STORE_ROOT_ENV,
  createFileArtifactStore,
  createFileNormalizedStore,
  resolveStoreRoot,
  storedKinds,
} from './store/file-backed.js';
export type { FileNormalizedStore, StoreConfig } from './store/file-backed.js';
export { memoryArtifactStore, memoryNormalizedStore } from './store/memory.js';
export type { MemoryArtifactStore } from './store/memory.js';

// --- extract ---
export type {
  Confidence,
  ConfidenceSignal,
  ConfidenceSignalCode,
  ExtractionFailure,
  ExtractionId,
  ExtractionOutcome,
  ExtractionRecord,
} from './extract/record.js';
export {
  DEFAULT_WEIGHTS,
  REVIEW_THRESHOLD,
  needsReview,
  scoreConfidence,
} from './extract/confidence.js';
export type { ConfidenceWeights } from './extract/confidence.js';
export {
  StrategyRegistry,
  inScope,
  registerCoreStrategies,
  strategyRef,
} from './extract/strategy.js';
export type {
  EntityProjectionContext,
  ExtractionContext,
  ExtractionStrategy,
  StrategyScope,
} from './extract/strategy.js';
export {
  createFileReviewQueue,
  memoryReviewQueue,
  reviewPriority,
} from './extract/review-queue.js';
export { createFileExtractionStore, memoryExtractionStore } from './extract/store.js';
export type { ExtractionStore } from './extract/store.js';
// Concrete strategies. Each wraps ONE artifact type; the month-level aggregation stays the task
// layer's job (`packages/core`), so a parser is measured on parsing alone.
export { f29PropuestaStrategy } from './extract/strategies/f29-propuesta.js';
export { rcvResumenStrategy } from './extract/strategies/rcv-resumen.js';
export type { RcvResumenExtract, RcvResumenTipo } from './extract/strategies/rcv-resumen.js';
export type { F29PropuestaExtract } from './extract/strategies/f29-propuesta.js';
export { BTE_RESUMEN_PII_KEYS, bteResumenStrategy } from './extract/strategies/bte-resumen.js';
export type { BteResumenExtract } from './extract/strategies/bte-resumen.js';
export { bpstPaginaStrategy } from './extract/strategies/bpst-pagina.js';
export type { BpstPaginaExtract } from './extract/strategies/bpst-pagina.js';
export type {
  ReviewItem,
  ReviewQueue,
  ReviewResolution,
  ReviewVerdict,
} from './extract/review-queue.js';

// --- kb ---
export {
  createFileNormativaStore,
  inForce,
  loadChunks,
  memoryNormativaStore,
} from './kb/normativa.js';
export type {
  ApplicableCorpus,
  CitationAnchor,
  EffectiveRange,
  NormativaCandidate,
  NormativaChunk,
  NormativaQuery,
  NormativaStore,
  NormativeRank,
} from './kb/normativa.js';
export { createFileBehaviorMap, importFromContractDocs } from './kb/behavior-map.js';
export type {
  BehaviorMap,
  EndpointEffect,
  EndpointFact,
  FieldFact,
  Observation as BehaviorObservation,
  ObservationStatus,
  PageFact,
  SelectorFact,
  StructuralChange,
  WireShape,
} from './kb/behavior-map.js';

// --- rules ---
export {
  MAX_EVAL_DEPTH,
  depth,
  explain,
  evaluate,
  referencedPaths,
  unknownPaths,
} from './rules/expression.js';
export type {
  EvaluationContext,
  EvaluationResult,
  Expression,
  RuleValue,
} from './rules/expression.js';
export { appliesOn, ruleRef } from './rules/record.js';
export { produceFindings } from './rules/findings.js';
export type { FindingContext, FindingOutcome, UndecidedRule } from './rules/findings.js';
export type {
  Applicability,
  RuleFilter,
  RuleId,
  RuleKind,
  RuleProvenance,
  RuleRecord,
  RuleStatus,
  RuleStore,
  RuleVersion,
} from './rules/record.js';
export {
  amend,
  canTransition,
  createRejectionLedger,
  promote,
  proposalFingerprint,
  propose,
  retire,
} from './rules/promotion.js';
export type {
  GateApproval,
  RejectionEntry,
  RejectionLedger,
  VersionAuthor,
} from './rules/promotion.js';
// Seeded rules: tax logic migrated out of `packages/core` conditionals into versioned data.
export { rcvRowFacts, seedReversaRules } from './rules/seed/reversa-nc.js';

// --- scoring ---
export {
  DEFAULT_Z_THRESHOLD,
  MAD_TO_SIGMA,
  MIN_OBSERVATIONS,
  differences,
  mad,
  median,
  rankFromZ,
  robustZ,
  scoreSeries,
} from './scoring/baseline.js';
export type { AnomalyKind, AnomalyScore, Observation } from './scoring/baseline.js';
export { buildFeatures } from './scoring/model.js';
export type { AnomalyScorer, FeatureVector, ScorerInfo } from './scoring/model.js';

// --- eval ---
export { GOLDEN_DIR_ENV, createFileGoldenSet } from './eval/golden.js';
export { checkCorroboration } from './eval/corroboration.js';
export type {
  Corroboration,
  CorroborationKind,
  CorroborationReport,
} from './eval/corroboration.js';
export { createFileEvalResultStore } from './eval/file-results.js';
export type { FileGoldenSet } from './eval/file-golden.js';
export type {
  EngagementId,
  EngagementManifest,
  ExpectedCitation,
  ExpectedField,
  ExpectedFinding,
  GoldenEngagement,
  GoldenSet,
} from './eval/golden.js';
export { TARGET_METRICS, metricValue } from './eval/result.js';
export type {
  EvalResult,
  EvalResultStore,
  ExtractionMetrics,
  FindingMetrics,
  NormativaMetrics,
  TargetMetric,
} from './eval/result.js';
export { DEFAULT_TOLERANCES, MIN_IMPROVEMENT, approvalFor, evaluateGate } from './eval/gate.js';
export type {
  GateDecision,
  GateRejectionReason,
  MetricComparison,
  MetricMovement,
  Tolerances,
} from './eval/gate.js';
export {
  extractionMetrics,
  f1,
  findingMetrics,
  flatten,
  normativaMetrics,
  ratio,
} from './eval/metrics.js';
export type { ProducedFinding, ResolvedAnchor } from './eval/metrics.js';
export { createEvalHarness } from './eval/harness.js';
export type { EvalHarness, HarnessDeps, HarnessRun } from './eval/harness.js';

// --- loop ---
export { STAGES, completedStages, nextStage } from './loop/manifest.js';
export type {
  RunManifest,
  RunManifestStore,
  RunStatus,
  Stage,
  StageOutcome,
  StageStatus,
} from './loop/manifest.js';
export { outcomeOf } from './loop/context.js';
export type { LoopConfig, LoopContext, StageFn, StageResult } from './loop/context.js';
export {
  DEFAULT_CONFIG,
  DEFAULT_NON_FATAL,
  STAGE_IMPLEMENTATIONS,
  resumeNightly,
  runNightly,
  runStage,
} from './loop/orchestrator.js';
export type { OrchestratorDeps } from './loop/orchestrator.js';
export { createFileManifestStore } from './loop/file-manifests.js';
export {
  emptyGoldenSet,
  fixedClock,
  inMemoryContext,
  memoryAuditSink,
  memoryEvalResultStore,
  memoryManifestStore,
  unimplementedRuleStore,
} from './loop/in-memory.js';
export type { InMemoryContextOptions } from './loop/in-memory.js';

// --- ask ---
export { createAskService, isAnswer } from './ask/question.js';
export type {
  Answer,
  AskResult,
  AskService,
  Citation,
  Declined,
  DeclineReason,
  Question,
  StructuredQuery,
} from './ask/question.js';
