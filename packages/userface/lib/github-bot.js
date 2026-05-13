const DEFAULT_MARKER = '<!-- userface-validation -->';
const DEFAULT_GENERATION_MARKER = '<!-- userface-generate -->';

function assertToken(token) {
  const value = String(token || '').trim();
  if (!value) {
    throw new Error('GitHub token is required');
  }
  return value;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function getValidationCommentMarker() {
  return DEFAULT_MARKER;
}

export function getGenerationCommentMarker() {
  return DEFAULT_GENERATION_MARKER;
}

export function buildValidationPullRequestComment(report, options = {}) {
  const marker = options.marker || DEFAULT_MARKER;
  const maxComponents = Math.max(1, Number(options.maxComponents || 20));
  const maxViolations = Math.max(1, Number(options.maxViolationsPerComponent || 3));
  const results = Array.isArray(report?.results) ? report.results.slice() : [];
  const sorted = results.sort((a, b) => {
    const rank = (value) => value === 'fail' ? 0 : value === 'error' ? 1 : 2;
    return rank(a?.status) - rank(b?.status) || String(a?.component || '').localeCompare(String(b?.component || ''));
  });
  const visible = sorted.slice(0, maxComponents);
  const lines = [
    marker,
    '## Userface Component Validation',
    '',
    `Scanned ${Number(report?.totalComponents || visible.length)} component(s) in \`${String(report?.root || '.')}\`.`,
    `Passed: ${Number(report?.passed || 0)} | Failed: ${Number(report?.failed || 0)} | Errors: ${Number(report?.errors || 0)} | Violations: ${Number(report?.violationsTotal || 0)}`,
    '',
  ];

  for (const result of visible) {
    const score = Number(result?.scores?.overall);
    const scoreLabel = Number.isFinite(score) ? `${score}/100` : 'n/a';
    const status = String(result?.status || 'error').toUpperCase();
    lines.push(`${status} ${String(result?.component || result?.path || 'component')}: ${scoreLabel}`);
    if (result?.status === 'error') {
      lines.push(`- ${String(result?.error || 'Validation failed unexpectedly.')}`);
      lines.push('');
      continue;
    }

    const violations = Array.isArray(result?.violations) ? result.violations.slice(0, maxViolations) : [];
    for (const violation of violations) {
      const message = String(violation?.description || violation?.message || violation?.ruleId || 'Violation detected');
      lines.push(`- ${message}`);
    }
    if (Array.isArray(result?.violations) && result.violations.length > maxViolations) {
      lines.push(`- ...and ${result.violations.length - maxViolations} more`);
    }
    lines.push('');
  }

  if (sorted.length > visible.length) {
    lines.push(`...and ${sorted.length - visible.length} more component result(s).`);
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

export function buildGenerationIssueComment(result, options = {}) {
  const marker = options.marker || DEFAULT_GENERATION_MARKER;
  const componentName = String(result?.componentName || 'Component');
  const lines = [
    marker,
    '## Userface Component Generation',
    '',
    `Prepared scaffold for \`${componentName}\`.`,
  ];

  if (result?.branch) {
    lines.push(`Branch: \`${String(result.branch)}\``);
  }
  if (result?.pullRequest?.html_url || result?.pullRequest?.htmlUrl) {
    lines.push(`Pull request: ${String(result.pullRequest.html_url || result.pullRequest.htmlUrl)}`);
  }
  if (Array.isArray(result?.files) && result.files.length > 0) {
    lines.push('');
    lines.push('Files:');
    for (const file of result.files) {
      lines.push(`- \`${String(file)}\``);
    }
  }
  if (result?.message) {
    lines.push('');
    lines.push(String(result.message));
  }

  return lines.join('\n').trim() + '\n';
}

export async function githubApiRequest(args) {
  const token = assertToken(args.token);
  const fetchImpl = args.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('Global fetch is not available');
  }

  const response = await fetchImpl(args.url, {
    method: args.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'userface-bot',
      ...(args.headers || {}),
    },
    body: args.body ? JSON.stringify(args.body) : undefined,
  });

  if (response.status === 404 && args.allow404) {
    return null;
  }

  if (!response.ok) {
    const payload = await readJsonResponse(response);
    throw new Error(`GitHub API ${response.status}: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }

  return await readJsonResponse(response);
}

export async function listPullRequestFiles(args) {
  const files = [];
  let page = 1;
  while (page <= 10) {
    const payload = await githubApiRequest({
      token: args.token,
      fetchImpl: args.fetchImpl,
      url: `https://api.github.com/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/files?per_page=100&page=${page}`,
    });
    const pageItems = Array.isArray(payload) ? payload : [];
    files.push(...pageItems);
    if (pageItems.length < 100) break;
    page += 1;
  }
  return files;
}

