/**
 * Face JSON Diff — compares two face.json files and produces a list of changes
 * with severity classification (breaking / warning / info).
 *
 * Used for PR review, CI gates, and versioning of component contracts.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiffSeverity = 'breaking' | 'warning' | 'info';

export interface FaceDiffEntry {
  kind: 'added' | 'removed' | 'changed';
  path: string;
  severity: DiffSeverity;
  description: string;
  before?: any;
  after?: any;
}

export interface FaceDiffResult {
  component: string;
  entries: FaceDiffEntry[];
  hasBreaking: boolean;
  summary: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface NormalizedProp {
  name: string;
  type?: string;
  required?: boolean;
  options?: string[];
  defaultValue?: any;
}

function normalizeProps(face: any): NormalizedProp[] {
  if (Array.isArray(face.controls)) {
    return face.controls.map((c: any) => ({
      name: c.name,
      type: c.type,
      required: c.required ?? false,
      options: c.options,
      defaultValue: c.defaultValue,
    }));
  }
  if (face.props && typeof face.props === 'object' && !Array.isArray(face.props)) {
    return Object.entries(face.props).map(([name, def]: [string, any]) => ({
      name,
      type: def.type,
      required: def.required ?? false,
      options: def.options,
      defaultValue: def.default ?? def.defaultValue,
    }));
  }
  if (Array.isArray(face.props)) {
    return face.props.map((p: any) => ({
      name: p.name,
      type: p.type,
      required: p.required ?? false,
      options: p.options,
      defaultValue: p.defaultValue ?? p.default,
    }));
  }
  return [];
}

function arraysEqual(a?: any[], b?: any[]): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// ---------------------------------------------------------------------------
// Diff engine
// ---------------------------------------------------------------------------

export function diffFaces(oldFace: any, newFace: any): FaceDiffResult {
  const entries: FaceDiffEntry[] = [];
  const componentName = newFace?.name || oldFace?.name || 'unknown';

  const oldProps = normalizeProps(oldFace);
  const newProps = normalizeProps(newFace);

  const oldMap = new Map(oldProps.map(p => [p.name, p]));
  const newMap = new Map(newProps.map(p => [p.name, p]));

  // Removed props
  for (const [name, oldProp] of oldMap) {
    if (!newMap.has(name)) {
      const severity: DiffSeverity = oldProp.required ? 'breaking' : 'warning';
      entries.push({
        kind: 'removed',
        path: `props.${name}`,
        severity,
        description: `Prop "${name}" removed${oldProp.required ? ' (was required)' : ''}`,
        before: oldProp,
      });
    }
  }

  // Added props
  for (const [name, newProp] of newMap) {
    if (!oldMap.has(name)) {
      const severity: DiffSeverity = newProp.required ? 'warning' : 'info';
      entries.push({
        kind: 'added',
        path: `props.${name}`,
        severity,
        description: `Prop "${name}" added${newProp.required ? ' (required — may break existing consumers)' : ''}`,
        after: newProp,
      });
    }
  }

  // Changed props
  for (const [name, oldProp] of oldMap) {
    const newProp = newMap.get(name);
    if (!newProp) continue;

    // Type change
    if (oldProp.type !== newProp.type) {
      entries.push({
        kind: 'changed',
        path: `props.${name}.type`,
        severity: 'breaking',
        description: `Prop "${name}" type changed from "${oldProp.type}" to "${newProp.type}"`,
        before: oldProp.type,
        after: newProp.type,
      });
    }

    // Required change
    if (!oldProp.required && newProp.required) {
      entries.push({
        kind: 'changed',
        path: `props.${name}.required`,
        severity: 'breaking',
        description: `Prop "${name}" became required (was optional)`,
        before: false,
        after: true,
      });
    } else if (oldProp.required && !newProp.required) {
      entries.push({
        kind: 'changed',
        path: `props.${name}.required`,
        severity: 'info',
        description: `Prop "${name}" became optional (was required)`,
        before: true,
        after: false,
      });
    }

    // Options change (enum narrowing is breaking)
    if (!arraysEqual(oldProp.options, newProp.options)) {
      const oldOptions = oldProp.options || [];
      const newOptions = newProp.options || [];
      const removedOptions = oldOptions.filter((o: string) => !newOptions.includes(o));
      const addedOptions = newOptions.filter((o: string) => !oldOptions.includes(o));

      if (removedOptions.length > 0) {
        entries.push({
          kind: 'changed',
          path: `props.${name}.options`,
          severity: 'breaking',
          description: `Prop "${name}" lost options: ${removedOptions.join(', ')}`,
          before: oldOptions,
          after: newOptions,
        });
      } else if (addedOptions.length > 0) {
        entries.push({
          kind: 'changed',
          path: `props.${name}.options`,
          severity: 'info',
          description: `Prop "${name}" gained options: ${addedOptions.join(', ')}`,
          before: oldOptions,
          after: newOptions,
        });
      }
    }

    // Default value change
    if (String(oldProp.defaultValue) !== String(newProp.defaultValue) && oldProp.defaultValue !== newProp.defaultValue) {
      entries.push({
        kind: 'changed',
        path: `props.${name}.defaultValue`,
        severity: 'info',
        description: `Prop "${name}" default changed from "${oldProp.defaultValue}" to "${newProp.defaultValue}"`,
        before: oldProp.defaultValue,
        after: newProp.defaultValue,
      });
    }
  }

  // Top-level metadata changes
  if (oldFace?.name !== newFace?.name) {
    entries.push({
      kind: 'changed',
      path: 'name',
      severity: 'warning',
      description: `Component name changed from "${oldFace?.name}" to "${newFace?.name}"`,
      before: oldFace?.name,
      after: newFace?.name,
    });
  }

  // -------------------------------------------------------------------------
  // v2 section diffs: behavior, keyboard, aria, composition, platform
  // -------------------------------------------------------------------------

  // Behavior contract changes
  diffBooleanMap(entries, 'behavior', oldFace?.behavior, newFace?.behavior, {
    removedSeverity: 'breaking',
    addedSeverity: 'warning',
    changedSeverity: 'breaking',
  });

  // Keyboard shortcuts
  diffKeyboardMap(entries, oldFace?.keyboard, newFace?.keyboard);

  // ARIA contract
  diffAriaContract(entries, oldFace?.aria, newFace?.aria);

  // Composition contract
  diffComposition(entries, oldFace?.composition, newFace?.composition);

  // Platform usage
  diffBooleanMap(entries, 'platform', oldFace?.platform, newFace?.platform, {
    removedSeverity: 'warning',
    addedSeverity: 'info',
    changedSeverity: 'warning',
  });

  entries.sort((a, b) => {
    const sevOrder = { breaking: 0, warning: 1, info: 2 };
    return sevOrder[a.severity] - sevOrder[b.severity];
  });

  const hasBreaking = entries.some(e => e.severity === 'breaking');
  const breakingCount = entries.filter(e => e.severity === 'breaking').length;
  const warningCount = entries.filter(e => e.severity === 'warning').length;
  const infoCount = entries.filter(e => e.severity === 'info').length;

  let summary: string;
  if (entries.length === 0) {
    summary = `${componentName}: no changes`;
  } else {
    const parts = [];
    if (breakingCount) parts.push(`${breakingCount} breaking`);
    if (warningCount) parts.push(`${warningCount} warning(s)`);
    if (infoCount) parts.push(`${infoCount} info`);
    summary = `${componentName}: ${entries.length} change(s) — ${parts.join(', ')}`;
  }

  return { component: componentName, entries, hasBreaking, summary };
}

// ---------------------------------------------------------------------------
// v2 diff helpers
// ---------------------------------------------------------------------------

interface SeverityConfig {
  removedSeverity: DiffSeverity;
  addedSeverity: DiffSeverity;
  changedSeverity: DiffSeverity;
}

/** Diff a boolean/value map like behavior or platform */
function diffBooleanMap(
  entries: FaceDiffEntry[],
  section: string,
  oldMap: Record<string, any> | undefined,
  newMap: Record<string, any> | undefined,
  config: SeverityConfig,
): void {
  if (!oldMap && !newMap) return;
  const oldKeys = oldMap ? Object.keys(oldMap) : [];
  const newKeys = newMap ? Object.keys(newMap) : [];

  // Removed keys
  for (const key of oldKeys) {
    if (!newMap || !(key in newMap)) {
      entries.push({
        kind: 'removed',
        path: `${section}.${key}`,
        severity: config.removedSeverity,
        description: `${section}.${key} removed (was ${JSON.stringify(oldMap![key])})`,
        before: oldMap![key],
      });
    }
  }

  // Added keys
  for (const key of newKeys) {
    if (!oldMap || !(key in oldMap)) {
      entries.push({
        kind: 'added',
        path: `${section}.${key}`,
        severity: config.addedSeverity,
        description: `${section}.${key} added (${JSON.stringify(newMap![key])})`,
        after: newMap![key],
      });
    }
  }

  // Changed keys
  for (const key of oldKeys) {
    if (newMap && key in newMap) {
      const oldVal = oldMap![key];
      const newVal = newMap[key];
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        entries.push({
          kind: 'changed',
          path: `${section}.${key}`,
          severity: config.changedSeverity,
          description: `${section}.${key} changed from ${JSON.stringify(oldVal)} to ${JSON.stringify(newVal)}`,
          before: oldVal,
          after: newVal,
        });
      }
    }
  }
}

