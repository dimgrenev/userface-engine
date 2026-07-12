import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign as signPayload,
  verify as verifyPayload,
} from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';

export const USERFACE_MERGE_GATE_EVIDENCE_SCHEMA = 'mergeGateEvidence@1' as const;
export const USERFACE_MERGE_GATE_INTEGRITY_ALGORITHM = 'sha256' as const;
export const USERFACE_MERGE_GATE_DEFAULT_MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
export const USERFACE_MERGE_GATE_DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_REVISION_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BLOCKER_CODES = new Set([
  'validation_missing',
  'validation_not_passed',
  'validation_stale',
  'conflicts_present',
  'approvals_missing',
  'changes_requested',
  'rejected',
]);
const FILE_ACTIONS = new Set(['write', 'edit', 'delete', 'restore']);
const REVIEW_STATES = new Set(['pending', 'approved', 'changes_requested', 'rejected', 'superseded']);
const GATE_STATUSES = new Set(['advisory', 'pending', 'passed', 'blocked']);
const DECISIONS = new Set(['approved', 'changes_requested', 'rejected']);
const PRINCIPAL_KINDS = new Set(['agent', 'user', 'system', 'unknown']);
const ROLES = new Set(['viewer', 'contributor', 'maintainer', 'owner']);

export type UserfaceMergeGateFileAction = 'write' | 'edit' | 'delete' | 'restore';
export type UserfaceMergeGatePolicyMode = 'advisory' | 'required';
export type UserfaceMergeGateGateStatus = 'advisory' | 'pending' | 'passed' | 'blocked';
export type UserfaceMergeGateReviewState =
  | 'pending'
  | 'approved'
  | 'changes_requested'
  | 'rejected'
  | 'superseded';

export interface UserfaceMergeGateSubjectFile {
  path: string;
  action: UserfaceMergeGateFileAction;
  beforeHash: string | null;
  afterHash: string | null;
  additions: number | null;
  deletions: number | null;
}

export interface UserfaceMergeGateSubjectValidation {
  validationId: string | null;
  renderJobId: string | null;
  status: string | null;
  score: number | null;
  valid: boolean | null;
  passed: boolean | null;
  pendingFix: boolean;
  staleReason: string | null;
  violations: string[];
}

export interface UserfaceMergeGateSubjectValidationRun {
  validationRunId: string;
  checkKind: string;
  status: string;
  trigger: string;
  renderJobId: string | null;
  commandId: string | null;
  score: number | null;
  artifactCount: number;
  diagnosticCount: number;
  staleReason: string | null;
}

export interface UserfaceMergeGateSubjectConflict {
  path: string;
  reason: string;
  beforeHash: string | null;
  afterHash: string | null;
  currentHash: string | null;
}

export interface UserfaceMergeGateSubjectSurface {
  surface: string;
  status: string;
  affectedTargetIds: string[];
}

export interface UserfaceMergeGateSubject {
  changeSetId: string;
  files: UserfaceMergeGateSubjectFile[];
  validation: UserfaceMergeGateSubjectValidation | null;
  validationRuns: UserfaceMergeGateSubjectValidationRun[];
  conflicts: UserfaceMergeGateSubjectConflict[];
  surfaces: UserfaceMergeGateSubjectSurface[];
}

export interface UserfaceMergeGatePrincipal {
  principalId: string;
  kind: 'agent' | 'user' | 'system' | 'unknown';
  role?: 'viewer' | 'contributor' | 'maintainer' | 'owner';
}

export interface UserfaceMergeGateDecision {
  decisionId: string;
  decision: 'approved' | 'changes_requested' | 'rejected';
  subjectRevision: string;
  reviewer: UserfaceMergeGatePrincipal;
  policyHash: string;
  comment?: string;
  evidenceRefs: string[];
  decidedAt: number;
}

export interface UserfaceMergeGateBlocker {
  code: string;
  message: string;
  evidenceRefs: string[];
}

export interface UserfaceMergeGateReview {
  reviewId: string;
  changeSetId: string;
  subjectRevision: string;
  policy: {
    mode: UserfaceMergeGatePolicyMode;
    requiredApprovals: number;
    minimumReviewerRole: 'viewer' | 'contributor' | 'maintainer' | 'owner';
    allowRequesterApproval: boolean;
    requireSignedMergeGate: boolean;
    policyHash: string;
    source: 'default' | 'workspace_policy';
  };
  author: UserfaceMergeGatePrincipal;
  requestedBy?: UserfaceMergeGatePrincipal;
  state: UserfaceMergeGateReviewState;
  gateStatus: UserfaceMergeGateGateStatus;
  mergeEligible: boolean;
  approvalCount: number;
  requiredApprovals: number;
  blockers: UserfaceMergeGateBlocker[];
  decisions: UserfaceMergeGateDecision[];
}

export interface UserfaceMergeGateEvidencePayload {
  schemaVersion: typeof USERFACE_MERGE_GATE_EVIDENCE_SCHEMA;
  producer: {
    name: 'Userface';
    contractVersion: 1;
  };
  createdAt: number;
  subject: UserfaceMergeGateSubject;
  review: UserfaceMergeGateReview;
}

export interface UserfaceMergeGateEvidence extends UserfaceMergeGateEvidencePayload {
  integrity: {
    algorithm: typeof USERFACE_MERGE_GATE_INTEGRITY_ALGORITHM;
    digest: string;
  };
  attestation?: {
    schemaVersion: 'mergeGateAttestation@1';
    algorithm: 'ed25519';
    keyId: string;
    signature: string;
  };
}

