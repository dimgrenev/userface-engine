import { isJsonRecord, parseJsonRecord } from './json.js';

export type FaceJsonState = {
  name?: string;
  props?: Record<string, unknown>;
};

export type FaceJsonPropSchema = {
  controlType?: unknown;
  default?: unknown;
  defaultValue?: unknown;
  description?: unknown;
  max?: unknown;
  min?: unknown;
  options?: unknown[];
  required?: unknown;
  step?: unknown;
  type?: string;
  validation?: Record<string, unknown>;
};

export type FaceJsonControl = {
  name: string;
  controlType?: unknown;
  defaultValue?: unknown;
  description?: unknown;
  max?: unknown;
  min?: unknown;
  options?: unknown[];
  required: boolean;
  step?: unknown;
  type: string;
};

/** Project-owned executable usage, resolved relative to this Face file by the host. */
export type FaceJsonPreviewReference = {
  entryPath: string;
  exportName: string;
};

export class FaceJsonPreviewReferenceError extends Error {
  readonly code = 'UF_FACE_PREVIEW_REFERENCE_INVALID' as const;
  constructor(detail: string) {
    super(`Invalid Face preview reference: ${detail}`);
    this.name = 'FaceJsonPreviewReferenceError';
  }
}

/** Syntax only: the host must authorize the resolved file against its workspace. */
export function parseFaceJsonPreviewReference(value: unknown): FaceJsonPreviewReference {
  const record = readFaceJsonRecord(value);
  if (!record || Object.keys(record).some(key => key !== 'entryPath' && key !== 'exportName')) {
    throw new FaceJsonPreviewReferenceError('expected an object containing entryPath and exportName only.');
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'entryPath') || typeof record.entryPath !== 'string'
    || !Object.prototype.hasOwnProperty.call(record, 'exportName') || typeof record.exportName !== 'string') {
    throw new FaceJsonPreviewReferenceError('entryPath and exportName must be nonempty strings.');
  }
  const entryPath = record.entryPath.trim(), exportName = record.exportName.trim();
  if (!entryPath || !exportName || /[\u0000-\u001f\u007f]/.test(entryPath + exportName)) {
    throw new FaceJsonPreviewReferenceError('entryPath and exportName must be nonempty strings without control characters.');
  }
  if (entryPath.startsWith('/') || entryPath.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(entryPath)
    || /[?#]/.test(entryPath)) {
    throw new FaceJsonPreviewReferenceError('entryPath must be a relative file path using forward slashes, without a URL, query or fragment.');
  }
  return { entryPath, exportName };
}

export type FaceJsonContract = {
  name?: string;
  preview?: FaceJsonPreviewReference;
  currentState?: Record<string, unknown>;
  initialProps?: Record<string, unknown>;
  rootProps?: Record<string, unknown>;
  rootChildren?: unknown;
  states?: FaceJsonState[];
  props?: Record<string, FaceJsonPropSchema>;
  controls?: FaceJsonControl[];
};

export function readFaceJsonRecord(value: unknown): Record<string, unknown> | undefined {
  return isJsonRecord(value) ? value : undefined;
}

export function hasFaceJsonRecordEntries(
  value: Record<string, unknown> | undefined | null,
): value is Record<string, unknown> {
  return !!value && Object.keys(value).length > 0;
}

const FACE_STATE_METADATA_KEYS = new Set([
  'canvas',
  'canvasColor',
  'device',
  'frame',
  'height',
  'mode',
  'scale',
  'scroll',
  'scrollX',
  'scrollY',
  'selected',
  'selectedId',
  'selectedIds',
  'selection',
  'theme',
  'viewport',
  'width',
  'zoom',
]);

function omitFaceJsonStateMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (FACE_STATE_METADATA_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function normalizeFaceJsonStateProps(value: unknown, allowDirectProps: boolean): Record<string, unknown> | undefined {
  const state = readFaceJsonRecord(value);
  if (!state) return undefined;

  if (Object.prototype.hasOwnProperty.call(state, 'props')) {
    const nestedProps = readFaceJsonRecord(state.props);
    const siblingKeys = Object.keys(state).filter((key) => key !== 'props');
    const hasStateMetadata = siblingKeys.some((key) => FACE_STATE_METADATA_KEYS.has(key));
    if (
      nestedProps
      && hasFaceJsonRecordEntries(nestedProps)
      && (!allowDirectProps || siblingKeys.length === 0 || hasStateMetadata)
    ) {
      return nestedProps;
    }
    if (!allowDirectProps) return readFaceJsonRecord(state.props);
    if (nestedProps) {
      const flatState = { ...state };
      delete flatState.props;
      const metadataFreeFlatState = omitFaceJsonStateMetadata(flatState);
      const propsLikeState = hasFaceJsonRecordEntries(nestedProps)
        ? { ...metadataFreeFlatState, props: nestedProps }
        : metadataFreeFlatState;
      return hasFaceJsonRecordEntries(propsLikeState) ? propsLikeState : undefined;
    }
    return undefined;
  }

  if (!allowDirectProps) return undefined;
  const metadataFreeState = omitFaceJsonStateMetadata(state);
  return hasFaceJsonRecordEntries(metadataFreeState) ? metadataFreeState : undefined;
}

export function readFaceCurrentStateProps(value: unknown): Record<string, unknown> | undefined {
  return normalizeFaceJsonStateProps(value, true);
}

export function readFaceJsonState(value: unknown): FaceJsonState | undefined {
  const state = readFaceJsonRecord(value);
  if (!state) return undefined;
  return {
    name: typeof state.name === 'string' ? state.name : undefined,
    props: readFaceJsonRecord(state.props),
  };
}

function readFaceJsonObjectState(name: string, value: unknown): FaceJsonState | undefined {
  const props = normalizeFaceJsonStateProps(value, true);
  if (!hasFaceJsonRecordEntries(props)) return undefined;
  return { name, props };
}

export function readFaceJsonStates(value: unknown): FaceJsonState[] | undefined {
  if (Array.isArray(value)) {
    const states = value
      .map(readFaceJsonState)
      .filter((state): state is FaceJsonState => !!state);
    return states.length > 0 ? states : undefined;
  }

  const statesRecord = readFaceJsonRecord(value);
  if (!statesRecord) return undefined;
  const states = Object.entries(statesRecord)
    .map(([name, state]) => readFaceJsonObjectState(name, state))
    .filter((state): state is FaceJsonState => !!state);
  return states.length > 0 ? states : undefined;
}

export function readFaceJsonPropSchemaMap(value: unknown): Record<string, FaceJsonPropSchema> | undefined {
  const props = readFaceJsonRecord(value);
  if (!props) return undefined;

  const entries = Object.entries(props)
    .filter((entry): entry is [string, Record<string, unknown>] => isJsonRecord(entry[1]))
    .map(([key, schema]) => [
      key,
      {
        default: schema.default,
        defaultValue: schema.defaultValue,
        controlType: schema.controlType,
        description: schema.description,
        max: schema.max,
        min: schema.min,
        options: Array.isArray(schema.options) ? schema.options : undefined,
        required: schema.required,
        step: schema.step,
        type: typeof schema.type === 'string' ? schema.type : undefined,
        validation: readFaceJsonRecord(schema.validation),
      } satisfies FaceJsonPropSchema,
    ]);

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function readFaceJsonControlOptions(record: Record<string, unknown>): unknown[] | undefined {
  if (Array.isArray(record.options)) return record.options;
  const validation = readFaceJsonRecord(record.validation);
  return Array.isArray(validation?.enum) ? validation.enum : undefined;
}

export function readFaceJsonControls(value: unknown): FaceJsonControl[] | undefined {
  const controls = Array.isArray(value) ? value : [];
  const normalized: FaceJsonControl[] = [];
  for (const control of controls) {
    const record = readFaceJsonRecord(control);
    if (!record) continue;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!name) continue;

    const next: FaceJsonControl = {
      name,
      type: typeof record.type === 'string' && record.type.trim() ? record.type.trim().toLowerCase() : 'string',
      required: Boolean(record.required),
      defaultValue: Object.prototype.hasOwnProperty.call(record, 'defaultValue')
        ? record.defaultValue
        : record.default,
      options: readFaceJsonControlOptions(record),
      description: record.description,
      controlType: record.controlType,
      min: record.min,
      max: record.max,
      step: record.step,
    };
    normalized.push(next);
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function readFaceJsonPropsArrayControls(value: unknown): FaceJsonControl[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return readFaceJsonControls(value.map((prop) => {
    const record = readFaceJsonRecord(prop);
    return {
      name: record?.name,
      type: record?.type,
      default: record?.default,
      defaultValue: record?.defaultValue ?? record?.default,
      options: record?.options,
      required: record?.required,
      validation: record?.validation,
      description: record?.description,
      controlType: record?.controlType,
      min: record?.min,
      max: record?.max,
      step: record?.step,
    };
  }));
}

export function readFaceJsonTypedPropsControls(value: unknown): FaceJsonControl[] | undefined {
  const props = readFaceJsonRecord(value);
  if (!props) return undefined;
  const entries = Object.entries(props);
  if (!entries.some(([, definition]) => {
    const schema = readFaceJsonRecord(definition);
    return Boolean(schema?.type);
  })) {
    return undefined;
  }
  const controls = entries.map(([name, definition]) => {
    const schema = readFaceJsonRecord(definition);
    return {
      name,
      type: schema?.type ? String(schema.type) : undefined,
      defaultValue: schema?.default ?? schema?.defaultValue,
      options: Array.isArray(schema?.options) ? schema.options : undefined,
      required: schema?.required,
      validation: schema?.validation,
      description: schema?.description,
      controlType: schema?.controlType,
      min: schema?.min,
      max: schema?.max,
      step: schema?.step,
    };
  });
  return readFaceJsonControls(controls);
}

export function readFaceJsonSchemaPropsControls(value: unknown): FaceJsonControl[] | undefined {
  const schema = readFaceJsonRecord(value);
  const schemaProps = schema?.props;
  return readFaceJsonPropsArrayControls(schemaProps) || readFaceJsonTypedPropsControls(schemaProps);
}

export function readFaceJsonRootProps(value: unknown): Record<string, unknown> | undefined {
  const root = readFaceJsonRecord(value);
  return readFaceJsonRecord(root?.props);
}

function inferFaceJsonControlTypeFromValue(value: unknown): string {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  return 'string';
}

export function readFaceJsonCurrentStateControls(value: unknown): FaceJsonControl[] | undefined {
  const stateProps = readFaceCurrentStateProps(value);
  if (!hasFaceJsonRecordEntries(stateProps)) return undefined;
  return readFaceJsonControls(Object.entries(stateProps).map(([name, defaultValue]) => ({
    name,
    type: inferFaceJsonControlTypeFromValue(defaultValue),
    defaultValue,
  })));
}

function hasFaceJsonExpressionKey(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string' && String(record[key] || '').trim().length > 0;
}

function isFaceJsonExpressionRecord(value: unknown): value is Record<string, unknown> {
  const record = readFaceJsonRecord(value);
  return !!record && (
    hasFaceJsonExpressionKey(record, '$ref') ||
    hasFaceJsonExpressionKey(record, '$action')
  );
}

export function readFaceJsonRootPropsControls(value: unknown): FaceJsonControl[] | undefined {
  const rootProps = readFaceJsonRootProps(value);
  if (!hasFaceJsonRecordEntries(rootProps)) return undefined;
  return readFaceJsonControls(Object.entries(rootProps)
    .filter(([, defaultValue]) => !isFaceJsonExpressionRecord(defaultValue))
    .map(([name, defaultValue]) => ({
      name,
      type: inferFaceJsonControlTypeFromValue(defaultValue),
      defaultValue,
    })));
}

function mergeFaceJsonControls(...sources: Array<FaceJsonControl[] | undefined>): FaceJsonControl[] | undefined {
  const controls: FaceJsonControl[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const control of source || []) {
      const name = String(control?.name || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      controls.push(control);
    }
  }
  return controls.length > 0 ? controls : undefined;
}

function getFaceJsonArrayControlPreviewDefault(name: string): unknown[] {
  if (name === 'options') {
    return [
      { value: '1', label: 'Option 1' },
      { value: '2', label: 'Option 2' },
    ];
  }
  if (name === 'items') {
    return [
      { id: '1', value: '1', label: 'Item 1', title: 'Item 1', content: 'Content 1' },
      { id: '2', value: '2', label: 'Item 2', title: 'Item 2', content: 'Content 2' },
    ];
  }
  if (name === 'tabs') {
    return [
      { id: 'overview', value: 'overview', label: 'Overview', title: 'Overview', content: 'Overview content' },
      { id: 'details', value: 'details', label: 'Details', title: 'Details', content: 'Details content' },
    ];
  }
  if (name === 'columns') {
    return [
      { key: 'name', id: 'name', label: 'Name', title: 'Name', header: 'Name' },
      { key: 'status', id: 'status', label: 'Status', title: 'Status', header: 'Status' },
    ];
  }
  if (name === 'rows') {
    return [
      { id: '1', name: 'Alpha', status: 'Ready' },
      { id: '2', name: 'Beta', status: 'Draft' },
    ];
  }
  return [];
}

const FACE_JSON_PREVIEW_COLLECTION_CONTROLS = new Set([
  'columns',
  'items',
  'options',
  'rows',
  'tabs',
]);

export function pickFaceJsonControlDefault(control: FaceJsonControl, componentName?: string): unknown {
  if (control.defaultValue !== undefined) return control.defaultValue;

  const name = control.name.toLowerCase();
  const type = String(control.type || 'string').toLowerCase();
  if (name === 'label' || name === 'text' || name === 'title') return componentName || '';
  if (name === 'variant') return control.options?.[0] ?? 'primary';
  if (name === 'size') return control.options?.includes('medium') ? 'medium' : control.options?.[0] ?? 'medium';
  if (type === 'boolean') return false;
  if (type === 'number') return 0;
  if (type === 'array') return getFaceJsonArrayControlPreviewDefault(name);
  if (type === 'object') return {};
  return '';
}

export function applyFaceJsonSchemaDefaults(nextProps: Record<string, unknown>, face: FaceJsonContract): void {
  if (!face.props) return;
  for (const [key, definition] of Object.entries(face.props)) {
    if (nextProps[key] !== undefined) continue;
    const defaultValue = definition.default !== undefined ? definition.default : definition.defaultValue;
    if (defaultValue !== undefined) nextProps[key] = defaultValue;
  }
}

export function applyFaceJsonControlDefaults(nextProps: Record<string, unknown>, face: FaceJsonContract): void {
  for (const control of face.controls || []) {
    if (nextProps[control.name] !== undefined) continue;

    const name = control.name.toLowerCase();
    const type = String(control.type || 'string').toLowerCase();
    const hasExplicitDefault = control.defaultValue !== undefined;
    const needsPreviewSeed = control.required
      || (type === 'array' && FACE_JSON_PREVIEW_COLLECTION_CONTROLS.has(name));
    if (!hasExplicitDefault && !needsPreviewSeed) continue;

    nextProps[control.name] = pickFaceJsonControlDefault(control, face.name);
  }
}

export function readFaceJsonDefaultStateProps(face: FaceJsonContract): Record<string, unknown> | undefined {
  const states = face.states || [];
  const firstState =
    states.find((state) => String(state.name || '').trim().toLowerCase().includes('default') && hasFaceJsonRecordEntries(state.props)) ||
    states.find((state) => hasFaceJsonRecordEntries(state.props));
  return firstState?.props;
}

function readFaceJsonContextPath(context: Record<string, unknown>, path: string): unknown {
  const parts = String(path || '').split('.').map((part) => part.trim()).filter(Boolean);
  let cursor: unknown = context;
  for (const part of parts) {
    const record = readFaceJsonRecord(cursor);
    if (!record) return undefined;
    cursor = record[part];
  }
  return cursor;
}

function resolveFaceJsonValue(value: unknown, context: Record<string, unknown>): unknown {
  const record = readFaceJsonRecord(value);
  if (record && hasFaceJsonExpressionKey(record, '$ref')) {
    return readFaceJsonContextPath(context, String(record.$ref || ''));
  }
  if (record && hasFaceJsonExpressionKey(record, '$action')) {
    return { __ufMockFn: String(record.$action || 'action') };
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveFaceJsonValue(item, context));
  }
  if (record) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const resolved = resolveFaceJsonValue(item, context);
      if (resolved !== undefined) out[key] = resolved;
    }
    return out;
  }
  return value;
}

