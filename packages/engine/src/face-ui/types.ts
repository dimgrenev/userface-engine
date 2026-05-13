export type FaceUiVersion = 'ui@1';

export type FaceJsonPrimitive = string | number | boolean | null;
export type FaceJsonValue = FaceJsonPrimitive | FaceJsonValue[] | { [key: string]: FaceJsonValue };

/**
 * Action reference inside JSON. Runtime converts it to a function.
 * Example:
 *   { "$action": "cart.add", "args": { "id": "x" } }
 */
export type FaceUiActionRef = {
  $action: string;
  args?: FaceJsonValue;
};

/**
 * Reference to external data (context). Host resolves via resolveRef().
 * Example:
 *   { "$ref": "user.id" }
 */
export type FaceUiRef = {
  $ref: string;
};

export type FaceUiValue = FaceJsonValue | FaceUiActionRef | FaceUiRef;

export type FaceUiChild = FaceUiNode | FaceJsonPrimitive;

export type FaceUiNode = {
  type: string;
  key?: string;
  props?: Record<string, FaceUiValue>;
  children?: FaceUiChild[];
};

export type FaceUiDoc = {
  version: FaceUiVersion;
  root: FaceUiNode;
  meta?: {
    name?: string;
    description?: string;
  };
  /** Local document state — values accessible via $ref: "state.key" */
  state?: Record<string, FaceJsonPrimitive>;
};

export type FaceUiRegistry = {
  /**
   * Resolve node.type to a concrete component.
   * For React renderer this must be a React component.
   */
  resolve(type: string): any | null;

  /**
   * Optional prop sanitation/whitelisting per component type.
   * Must be pure (no side effects).
   */
  sanitizeProps?: (type: string, props: Record<string, any>) => Record<string, any>;
};

export type FaceUiActionContext = {
  nodeType: string;
  propName: string;
};

export type FaceUiActions = {
  dispatch: (action: string, args: FaceJsonValue | undefined, ctx: FaceUiActionContext) => void;
  /**
   * Optional allowlist of permitted action ids.
   * If provided, any action not in this list will be ignored or throw an error during materialization/dispatch.
   */
  allowlist?: string[];
};

export type FaceUiRenderEnv = {
  registry: FaceUiRegistry;
  actions?: FaceUiActions;
  context?: any;
  resolveRef?: (ref: string, ctx: any) => any;
  /**
   * Node identity policy.
   * - `derived` (default): nodeId uses `key` when present, otherwise sibling index (`i0`, `i1`...), which can shift.
   * - `stable`: require `key` for every non-root node; otherwise materialization throws.
   */
  nodeIdPolicy?: 'derived' | 'stable';
  /**
   * Safety: max depth to prevent stack blowups from cyclic JSON or abuse.
   * Default: 64
   */
  maxDepth?: number;
};

/**
 * Materialized node representation used by editors/tooling and by canonical renderers.
 * NOTE: ids are derived-only (no explicit `id` field in ui@1 doc).
 */
export type MaterializedFaceUiNode = {
  nodeId: string;
  type: string;
  key?: string;
  rawProps: Record<string, FaceUiValue>;
  resolvedProps: Record<string, any>;
  /**
   * Children in original order. Nodes are materialized; primitives are preserved.
   * NOTE: nodeId sibling indices (`i0`, `i1`...) count only node-children, not primitives.
   */
  children: MaterializedFaceUiChild[];
  parentId: string;
  depth: number;
};

export type MaterializedFaceUiChild = MaterializedFaceUiNode | FaceJsonPrimitive;

export type MaterializedFaceUiTree = {
  doc: FaceUiDoc;
  root: MaterializedFaceUiNode;
  byId: Record<string, MaterializedFaceUiNode>;
};


