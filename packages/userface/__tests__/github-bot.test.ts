import { describe, expect, it, vi } from 'vitest';
import {
  buildGenerationIssueComment,
  buildValidationPullRequestComment,
  getGenerationCommentMarker,
  getValidationCommentMarker,
  upsertIssueComment,
} from '../lib/github-bot.js';

describe('userface github-bot helpers', () => {
  it('formats a structured pull request validation comment', () => {
    const body = buildValidationPullRequestComment({
      root: 'packages/face-ui-react',
      totalComponents: 2,
      passed: 1,
      failed: 1,
      errors: 0,
      violationsTotal: 3,
      results: [
        {
          component: 'Button',
          status: 'pass',
          scores: { overall: 92 },
          violations: [],
        },
        {
          component: 'Select',
          status: 'fail',
          scores: { overall: 45 },
          violations: [
            { description: 'Missing keyboard navigation' },
            { description: 'No ARIA roles defined' },
          ],
        },
      ],
    });

    expect(body).toContain(getValidationCommentMarker());
    expect(body).toContain('## Userface Component Validation');
    expect(body).toContain('PASS Button: 92/100');
    expect(body).toContain('FAIL Select: 45/100');
    expect(body).toContain('- Missing keyboard navigation');
  });

  it('updates an existing marker comment instead of creating duplicates', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { id: 77, body: `${getValidationCommentMarker()}\nold` },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 77,
        body: `${getValidationCommentMarker()}\nnew`,
      }), { status: 200 }));

    const result = await upsertIssueComment({
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 12,
      token: 'ghs_test',
      fetchImpl,
      body: `${getValidationCommentMarker()}\nnew`,
    });

    expect(result).toEqual({
      action: 'updated',
      commentId: 77,
      body: `${getValidationCommentMarker()}\nnew`,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toContain('/issues/comments/77');
  });

  it('formats a generation comment with branch and pull request metadata', () => {
    const body = buildGenerationIssueComment({
      componentName: 'EmptyState',
      branch: 'userface/generate-empty-state-17',
      files: [
        'packages/face-ui-react/EmptyState/EmptyState.tsx',
        'packages/face-ui-react/EmptyState/EmptyState.json',
      ],
      pullRequest: { html_url: 'https://github.com/acme/widgets/pull/17' },
      message: 'Generated scaffold and opened a pull request.',
    });

    expect(body).toContain(getGenerationCommentMarker());
    expect(body).toContain('## Userface Component Generation');
    expect(body).toContain('EmptyState');
    expect(body).toContain('userface/generate-empty-state-17');
    expect(body).toContain('https://github.com/acme/widgets/pull/17');
  });
});