function isRenderableFaceJsonRootChild(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number';
}

function resolveFaceJsonRootChildren(value: unknown, context: Record<string, unknown>): unknown {
  const resolved = resolveFaceJsonValue(value, context);
  if (isRenderableFaceJsonRootChild(resolved)) return resolved;
  if (!Array.isArray(resolved)) return undefined;
  const children = resolved.filter(isRenderableFaceJsonRootChild);
  return children.length > 0 ? children : undefined;
}

export function applyFaceJsonRootProps(nextProps: Record<string, unknown>, face: FaceJsonContract): void {
  const context = { props: { ...nextProps } };
  for (const [key, value] of Object.entries(face.rootProps || {})) {
    const resolved = resolveFaceJsonValue(value, context);
    if (resolved !== undefined) nextProps[key] = resolved;
  }

  if (face.rootChildren !== undefined) {
    const children = resolveFaceJsonRootChildren(face.rootChildren, { props: { ...nextProps } });
    if (children !== undefined) nextProps.children = children;
  }
}

export function resolveFaceJsonPreviewProps(
  baseProps: Record<string, unknown>,
  face: FaceJsonContract,
): Record<string, unknown> {
  const nextProps = { ...baseProps };
  if (hasFaceJsonRecordEntries(face.initialProps)) Object.assign(nextProps, face.initialProps);
  const defaultStateProps = readFaceJsonDefaultStateProps(face);
  if (hasFaceJsonRecordEntries(defaultStateProps)) Object.assign(nextProps, defaultStateProps);
  if (hasFaceJsonRecordEntries(face.currentState)) Object.assign(nextProps, face.currentState);

  applyFaceJsonSchemaDefaults(nextProps, face);
  applyFaceJsonControlDefaults(nextProps, face);
  applyFaceJsonRootProps(nextProps, face);
  return nextProps;
}