export type UserfaceMergeGateVerificationIssueCode =
  | 'evidence_read_failed'
  | 'evidence_too_large'
  | 'evidence_invalid_json'
  | 'evidence_invalid_schema'
  | 'integrity_invalid'
  | 'integrity_mismatch'
  | 'signature_required'
  | 'signature_invalid'
  | 'signature_key_missing'
  | 'subject_revision_mismatch'
  | 'review_inconsistent'
  | 'gate_not_eligible'
  | 'path_invalid'
  | 'path_duplicate'
  | 'path_outside_root'
  | 'symlink_not_allowed'
  | 'file_missing'
  | 'file_unexpected'
  | 'file_not_regular'
  | 'file_too_large'
  | 'file_hash_missing'
  | 'file_hash_mismatch'
  | 'file_state_unavailable'
  | 'before_file_missing'
  | 'before_file_unexpected'
  | 'before_file_not_regular'
  | 'before_file_too_large'
  | 'before_file_hash_missing'
  | 'before_file_hash_mismatch'
  | 'before_file_state_unavailable';

export interface UserfaceMergeGateVerificationIssue {
  code: UserfaceMergeGateVerificationIssueCode;
  message: string;
  path?: string;
  evidenceRefs?: string[];
}

export interface UserfaceMergeGateVerificationResult {
  schemaVersion: 'mergeGateVerification@1';
  valid: boolean;
  mergeEligible: boolean;
  exitCode: 0 | 1;
  evidenceId: string | null;
  reviewId: string | null;
  changeSetId: string | null;
  subjectRevision: string | null;
  gateStatus: UserfaceMergeGateGateStatus | null;
  authenticity: 'unsigned' | 'verified' | 'unverified';
  checkedFileCount: number;
  issues: UserfaceMergeGateVerificationIssue[];
}

export interface VerifyUserfaceMergeGateEvidenceOptions {
  root: string;
  maxFileBytes?: number;
  requireSignature?: boolean;
  trustedPublicKey?: string | Buffer | KeyObject;
  trustedPublicKeys?: Record<string, string | Buffer | KeyObject>;
}

export type UserfaceMergeGateResolvedFileState =
  | { kind: 'missing' }
  | {
      kind: 'file';
      sizeBytes: number;
      sha256: string;
    }
  | {
      kind: 'symlink' | 'directory' | 'submodule' | 'other' | 'unreadable';
      sizeBytes?: number;
    };

export interface VerifyUserfaceMergeGateRemoteEvidenceOptions {
  headFileStates: Readonly<Record<string, UserfaceMergeGateResolvedFileState>>;
  baseFileStates?: Readonly<Record<string, UserfaceMergeGateResolvedFileState>>;
  requireBaseFileStates?: boolean;
  maxFileBytes?: number;
  requireSignature?: boolean;
  trustedPublicKey?: string | Buffer | KeyObject;
  trustedPublicKeys?: Record<string, string | Buffer | KeyObject>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON does not support non-finite numbers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('Canonical JSON supports only JSON values');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stableStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry || '').trim()).filter(Boolean))].sort();
}

function stableBy<T>(values: T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

export function normalizeUserfaceMergeGateSubject(input: UserfaceMergeGateSubject): UserfaceMergeGateSubject {
  const validation = input.validation
    ? {
        validationId: optionalString(input.validation.validationId),
        renderJobId: optionalString(input.validation.renderJobId),
        status: optionalString(input.validation.status),
        score: optionalNumber(input.validation.score),
        valid: optionalBoolean(input.validation.valid),
        passed: optionalBoolean(input.validation.passed),
        pendingFix: input.validation.pendingFix === true,
        staleReason: optionalString(input.validation.staleReason),
        violations: stableStringArray(input.validation.violations),
      }
    : null;
  return {
    changeSetId: String(input.changeSetId || '').trim(),
    files: stableBy(Array.isArray(input.files) ? input.files : [], (file) => `${file.path}:${file.action}`).map((file) => ({
      path: String(file.path || '').trim(),
      action: file.action,
      beforeHash: optionalString(file.beforeHash),
      afterHash: optionalString(file.afterHash),
      additions: optionalNumber(file.additions),
      deletions: optionalNumber(file.deletions),
    })),
    validation,
    validationRuns: stableBy(
      Array.isArray(input.validationRuns) ? input.validationRuns : [],
      (run) => run.validationRunId,
    ).map((run) => ({
      validationRunId: String(run.validationRunId || '').trim(),
      checkKind: String(run.checkKind || '').trim(),
      status: String(run.status || '').trim(),
      trigger: String(run.trigger || '').trim(),
      renderJobId: optionalString(run.renderJobId),
      commandId: optionalString(run.commandId),
      score: optionalNumber(run.score),
      artifactCount: Number.isInteger(run.artifactCount) && run.artifactCount >= 0 ? run.artifactCount : 0,
      diagnosticCount: Number.isInteger(run.diagnosticCount) && run.diagnosticCount >= 0 ? run.diagnosticCount : 0,
      staleReason: optionalString(run.staleReason),
    })),
    conflicts: stableBy(Array.isArray(input.conflicts) ? input.conflicts : [], (conflict) => conflict.path).map((conflict) => ({
      path: String(conflict.path || '').trim(),
      reason: String(conflict.reason || '').trim(),
      beforeHash: optionalString(conflict.beforeHash),
      afterHash: optionalString(conflict.afterHash),
      currentHash: optionalString(conflict.currentHash),
    })),
    surfaces: stableBy(
      Array.isArray(input.surfaces) ? input.surfaces : [],
      (surface) => `${surface.surface}:${surface.status}`,
    ).map((surface) => ({
      surface: String(surface.surface || '').trim(),
      status: String(surface.status || '').trim(),
      affectedTargetIds: stableStringArray(surface.affectedTargetIds),
    })),
  };
}

export function computeUserfaceMergeGateSubjectRevision(input: UserfaceMergeGateSubject): string {
  return `sha256:${sha256(JSON.stringify(normalizeUserfaceMergeGateSubject(input)))}`;
}

function evidencePayload(value: UserfaceMergeGateEvidencePayload): UserfaceMergeGateEvidencePayload {
  return {
    schemaVersion: USERFACE_MERGE_GATE_EVIDENCE_SCHEMA,
    producer: {
      name: 'Userface',
      contractVersion: 1,
    },
    createdAt: value.createdAt,
    subject: normalizeUserfaceMergeGateSubject(value.subject),
    review: value.review,
  };
}

export function computeUserfaceMergeGateEvidenceDigest(value: UserfaceMergeGateEvidencePayload): string {
  return `sha256:${sha256(canonicalJson(evidencePayload(value)))}`;
}

export function createUserfaceMergeGateEvidence(
  value: UserfaceMergeGateEvidencePayload,
): UserfaceMergeGateEvidence {
  const payload = evidencePayload(value);
  const structuralIssues = validateEvidencePayload(payload);
  if (structuralIssues.length > 0) {
    throw new Error(`Invalid Userface merge gate evidence: ${structuralIssues.map((issue) => issue.message).join('; ')}`);
  }
  return {
    ...payload,
    integrity: {
      algorithm: USERFACE_MERGE_GATE_INTEGRITY_ALGORITHM,
      digest: computeUserfaceMergeGateEvidenceDigest(payload),
    },
  };
}

function asPublicKey(value: string | Buffer | KeyObject): KeyObject {
  const key = value instanceof KeyObject ? value : createPublicKey(value);
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Userface merge gate requires an Ed25519 public key');
  }
  return key;
}

