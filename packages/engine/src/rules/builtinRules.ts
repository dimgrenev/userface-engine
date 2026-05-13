/**
 * Built-in rules for Userface Engine.
 * These form the "base" policy pack — open-source, shipped with the engine.
 */

import type { Rule } from './types';

// ---------------------------------------------------------------------------
// Contract rules — validate component against its contract/face.json
// ---------------------------------------------------------------------------

export const contractRules: Rule[] = [
  {
    id: 'contract/no-props',
    description: 'Component has no extractable props — analysis may have failed or component is trivial.',
    severity: 'warning',
    confidence: 0.7,
    match: { component: '*' },
    forbid: { propsCount: { $lte: 0 } },
    fixHint: 'Ensure the component exports a typed Props interface or type alias.',
    category: 'contract',
  },
  {
    id: 'contract/excessive-props',
    description: 'Component has more than 25 props — consider decomposing into smaller components.',
    severity: 'warning',
    confidence: 0.9,
    match: { component: '*' },
    forbid: { propsCount: { $gt: 25 } },
    fixHint: 'Split into subcomponents or use a config object prop to reduce API surface.',
    category: 'complexity',
  },
  {
    id: 'contract/extreme-props',
    description: 'Component has more than 40 props — likely includes inherited HTML attributes. Review prop extraction.',
    severity: 'info',
    confidence: 0.6,
    match: { component: '*' },
    forbid: { propsCount: { $gt: 40 } },
    fixHint: 'Check if props include inherited HTML attributes. Use explicit Props type to limit surface.',
    category: 'complexity',
  },
];

// ---------------------------------------------------------------------------
// Structural rules — common UX/a11y patterns detectable without SSR
// ---------------------------------------------------------------------------

export const structuralRules: Rule[] = [
  {
    id: 'a11y/button-type',
    description: 'Button component should accept a "type" prop (submit/button/reset) to prevent accidental form submissions.',
    severity: 'warning',
    confidence: 0.8,
    match: { component: 'Button' },
    require: { propExists: 'type' },
    fixHint: 'Add a "type" prop with options: "button", "submit", "reset". Default to "button".',
    category: 'a11y',
  },
  {
    id: 'a11y/input-label',
    description: 'Input component should accept a "label" or "aria-label" prop for accessibility.',
    severity: 'error',
    confidence: 0.85,
    match: { component: 'Input' },
    require: { propExists: 'label' },
    fixHint: 'Add a "label" prop that renders a <label> element, or accept "aria-label".',
    category: 'a11y',
  },
  {
    id: 'a11y/select-label',
    description: 'Select component should accept a "label" or "aria-label" prop for accessibility.',
    severity: 'error',
    confidence: 0.85,
    match: { component: 'Select' },
    require: { propExists: 'label' },
    fixHint: 'Add a "label" prop that renders a <label> element.',
    category: 'a11y',
  },
  {
    id: 'a11y/checkbox-label',
    description: 'Checkbox component should accept a "label" prop for accessibility.',
    severity: 'warning',
    confidence: 0.8,
    match: { component: 'Checkbox' },
    require: { propExists: 'label' },
    fixHint: 'Add a "label" prop that renders a <label> element associated with the checkbox.',
    category: 'a11y',
  },
  {
    id: 'structural/modal-onclose',
    description: 'Modal component should accept an "onOpenChange" callback for dismissal.',
    severity: 'warning',
    confidence: 0.8,
    match: { component: 'Modal' },
    require: { propExists: 'onOpenChange' },
    fixHint: 'Add an "onOpenChange" or "onClose" callback prop to handle dismissal (ESC key, backdrop click).',
    category: 'structural',
  },
  {
    id: 'structural/table-columns',
    description: 'Table component should accept a "columns" prop to define column structure.',
    severity: 'info',
    confidence: 0.7,
    match: { component: 'Table' },
    require: { propExists: 'columns' },
    fixHint: 'Accept a "columns" prop with column definitions (key, header, render).',
    category: 'structural',
  },
  {
    id: 'a11y/img-alt',
    description: 'Image/Media component should accept an "alt" prop for accessibility.',
    severity: 'error',
    confidence: 0.9,
    match: { component: 'Media' },
    require: { propExists: 'alt' },
    fixHint: 'Add an "alt" prop for image description. For decorative images, allow alt="".',
    category: 'a11y',
  },
  {
    id: 'structural/slider-range',
    description: 'Slider component should define min and max props for bounded input.',
    severity: 'warning',
    confidence: 0.8,
    match: { component: 'Slider' },
    require: { propExists: 'min' },
    fixHint: 'Add "min" and "max" props to define the allowed range.',
    category: 'structural',
  },
  {
    id: 'structural/progress-value',
    description: 'Progress component should accept a "value" prop to display progress.',
    severity: 'warning',
    confidence: 0.85,
    match: { component: 'Progress' },
    require: { propExists: 'value' },
    fixHint: 'Add a "value" prop (0-100) to indicate progress.',
    category: 'structural',
  },
];

// ---------------------------------------------------------------------------
// face.json v2 rules — validate behavior/platform contracts against source
// ---------------------------------------------------------------------------