export function isLikelyFaceJsonRecord(parsed: Record<string, unknown>): boolean {
  const schemaProps = readFaceJsonRecord(parsed.schema)?.props;
  const hasSchemaPropsContract = (Array.isArray(schemaProps) && schemaProps.length > 0)
    || !!readFaceJsonTypedPropsControls(schemaProps);
  const hasName = Boolean(parsed.name);
  if (hasName && Object.prototype.hasOwnProperty.call(parsed, 'preview')) return true;
  if (parsed.schema === 'face' && parsed['schema-version'] === 1 && parsed.root) return true;
  if (Array.isArray(parsed.controls)) return true;
  if (Array.isArray(parsed.props)) return true;
  if (hasSchemaPropsContract && hasName) return true;
  if (isJsonRecord(parsed.props) && hasName) return true;
  if ((Array.isArray(parsed.states) || isJsonRecord(parsed.states)) && hasName) return true;
  if (isJsonRecord(parsed.currentState)) return true;
  if (parsed.platform && parsed.currentState) return true;
  return false;
}

export function normalizeFaceJsonContract(parsed: Record<string, unknown>): FaceJsonContract | null {
  if (!isLikelyFaceJsonRecord(parsed)) return null;

  const preview = Object.prototype.hasOwnProperty.call(parsed, 'preview')
    ? parseFaceJsonPreviewReference(parsed.preview) : undefined;
  const currentState = readFaceCurrentStateProps(parsed.currentState);
  const initialProps = readFaceJsonRecord(parsed.initialProps);
  const root = readFaceJsonRecord(parsed.root);
  const rootProps = readFaceJsonRootProps(parsed.root);
  const hasRootChildren = !!root && Object.prototype.hasOwnProperty.call(root, 'children');
  const states = readFaceJsonStates(parsed.states);
  const props = readFaceJsonPropSchemaMap(parsed.props);
  const controls = mergeFaceJsonControls(
    readFaceJsonControls(parsed.controls),
    readFaceJsonPropsArrayControls(parsed.props),
    readFaceJsonTypedPropsControls(parsed.props),
    readFaceJsonSchemaPropsControls(parsed.schema),
    readFaceJsonRootPropsControls(parsed.root),
    readFaceJsonCurrentStateControls(parsed.currentState),
  );

  return {
    ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
    ...(preview ? { preview } : {}),
    ...(currentState ? { currentState } : {}),
    ...(initialProps ? { initialProps } : {}),
    ...(rootProps ? { rootProps } : {}),
    ...(hasRootChildren ? { rootChildren: root?.children } : {}),
    ...(states && states.length > 0 ? { states } : {}),
    ...(props ? { props } : {}),
    ...(controls ? { controls } : {}),
  };
}

export function decodeFaceJsonContract(source: string): FaceJsonContract | null {
  const parsed = parseJsonRecord(source);
  return parsed ? normalizeFaceJsonContract(parsed) : null;
}