function asPrivateKey(value: string | Buffer | KeyObject): KeyObject {
  const key = value instanceof KeyObject ? value : createPrivateKey(value);
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Userface merge gate requires an Ed25519 private key');
  }
  return key;
}

export function deriveUserfaceMergeGateKeyId(value: string | Buffer | KeyObject): string {
  const publicKey = value instanceof KeyObject && value.type === 'private'
    ? createPublicKey(value)
    : asPublicKey(value);
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return `ed25519:${sha256(der).slice(0, 24)}`;
}

export function signUserfaceMergeGateEvidence(
  evidence: UserfaceMergeGateEvidence,
  privateKeyInput: string | Buffer | KeyObject,
  keyId?: string,
): UserfaceMergeGateEvidence {
  const expectedDigest = computeUserfaceMergeGateEvidenceDigest(evidence);
  if (evidence.integrity.algorithm !== USERFACE_MERGE_GATE_INTEGRITY_ALGORITHM
    || evidence.integrity.digest !== expectedDigest) {
    throw new Error('Cannot sign merge gate evidence with invalid integrity');
  }
  const privateKey = asPrivateKey(privateKeyInput);
  const resolvedKeyId = String(keyId || deriveUserfaceMergeGateKeyId(privateKey)).trim();
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(resolvedKeyId)) {
    throw new Error('Merge gate attestation keyId is invalid');
  }
  const signature = signPayload(
    null,
    Buffer.from(evidence.integrity.digest, 'utf8'),
    privateKey,
  ).toString('base64url');
  return {
    ...evidence,
    attestation: {
      schemaVersion: 'mergeGateAttestation@1',
      algorithm: 'ed25519',
      keyId: resolvedKeyId,
      signature,
    },
  };
}

function issue(
  code: UserfaceMergeGateVerificationIssueCode,
  message: string,
  path?: string,
  evidenceRefs?: string[],
): UserfaceMergeGateVerificationIssue {
  return {
    code,
    message,
    ...(path ? { path } : {}),
    ...(evidenceRefs && evidenceRefs.length > 0 ? { evidenceRefs } : {}),
  };
}

function validPrincipal(value: unknown): value is UserfaceMergeGatePrincipal {
  if (!isRecord(value)) return false;
  const principalId = optionalString(value.principalId);
  return Boolean(principalId)
    && principalId!.length <= 200
    && PRINCIPAL_KINDS.has(String(value.kind || ''))
    && (value.role === undefined || ROLES.has(String(value.role || '')));
}

function validDecision(value: unknown): value is UserfaceMergeGateDecision {
  if (!isRecord(value) || !validPrincipal(value.reviewer)) return false;
  return Boolean(optionalString(value.decisionId))
    && DECISIONS.has(String(value.decision || ''))
    && SHA256_REVISION_PATTERN.test(String(value.subjectRevision || ''))
    && SHA256_HEX_PATTERN.test(String(value.policyHash || ''))
    && Number.isFinite(value.decidedAt)
    && Number(value.decidedAt) > 0
    && Array.isArray(value.evidenceRefs);
}

function validSubjectFile(value: unknown): value is UserfaceMergeGateSubjectFile {
  if (!isRecord(value)) return false;
  return typeof value.path === 'string'
    && FILE_ACTIONS.has(String(value.action || ''))
    && (value.beforeHash === null || typeof value.beforeHash === 'string')
    && (value.afterHash === null || typeof value.afterHash === 'string')
    && (value.additions === null || (Number.isInteger(value.additions) && Number(value.additions) >= 0))
    && (value.deletions === null || (Number.isInteger(value.deletions) && Number(value.deletions) >= 0));
}

function validSubjectValidation(value: unknown): value is UserfaceMergeGateSubjectValidation | null {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return (value.validationId === null || typeof value.validationId === 'string')
    && (value.renderJobId === null || typeof value.renderJobId === 'string')
    && (value.status === null || typeof value.status === 'string')
    && (value.score === null || (typeof value.score === 'number' && Number.isFinite(value.score)))
    && (value.valid === null || typeof value.valid === 'boolean')
    && (value.passed === null || typeof value.passed === 'boolean')
    && typeof value.pendingFix === 'boolean'
    && (value.staleReason === null || typeof value.staleReason === 'string')
    && Array.isArray(value.violations)
    && value.violations.every((entry) => typeof entry === 'string');
}

function validSubjectRun(value: unknown): value is UserfaceMergeGateSubjectValidationRun {
  if (!isRecord(value)) return false;
  return Boolean(optionalString(value.validationRunId))
    && Boolean(optionalString(value.checkKind))
    && Boolean(optionalString(value.status))
    && Boolean(optionalString(value.trigger))
    && (value.renderJobId === null || typeof value.renderJobId === 'string')
    && (value.commandId === null || typeof value.commandId === 'string')
    && (value.score === null || (typeof value.score === 'number' && Number.isFinite(value.score)))
    && Number.isInteger(value.artifactCount)
    && Number(value.artifactCount) >= 0
    && Number.isInteger(value.diagnosticCount)
    && Number(value.diagnosticCount) >= 0
    && (value.staleReason === null || typeof value.staleReason === 'string');
}

