/**
 * Rule Engine — loads rules, compiles matchers, evaluates against ComponentSpec.
 *
 * Design:
 * - Rules are declarative JSON (Rule[])
 * - Matchers are compiled once, evaluated many times
 * - Single pass over ComponentSpec per validation
 * - Deterministic output: same input → same violations, same order
 */

import type {
  Rule,
  RuleMatch,
  RuleCondition,
  Violation,
  ValidationReport,
  ValidationScores,
  ValidateOptions,
  ValidateMode,
  BudgetMode,
  PolicyPack,
} from './types';
import type { ComponentSpec, ComponentProp } from '../core-engine';

// ---------------------------------------------------------------------------
// Compiled matcher type
// ---------------------------------------------------------------------------

type MatcherFn = (ctx: EvalContext) => boolean;
type ConditionFn = (ctx: EvalContext) => boolean;

interface CompiledRule {
  rule: Rule;
  matches: MatcherFn;
  check: ConditionFn;
}

interface EvalContext {
  spec: ComponentSpec;
  props: ComponentProp[];
  code?: string;
  faceJson?: any;
}

// ---------------------------------------------------------------------------
// Matcher compilation
// ---------------------------------------------------------------------------

function compileMatch(match: RuleMatch): MatcherFn {
  const checks: MatcherFn[] = [];

  if (match.component) {
    const pattern = match.component;
    if (pattern === '*') {
      // matches all
    } else if (pattern.includes('*')) {
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
      checks.push(ctx => regex.test(ctx.spec.name));
    } else {
      const lower = pattern.toLowerCase();
      checks.push(ctx => ctx.spec.name.toLowerCase() === lower);
    }
  }

  if (match.framework) {
    const fw = match.framework.toLowerCase();
    checks.push(ctx => (ctx.spec.framework || '').toLowerCase() === fw);
  }

  if (match.hasFaceJson !== undefined) {
    const want = match.hasFaceJson;
    checks.push(ctx => (!!ctx.faceJson) === want);
  }

  if (checks.length === 0) return () => true;
  return (ctx) => checks.every(fn => fn(ctx));
}

function compileCondition(cond: RuleCondition): ConditionFn {
  const checks: ConditionFn[] = [];

  if (cond.propExists) {
    const name = cond.propExists;
    checks.push(ctx => ctx.props.some(p => p.name === name));
  }

  if (cond.propAbsent) {
    const name = cond.propAbsent;
    checks.push(ctx => !ctx.props.some(p => p.name === name));
  }

  if (cond.propValueIn) {
    const { prop, values } = cond.propValueIn;
    checks.push(ctx => {
      const p = ctx.props.find(p => p.name === prop);
      if (!p) return false;
      const val = String(p.defaultValue ?? '');
      return values.includes(val);
    });
  }

  if (cond.propsCount) {
    const { $gt, $lt, $lte, $gte } = cond.propsCount;
    checks.push(ctx => {
      const n = ctx.props.length;
      if ($gt !== undefined && !(n > $gt)) return false;
      if ($lt !== undefined && !(n < $lt)) return false;
      if ($gte !== undefined && !(n >= $gte)) return false;
      if ($lte !== undefined && !(n <= $lte)) return false;
      return true;
    });
  }

  if (cond.codeContains) {
    const regex = new RegExp(cond.codeContains);
    checks.push(ctx => ctx.code ? regex.test(ctx.code) : false);
  }

  if (cond.codeAbsent) {
    const regex = new RegExp(cond.codeAbsent);
    checks.push(ctx => ctx.code ? !regex.test(ctx.code) : true);
  }

  if (checks.length === 0) return () => true;
  return (ctx) => checks.every(fn => fn(ctx));
}

function compileRule(rule: Rule): CompiledRule {
  const matches = compileMatch(rule.match);

  let check: ConditionFn;
  if (rule.require) {
    const condFn = compileCondition(rule.require);
    check = (ctx) => condFn(ctx);
  } else if (rule.forbid) {
    const condFn = compileCondition(rule.forbid);
    check = (ctx) => !condFn(ctx);
  } else {
    check = () => true;
  }

  return { rule, matches, check };
}

// ---------------------------------------------------------------------------
// Score calculation
// ---------------------------------------------------------------------------