/** Diff keyboard shortcuts */
function diffKeyboardMap(
  entries: FaceDiffEntry[],
  oldKb: Record<string, any> | undefined,
  newKb: Record<string, any> | undefined,
): void {
  if (!oldKb && !newKb) return;
  const oldKeys = oldKb ? Object.keys(oldKb) : [];
  const newKeys = newKb ? Object.keys(newKb) : [];

  // Removed shortcuts — breaking (users rely on keyboard shortcuts)
  for (const key of oldKeys) {
    if (!newKb || !(key in newKb)) {
      entries.push({
        kind: 'removed',
        path: `keyboard.${key}`,
        severity: 'breaking',
        description: `Keyboard shortcut "${key}" removed (was: ${oldKb![key]?.action})`,
        before: oldKb![key],
      });
    }
  }

  // Added shortcuts — info
  for (const key of newKeys) {
    if (!oldKb || !(key in oldKb)) {
      entries.push({
        kind: 'added',
        path: `keyboard.${key}`,
        severity: 'info',
        description: `Keyboard shortcut "${key}" added (action: ${newKb![key]?.action})`,
        after: newKb![key],
      });
    }
  }

  // Changed shortcuts — warning
  for (const key of oldKeys) {
    if (newKb && key in newKb) {
      const oldAction = JSON.stringify(oldKb![key]);
      const newAction = JSON.stringify(newKb[key]);
      if (oldAction !== newAction) {
        entries.push({
          kind: 'changed',
          path: `keyboard.${key}`,
          severity: 'warning',
          description: `Keyboard shortcut "${key}" changed: ${oldKb![key]?.action} → ${newKb[key]?.action}`,
          before: oldKb![key],
          after: newKb[key],
        });
      }
    }
  }
}