function validSubjectConflict(value: unknown): value is UserfaceMergeGateSubjectConflict {
  if (!isRecord(value)) return false;
  return Boolean(optionalString(value.path))
    && Boolean(optionalString(value.reason))
    && (value.beforeHash === null || typeof value.beforeHash === 'string')
    && (value.afterHash === null || typeof value.afterHash === 'string')
    && (value.currentHash === null || typeof value.currentHash === 'string');
}

function validSubjectSurface(value: unknown): value is UserfaceMergeGateSubjectSurface {
  if (!isRecord(value)) return false;
  return Boolean(optionalString(value.surface))
    && Boolean(optionalString(value.status))
    && Array.isArray(value.affectedTargetIds)
    && value.affectedTargetIds.every((entry) => typeof entry === 'string');
}

function validateEvidencePayload(value: unknown): UserfaceMergeGateVerificationIssue[] {
  const issues: UserfaceMergeGateVerificationIssue[] = [];
  if (!isRecord(value) || value.schemaVersion !== USERFACE_MERGE_GATE_EVIDENCE_SCHEMA) {
    return [issue('evidence_invalid_schema', `Expected ${USERFACE_MERGE_GATE_EVIDENCE_SCHEMA}`)];
  }
  if (!isRecord(value.producer) || value.producer.name !== 'Userface' || value.producer.contractVersion !== 1) {
    issues.push(issue('evidence_invalid_schema', 'Invalid merge gate producer contract'));
  }
  if (!Number.isFinite(value.createdAt) || Number(value.createdAt) <= 0) {
    issues.push(issue('evidence_invalid_schema', 'createdAt must be a positive timestamp'));
  }
  if (!isRecord(value.subject) || !optionalString(value.subject.changeSetId)) {
    issues.push(issue('evidence_invalid_schema', 'Merge gate subject requires changeSetId'));
  }
  if (!isRecord(value.review)) {
    issues.push(issue('evidence_invalid_schema', 'Merge gate evidence requires review'));
    return issues;
  }
  const review = value.review;
  if (!optionalString(review.reviewId) || !optionalString(review.changeSetId)) {
    issues.push(issue('evidence_invalid_schema', 'Review requires reviewId and changeSetId'));
  }
  if (!SHA256_REVISION_PATTERN.test(String(review.subjectRevision || ''))) {
    issues.push(issue('evidence_invalid_schema', 'Review subjectRevision must be sha256'));
  }
  if (!isRecord(review.policy)
    || (review.policy.mode !== 'advisory' && review.policy.mode !== 'required')
    || !Number.isInteger(review.policy.requiredApprovals)
    || Number(review.policy.requiredApprovals) < 0
    || Number(review.policy.requiredApprovals) > 5
    || !ROLES.has(String(review.policy.minimumReviewerRole || ''))
    || typeof review.policy.allowRequesterApproval !== 'boolean'
    || typeof review.policy.requireSignedMergeGate !== 'boolean'
    || !SHA256_HEX_PATTERN.test(String(review.policy.policyHash || ''))
    || (review.policy.source !== 'default' && review.policy.source !== 'workspace_policy')) {
    issues.push(issue('evidence_invalid_schema', 'Invalid review policy snapshot'));
  }
  if (!validPrincipal(review.author) || (review.requestedBy !== undefined && !validPrincipal(review.requestedBy))) {
    issues.push(issue('evidence_invalid_schema', 'Invalid review principal'));
  }
  if (!REVIEW_STATES.has(String(review.state || ''))
    || !GATE_STATUSES.has(String(review.gateStatus || ''))
    || typeof review.mergeEligible !== 'boolean'
    || !Number.isInteger(review.approvalCount)
    || !Number.isInteger(review.requiredApprovals)
    || !Array.isArray(review.blockers)
    || !Array.isArray(review.decisions)) {
    issues.push(issue('evidence_invalid_schema', 'Invalid review state contract'));
  }
  if (Array.isArray(review.blockers)) {
    for (const blocker of review.blockers) {
      if (!isRecord(blocker)
        || !BLOCKER_CODES.has(String(blocker.code || ''))
        || !optionalString(blocker.message)
        || !Array.isArray(blocker.evidenceRefs)) {
        issues.push(issue('evidence_invalid_schema', 'Invalid review blocker contract'));
        break;
      }
    }
  }
  if (Array.isArray(review.decisions) && !review.decisions.every(validDecision)) {
    issues.push(issue('evidence_invalid_schema', 'Invalid review decision contract'));
  }
  if (isRecord(value.subject)) {
    if (!Array.isArray(value.subject.files)
      || !Array.isArray(value.subject.validationRuns)
      || !Array.isArray(value.subject.conflicts)
      || !Array.isArray(value.subject.surfaces)) {
      issues.push(issue('evidence_invalid_schema', 'Invalid merge gate subject collections'));
    } else if (value.subject.files.length === 0
      || !value.subject.files.every(validSubjectFile)
      || !validSubjectValidation(value.subject.validation)
      || !value.subject.validationRuns.every(validSubjectRun)
      || !value.subject.conflicts.every(validSubjectConflict)
      || !value.subject.surfaces.every(validSubjectSurface)) {
      issues.push(issue('evidence_invalid_schema', 'Invalid merge gate subject evidence'));
    }
  }
  return issues;
}

