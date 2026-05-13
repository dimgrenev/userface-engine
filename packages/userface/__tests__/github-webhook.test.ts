import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const validateMocks = vi.hoisted(() => ({
  validateTarget: vi.fn(),
  mergeValidationReports: vi.fn(),
}));

vi.mock('../lib/validate.js', () => ({
  validateTarget: validateMocks.validateTarget,
  mergeValidationReports: validateMocks.mergeValidationReports,
}));

import {
  handleGitHubWebhook,
  inferValidationTargetsFromFiles,
  parseUserfaceCommand,
} from '../lib/github-webhook.js';

describe('userface github-webhook helpers', () => {
  let tempRoot = '';

  beforeEach(async () => {
    validateMocks.validateTarget.mockReset();
    validateMocks.mergeValidationReports.mockReset();
    tempRoot = await mkdtemp(join(tmpdir(), 'uf-gh-webhook-'));
    await mkdir(join(tempRoot, 'packages/face-ui-react/Button'), { recursive: true });
    await writeFile(join(tempRoot, 'packages/face-ui-react/Button/face.json'), '{}');
    await writeFile(join(tempRoot, 'packages/face-ui-react/Button/Button.tsx'), 'export const Button = () => null;');
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = '';
    }
  });

  it('parses validate and generate commands from PR comments', () => {
    expect(parseUserfaceCommand('@userface validate')).toEqual({
      name: 'validate',
      args: '',
    });
    expect(parseUserfaceCommand('please check\n@userface generate Button')).toEqual({
      name: 'generate',
      target: 'Button',
    });
    expect(parseUserfaceCommand('hello world')).toBeNull();
  });

  it('infers component targets from changed files', () => {
    const targets = inferValidationTargetsFromFiles([
      'packages/face-ui-react/Button/Button.tsx',
      'packages/face-ui-react/Button/face.json',
    ], { cwd: tempRoot });

    expect(targets).toEqual(['packages/face-ui-react/Button']);
  });

  it('handles @userface validate for pull request comments', async () => {
    validateMocks.validateTarget.mockResolvedValue({
      root: 'packages/face-ui-react/Button',
      totalComponents: 1,
      passed: 1,
      failed: 0,
      errors: 0,
      violationsTotal: 0,
      results: [
        { component: 'Button', status: 'pass', scores: { overall: 92 }, violations: [] },
      ],
    });
    validateMocks.mergeValidationReports.mockReturnValue({
      root: 'changed-components',
      totalComponents: 1,
      passed: 1,
      failed: 0,
      errors: 0,
      violationsTotal: 0,
      results: [
        { component: 'Button', status: 'pass', scores: { overall: 92 }, violations: [] },
      ],
    });

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { filename: 'packages/face-ui-react/Button/Button.tsx' },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 55,
        body: '<!-- userface-validation -->\n## Userface Component Validation',
      }), { status: 200 }));

    const result = await handleGitHubWebhook({
      eventName: 'issue_comment',
      payload: {
        comment: { body: '@userface validate --mode fast --fail-on warning' },
        issue: { number: 42, pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/42' } },
        repository: { name: 'widgets', owner: { login: 'acme' } },
      },
      githubToken: 'ghs_test',
      repoRoot: tempRoot,
      fetchImpl,
      mode: 'standard',
      failOn: 'error',
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe('validate');
    expect(result.targets).toEqual(['packages/face-ui-react/Button']);
    expect(validateMocks.validateTarget).toHaveBeenCalledWith('packages/face-ui-react/Button', expect.objectContaining({
      cwd: tempRoot,
      failOn: 'warning',
      forwardedArgs: ['--mode', 'fast'],
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('handles @userface generate for issues in dry-run mode', async () => {
    const fetchImpl = vi.fn();

    const result = await handleGitHubWebhook({
      eventName: 'issues',
      payload: {
        action: 'opened',
        issue: {
          number: 17,
          body: '@userface generate EmptyState',
        },
        repository: { name: 'widgets', owner: { login: 'acme' } },
      },
      githubToken: 'ghs_test',
      repoRoot: tempRoot,
      fetchImpl,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.command).toBe('generate');
    expect(result.supported).toBe(true);
    expect(result.componentName).toBe('EmptyState');
    expect(result.branch).toBe('userface/generate-empty-state-17');
    expect(result.files).toEqual([
      'packages/face-ui-react/EmptyState/EmptyState.tsx',
      'packages/face-ui-react/EmptyState/EmptyState.json',
      'packages/face-ui-react/index.ts',
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