/** Diff ARIA contract */
function diffAriaContract(
  entries: FaceDiffEntry[],
  oldAria: any | undefined,
  newAria: any | undefined,
): void {
  if (!oldAria && !newAria) return;

  // Role change — breaking
  if (oldAria?.role !== newAria?.role) {
    if (oldAria?.role && !newAria?.role) {
      entries.push({
        kind: 'removed',
        path: 'aria.role',
        severity: 'breaking',
        description: `ARIA role removed (was "${oldAria.role}")`,
        before: oldAria.role,
      });
    } else if (!oldAria?.role && newAria?.role) {
      entries.push({
        kind: 'added',
        path: 'aria.role',
        severity: 'info',
        description: `ARIA role added: "${newAria.role}"`,
        after: newAria.role,
      });
    } else {
      entries.push({
        kind: 'changed',
        path: 'aria.role',
        severity: 'breaking',
        description: `ARIA role changed from "${oldAria?.role}" to "${newAria?.role}"`,
        before: oldAria?.role,
        after: newAria?.role,
      });
    }
  }

  // Modal change — breaking
  if (oldAria?.modal !== newAria?.modal) {
    entries.push({
      kind: 'changed',
      path: 'aria.modal',
      severity: 'warning',
      description: `aria.modal changed from ${oldAria?.modal} to ${newAria?.modal}`,
      before: oldAria?.modal,
      after: newAria?.modal,
    });
  }

  // labelledBy / describedBy changes — info
  for (const key of ['labelledBy', 'describedBy'] as const) {
    const oldVal = oldAria?.[key];
    const newVal = newAria?.[key];
    if (oldVal !== newVal) {
      if (oldVal === undefined && newVal !== undefined) {
        entries.push({
          kind: 'added',
          path: `aria.${key}`,
          severity: 'info',
          description: `aria.${key} added: "${newVal}"`,
          after: newVal,
        });
      } else if (oldVal !== undefined && newVal === undefined) {
        entries.push({
          kind: 'removed',
          path: `aria.${key}`,
          severity: 'info',
          description: `aria.${key} removed (was "${oldVal}")`,
          before: oldVal,
        });
      } else {
        entries.push({
          kind: 'changed',
          path: `aria.${key}`,
          severity: 'info',
          description: `aria.${key} changed from "${oldVal}" to "${newVal}"`,
          before: oldVal,
          after: newVal,
        });
      }
    }
  }
}