function validateReviewConsistency(evidence: UserfaceMergeGateEvidence): UserfaceMergeGateVerificationIssue[] {
  const issues: UserfaceMergeGateVerificationIssue[] = [];
  const { review, subject } = evidence;
  if (review.changeSetId !== subject.changeSetId) {
    issues.push(issue('review_inconsistent', 'Review and subject use different ChangeSet ids'));
  }
  const currentDecisions = review.decisions.filter((decision) => (
    decision.subjectRevision === review.subjectRevision
    && decision.policyHash === review.policy.policyHash
  ));
  const latestByReviewer = new Map<string, UserfaceMergeGateDecision>();
  for (const decision of [...currentDecisions].sort((left, right) => (
    left.decidedAt - right.decidedAt || left.decisionId.localeCompare(right.decisionId)
  ))) {
    latestByReviewer.set(decision.reviewer.principalId, decision);
  }
  const effectiveDecisions = [...latestByReviewer.values()];
  const approvals = effectiveDecisions.filter((decision) => decision.decision === 'approved');
  const changesRequested = effectiveDecisions.filter((decision) => decision.decision === 'changes_requested');
  const rejected = effectiveDecisions.filter((decision) => decision.decision === 'rejected');
  if (review.approvalCount !== approvals.length) {
    issues.push(issue('review_inconsistent', `Review claims ${review.approvalCount} approvals but ${approvals.length} are effective`));
  }
  if (review.requiredApprovals !== review.policy.requiredApprovals) {
    issues.push(issue('review_inconsistent', 'Review requiredApprovals does not match its policy'));
  }

  const validation = subject.validation;
  const validationPassed = Boolean(validation)
    && validation!.passed === true
    && validation!.valid === true
    && validation!.pendingFix !== true
    && (validation!.status === null || validation!.status === 'passed')
    && !validation!.staleReason;
  const hasSafetyBlocker = review.blockers.some((blocker) => (
    blocker.code === 'validation_missing'
    || blocker.code === 'validation_not_passed'
    || blocker.code === 'validation_stale'
    || blocker.code === 'conflicts_present'
  ));
  const deterministicSafetyPassed = validationPassed
    && subject.conflicts.length === 0
    && !hasSafetyBlocker;
  const approvalsSatisfied = review.policy.mode === 'advisory'
    || approvals.length >= review.policy.requiredApprovals;
  const expectedEligible = deterministicSafetyPassed
    && rejected.length === 0
    && changesRequested.length === 0
    && approvalsSatisfied
    && review.blockers.length === 0;
  if (review.mergeEligible !== expectedEligible) {
    issues.push(issue('review_inconsistent', 'mergeEligible is inconsistent with validation, conflicts, decisions, policy, or blockers'));
  }
  const expectedGateStatus: UserfaceMergeGateGateStatus = review.policy.mode === 'advisory'
    ? !deterministicSafetyPassed || rejected.length > 0 || changesRequested.length > 0
      ? 'blocked'
      : review.state === 'approved'
        ? 'passed'
        : 'advisory'
    : expectedEligible
      ? 'passed'
      : hasSafetyBlocker || rejected.length > 0 || changesRequested.length > 0
        ? 'blocked'
        : 'pending';
  if (review.gateStatus !== expectedGateStatus) {
    issues.push(issue('review_inconsistent', `gateStatus ${review.gateStatus} should be ${expectedGateStatus}`));
  }
  return issues;
}

function isPortableWorkspacePath(path: string): boolean {
  if (!path
    || path.length > 1_024
    || path.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(path)) return false;
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..');
}

function pathInsideRoot(root: string, target: string): boolean {
  const delta = relative(root, target);
  return delta === '' || (!delta.startsWith(`..${sep}`) && delta !== '..' && !isAbsolute(delta));
}

function findSymlink(root: string, portablePath: string): string | null {
  let cursor = root;
  for (const segment of portablePath.split('/')) {
    cursor = resolve(cursor, segment);
    if (!existsSync(cursor)) return null;
    try {
      if (lstatSync(cursor).isSymbolicLink()) return cursor;
    } catch {
      return null;
    }
  }
  return null;
}

function verifySubjectFiles(
  subject: UserfaceMergeGateSubject,
  options: VerifyUserfaceMergeGateEvidenceOptions,
): { issues: UserfaceMergeGateVerificationIssue[]; checkedFileCount: number } {
  const issues: UserfaceMergeGateVerificationIssue[] = [];
  const root = resolve(String(options.root || '').trim());
  const maxFileBytes = Number.isFinite(options.maxFileBytes)
    ? Math.max(1, Number(options.maxFileBytes))
    : USERFACE_MERGE_GATE_DEFAULT_MAX_FILE_BYTES;
  let canonicalRoot = root;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    issues.push(issue('path_outside_root', 'Workspace root does not exist or cannot be resolved'));
    return { issues, checkedFileCount: 0 };
  }
  const seen = new Set<string>();
  let checkedFileCount = 0;
  for (const file of subject.files) {
    const portablePath = String(file.path || '').trim();
    if (!isPortableWorkspacePath(portablePath) || !FILE_ACTIONS.has(file.action)) {
      issues.push(issue('path_invalid', `Invalid portable workspace path: ${portablePath || '<empty>'}`, portablePath || undefined));
      continue;
    }
    if (seen.has(portablePath)) {
      issues.push(issue('path_duplicate', `Duplicate merge gate path: ${portablePath}`, portablePath));
      continue;
    }
    seen.add(portablePath);
    const target = resolve(canonicalRoot, ...portablePath.split('/'));
    if (!pathInsideRoot(canonicalRoot, target)) {
      issues.push(issue('path_outside_root', `Path escapes workspace root: ${portablePath}`, portablePath));
      continue;
    }
    const symlink = findSymlink(canonicalRoot, portablePath);
    if (symlink) {
      issues.push(issue('symlink_not_allowed', `Symlinks are not allowed in merge gate paths: ${portablePath}`, portablePath));
      continue;
    }
    checkedFileCount += 1;
    if (file.action === 'delete') {
      if (existsSync(target)) {
        issues.push(issue('file_unexpected', `Deleted file still exists: ${portablePath}`, portablePath));
      }
      continue;
    }
    if (!SHA256_HEX_PATTERN.test(String(file.afterHash || ''))) {
      issues.push(issue('file_hash_missing', `Current file hash is missing or invalid: ${portablePath}`, portablePath));
      continue;
    }
    if (!existsSync(target)) {
      issues.push(issue('file_missing', `Expected file is missing: ${portablePath}`, portablePath));
      continue;
    }
    let metadata;
    try {
      metadata = statSync(target);
    } catch {
      issues.push(issue('file_missing', `Expected file cannot be inspected: ${portablePath}`, portablePath));
      continue;
    }
    if (!metadata.isFile()) {
      issues.push(issue('file_not_regular', `Expected a regular file: ${portablePath}`, portablePath));
      continue;
    }
    if (metadata.size > maxFileBytes) {
      issues.push(issue('file_too_large', `File exceeds merge gate verification limit: ${portablePath}`, portablePath));
      continue;
    }
    let actualHash = '';
    try {
      actualHash = sha256(readFileSync(target));
    } catch {
      issues.push(issue('file_missing', `Expected file cannot be read: ${portablePath}`, portablePath));
      continue;
    }
    if (actualHash !== file.afterHash) {
      issues.push(issue('file_hash_mismatch', `File changed after Userface review: ${portablePath}`, portablePath));
    }
  }
  return { issues, checkedFileCount };
}