export const v2BehaviorRules: Rule[] = [
  {
    id: 'v2/focus-trap-impl',
    description: 'Component declares focusTrap in face.json but source does not use useFocusTrap or <dialog>.',
    severity: 'error',
    confidence: 0.9,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'useFocusTrap|<dialog|showModal' },
    fixHint: 'Add useFocusTrap hook or use native <dialog> element for automatic focus trapping.',
    category: 'contract',
    tags: ['v2', 'behavior'],
  },
  {
    id: 'v2/scroll-lock-impl',
    description: 'Component declares scrollLock in face.json but source does not use useScrollLock or <dialog>.',
    severity: 'warning',
    confidence: 0.85,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'useScrollLock|<dialog|showModal' },
    fixHint: 'Add useScrollLock hook or use native <dialog> (which locks scroll automatically).',
    category: 'contract',
    tags: ['v2', 'behavior'],
  },
  {
    id: 'v2/dismiss-escape-impl',
    description: 'Component declares dismissOnEscape in face.json but source does not use useDismiss, <dialog>, or CloseWatcher.',
    severity: 'error',
    confidence: 0.9,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'useDismiss|onCancel|CloseWatcher|Escape' },
    fixHint: 'Add useDismiss hook or handle Escape via native <dialog> onCancel event.',
    category: 'contract',
    tags: ['v2', 'behavior'],
  },
  {
    id: 'v2/roving-focus-impl',
    description: 'Component declares rovingFocus in face.json but source does not use useRovingFocus.',
    severity: 'warning',
    confidence: 0.85,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'useRovingFocus|data-collection-item' },
    fixHint: 'Add useRovingFocus hook to the container element for keyboard navigation.',
    category: 'contract',
    tags: ['v2', 'behavior'],
  },
  {
    id: 'v2/drag-dismiss-impl',
    description: 'Component declares dragToDismiss in face.json but source does not handle touch events.',
    severity: 'warning',
    confidence: 0.8,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'onTouchStart|onTouchMove|onTouchEnd|touch' },
    fixHint: 'Add touch event handlers for drag-to-dismiss behavior.',
    category: 'contract',
    tags: ['v2', 'behavior'],
  },
];

export const v2PlatformRules: Rule[] = [
  {
    id: 'v2/platform-dialog',
    description: 'Component declares platform.dialog in face.json but source does not use <dialog> element.',
    severity: 'error',
    confidence: 0.95,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: '<dialog|showModal' },
    fixHint: 'Use native <dialog> element with showModal() for modal behavior.',
    category: 'contract',
    tags: ['v2', 'platform'],
  },
  {
    id: 'v2/platform-popover',
    description: 'Component declares platform.popover in face.json but source does not use [popover] attribute.',
    severity: 'warning',
    confidence: 0.8,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'popover|useFloating' },
    fixHint: 'Use popover attribute or useFloating hook for floating positioning.',
    category: 'contract',
    tags: ['v2', 'platform'],
  },
  {
    id: 'v2/platform-anchor',
    description: 'Component declares platform.anchorPositioning in face.json but source does not use CSS Anchor or useFloating.',
    severity: 'info',
    confidence: 0.75,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'useFloating|anchor-name|position-anchor|anchorPositioning' },
    fixHint: 'Use useFloating hook for CSS Anchor Positioning with JS fallback.',
    category: 'contract',
    tags: ['v2', 'platform'],
  },
];

export const v2AriaRules: Rule[] = [
  {
    id: 'v2/aria-role-dialog',
    description: 'Component declares aria.role="dialog" but source does not include role="dialog" or use <dialog>.',
    severity: 'warning',
    confidence: 0.85,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'role=.dialog|role=.alertdialog|<dialog' },
    fixHint: 'Add role="dialog" attribute or use native <dialog> element.',
    category: 'a11y',
    tags: ['v2', 'aria'],
  },
  {
    id: 'v2/aria-labelledby',
    description: 'Component declares aria.labelledBy but source does not include aria-labelledby.',
    severity: 'warning',
    confidence: 0.85,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'aria-labelledby|labelledby' },
    fixHint: 'Add aria-labelledby attribute referencing the title element ID.',
    category: 'a11y',
    tags: ['v2', 'aria'],
  },
  {
    id: 'v2/aria-modal',
    description: 'Component declares aria.modal but source does not include aria-modal or use <dialog showModal>.',
    severity: 'warning',
    confidence: 0.8,
    match: { component: '*', hasFaceJson: true },
    require: { codeContains: 'aria-modal|showModal' },
    fixHint: 'Add aria-modal="true" or use showModal() which sets it automatically.',
    category: 'a11y',
    tags: ['v2', 'aria'],
  },
];

// ---------------------------------------------------------------------------
// All built-in rules combined
// ---------------------------------------------------------------------------

export const builtinRules: Rule[] = [
  ...contractRules,
  ...structuralRules,
  ...v2BehaviorRules,
  ...v2PlatformRules,
  ...v2AriaRules,
];

/** Base policy pack shipped with the engine */
export const basePolicyPack = {
  name: 'base',
  version: '0.2.0',
  description: 'Built-in rules for contract validation, a11y basics, structural patterns, and face.json v2 behavior/platform/aria contracts.',
  rules: builtinRules,
};