/** Diff composition contract */
function diffComposition(
  entries: FaceDiffEntry[],
  oldComp: any | undefined,
  newComp: any | undefined,
): void {
  if (!oldComp && !newComp) return;

  // Required parts
  const oldRequired = new Set<string>(oldComp?.required || []);
  const newRequired = new Set<string>(newComp?.required || []);

  for (const part of newRequired) {
    if (!oldRequired.has(part)) {
      entries.push({
        kind: 'added',
        path: `composition.required`,
        severity: 'breaking',
        description: `Required composition part "${part}" added — existing consumers must include it`,
        after: part,
      });
    }
  }
  for (const part of oldRequired) {
    if (!newRequired.has(part)) {
      entries.push({
        kind: 'removed',
        path: `composition.required`,
        severity: 'info',
        description: `Required composition part "${part}" removed (now optional)`,
        before: part,
      });
    }
  }

  // Recommended parts — info only
  const oldRec = new Set<string>(oldComp?.recommended || []);
  const newRec = new Set<string>(newComp?.recommended || []);
  for (const part of newRec) {
    if (!oldRec.has(part)) {
      entries.push({
        kind: 'added',
        path: `composition.recommended`,
        severity: 'info',
        description: `Recommended composition part "${part}" added`,
        after: part,
      });
    }
  }

  // Parts added/removed
  const oldParts = new Set<string>(Object.keys(oldComp?.parts || {}));
  const newParts = new Set<string>(Object.keys(newComp?.parts || {}));

  for (const part of newParts) {
    if (!oldParts.has(part)) {
      entries.push({
        kind: 'added',
        path: `composition.parts.${part}`,
        severity: 'info',
        description: `Composition part "${part}" added`,
        after: newComp.parts[part],
      });
    }
  }
  for (const part of oldParts) {
    if (!newParts.has(part)) {
      entries.push({
        kind: 'removed',
        path: `composition.parts.${part}`,
        severity: 'warning',
        description: `Composition part "${part}" removed`,
        before: oldComp.parts[part],
      });
    }
  }
}
