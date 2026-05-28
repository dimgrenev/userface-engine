import { createHash } from 'node:crypto';
import type { ValidationReport, Violation, Severity } from './rules/types';
import { USERFACE_PROOF_JSON_SCHEMA } from './proof-schema';

export const USERFACE_PROOF_SCHEMA = 'userface-proof@1';
export const USERFACE_PROOF_RENDERER_VERSION = 1;
export { USERFACE_PROOF_JSON_SCHEMA };

export type UserfaceProofStatus = 'blocked' | 'passed' | 'needs_input' | 'stale' | 'warning';
export type UserfaceProofCheckStatus = 'passed' | 'failed' | 'blocked' | 'stale' | 'not_run' | 'unavailable';
export type UserfaceProofFailOn = Severity;
export type UserfaceProofEgressMeasurement = 'zero_upload' | 'request_boundary' | 'unavailable';

export interface UserfaceProofCheck {
  status: UserfaceProofCheckStatus;
  score?: number;
  reason?: string;
  violations: Violation[];
}

export interface UserfaceProof {
  schema: typeof USERFACE_PROOF_SCHEMA;
  id: string;
  status: UserfaceProofStatus;
  createdAt: string;
  renderer: {
    name: 'userface-proof';
    version: number;
  };
  repo: {
    rootHash?: string;
    branch?: string;
    commit?: string;
  };
  target: {
    kind: 'readiness' | 'composition' | 'patch' | 'pr_gate' | 'trust';
    paths: string[];
  };
  components: {
    total: number;
    contracted: number;
    used: string[];
  };
  validation: UserfaceProofCheck;
  composition: UserfaceProofCheck;
  preview: {
    status: UserfaceProofCheckStatus;
    reason?: string;
    artifacts: string[];
  };
  patch: {
    changeSetId?: string;
    files: string[];
    additions: number;
    deletions: number;
  };
  agent: {
    status: 'not_run' | 'working' | 'repaired' | 'needs_input' | 'blocked';
    attempts: number;
    lastBlockingReason?: string;
  };
  egress: {
    mode: 'offline' | 'local' | 'cloud';
    measurement: UserfaceProofEgressMeasurement;
    reason?: string;
    providerId?: string;
    model?: string;
    requestPayloadHash?: string;
    modelCalls: number;
    estimatedInputTokens?: number;
    filesConsidered: number;
    filesSent: number;
    bytesSent: number;
    contextItems?: number;
    toolSchemaCount?: number;
    totalRequestBytes?: number;
    approvalCount?: number;
    dataClasses?: string[];
    absolutePathsSent: boolean;
    remoteTelemetry: boolean;
    network: boolean;
  };
  pr: {
    provider: 'github' | 'none';
    annotations: number;
    summaryPath?: string;
  };
  summaries: string[];
}

export interface UserfaceProofValidationResult {
  valid: boolean;
  errors: string[];
}

export interface CreateUserfaceProofInput {
  status?: UserfaceProofStatus;
  createdAt?: string;
  repo?: Partial<UserfaceProof['repo']> | null;
  target: UserfaceProof['target'];
  validation?: Partial<UserfaceProofCheck> | null;
  composition?: Partial<UserfaceProofCheck> | null;
  preview?: Partial<UserfaceProof['preview']> | null;
  patch?: Partial<UserfaceProof['patch']> | null;
  agent?: Partial<UserfaceProof['agent']> | null;
  egress?: Partial<UserfaceProof['egress']> | null;
  pr?: Partial<UserfaceProof['pr']> | null;
  components?: Partial<UserfaceProof['components']> | null;
  summaries?: string[];
}

const severityRank: Record<Severity, number> = {
  error: 3,
  warning: 2,
  info: 1,
};

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    output[key] = sortObject((value as Record<string, unknown>)[key]);
  }
  return output;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortObject(value));
}

function proofId(seed: unknown): string {
  return `ufp_${createHash('sha256').update(stableJson(seed)).digest('hex').slice(0, 20)}`;
}