export async function upsertIssueComment(args) {
  const marker = args.marker || DEFAULT_MARKER;
  const comments = await githubApiRequest({
    token: args.token,
    fetchImpl: args.fetchImpl,
    url: `https://api.github.com/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/comments?per_page=100`,
  });
  const existing = Array.isArray(comments)
    ? comments.find((comment) => String(comment?.body || '').includes(marker))
    : null;

  if (existing?.id) {
    const updated = await githubApiRequest({
      token: args.token,
      fetchImpl: args.fetchImpl,
      method: 'PATCH',
      url: `https://api.github.com/repos/${args.owner}/${args.repo}/issues/comments/${existing.id}`,
      body: { body: args.body },
    });
    return {
      action: 'updated',
      commentId: updated?.id || existing.id,
      body: updated?.body || args.body,
    };
  }

  const created = await githubApiRequest({
    token: args.token,
    fetchImpl: args.fetchImpl,
    method: 'POST',
    url: `https://api.github.com/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/comments`,
    body: { body: args.body },
  });
  return {
    action: 'created',
    commentId: created?.id,
    body: created?.body || args.body,
  };
}

function encodeGitHubPath(filePath) {
  return String(filePath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export async function getRepository(args) {
  return await githubApiRequest({
    token: args.token,
    fetchImpl: args.fetchImpl,
    url: `https://api.github.com/repos/${args.owner}/${args.repo}`,
  });
}

export async function getBranchRef(args) {
  return await githubApiRequest({
    token: args.token,
    fetchImpl: args.fetchImpl,
    allow404: args.allow404,
    url: `https://api.github.com/repos/${args.owner}/${args.repo}/git/ref/heads/${String(args.branch || '').split('/').map((segment) => encodeURIComponent(segment)).join('/')}`,
  });
}

export async function createBranchRef(args) {
  return await githubApiRequest({
    token: args.token,
    fetchImpl: args.fetchImpl,
    method: 'POST',
    url: `https://api.github.com/repos/${args.owner}/${args.repo}/git/refs`,
    body: {
      ref: `refs/heads/${args.branch}`,
      sha: args.sha,
    },
  });
}

export async function getRepositoryContent(args) {
  const suffix = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : '';
  const payload = await githubApiRequest({
    token: args.token,
    fetchImpl: args.fetchImpl,
    allow404: args.allow404,
    url: `https://api.github.com/repos/${args.owner}/${args.repo}/contents/${encodeGitHubPath(args.path)}${suffix}`,
  });

  if (!payload || Array.isArray(payload)) return payload;
  const content = typeof payload.content === 'string'
    ? Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf-8')
    : '';
  return {
    ...payload,
    decodedContent: content,
  };
}

export async function putRepositoryContent(args) {
  return await githubApiRequest({
    token: args.token,
    fetchImpl: args.fetchImpl,
    method: 'PUT',
    url: `https://api.github.com/repos/${args.owner}/${args.repo}/contents/${encodeGitHubPath(args.path)}`,
    body: {
      message: args.message,
      content: Buffer.from(String(args.content || ''), 'utf-8').toString('base64'),
      branch: args.branch,
      sha: args.sha,
    },
  });
}

export async function findOpenPullRequestByHead(args) {
  const payload = await githubApiRequest({
    token: args.token,
    fetchImpl: args.fetchImpl,
    url: `https://api.github.com/repos/${args.owner}/${args.repo}/pulls?state=open&head=${encodeURIComponent(`${args.owner}:${args.branch}`)}`,
  });
  return Array.isArray(payload) && payload.length > 0 ? payload[0] : null;
}

export async function createPullRequest(args) {
  return await githubApiRequest({
    token: args.token,
    fetchImpl: args.fetchImpl,
    method: 'POST',
    url: `https://api.github.com/repos/${args.owner}/${args.repo}/pulls`,
    body: {
      title: args.title,
      head: args.branch,
      base: args.base,
      body: args.body,
      draft: !!args.draft,
    },
  });
}