function computeScores(violations: Violation[], propCount: number): ValidationScores {
  const byCat = { structural: 0, contract: 0, a11y: 0, complexity: 0, pattern: 0 };
  const weights = { error: 10, warning: 3, info: 1 };

  for (const v of violations) {
    byCat[v.category] += weights[v.severity] * v.confidence;
  }

  const maxPerCat = 100;
  const score = (penalty: number) => Math.max(0, Math.round(maxPerCat - penalty));

  const structural = score(byCat.structural);
  const contract = score(byCat.contract);
  const accessibility = score(byCat.a11y);
  const complexity = propCount > 25 ? Math.max(0, 100 - (propCount - 25) * 3) : 100;

  const overall = Math.round((structural + contract + accessibility + complexity) / 4);

  return { overall, structural, contract, accessibility, complexity };
}

// ---------------------------------------------------------------------------
// Budget filtering
// ---------------------------------------------------------------------------

function applyBudget(violations: Violation[], budget: BudgetMode): Violation[] {
  const sorted = [...violations].sort((a, b) => {
    const sevOrder = { error: 0, warning: 1, info: 2 };
    const sa = sevOrder[a.severity] ?? 2;
    const sb = sevOrder[b.severity] ?? 2;
    if (sa !== sb) return sa - sb;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return (a.ruleId || '').localeCompare(b.ruleId || '');
  });

  switch (budget) {
    case 'llm':
      return sorted.filter(v => v.severity === 'error').slice(0, 5);
    case 'compact':
      return sorted.filter(v => v.severity !== 'info').slice(0, 10);
    case 'verbose':
    default:
      return sorted;
  }
}

function generateSummary(report: Pick<ValidationReport, 'component' | 'scores' | 'violationsTotal'>): string {
  const { component, scores, violationsTotal } = report;
  if (violationsTotal === 0) return `${component}: all checks passed (score: ${scores.overall}/100)`;
  return `${component}: ${violationsTotal} issue(s) found (score: ${scores.overall}/100)`;
}

// ---------------------------------------------------------------------------
// Rule Engine
// ---------------------------------------------------------------------------

export class RuleEngine {
  private compiled: CompiledRule[] = [];

  loadRules(rules: Rule[]): void {
    for (const rule of rules) {
      if (!rule.id || !rule.severity || !rule.match) {
        throw new Error(`Invalid rule: missing required field(s) in rule "${rule.id || '<unknown>'}"`);
      }
      this.compiled.push(compileRule(rule));
    }
  }

  loadPolicyPack(pack: PolicyPack): void {
    this.loadRules(pack.rules);
  }

  get ruleCount(): number {
    return this.compiled.length;
  }

  /**
   * Validate a ComponentSpec against loaded rules.
   * This is the "fast" path — no SSR, no axe, pure rule evaluation.
   */
  evaluate(
    spec: ComponentSpec,
    options?: {
      code?: string;
      faceJson?: any;
      suppress?: string[];
    },
  ): Violation[] {
    const ctx: EvalContext = {
      spec,
      props: spec.props || [],
      code: options?.code,
      faceJson: options?.faceJson,
    };

    const suppressSet = new Set(options?.suppress || []);
    const violations: Violation[] = [];

    for (const compiled of this.compiled) {
      if (suppressSet.has(compiled.rule.id)) continue;
      if (!compiled.matches(ctx)) continue;
      if (!compiled.check(ctx)) {
        violations.push({
          ruleId: compiled.rule.id,
          description: compiled.rule.description,
          severity: compiled.rule.severity,
          confidence: compiled.rule.confidence,
          category: compiled.rule.category,
          location: { component: spec.name },
          fixHint: compiled.rule.fixHint,
        });
      }
    }

    return violations;
  }

  /**
   * Full validation pipeline with report generation.
   */
  validate(
    spec: ComponentSpec,
    options: ValidateOptions & { code?: string; faceJson?: any } = {},
  ): ValidationReport {
    const start = performance.now();
    const mode: ValidateMode = options.mode || 'fast';
    const budget: BudgetMode = options.budget || 'verbose';

    const allViolations = this.evaluate(spec, {
      code: options.code,
      faceJson: options.faceJson,
      suppress: options.suppress,
    });

    const scores = computeScores(allViolations, (spec.props || []).length);
    const budgeted = applyBudget(allViolations, budget);

    const report: ValidationReport = {
      component: spec.name,
      mode,
      durationMs: Math.round(performance.now() - start),
      scores,
      violations: budgeted,
      violationsTotal: allViolations.length,
      violationsShown: budgeted.length,
      summary: '',
    };

    report.summary = generateSummary(report);

    return report;
  }
}