function normalizeRepo(input: Partial<UserfaceProof['repo']> | null | undefined): UserfaceProof['repo'] {
  const repo: UserfaceProof['repo'] = {};
  const rootHash = String(input?.rootHash || '').trim();
  const branch = String(input?.branch || '').trim();
  const commit = String(input?.commit || '').trim();
  if (rootHash) repo.rootHash = rootHash;
  if (branch) repo.branch = branch;
  if (commit) repo.commit = commit;
  return repo;
}

function normalizeCheck(input: Partial<UserfaceProofCheck> | null | undefined): UserfaceProofCheck {
  const violations = Array.isArray(input?.violations) ? input.violations : [];
  const status = input?.status
    || (violations.some((violation) => violation.severity === 'error') ? 'failed' : violations.length ? 'blocked' : 'not_run');
  const reason = String(input?.reason || '').trim()
    || (status === 'not_run' ? 'This check was not run for this proof.' : '')
    || (status === 'unavailable' ? 'This check is unavailable for this proof.' : '');
  return {
    status,
    ...(typeof input?.score === 'number' && Number.isFinite(input.score) ? { score: input.score } : {}),
    ...(reason ? { reason } : {}),
    violations,
  };
}

function optionalCleanString(value: unknown): string | undefined {
  const clean = String(value || '').trim();
  return clean || undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isFinite(value) ? Math.max(0, Math.floor(Number(value))) : undefined;
}

function isEgressMeasurement(value: unknown): value is UserfaceProofEgressMeasurement {
  return value === 'zero_upload' || value === 'request_boundary' || value === 'unavailable';
}

function normalizeEgressMeasurement(
  input: Partial<UserfaceProof['egress']> | null | undefined,
  mode: UserfaceProof['egress']['mode'],
): UserfaceProofEgressMeasurement {
  if (isEgressMeasurement(input?.measurement)) return input.measurement;
  const modelCalls = Number(input?.modelCalls) || 0;
  const filesSent = Number(input?.filesSent) || 0;
  const bytesSent = Number(input?.bytesSent ?? input?.totalRequestBytes) || 0;
  if (mode === 'offline' && modelCalls === 0 && filesSent === 0 && bytesSent === 0 && input?.network !== true) {
    return 'zero_upload';
  }
  if (optionalCleanString(input?.requestPayloadHash) || modelCalls > 0 || bytesSent > 0) {
    return 'request_boundary';
  }
  return 'unavailable';
}

export function violationFailsThreshold(violation: Pick<Violation, 'severity'>, failOn: UserfaceProofFailOn): boolean {
  return severityRank[violation.severity] >= severityRank[failOn];
}

export function reportFailsThreshold(report: Pick<ValidationReport, 'violations'>, failOn: UserfaceProofFailOn): boolean {
  return report.violations.some((violation) => violationFailsThreshold(violation, failOn));
}

export function proofStatusFromViolations(
  violations: Array<Pick<Violation, 'severity'>>,
  failOn: UserfaceProofFailOn,
): UserfaceProofStatus {
  if (violations.some((violation) => violationFailsThreshold(violation, failOn))) return 'blocked';
  return violations.length > 0 ? 'warning' : 'passed';
}

function proofStatusFromEvidence(input: {
  validation: UserfaceProofCheck;
  composition: UserfaceProofCheck;
  preview: UserfaceProof['preview'];
  agent: UserfaceProof['agent'];
  failOn?: UserfaceProofFailOn;
}): UserfaceProofStatus {
  const checks = [input.validation.status, input.composition.status, input.preview.status];
  if (input.agent.status === 'blocked' || checks.some((status) => status === 'blocked' || status === 'failed')) {
    return 'blocked';
  }
  if (input.agent.status === 'needs_input') return 'needs_input';
  if (checks.some((status) => status === 'stale')) return 'stale';
  if (checks.some((status) => status === 'not_run' || status === 'unavailable')) return 'warning';
  return proofStatusFromViolations(
    [...input.validation.violations, ...input.composition.violations],
    input.failOn || 'error',
  );
}