function readResolvedFileState(
  states: Readonly<Record<string, UserfaceMergeGateResolvedFileState>> | undefined,
  portablePath: string,
): UserfaceMergeGateResolvedFileState | null {
  if (!states || !Object.prototype.hasOwnProperty.call(states, portablePath)) return null;
  const value = states[portablePath] as unknown;
  if (!isRecord(value)) return null;
  const kind = String(value.kind || '');
  if (kind === 'missing') return { kind: 'missing' };
  if (kind === 'file') {
    const sizeBytes = Number(value.sizeBytes);
    const hash = String(value.sha256 || '').trim();
    if (!Number.isInteger(sizeBytes) || sizeBytes < 0 || !SHA256_HEX_PATTERN.test(hash)) return null;
    return { kind: 'file', sizeBytes, sha256: hash };
  }
  if (kind === 'symlink'
    || kind === 'directory'
    || kind === 'submodule'
    || kind === 'other'
    || kind === 'unreadable') {
    const sizeBytes = Number(value.sizeBytes);
    return {
      kind,
      ...(Number.isInteger(sizeBytes) && sizeBytes >= 0 ? { sizeBytes } : {}),
    };
  }
  return null;
}

function verifyRemoteHeadFileState(
  file: UserfaceMergeGateSubjectFile,
  state: UserfaceMergeGateResolvedFileState | null,
  maxFileBytes: number,
): UserfaceMergeGateVerificationIssue[] {
  const portablePath = file.path;
  if (!state) {
    return [issue('file_state_unavailable', `Head file state is unavailable: ${portablePath}`, portablePath)];
  }
  if (file.action === 'delete') {
    return state.kind === 'missing'
      ? []
      : [issue('file_unexpected', `Deleted file still exists at head revision: ${portablePath}`, portablePath)];
  }
  if (!SHA256_HEX_PATTERN.test(String(file.afterHash || ''))) {
    return [issue('file_hash_missing', `Reviewed head file hash is missing or invalid: ${portablePath}`, portablePath)];
  }
  if (state.kind === 'missing') {
    return [issue('file_missing', `Expected file is missing at head revision: ${portablePath}`, portablePath)];
  }
  if (state.kind === 'symlink') {
    return [issue('symlink_not_allowed', `Symlinks are not allowed in merge gate paths: ${portablePath}`, portablePath)];
  }
  if (state.kind === 'unreadable') {
    return [issue('file_state_unavailable', `Head file cannot be inspected: ${portablePath}`, portablePath)];
  }
  if (state.kind !== 'file') {
    return [issue('file_not_regular', `Expected a regular file at head revision: ${portablePath}`, portablePath)];
  }
  if (state.sizeBytes > maxFileBytes) {
    return [issue('file_too_large', `Head file exceeds merge gate verification limit: ${portablePath}`, portablePath)];
  }
  if (state.sha256 !== file.afterHash) {
    return [issue('file_hash_mismatch', `Head file differs from the reviewed state: ${portablePath}`, portablePath)];
  }
  return [];
}

function verifyRemoteBaseFileState(
  file: UserfaceMergeGateSubjectFile,
  state: UserfaceMergeGateResolvedFileState | null,
  maxFileBytes: number,
): UserfaceMergeGateVerificationIssue[] {
  const portablePath = file.path;
  if (!state) {
    return [issue('before_file_state_unavailable', `Base file state is unavailable: ${portablePath}`, portablePath)];
  }
  if (file.action === 'write') {
    if (file.beforeHash !== null) {
      return [issue('before_file_hash_mismatch', `New file unexpectedly declares a base hash: ${portablePath}`, portablePath)];
    }
    return state.kind === 'missing'
      ? []
      : [issue('before_file_unexpected', `New file already exists at base revision: ${portablePath}`, portablePath)];
  }
  if (!SHA256_HEX_PATTERN.test(String(file.beforeHash || ''))) {
    return [issue('before_file_hash_missing', `Reviewed base file hash is missing or invalid: ${portablePath}`, portablePath)];
  }
  if (state.kind === 'missing') {
    return [issue('before_file_missing', `Expected file is missing at base revision: ${portablePath}`, portablePath)];
  }
  if (state.kind === 'unreadable') {
    return [issue('before_file_state_unavailable', `Base file cannot be inspected: ${portablePath}`, portablePath)];
  }
  if (state.kind !== 'file') {
    return [issue('before_file_not_regular', `Expected a regular file at base revision: ${portablePath}`, portablePath)];
  }
  if (state.sizeBytes > maxFileBytes) {
    return [issue('before_file_too_large', `Base file exceeds merge gate verification limit: ${portablePath}`, portablePath)];
  }
  if (state.sha256 !== file.beforeHash) {
    return [issue('before_file_hash_mismatch', `Base file differs from the reviewed starting state: ${portablePath}`, portablePath)];
  }
  return [];
}

