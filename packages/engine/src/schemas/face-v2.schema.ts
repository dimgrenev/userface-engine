/**
 * face.json v2 Schema — full runtime contract for UI components.
 *
 * Extends v1 (name, props, states) with:
 * - behavior: focus trap, scroll lock, dismiss, drag, roving focus
 * - keyboard: key→action mappings
 * - aria: role, modal, labelledBy, describedBy, live
 * - composition: required/recommended parts, part tree
 * - platform: native APIs used (<dialog>, popover, CSS Anchor, etc.)
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// v1 (existing) sections
// ---------------------------------------------------------------------------

export const PropOptionValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const PropDefinitionSchema = z.object({
  type: z.string(),
  default: z.any().optional(),
  required: z.boolean().optional(),
  description: z.string().optional(),
  options: z.array(PropOptionValueSchema).optional(),
});

export const StateDefinitionSchema = z.object({
  name: z.string(),
  props: z.record(z.string(), z.any()),
  priority: z.number().optional(),
});

// ---------------------------------------------------------------------------
// v2: Behavior Contract
// ---------------------------------------------------------------------------

export const BehaviorContractSchema = z.object({
  focusTrap: z.boolean().optional(),
  scrollLock: z.boolean().optional(),
  dismissOnEscape: z.boolean().optional(),
  dismissOnClickOutside: z.boolean().optional(),
  returnFocusOnClose: z.boolean().optional(),
  autoFocusOnOpen: z.union([
    z.literal('first-focusable'),
    z.literal('none'),
    z.string(),
  ]).optional(),
  rovingFocus: z.boolean().optional(),
  typeahead: z.boolean().optional(),
  dragToDismiss: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// v2: Keyboard Actions
// ---------------------------------------------------------------------------

export const KeyboardActionSchema = z.object({
  action: z.string(),
  scope: z.string().optional(),
  condition: z.string().optional(),
});

// ---------------------------------------------------------------------------
// v2: ARIA Contract
// ---------------------------------------------------------------------------

export const AriaContractSchema = z.object({
  role: z.string().optional(),
  nativeElement: z.string().optional(),
  modal: z.boolean().optional(),
  labelledBy: z.string().optional(),
  describedBy: z.string().optional(),
  live: z.enum(['polite', 'assertive']).optional(),
  required: z.array(z.string()).optional(),
  notes: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// v2: Composition Contract
// ---------------------------------------------------------------------------

export const PartDefinitionSchema = z.object({
  slot: z.string(),
  parent: z.string().optional(),
  children: z.array(z.string()).optional(),
  accepts: z.array(z.string()).optional(),
  multiple: z.boolean().optional(),
});

export const CompositionContractSchema = z.object({
  required: z.array(z.string()),
  recommended: z.array(z.string()).optional(),
  parts: z.record(z.string(), PartDefinitionSchema),
});

// ---------------------------------------------------------------------------
// v2: Platform Usage
// ---------------------------------------------------------------------------

export const PlatformUsageSchema = z.object({
  dialog: z.boolean().optional(),
  popover: z.boolean().optional(),
  anchorPositioning: z.boolean().optional(),
  closeWatcher: z.boolean().optional(),
  inert: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// v2: Usage Contract
// ---------------------------------------------------------------------------

export const UsageContractSchema = z.object({
  whenToUse: z.array(z.string()).optional(),
  whenNotToUse: z.array(z.string()).optional(),
  alternatives: z.array(z.string()).optional(),
  context: z.enum(['app', 'landing', 'both']).optional(),
}).strict();

// ---------------------------------------------------------------------------
// Full face.json v2 schema
// ---------------------------------------------------------------------------

export const FaceJsonV2Schema = z.object({
  // v1 fields
  name: z.string(),
  description: z.string().optional(),
  props: z.record(z.string(), PropDefinitionSchema).optional(),
  states: z.array(StateDefinitionSchema).optional(),

  // v2 fields
  behavior: BehaviorContractSchema.optional(),
  keyboard: z.record(z.string(), KeyboardActionSchema).optional(),
  aria: AriaContractSchema.optional(),
  composition: CompositionContractSchema.optional(),
  platform: PlatformUsageSchema.optional(),
  usage: UsageContractSchema.optional(),
});

// ---------------------------------------------------------------------------
// TypeScript types (inferred from Zod)
// ---------------------------------------------------------------------------

export type PropDefinition = z.infer<typeof PropDefinitionSchema>;
export type PropOptionValue = z.infer<typeof PropOptionValueSchema>;
export type StateDefinition = z.infer<typeof StateDefinitionSchema>;
export type BehaviorContract = z.infer<typeof BehaviorContractSchema>;
export type KeyboardAction = z.infer<typeof KeyboardActionSchema>;
export type AriaContract = z.infer<typeof AriaContractSchema>;
export type CompositionContract = z.infer<typeof CompositionContractSchema>;
export type PartDefinition = z.infer<typeof PartDefinitionSchema>;
export type PlatformUsage = z.infer<typeof PlatformUsageSchema>;
export type UsageContract = z.infer<typeof UsageContractSchema>;
export type FaceJsonV2 = z.infer<typeof FaceJsonV2Schema>;

// ---------------------------------------------------------------------------
// Utility: parse & validate face.json
// ---------------------------------------------------------------------------

export function parseFaceJsonV2(data: unknown): FaceJsonV2 {
  return FaceJsonV2Schema.parse(data);
}

export function safeParseFaceJsonV2(data: unknown) {
  return FaceJsonV2Schema.safeParse(data);
}

/**
 * Check if a face.json has any v2 sections.
 */
export function hasV2Sections(face: FaceJsonV2): boolean {
  return !!(face.behavior || face.keyboard || face.aria || face.composition || face.platform || face.usage);
}