export function checkFromValidationReport(
  report: ValidationReport | null | undefined,
  unavailableReason?: string,
): UserfaceProofCheck {
  if (!report) {
    return {
      status: unavailableReason ? 'unavailable' : 'not_run',
      ...(unavailableReason ? { reason: unavailableReason } : {}),
      violations: [],
    };
  }
  return {
    status: report.violations.length > 0 ? 'failed' : 'passed',
    score: report.scores.overall,
    reason: report.summary,
    violations: report.violations,
  };
}

export function createUserfaceProof(input: CreateUserfaceProofInput): UserfaceProof {
  const repo = normalizeRepo(input.repo);
  const validation = normalizeCheck(input.validation);
  const composition = normalizeCheck(input.composition);
  const preview = {
    status: input.preview?.status || 'not_run',
    ...(String(input.preview?.reason || '').trim()
      ? { reason: String(input.preview?.reason || '').trim() }
      : input.preview?.status === 'unavailable'
        ? { reason: 'Preview evidence is unavailable for this proof.' }
        : (input.preview?.status || 'not_run') === 'not_run'
          ? { reason: 'Preview evidence was not run for this proof.' }
          : {}),
    artifacts: Array.isArray(input.preview?.artifacts) ? input.preview.artifacts : [],
  };
  const patch = {
    ...(String(input.patch?.changeSetId || '').trim() ? { changeSetId: String(input.patch?.changeSetId || '').trim() } : {}),
    files: Array.isArray(input.patch?.files) ? input.patch.files : [],
    additions: Number.isFinite(input.patch?.additions) ? Math.max(0, Math.floor(Number(input.patch?.additions))) : 0,
    deletions: Number.isFinite(input.patch?.deletions) ? Math.max(0, Math.floor(Number(input.patch?.deletions))) : 0,
  };
  const agent = {
    status: input.agent?.status || 'not_run',
    attempts: Number.isFinite(input.agent?.attempts) ? Math.max(0, Math.floor(Number(input.agent?.attempts))) : 0,
    ...(String(input.agent?.lastBlockingReason || '').trim()
      ? { lastBlockingReason: String(input.agent?.lastBlockingReason || '').trim() }
      : {}),
  };
  const egressMode = input.egress?.mode || 'offline';
  const egressMeasurement = normalizeEgressMeasurement(input.egress, egressMode);
  const egressReason = optionalCleanString(input.egress?.reason)
    || (egressMeasurement === 'unavailable'
      ? 'Request-boundary egress evidence is unavailable for this proof.'
      : undefined);
  const egress = {
    mode: egressMode,
    measurement: egressMeasurement,
    ...(egressReason ? { reason: egressReason } : {}),
    ...(optionalCleanString(input.egress?.providerId) ? { providerId: optionalCleanString(input.egress?.providerId) } : {}),
    ...(optionalCleanString(input.egress?.model) ? { model: optionalCleanString(input.egress?.model) } : {}),
    ...(optionalCleanString(input.egress?.requestPayloadHash) ? { requestPayloadHash: optionalCleanString(input.egress?.requestPayloadHash) } : {}),
    modelCalls: Number.isFinite(input.egress?.modelCalls) ? Math.max(0, Math.floor(Number(input.egress?.modelCalls))) : 0,
    ...(optionalNonNegativeInteger(input.egress?.estimatedInputTokens) !== undefined ? { estimatedInputTokens: optionalNonNegativeInteger(input.egress?.estimatedInputTokens) } : {}),
    filesConsidered: Number.isFinite(input.egress?.filesConsidered) ? Math.max(0, Math.floor(Number(input.egress?.filesConsidered))) : 0,
    filesSent: Number.isFinite(input.egress?.filesSent) ? Math.max(0, Math.floor(Number(input.egress?.filesSent))) : 0,
    bytesSent: Number.isFinite(input.egress?.bytesSent) ? Math.max(0, Math.floor(Number(input.egress?.bytesSent))) : 0,
    ...(optionalNonNegativeInteger(input.egress?.contextItems) !== undefined ? { contextItems: optionalNonNegativeInteger(input.egress?.contextItems) } : {}),
    ...(optionalNonNegativeInteger(input.egress?.toolSchemaCount) !== undefined ? { toolSchemaCount: optionalNonNegativeInteger(input.egress?.toolSchemaCount) } : {}),
    ...(optionalNonNegativeInteger(input.egress?.totalRequestBytes) !== undefined ? { totalRequestBytes: optionalNonNegativeInteger(input.egress?.totalRequestBytes) } : {}),
    ...(optionalNonNegativeInteger(input.egress?.approvalCount) !== undefined ? { approvalCount: optionalNonNegativeInteger(input.egress?.approvalCount) } : {}),
    ...(Array.isArray(input.egress?.dataClasses) ? {
      dataClasses: [...new Set(input.egress.dataClasses.map(String).map((item) => item.trim()).filter(Boolean))].sort(),
    } : {}),
    absolutePathsSent: Boolean(input.egress?.absolutePathsSent),
    remoteTelemetry: Boolean(input.egress?.remoteTelemetry),
    network: Boolean(input.egress?.network),
  };
  const pr = {
    provider: input.pr?.provider || 'none',
    annotations: Number.isFinite(input.pr?.annotations) ? Math.max(0, Math.floor(Number(input.pr?.annotations))) : 0,
    ...(String(input.pr?.summaryPath || '').trim() ? { summaryPath: String(input.pr?.summaryPath || '').trim() } : {}),
  };
  const components = {
    total: Number.isFinite(input.components?.total) ? Math.max(0, Math.floor(Number(input.components?.total))) : 0,
    contracted: Number.isFinite(input.components?.contracted) ? Math.max(0, Math.floor(Number(input.components?.contracted))) : 0,
    used: Array.isArray(input.components?.used) ? [...new Set(input.components.used.map(String).filter(Boolean))] : [],
  };

  const seed = {
    repo,
    target: input.target,
    validation,
    composition,
    preview,
    patch,
    agent,
    egress,
    pr: {
      provider: pr.provider,
      annotations: pr.annotations,
    },
    components,
    summaries: input.summaries || [],
  };

  return {
    schema: USERFACE_PROOF_SCHEMA,
    id: proofId(seed),
    status: input.status || proofStatusFromEvidence({ validation, composition, preview, agent }),
    createdAt: input.createdAt || new Date().toISOString(),
    renderer: {
      name: 'userface-proof',
      version: USERFACE_PROOF_RENDERER_VERSION,
    },
    repo,
    target: {
      kind: input.target.kind,
      paths: [...new Set((input.target.paths || []).map(String).filter(Boolean))],
    },
    components,
    validation,
    composition,
    preview,
    patch,
    agent,
    egress,
    pr,
    summaries: input.summaries || [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'string' && String(value[key]).trim().length > 0;
}

function hasNumber(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === 'number' && Number.isFinite(value[key]);
}

function validateCheck(errors: string[], value: unknown, path: string) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (!isProofCheckStatus(value.status)) errors.push(`${path}.status must be a known proof check status`);
  if ((value.status === 'not_run' || value.status === 'unavailable') && !hasString(value, 'reason')) {
    errors.push(`${path}.reason must explain ${value.status}`);
  }
  if (!Array.isArray(value.violations)) errors.push(`${path}.violations must be an array`);
}

function isProofStatus(value: unknown): value is UserfaceProofStatus {
  return value === 'blocked' || value === 'passed' || value === 'needs_input' || value === 'stale' || value === 'warning';
}

function isProofCheckStatus(value: unknown): value is UserfaceProofCheckStatus {
  return value === 'passed'
    || value === 'failed'
    || value === 'blocked'
    || value === 'stale'
    || value === 'not_run'
    || value === 'unavailable';
}

function isTargetKind(value: unknown): value is UserfaceProof['target']['kind'] {
  return value === 'readiness' || value === 'composition' || value === 'patch' || value === 'pr_gate' || value === 'trust';
}

function isEgressMode(value: unknown): value is UserfaceProof['egress']['mode'] {
  return value === 'offline' || value === 'local' || value === 'cloud';
}

function isAgentStatus(value: unknown): value is UserfaceProof['agent']['status'] {
  return value === 'not_run' || value === 'working' || value === 'repaired' || value === 'needs_input' || value === 'blocked';
}

function isPrProvider(value: unknown): value is UserfaceProof['pr']['provider'] {
  return value === 'github' || value === 'none';
}

export function validateUserfaceProof(value: unknown): UserfaceProofValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { valid: false, errors: ['proof must be an object'] };
  }

  if (value.schema !== USERFACE_PROOF_SCHEMA) errors.push(`schema must be ${USERFACE_PROOF_SCHEMA}`);
  for (const key of ['id', 'createdAt']) {
    if (!hasString(value, key)) errors.push(`${key} must be a non-empty string`);
  }
  if (!isProofStatus(value.status)) errors.push('status must be a known proof status');

  if (!isRecord(value.renderer)) {
    errors.push('renderer must be an object');
  } else {
    if (value.renderer.name !== 'userface-proof') errors.push('renderer.name must be userface-proof');
    if (!hasNumber(value.renderer, 'version')) errors.push('renderer.version must be a number');
  }

  if (!isRecord(value.repo)) {
    errors.push('repo must be an object');
  } else if (!hasString(value.repo, 'rootHash')) {
    errors.push('repo.rootHash must be present so proof can be tied to a source fingerprint');
  }

  if (!isRecord(value.target)) {
    errors.push('target must be an object');
  } else {
    if (!isTargetKind(value.target.kind)) errors.push('target.kind must be a known target kind');
    if (!Array.isArray(value.target.paths)) errors.push('target.paths must be an array');
  }

  if (!isRecord(value.components)) {
    errors.push('components must be an object');
  } else {
    for (const key of ['total', 'contracted']) {
      if (!hasNumber(value.components, key)) errors.push(`components.${key} must be a number`);
    }
    if (!Array.isArray(value.components.used)) errors.push('components.used must be an array');
  }

  validateCheck(errors, value.validation, 'validation');
  validateCheck(errors, value.composition, 'composition');

  if (!isRecord(value.preview)) {
    errors.push('preview must be an object');
  } else {
    if (!isProofCheckStatus(value.preview.status)) errors.push('preview.status must be a known proof check status');
    if ((value.preview.status === 'not_run' || value.preview.status === 'unavailable') && !hasString(value.preview, 'reason')) {
      errors.push(`preview.reason must explain ${value.preview.status}`);
    }
    if (!Array.isArray(value.preview.artifacts)) errors.push('preview.artifacts must be an array');
  }

  if (!isRecord(value.patch)) {
    errors.push('patch must be an object');
  } else {
    for (const key of ['additions', 'deletions']) {
      if (!hasNumber(value.patch, key)) errors.push(`patch.${key} must be a number`);
    }
    if (!Array.isArray(value.patch.files)) errors.push('patch.files must be an array');
  }
  if (!isRecord(value.agent)) {
    errors.push('agent must be an object');
  } else {
    if (!isAgentStatus(value.agent.status)) errors.push('agent.status must be a known agent status');
    if (!hasNumber(value.agent, 'attempts')) errors.push('agent.attempts must be a number');
  }

  if (!isRecord(value.egress)) {
    errors.push('egress must be an object');
  } else {
    if (!isEgressMode(value.egress.mode)) errors.push('egress.mode must be offline, local or cloud');
    if (!isEgressMeasurement(value.egress.measurement)) errors.push('egress.measurement must be zero_upload, request_boundary or unavailable');
    if (value.egress.measurement === 'unavailable' && !hasString(value.egress, 'reason')) {
      errors.push('egress.reason must explain unavailable measurement');
    }
    for (const key of ['modelCalls', 'filesConsidered', 'filesSent', 'bytesSent']) {
      if (!hasNumber(value.egress, key)) errors.push(`egress.${key} must be a number`);
    }
    for (const key of ['estimatedInputTokens', 'contextItems', 'toolSchemaCount', 'totalRequestBytes', 'approvalCount']) {
      if (key in value.egress && !hasNumber(value.egress, key)) errors.push(`egress.${key} must be a number`);
    }
    for (const key of ['providerId', 'model', 'requestPayloadHash', 'reason']) {
      if (key in value.egress && !hasString(value.egress, key)) errors.push(`egress.${key} must be a non-empty string`);
    }
    if ('dataClasses' in value.egress) {
      if (!Array.isArray(value.egress.dataClasses)) {
        errors.push('egress.dataClasses must be an array');
      } else if (value.egress.dataClasses.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
        errors.push('egress.dataClasses must contain non-empty strings');
      }
    }
    for (const key of ['absolutePathsSent', 'remoteTelemetry', 'network']) {
      if (typeof value.egress[key] !== 'boolean') errors.push(`egress.${key} must be a boolean`);
    }
  }

  if (!isRecord(value.pr)) {
    errors.push('pr must be an object');
  } else {
    if (!isPrProvider(value.pr.provider)) errors.push('pr.provider must be github or none');
    if (!hasNumber(value.pr, 'annotations')) errors.push('pr.annotations must be a number');
  }
  if (!Array.isArray(value.summaries)) errors.push('summaries must be an array');

  return { valid: errors.length === 0, errors };
}