function verifySubjectRemoteFileStates(
  subject: UserfaceMergeGateSubject,
  options: VerifyUserfaceMergeGateRemoteEvidenceOptions,
): { issues: UserfaceMergeGateVerificationIssue[]; checkedFileCount: number } {
  const issues: UserfaceMergeGateVerificationIssue[] = [];
  const maxFileBytes = Number.isFinite(options.maxFileBytes)
    ? Math.max(1, Number(options.maxFileBytes))
    : USERFACE_MERGE_GATE_DEFAULT_MAX_FILE_BYTES;
  const verifyBase = options.requireBaseFileStates === true || options.baseFileStates !== undefined;
  const seen = new Set<string>();
  let checkedFileCount = 0;
  for (const file of subject.files) {
    const portablePath = String(file.path || '').trim();
    if (!isPortableWorkspacePath(portablePath) || !FILE_ACTIONS.has(file.action)) {
      issues.push(issue('path_invalid', `Invalid portable workspace path: ${portablePath || '<empty>'}`, portablePath || undefined));
      continue;
    }
    if (seen.has(portablePath)) {
      issues.push(issue('path_duplicate', `Duplicate merge gate path: ${portablePath}`, portablePath));
      continue;
    }
    seen.add(portablePath);
    checkedFileCount += 1;
    issues.push(...verifyRemoteHeadFileState(
      file,
      readResolvedFileState(options.headFileStates, portablePath),
      maxFileBytes,
    ));
    if (verifyBase) {
      issues.push(...verifyRemoteBaseFileState(
        file,
        readResolvedFileState(options.baseFileStates, portablePath),
        maxFileBytes,
      ));
    }
  }
  return { issues, checkedFileCount };
}

function emptyResult(issues: UserfaceMergeGateVerificationIssue[]): UserfaceMergeGateVerificationResult {
  return {
    schemaVersion: 'mergeGateVerification@1',
    valid: false,
    mergeEligible: false,
    exitCode: 1,
    evidenceId: null,
    reviewId: null,
    changeSetId: null,
    subjectRevision: null,
    gateStatus: null,
    authenticity: 'unverified',
    checkedFileCount: 0,
    issues,
  };
}

function verifyEvidenceAttestation(
  evidence: UserfaceMergeGateEvidence,
  options: Pick<
    VerifyUserfaceMergeGateEvidenceOptions,
    'requireSignature' | 'trustedPublicKey' | 'trustedPublicKeys'
  >,
): {
  authenticity: UserfaceMergeGateVerificationResult['authenticity'];
  issues: UserfaceMergeGateVerificationIssue[];
} {
  const required = options.requireSignature === true
    || evidence.review.policy.requireSignedMergeGate === true;
  const attestation = evidence.attestation;
  if (!attestation) {
    return {
      authenticity: 'unsigned',
      issues: required
        ? [issue('signature_required', 'A trusted Ed25519 merge gate signature is required')]
        : [],
    };
  }
  if (attestation.schemaVersion !== 'mergeGateAttestation@1'
    || attestation.algorithm !== 'ed25519'
    || !/^[a-zA-Z0-9._:-]{1,128}$/.test(String(attestation.keyId || ''))
    || !/^[a-zA-Z0-9_-]{64,256}$/.test(String(attestation.signature || ''))) {
    return {
      authenticity: 'unverified',
      issues: [issue('signature_invalid', 'Merge gate attestation is malformed')],
    };
  }
  const trustedKey = options.trustedPublicKeys?.[attestation.keyId]
    || options.trustedPublicKey;
  if (!trustedKey) {
    return {
      authenticity: 'unverified',
      issues: [issue('signature_key_missing', `No trusted public key is configured for ${attestation.keyId}`)],
    };
  }
  try {
    const publicKey = asPublicKey(trustedKey);
    const signature = Buffer.from(attestation.signature, 'base64url');
    const valid = verifyPayload(
      null,
      Buffer.from(evidence.integrity.digest, 'utf8'),
      publicKey,
      signature,
    );
    return valid
      ? { authenticity: 'verified', issues: [] }
      : {
          authenticity: 'unverified',
          issues: [issue('signature_invalid', 'Merge gate attestation signature does not match the trusted key')],
        };
  } catch {
    return {
      authenticity: 'unverified',
      issues: [issue('signature_invalid', 'Merge gate attestation or trusted public key is invalid')],
    };
  }
}

function verifyUserfaceMergeGateEvidenceCore(
  value: unknown,
  options: Pick<
    VerifyUserfaceMergeGateEvidenceOptions,
    'requireSignature' | 'trustedPublicKey' | 'trustedPublicKeys'
  >,
  verifyFiles: (evidence: UserfaceMergeGateEvidence) => {
    issues: UserfaceMergeGateVerificationIssue[];
    checkedFileCount: number;
  },
): UserfaceMergeGateVerificationResult {
  const structuralIssues = validateEvidencePayload(value);
  if (structuralIssues.length > 0 || !isRecord(value) || !isRecord(value.integrity)) {
    if (structuralIssues.length === 0) {
      structuralIssues.push(issue('integrity_invalid', 'Merge gate evidence integrity receipt is missing'));
    }
    return emptyResult(structuralIssues);
  }
  const evidence = value as unknown as UserfaceMergeGateEvidence;
  const issues: UserfaceMergeGateVerificationIssue[] = [];
  const digest = String(evidence.integrity.digest || '');
  if (evidence.integrity.algorithm !== USERFACE_MERGE_GATE_INTEGRITY_ALGORITHM
    || !SHA256_REVISION_PATTERN.test(digest)) {
    issues.push(issue('integrity_invalid', 'Merge gate evidence integrity receipt is invalid'));
  } else {
    const expectedDigest = computeUserfaceMergeGateEvidenceDigest(evidence);
    if (digest !== expectedDigest) {
      issues.push(issue('integrity_mismatch', 'Merge gate evidence was modified after export'));
    }
  }
  const expectedSubjectRevision = computeUserfaceMergeGateSubjectRevision(evidence.subject);
  if (expectedSubjectRevision !== evidence.review.subjectRevision) {
    issues.push(issue('subject_revision_mismatch', 'Review subject revision does not match the embedded evidence'));
  }
  issues.push(...validateReviewConsistency(evidence));
  const attestation = verifyEvidenceAttestation(evidence, options);
  issues.push(...attestation.issues);
  const files = verifyFiles(evidence);
  issues.push(...files.issues);
  if (!evidence.review.mergeEligible) {
    issues.push(issue(
      'gate_not_eligible',
      `Userface review is ${evidence.review.gateStatus}, not merge eligible`,
      undefined,
      evidence.review.blockers.flatMap((blocker) => blocker.evidenceRefs),
    ));
  }
  const valid = issues.length === 0;
  return {
    schemaVersion: 'mergeGateVerification@1',
    valid,
    mergeEligible: valid && evidence.review.mergeEligible,
    exitCode: valid && evidence.review.mergeEligible ? 0 : 1,
    evidenceId: SHA256_REVISION_PATTERN.test(digest) ? digest : null,
    reviewId: evidence.review.reviewId,
    changeSetId: evidence.review.changeSetId,
    subjectRevision: evidence.review.subjectRevision,
    gateStatus: evidence.review.gateStatus,
    authenticity: attestation.authenticity,
    checkedFileCount: files.checkedFileCount,
    issues,
  };
}

