export * from './public-types';
export * from './createEngine';
export * from './stateMatrix';
export { normalizePropDef, normalizeAndDedup } from './normalizePropDef';
export {
  mapTypeRich,
  parseStringLiterals,
  extractLocalAliases,
  extractPropsFromCode,
  extractEnumMap,
  extractInterfaceMap,
} from './propParsingHelpers';

// Core building blocks (advanced usage)
export { CoreEngine } from './core-engine';
export type { ComponentProp, ComponentSpec } from './core-engine';
export * from './adapters/core-adapters';
export * from './faces/types';
export * from './face-ui';

// Diff
export { diffFaces } from './diff';
export type { FaceDiffEntry, FaceDiffResult, DiffSeverity } from './diff';

// Registry
export { scanRegistry, clearRegistryCache } from './registry';
export type { RegistryEntry, RegistryIndex, RegistryPropSummary, ScanOptions } from './registry';

// Rule Engine
export { RuleEngine, builtinRules, basePolicyPack } from './rules';
import type { ValidateMode } from './rules';
export type {
  Rule, Violation, ValidationReport, ValidationScores,
  ValidateOptions, ValidateMode, BudgetMode, PolicyPack,
} from './rules';
export {
  USERFACE_PROOF_SCHEMA,
  USERFACE_PROOF_JSON_SCHEMA,
  USERFACE_PROOF_RENDERER_VERSION,
  createUserfaceProof,
  renderUserfaceProofMarkdown,
  reportFailsThreshold,
  violationFailsThreshold,
  proofStatusFromViolations,
  checkFromValidationReport,
  validateUserfaceProof,
} from './proof';

export {
  USERFACE_READINESS_SCHEMA,
  createReadinessReport,
  renderReadinessReportMarkdown,
  type UserfaceReadinessCheck,
  type UserfaceReadinessCheckStatus,
  type UserfaceReadinessReport,
  type UserfaceReadinessStatus,
} from './readiness';
export type {
  UserfaceProof,
  UserfaceProofStatus,
  UserfaceProofCheck,
  UserfaceProofCheckStatus,
  UserfaceProofFailOn,
  CreateUserfaceProofInput,
  UserfaceProofValidationResult,
} from './proof';

// Config
export interface UserfaceConfig {
  root?: string;
  framework?: 'react' | 'vue' | 'svelte' | 'auto';
  validation?: {
    mode?: ValidateMode;
    policies?: string[];
    ignore?: string[];
  };
  mcp?: {
    port?: number;
  };
  libraries?: Record<string, {
    id: string;
    version: string;
    targetDir: string;
    mode?: 'copy' | 'link';
  }>;
}

export function defineConfig(config: UserfaceConfig): UserfaceConfig {
  return config;
}