export function renderUserfaceProofMarkdown(proof: UserfaceProof): string {
  const formatCheckLine = (
    label: string,
    check: Pick<UserfaceProofCheck, 'status' | 'reason'>,
    suffix = '',
  ) => `${label}: ${check.status}${suffix}${check.reason ? ` - ${check.reason}` : ''}`;

  const lines = [
    `# Userface Proof ${proof.id}`,
    '',
    `Status: ${proof.status}`,
    `Target: ${proof.target.kind}`,
    `Paths: ${proof.target.paths.length ? proof.target.paths.join(', ') : 'none'}`,
    formatCheckLine('Validation', proof.validation),
    formatCheckLine('Composition', proof.composition),
    formatCheckLine('Preview', proof.preview, proof.preview.artifacts.length ? ` (${proof.preview.artifacts.length} artifact(s))` : ''),
    `Egress: ${proof.egress.mode}, ${proof.egress.measurement}, model calls ${proof.egress.modelCalls}, files sent ${proof.egress.filesSent}, bytes sent ${proof.egress.bytesSent}`,
    proof.egress.reason ? `Egress reason: ${proof.egress.reason}` : null,
    proof.egress.providerId || proof.egress.model
      ? `Provider: ${proof.egress.providerId || 'unknown'}${proof.egress.model ? ` / ${proof.egress.model}` : ''}`
      : null,
    typeof proof.egress.estimatedInputTokens === 'number'
      ? `Request: ${proof.egress.estimatedInputTokens} estimated input tokens, ${proof.egress.toolSchemaCount ?? 0} tool schema(s), ${proof.egress.totalRequestBytes ?? proof.egress.bytesSent} request bytes`
      : null,
    '',
  ].filter((line): line is string => line !== null);

  for (const summary of proof.summaries) {
    lines.push(`- ${summary}`);
  }

  if (proof.preview.artifacts.length > 0) {
    lines.push('', '## Preview Evidence');
    for (const artifact of proof.preview.artifacts) {
      lines.push(`- ${artifact}`);
    }
  }

  const violations = [...proof.validation.violations, ...proof.composition.violations];
  if (violations.length > 0) {
    lines.push('', '## Violations');
    for (const violation of violations.slice(0, 20)) {
      const where = violation.location?.component || violation.location?.file || 'composition';
      lines.push(`- [${violation.severity}] ${violation.ruleId} (${where}): ${violation.description}`);
      if (violation.fixHint) lines.push(`  Fix: ${violation.fixHint}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
