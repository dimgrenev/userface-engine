export * from './types';
export { RuleEngine } from './ruleEngine';
export {
  builtinRules,
  basePolicyPack,
  contractRules,
  structuralRules,
  v2BehaviorRules,
  v2PlatformRules,
  v2AriaRules,
} from './builtinRules';

import { builtinRules } from './builtinRules';
import type { Rule } from './types';

/**
 * Assembly flow step names in pipeline order.
 */
export const ASSEMBLY_FLOW_STEPS = [
  'intent',       // Understand what is being built
  'pattern',      // Select a composition pattern
  'skeleton',     // Build from pattern skeleton
  'components',   // Wire components with contracts
  'validate',     // Run validation checks
  'render',       // Materialize and test
] as const;

/**
 * Get the full assembly policy state.
 * Useful for the MCP orchestrator to provide stage-specific policy slices.
 */
export function getAssemblyPolicy(): {
  flow: readonly string[];
  rules: Rule[];
  antiPatternRuleIds: string[];
} {
  const antiPatternRuleIds = [
    'anti-pattern/multiple-primary-ctas',
    'anti-pattern/separator-overuse',
    'anti-pattern/card-in-card',
    'composition/interactive-nesting',
    'composition/max-depth',
  ];

  return {
    flow: ASSEMBLY_FLOW_STEPS,
    rules: builtinRules,
    antiPatternRuleIds,
  };
}
