/**
 * Rule Engine type system.
 *
 * Rules are declarative JSON definitions that describe what to check.
 * The engine compiles them into efficient matchers for single-pass evaluation.
 */

// ---------------------------------------------------------------------------
// Rule Definition (JSON DSL)
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info';

export interface RuleMatch {
  /** Match by component name (glob or regex pattern) */
  component?: string;
  /** Match by prop name (when checking individual props) */
  prop?: string;
  /** Match by framework */
  framework?: string;
  /** Match by presence of face.json */
  hasFaceJson?: boolean;
  /** Custom predicate key (for programmatic rules) */
  custom?: string;
}

export interface RuleCondition {
  /** Require a prop to exist */
  propExists?: string;
  /** Require a prop to NOT exist */
  propAbsent?: string;
  /** Require prop value to be in a set */
  propValueIn?: { prop: string; values: string[] };
  /** Require prop count to be within a range */
  propsCount?: { $gt?: number; $lt?: number; $lte?: number; $gte?: number };
  /** Require component to have states defined */
  hasStates?: boolean;
  /** Generic: code must contain pattern (regex) */
  codeContains?: string;
  /** Generic: code must NOT contain pattern (regex) */
  codeAbsent?: string;
}

export interface Rule {
  id: string;
  /** Human-readable description */
  description: string;
  severity: Severity;
  /** Confidence level 0-1 (1 = certain, 0.5 = heuristic) */
  confidence: number;
  /** What components this rule applies to */
  match: RuleMatch;
  /** Condition to check — if true, no violation; if false, emit violation */
  require?: RuleCondition;
  /** Inverse: if condition matches, emit violation */
  forbid?: RuleCondition;
  /** Fix suggestion for LLM/human */
  fixHint?: string;
  /** Category for grouping */
  category: 'contract' | 'structural' | 'a11y' | 'complexity' | 'pattern';
  /** Tags for filtering */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

export interface ViolationLocation {
  component?: string;
  prop?: string;
  file?: string;
  line?: number;
}

export interface Violation {
  ruleId: string;
  description: string;
  severity: Severity;
  confidence: number;
  category: Rule['category'];
  location: ViolationLocation;
  fixHint?: string;
}

// ---------------------------------------------------------------------------
// Validation Report
// ---------------------------------------------------------------------------

export interface ValidationScores {
  overall: number;
  structural: number;
  contract: number;
  accessibility: number;
  complexity: number;
}

export type ValidateMode = 'fast' | 'standard' | 'deep';
export type BudgetMode = 'llm' | 'compact' | 'verbose';

export interface ValidationReport {
  component: string;
  mode: ValidateMode;
  durationMs: number;
  scores: ValidationScores;
  violations: Violation[];
  violationsTotal: number;
  violationsShown: number;
  summary: string;
}

// ---------------------------------------------------------------------------
// Policy Pack
// ---------------------------------------------------------------------------

export interface PolicyPack {
  name: string;
  version: string;
  description: string;
  rules: Rule[];
}

// ---------------------------------------------------------------------------
// Validate Options
// ---------------------------------------------------------------------------

export interface ValidateOptions {
  mode?: ValidateMode;
  budget?: BudgetMode;
  /** Maximum violations to return */
  maxViolations?: number;
  /** Additional rules to apply on top of policy pack */
  extraRules?: Rule[];
  /** Suppress specific rule IDs */
  suppress?: string[];
}
