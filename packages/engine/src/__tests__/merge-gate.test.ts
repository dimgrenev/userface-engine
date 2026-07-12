import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeUserfaceMergeGateEvidenceDigest,
  computeUserfaceMergeGateSubjectRevision,
  createUserfaceMergeGateEvidence,
  deriveUserfaceMergeGateKeyId,
  renderUserfaceMergeGateVerification,
  renderUserfaceMergeGateVerificationMarkdown,
  signUserfaceMergeGateEvidence,
  verifyUserfaceMergeGateEvidence,
  verifyUserfaceMergeGateEvidenceAgainstFileStates,
  verifyUserfaceMergeGateEvidenceFile,
  type UserfaceMergeGateEvidence,
  type UserfaceMergeGateEvidencePayload,
  type UserfaceMergeGateResolvedFileState,
  type UserfaceMergeGateSubject,
} from '../merge-gate';

const roots: string[] = [];

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'userface-merge-gate-'));
  roots.push(root);
  return root;
}

function writeWorkspaceFile(root: string, path: string, content: string): string {
  const target = join(root, ...path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
  return sha256(content);
}

function passingSubject(root: string): UserfaceMergeGateSubject {
  const content = 'export function App() { return <main>Billing</main>; }\n';
  const afterHash = writeWorkspaceFile(root, 'src/App.tsx', content);
  return {
    changeSetId: 'changeset_billing',
    files: [{
      path: 'src/App.tsx',
      action: 'edit',
      beforeHash: sha256('old'),
      afterHash,
      additions: 1,
      deletions: 1,
    }],
    validation: {
      validationId: 'validation_billing',
      renderJobId: 'render_billing',
      status: 'passed',
      score: 100,
      valid: true,
      passed: true,
      pendingFix: false,
      staleReason: null,
      violations: [],
    },
    validationRuns: [{
      validationRunId: 'run_billing',
      checkKind: 'render_preview',
      status: 'passed',
      trigger: 'render_target',
      renderJobId: 'render_billing',
      commandId: null,
      score: 100,
      artifactCount: 2,
      diagnosticCount: 0,
      staleReason: null,
    }],
    conflicts: [],
    surfaces: [{
      surface: 'app_preview',
      status: 'synced',
      affectedTargetIds: ['billing-page'],
    }],
  };
}

function evidencePayload(
  root: string,
  options: { required?: boolean; subject?: UserfaceMergeGateSubject } = {},
): UserfaceMergeGateEvidencePayload {
  const subject = options.subject || passingSubject(root);
  const subjectRevision = computeUserfaceMergeGateSubjectRevision(subject);
  const required = options.required === true;
  const policyHash = sha256(required ? 'required-policy' : 'advisory-policy');
  const decisions = required
    ? [{
        decisionId: 'decision_maintainer',
        decision: 'approved' as const,
        subjectRevision,
        reviewer: {
          principalId: 'maintainer@example.com',
          kind: 'user' as const,
          role: 'maintainer' as const,
        },
        policyHash,
        evidenceRefs: ['validation:run_billing'],
        decidedAt: 1_700_000_000_100,
      }]
    : [];
  return {
    schemaVersion: 'mergeGateEvidence@1',
    producer: { name: 'Userface', contractVersion: 1 },
    createdAt: 1_700_000_000_200,
    subject,
    review: {
      reviewId: 'review_changeset_billing',
      changeSetId: subject.changeSetId,
      subjectRevision,
      policy: {
        mode: required ? 'required' : 'advisory',
        requiredApprovals: required ? 1 : 0,
        minimumReviewerRole: 'maintainer',
        allowRequesterApproval: false,
        requireSignedMergeGate: false,
        policyHash,
        source: required ? 'workspace_policy' : 'default',
      },
      author: { principalId: 'userface-agent:turn_billing', kind: 'agent' },
      requestedBy: {
        principalId: 'builder@example.com',
        kind: 'user',
        role: 'contributor',
      },
      state: required ? 'approved' : 'pending',
      gateStatus: required ? 'passed' : 'advisory',
      mergeEligible: true,
      approvalCount: required ? 1 : 0,
      requiredApprovals: required ? 1 : 0,
      blockers: [],
      decisions,
    },
  };
}

function resign(evidence: UserfaceMergeGateEvidence): UserfaceMergeGateEvidence {
  return {
    ...evidence,
    integrity: {
      algorithm: 'sha256',
      digest: computeUserfaceMergeGateEvidenceDigest(evidence),
    },
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Userface portable merge gate', () => {
  it.each([
    ['advisory safety gate', false],
    ['required approved gate', true],
  ])('passes a current %s', (_label, required) => {
    const root = workspace();
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root, { required }));
    const result = verifyUserfaceMergeGateEvidence(evidence, { root });

    expect(result).toMatchObject({
      valid: true,
      mergeEligible: true,
      exitCode: 0,
      checkedFileCount: 1,
      issues: [],
    });
    expect(result.evidenceId).toBe(evidence.integrity.digest);
  });

  it('is deterministic for the same review evidence', () => {
    const root = workspace();
    const payload = evidencePayload(root, { required: true });
    const first = createUserfaceMergeGateEvidence(payload);
    const second = createUserfaceMergeGateEvidence({
      ...payload,
      subject: {
        ...payload.subject,
        surfaces: [...payload.subject.surfaces].reverse(),
        validationRuns: [...payload.subject.validationRuns].reverse(),
      },
    });

    expect(second).toEqual(first);
  });

  it('verifies a policy-required Ed25519 attestation against a pinned public key', () => {
    const root = workspace();
    const payload = evidencePayload(root, { required: true });
    payload.review.policy.requireSignedMergeGate = true;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyId = deriveUserfaceMergeGateKeyId(publicKey);
    const evidence = signUserfaceMergeGateEvidence(
      createUserfaceMergeGateEvidence(payload),
      privateKey,
    );

    expect(evidence.attestation).toEqual(expect.objectContaining({
      algorithm: 'ed25519',
      keyId,
    }));
    expect(verifyUserfaceMergeGateEvidence(evidence, {
      root,
      trustedPublicKeys: { [keyId]: publicKey },
    })).toMatchObject({
      valid: true,
      mergeEligible: true,
      exitCode: 0,
      authenticity: 'verified',
      issues: [],
    });
  });

  it('fails closed when a required attestation or trusted key is missing', () => {
    const root = workspace();
    const payload = evidencePayload(root);
    payload.review.policy.requireSignedMergeGate = true;
    const unsigned = createUserfaceMergeGateEvidence(payload);
    expect(verifyUserfaceMergeGateEvidence(unsigned, { root })).toMatchObject({
      authenticity: 'unsigned',
      exitCode: 1,
      issues: [expect.objectContaining({ code: 'signature_required' })],
    });

    const { privateKey } = generateKeyPairSync('ed25519');
    const signed = signUserfaceMergeGateEvidence(unsigned, privateKey, 'enterprise-key');
    expect(verifyUserfaceMergeGateEvidence(signed, { root })).toMatchObject({
      authenticity: 'unverified',
      exitCode: 1,
      issues: [expect.objectContaining({ code: 'signature_key_missing' })],
    });
  });

  it('rejects a wrong key, altered signature, and command-level signature requirement', () => {
    const root = workspace();
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root));
    expect(verifyUserfaceMergeGateEvidence(evidence, { root, requireSignature: true }).issues)
      .toEqual([expect.objectContaining({ code: 'signature_required' })]);

    const signer = generateKeyPairSync('ed25519');
    const stranger = generateKeyPairSync('ed25519');
    const signed = signUserfaceMergeGateEvidence(evidence, signer.privateKey, 'trusted-enterprise-key');
    expect(verifyUserfaceMergeGateEvidence(signed, { root, trustedPublicKey: stranger.publicKey }).issues)
      .toEqual([expect.objectContaining({ code: 'signature_invalid' })]);

    signed.attestation!.signature = `${signed.attestation!.signature.startsWith('A') ? 'B' : 'A'}${signed.attestation!.signature.slice(1)}`;
    expect(verifyUserfaceMergeGateEvidence(signed, { root, trustedPublicKey: signer.publicKey }).issues)
      .toEqual([expect.objectContaining({ code: 'signature_invalid' })]);
  });

  it.each([
    ['failed validation', 'validation_not_passed'],
    ['stale validation', 'validation_stale'],
    ['missing required approval', 'approvals_missing'],
    ['changes requested', 'changes_requested'],
    ['rejected', 'rejected'],
    ['unresolved conflict', 'conflicts_present'],
  ])('blocks %s with inspectable evidence', (_label, blockerCode) => {
    const root = workspace();
    const payload = evidencePayload(root, { required: blockerCode === 'approvals_missing' });
    payload.review.mergeEligible = false;
    payload.review.approvalCount = 0;
    payload.review.decisions = [];
    payload.review.state = blockerCode === 'changes_requested'
      ? 'changes_requested'
      : blockerCode === 'rejected'
        ? 'rejected'
        : 'pending';
    payload.review.gateStatus = blockerCode === 'approvals_missing' ? 'pending' : 'blocked';
    payload.review.blockers = [{
      code: blockerCode,
      message: `Blocked by ${blockerCode}`,
      evidenceRefs: [`test:${blockerCode}`],
    }];
    if (blockerCode === 'validation_not_passed') {
      payload.subject.validation = { ...payload.subject.validation!, status: 'failed', passed: false };
      payload.review.subjectRevision = computeUserfaceMergeGateSubjectRevision(payload.subject);
    }
    if (blockerCode === 'validation_stale') {
      payload.subject.validation = { ...payload.subject.validation!, status: 'stale', staleReason: 'source changed' };
      payload.review.subjectRevision = computeUserfaceMergeGateSubjectRevision(payload.subject);
    }
    if (blockerCode === 'changes_requested' || blockerCode === 'rejected') {
      payload.review.decisions = [{
        decisionId: `decision_${blockerCode}`,
        decision: blockerCode,
        subjectRevision: payload.review.subjectRevision,
        reviewer: { principalId: 'maintainer@example.com', kind: 'user', role: 'maintainer' },
        policyHash: payload.review.policy.policyHash,
        evidenceRefs: [`test:${blockerCode}`],
        decidedAt: 1_700_000_000_100,
      }];
    }
    if (blockerCode === 'conflicts_present') {
      payload.subject.conflicts = [{
        path: 'src/App.tsx',
        reason: 'manual edit',
        beforeHash: null,
        afterHash: null,
        currentHash: null,
      }];
      payload.review.subjectRevision = computeUserfaceMergeGateSubjectRevision(payload.subject);
    }
    const evidence = createUserfaceMergeGateEvidence(payload);
    const result = verifyUserfaceMergeGateEvidence(evidence, { root });

    expect(result.mergeEligible).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.issues.map((entry) => entry.code)).toContain('gate_not_eligible');
    expect(result.issues.filter((entry) => entry.code === 'review_inconsistent')).toEqual([]);
  });

  it('detects post-export evidence tampering', () => {
    const root = workspace();
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root));
    evidence.review.gateStatus = 'passed';

    const result = verifyUserfaceMergeGateEvidence(evidence, { root });

    expect(result.issues.map((entry) => entry.code)).toContain('integrity_mismatch');
  });

  it('detects a replayed subject even when the envelope digest is recomputed', () => {
    const root = workspace();
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root));
    evidence.subject.files[0].afterHash = sha256('different revision');
    const replayed = resign(evidence);

    const result = verifyUserfaceMergeGateEvidence(replayed, { root });

    expect(result.issues.map((entry) => entry.code)).toContain('subject_revision_mismatch');
  });

  it('detects inconsistent approval claims after a recomputed digest', () => {
    const root = workspace();
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root, { required: true }));
    evidence.review.decisions = [];
    const forged = resign(evidence);

    const result = verifyUserfaceMergeGateEvidence(forged, { root });

    expect(result.issues.map((entry) => entry.code)).toContain('review_inconsistent');
  });

  it.each([
    ['changed file', 'changed', 'file_hash_mismatch'],
    ['missing file', null, 'file_missing'],
  ])('fails when a reviewed file is %s', (_label, replacement, expectedCode) => {
    const root = workspace();
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root));
    const path = join(root, 'src/App.tsx');
    if (replacement === null) rmSync(path);
    else writeFileSync(path, replacement, 'utf8');

    const result = verifyUserfaceMergeGateEvidence(evidence, { root });

    expect(result.issues.map((entry) => entry.code)).toContain(expectedCode);
  });

  it('verifies delete state and fails if the deleted file reappears', () => {
    const root = workspace();
    const subject = passingSubject(root);
    subject.files.push({
      path: 'src/Legacy.tsx',
      action: 'delete',
      beforeHash: sha256('legacy'),
      afterHash: null,
      additions: 0,
      deletions: 1,
    });
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root, { subject }));
    expect(verifyUserfaceMergeGateEvidence(evidence, { root }).exitCode).toBe(0);

    writeWorkspaceFile(root, 'src/Legacy.tsx', 'legacy');
    const result = verifyUserfaceMergeGateEvidence(evidence, { root });
    expect(result.issues.map((entry) => entry.code)).toContain('file_unexpected');
  });

  it('verifies exact remote base and head states for edit, write, and delete actions', () => {
    const root = workspace();
    const subject = passingSubject(root);
    const created = 'export const NewPanel = () => <aside />;\n';
    const removed = 'export const Legacy = true;\n';
    subject.files.push(
      {
        path: 'src/NewPanel.tsx',
        action: 'write',
        beforeHash: null,
        afterHash: sha256(created),
        additions: 1,
        deletions: 0,
      },
      {
        path: 'src/Legacy.tsx',
        action: 'delete',
        beforeHash: sha256(removed),
        afterHash: null,
        additions: 0,
        deletions: 1,
      },
    );
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root, { subject }));
    const headFileStates: Record<string, UserfaceMergeGateResolvedFileState> = {
      'src/App.tsx': {
        kind: 'file',
        sizeBytes: 58,
        sha256: subject.files[0].afterHash!,
      },
      'src/NewPanel.tsx': {
        kind: 'file',
        sizeBytes: Buffer.byteLength(created),
        sha256: sha256(created),
      },
      'src/Legacy.tsx': { kind: 'missing' },
    };
    const baseFileStates: Record<string, UserfaceMergeGateResolvedFileState> = {
      'src/App.tsx': {
        kind: 'file',
        sizeBytes: 3,
        sha256: subject.files[0].beforeHash!,
      },
      'src/NewPanel.tsx': { kind: 'missing' },
      'src/Legacy.tsx': {
        kind: 'file',
        sizeBytes: Buffer.byteLength(removed),
        sha256: sha256(removed),
      },
    };

    expect(verifyUserfaceMergeGateEvidenceAgainstFileStates(evidence, {
      headFileStates,
      baseFileStates,
      requireBaseFileStates: true,
    })).toMatchObject({
      valid: true,
      mergeEligible: true,
      checkedFileCount: 3,
      issues: [],
    });
  });

  it.each([
    ['missing head resolution', {}, undefined, 'file_state_unavailable'],
    ['head hash mismatch', { 'src/App.tsx': { kind: 'file', sizeBytes: 1, sha256: sha256('wrong') } }, undefined, 'file_hash_mismatch'],
    ['head symlink', { 'src/App.tsx': { kind: 'symlink' } }, undefined, 'symlink_not_allowed'],
    ['missing base resolution', null, {}, 'before_file_state_unavailable'],
    ['base hash mismatch', null, { 'src/App.tsx': { kind: 'file', sizeBytes: 1, sha256: sha256('wrong') } }, 'before_file_hash_mismatch'],
  ] as const)('fails closed for remote %s', (_label, headOverride, baseOverride, expectedCode) => {
    const root = workspace();
    const subject = passingSubject(root);
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root, { subject }));
    const headFileStates = headOverride === null
      ? {
          'src/App.tsx': {
            kind: 'file' as const,
            sizeBytes: 58,
            sha256: subject.files[0].afterHash!,
          },
        }
      : headOverride;
    const baseFileStates = baseOverride === undefined
      ? undefined
      : baseOverride;
    const result = verifyUserfaceMergeGateEvidenceAgainstFileStates(evidence, {
      headFileStates,
      ...(baseFileStates !== undefined ? { baseFileStates } : {}),
      ...(baseFileStates !== undefined ? { requireBaseFileStates: true } : {}),
    });
    expect(result.issues.map((entry) => entry.code)).toContain(expectedCode);
    expect(result.mergeEligible).toBe(false);
  });

  it('keeps policy-required signatures mandatory for remote file-state verification', () => {
    const root = workspace();
    const subject = passingSubject(root);
    const payload = evidencePayload(root, { subject });
    payload.review.policy.requireSignedMergeGate = true;
    const unsigned = createUserfaceMergeGateEvidence(payload);
    const state = {
      'src/App.tsx': {
        kind: 'file' as const,
        sizeBytes: 58,
        sha256: subject.files[0].afterHash!,
      },
    };
    expect(verifyUserfaceMergeGateEvidenceAgainstFileStates(unsigned, {
      headFileStates: state,
    }).issues.map((entry) => entry.code)).toContain('signature_required');

    const keys = generateKeyPairSync('ed25519');
    const signed = signUserfaceMergeGateEvidence(unsigned, keys.privateKey, 'managed-service-key');
    expect(verifyUserfaceMergeGateEvidenceAgainstFileStates(signed, {
      headFileStates: state,
      trustedPublicKeys: { 'managed-service-key': keys.publicKey },
    })).toMatchObject({ valid: true, mergeEligible: true, authenticity: 'verified' });
  });

  it.each([
    ['../outside.ts', 'path_invalid'],
    ['/tmp/outside.ts', 'path_invalid'],
    ['src\\App.tsx', 'path_invalid'],
    ['src/./App.tsx', 'path_invalid'],
  ])('rejects non-portable path %s', (path, expectedCode) => {
    const root = workspace();
    const subject = passingSubject(root);
    subject.files[0].path = path;
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root, { subject }));
    const result = verifyUserfaceMergeGateEvidence(evidence, { root });
    expect(result.issues.map((entry) => entry.code)).toContain(expectedCode);
  });

  it('rejects duplicate file evidence', () => {
    const root = workspace();
    const subject = passingSubject(root);
    subject.files.push({ ...subject.files[0] });
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root, { subject }));
    const result = verifyUserfaceMergeGateEvidence(evidence, { root });
    expect(result.issues.map((entry) => entry.code)).toContain('path_duplicate');
  });

  it.each(['target', 'parent'])('rejects a %s symlink in a reviewed path', (kind) => {
    const root = workspace();
    const outside = workspace();
    const outsideFile = writeWorkspaceFile(outside, 'App.tsx', 'outside');
    const subject = passingSubject(root);
    rmSync(join(root, 'src'), { recursive: true, force: true });
    if (kind === 'parent') {
      symlinkSync(outside, join(root, 'src'));
      subject.files[0].afterHash = outsideFile;
    } else {
      mkdirSync(join(root, 'src'), { recursive: true });
      symlinkSync(join(outside, 'App.tsx'), join(root, 'src/App.tsx'));
      subject.files[0].afterHash = outsideFile;
    }
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root, { subject }));
    const result = verifyUserfaceMergeGateEvidence(evidence, { root });
    expect(result.issues.map((entry) => entry.code)).toContain('symlink_not_allowed');
  });

  it('fails closed on missing file hash and file size overflow', () => {
    const root = workspace();
    const payload = evidencePayload(root);
    payload.subject.files[0].afterHash = null;
    payload.review.subjectRevision = computeUserfaceMergeGateSubjectRevision(payload.subject);
    const missingHash = createUserfaceMergeGateEvidence(payload);
    expect(verifyUserfaceMergeGateEvidence(missingHash, { root }).issues.map((entry) => entry.code))
      .toContain('file_hash_missing');

    const valid = createUserfaceMergeGateEvidence(evidencePayload(root));
    expect(verifyUserfaceMergeGateEvidence(valid, { root, maxFileBytes: 1 }).issues.map((entry) => entry.code))
      .toContain('file_too_large');
  });

  it('fails closed on unreadable, oversized, invalid JSON, and malformed evidence files', () => {
    const root = workspace();
    const evidencePath = join(root, 'evidence.json');
    expect(verifyUserfaceMergeGateEvidenceFile(evidencePath, { root }).issues[0].code)
      .toBe('evidence_read_failed');

    writeFileSync(evidencePath, '{broken', 'utf8');
    expect(verifyUserfaceMergeGateEvidenceFile(evidencePath, { root }).issues[0].code)
      .toBe('evidence_invalid_json');
    expect(verifyUserfaceMergeGateEvidenceFile(evidencePath, { root, maxEvidenceBytes: 1 }).issues[0].code)
      .toBe('evidence_too_large');

    writeFileSync(evidencePath, JSON.stringify({ schemaVersion: 'wrong' }), 'utf8');
    expect(verifyUserfaceMergeGateEvidenceFile(evidencePath, { root }).issues[0].code)
      .toBe('evidence_invalid_schema');
  });

  it('renders actionable plain, JSON, GitHub, GitLab, and Markdown reports', () => {
    const root = workspace();
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root));
    writeFileSync(join(root, 'src/App.tsx'), 'changed', 'utf8');
    const result = verifyUserfaceMergeGateEvidence(evidence, { root });

    expect(renderUserfaceMergeGateVerification(result, 'plain')).toContain('file_hash_mismatch');
    expect(JSON.parse(renderUserfaceMergeGateVerification(result, 'json')).exitCode).toBe(1);
    expect(renderUserfaceMergeGateVerification(result, 'github')).toContain('::error file=src/App.tsx');
    expect(renderUserfaceMergeGateVerification(result, 'gitlab')).toContain('section_start:');
    expect(renderUserfaceMergeGateVerificationMarkdown(result)).toContain('## Userface merge gate: blocked');
  });

  it('preserves evidence without source content or absolute workspace paths', () => {
    const root = workspace();
    const evidence = createUserfaceMergeGateEvidence(evidencePayload(root, { required: true }));
    const serialized = JSON.stringify(evidence);

    expect(serialized).not.toContain(root);
    expect(serialized).not.toContain(readFileSync(join(root, 'src/App.tsx'), 'utf8'));
    expect(serialized).toContain('src/App.tsx');
  });
});
