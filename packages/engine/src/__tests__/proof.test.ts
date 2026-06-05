import { describe, expect, it } from 'vitest';
import { createUserfaceProof, renderUserfaceProofMarkdown, validateUserfaceProof } from '../proof';

describe('userface proof factory', () => {
  it('creates valid partial proofs with explicit not-run reasons for omitted evidence sections', () => {
    const proof = createUserfaceProof({
      repo: { rootHash: 'sha256:partial-proof' },
      target: { kind: 'patch', paths: ['src/App.tsx'] },
      egress: {
        mode: 'local',
        modelCalls: 1,
        filesConsidered: 1,
        filesSent: 1,
        bytesSent: 512,
        absolutePathsSent: false,
        remoteTelemetry: false,
        network: true,
      },
    });

    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.status).toBe('warning');
    expect(proof.egress.measurement).toBe('request_boundary');
    expect(proof.validation).toEqual(expect.objectContaining({
      status: 'not_run',
      reason: expect.stringContaining('not run'),
    }));
    expect(proof.composition).toEqual(expect.objectContaining({
      status: 'not_run',
      reason: expect.stringContaining('not run'),
    }));
    expect(proof.preview).toEqual(expect.objectContaining({
      status: 'not_run',
      reason: expect.stringContaining('not run'),
    }));

    const markdown = renderUserfaceProofMarkdown(proof);
    expect(markdown).toContain('Egress: local, request_boundary');
    expect(markdown).toContain('Validation: not_run - This check was not run for this proof.');
    expect(markdown).toContain('Composition: not_run - This check was not run for this proof.');
    expect(markdown).toContain('Preview: not_run - Preview evidence was not run for this proof.');
  });

  it('keeps proof ids stable when only volatile timestamps differ', () => {
    const input = {
      repo: { rootHash: 'sha256:stable-proof' },
      target: { kind: 'trust' as const, paths: [] },
      validation: {
        status: 'not_run' as const,
        reason: 'Trust proof does not run validation.',
        violations: [],
      },
      composition: {
        status: 'not_run' as const,
        reason: 'Trust proof does not run composition.',
        violations: [],
      },
      preview: {
        status: 'not_run' as const,
        reason: 'Trust proof does not render preview.',
        artifacts: [],
      },
      egress: {
        mode: 'offline' as const,
        modelCalls: 0,
        filesConsidered: 0,
        filesSent: 0,
        bytesSent: 0,
        absolutePathsSent: false,
        remoteTelemetry: false,
        network: false,
      },
    };

    const first = createUserfaceProof({
      ...input,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const second = createUserfaceProof({
      ...input,
      createdAt: '2026-05-28T00:00:00.000Z',
    });

    expect(first.id).toBe(second.id);
    expect(first.egress.measurement).toBe('zero_upload');
  });

  it('keeps proof ids stable when only repo evidence metadata differs', () => {
    const input = {
      target: { kind: 'readiness' as const, paths: ['screens/fixed.ui.json'] },
      validation: {
        status: 'passed' as const,
        reason: 'Representative target passed validation.',
        violations: [],
      },
      composition: {
        status: 'passed' as const,
        reason: 'Representative target passed composition.',
        violations: [],
      },
      preview: {
        status: 'passed' as const,
        artifacts: ['artifacts/fixed.preview.svg'],
      },
      egress: {
        mode: 'offline' as const,
        modelCalls: 0,
        filesConsidered: 0,
        filesSent: 0,
        bytesSent: 0,
        absolutePathsSent: false,
        remoteTelemetry: false,
        network: false,
      },
    };

    const first = createUserfaceProof({
      ...input,
      repo: { rootHash: 'sha256:first', branch: 'main', commit: '111' },
    });
    const second = createUserfaceProof({
      ...input,
      repo: { rootHash: 'sha256:second', branch: 'feature', commit: '222' },
    });

    expect(first.id).toBe(second.id);
    expect(first.repo.rootHash).toBe('sha256:first');
    expect(second.repo.rootHash).toBe('sha256:second');
  });

  it('keeps missing request-boundary egress explicit instead of estimating payload data', () => {
    const proof = createUserfaceProof({
      repo: { rootHash: 'sha256:missing-egress' },
      target: { kind: 'patch', paths: ['src/App.tsx'] },
      egress: {
        mode: 'cloud',
        modelCalls: 0,
        filesConsidered: 2,
        filesSent: 0,
        bytesSent: 0,
        absolutePathsSent: false,
        remoteTelemetry: true,
        network: true,
      },
    });

    expect(validateUserfaceProof(proof)).toEqual({ valid: true, errors: [] });
    expect(proof.egress).toEqual(expect.objectContaining({
      measurement: 'unavailable',
      reason: expect.stringContaining('Request-boundary egress evidence is unavailable'),
      filesSent: 0,
      bytesSent: 0,
    }));
  });

  it('does not mark failed or stale evidence as passed when callers omit the top-level status', () => {
    const previewFailed = createUserfaceProof({
      repo: { rootHash: 'sha256:preview-failed' },
      target: { kind: 'patch', paths: ['src/App.tsx'] },
      preview: {
        status: 'failed',
        reason: 'Preview render crashed before screenshot capture.',
        artifacts: [],
      },
    });

    const validationFailed = createUserfaceProof({
      repo: { rootHash: 'sha256:validation-failed' },
      target: { kind: 'patch', paths: ['src/App.tsx'] },
      validation: {
        status: 'failed',
        reason: 'Required component contract is missing.',
        violations: [],
      },
    });

    const staleProof = createUserfaceProof({
      repo: { rootHash: 'sha256:stale-proof' },
      target: { kind: 'patch', paths: ['src/App.tsx'] },
      composition: {
        status: 'stale',
        reason: 'File hash changed after validation.',
        violations: [],
      },
    });

    expect(validateUserfaceProof(previewFailed)).toEqual({ valid: true, errors: [] });
    expect(validateUserfaceProof(validationFailed)).toEqual({ valid: true, errors: [] });
    expect(validateUserfaceProof(staleProof)).toEqual({ valid: true, errors: [] });
    expect(previewFailed.status).toBe('blocked');
    expect(validationFailed.status).toBe('blocked');
    expect(staleProof.status).toBe('stale');
  });
});