export function verifyUserfaceMergeGateEvidence(
  value: unknown,
  options: VerifyUserfaceMergeGateEvidenceOptions,
): UserfaceMergeGateVerificationResult {
  return verifyUserfaceMergeGateEvidenceCore(
    value,
    options,
    (evidence) => verifySubjectFiles(evidence.subject, options),
  );
}

export function verifyUserfaceMergeGateEvidenceAgainstFileStates(
  value: unknown,
  options: VerifyUserfaceMergeGateRemoteEvidenceOptions,
): UserfaceMergeGateVerificationResult {
  return verifyUserfaceMergeGateEvidenceCore(
    value,
    options,
    (evidence) => verifySubjectRemoteFileStates(evidence.subject, options),
  );
}

export function verifyUserfaceMergeGateEvidenceFile(
  evidencePath: string,
  options: VerifyUserfaceMergeGateEvidenceOptions & { maxEvidenceBytes?: number },
): UserfaceMergeGateVerificationResult {
  const path = resolve(String(evidencePath || '').trim());
  const maxEvidenceBytes = Number.isFinite(options.maxEvidenceBytes)
    ? Math.max(1, Number(options.maxEvidenceBytes))
    : USERFACE_MERGE_GATE_DEFAULT_MAX_EVIDENCE_BYTES;
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    return emptyResult([issue('evidence_read_failed', `Merge gate evidence cannot be read: ${path}`)]);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    return emptyResult([issue('evidence_read_failed', 'Merge gate evidence must be a regular non-symlink file')]);
  }
  if (metadata.size > maxEvidenceBytes) {
    return emptyResult([issue('evidence_too_large', `Merge gate evidence exceeds ${maxEvidenceBytes} bytes`)]);
  }
  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return emptyResult([issue('evidence_read_failed', `Merge gate evidence cannot be read: ${path}`)]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyResult([issue('evidence_invalid_json', 'Merge gate evidence is not valid JSON')]);
  }
  return verifyUserfaceMergeGateEvidence(parsed, options);
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>|])/g, '\\$1');
}

export function renderUserfaceMergeGateVerificationMarkdown(
  result: UserfaceMergeGateVerificationResult,
): string {
  const lines = [
    `## Userface merge gate: ${result.mergeEligible ? 'passed' : 'blocked'}`,
    '',
    `- Review: ${result.reviewId || 'unavailable'}`,
    `- ChangeSet: ${result.changeSetId || 'unavailable'}`,
    `- Subject revision: ${result.subjectRevision || 'unavailable'}`,
    `- Authenticity: ${result.authenticity}`,
    `- Files verified: ${result.checkedFileCount}`,
  ];
  if (result.issues.length > 0) {
    lines.push('', '### Blockers');
    for (const entry of result.issues) {
      lines.push(`- \`${entry.code}\`: ${escapeMarkdown(entry.message)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function escapeGitHubCommand(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C');
}

export function renderUserfaceMergeGateVerification(
  result: UserfaceMergeGateVerificationResult,
  format: 'plain' | 'json' | 'github' | 'gitlab' = 'plain',
): string {
  if (format === 'json') return `${JSON.stringify(result, null, 2)}\n`;
  if (format === 'github') {
    if (result.issues.length === 0) {
      return `::notice title=Userface merge gate::Review ${escapeGitHubCommand(result.reviewId || 'unknown')} passed for ${result.checkedFileCount} file(s); authenticity=${result.authenticity}\n`;
    }
    return `${result.issues.map((entry) => {
      const properties = entry.path
        ? `file=${escapeGitHubCommand(entry.path)},title=Userface merge gate`
        : 'title=Userface merge gate';
      return `::error ${properties}::${escapeGitHubCommand(entry.message)}`;
    }).join('\n')}\n`;
  }
  if (format === 'gitlab') {
    const status = result.mergeEligible ? 'PASSED' : 'BLOCKED';
    const lines = [`section_start:${Math.floor(Date.now() / 1000)}:userface_merge_gate[collapsed=false]\r\u001b[0KUserface merge gate: ${status}`];
    for (const entry of result.issues) lines.push(`[${entry.code}] ${entry.message}`);
    lines.push(`section_end:${Math.floor(Date.now() / 1000)}:userface_merge_gate\r\u001b[0K`);
    return `${lines.join('\n')}\n`;
  }
  const status = result.mergeEligible ? 'PASS' : 'BLOCK';
  const lines = [
    `Userface merge gate: ${status}`,
    `review=${result.reviewId || 'unavailable'} revision=${result.subjectRevision || 'unavailable'} authenticity=${result.authenticity} files=${result.checkedFileCount}`,
  ];
  for (const entry of result.issues) lines.push(`- ${entry.code}: ${entry.message}`);
  return `${lines.join('\n')}\n`;
}
