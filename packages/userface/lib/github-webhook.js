import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildGenerationIssueComment,
  buildValidationPullRequestComment,
  createBranchRef,
  createPullRequest,
  findOpenPullRequestByHead,
  getBranchRef,
  getRepository,
  getRepositoryContent,
  listPullRequestFiles,
  putRepositoryContent,
  upsertIssueComment,
} from './github-bot.js';
import {
  mergeValidationReports,
  validateTarget,
} from './validate.js';
import {
  buildGeneratedComponentFiles,
  normalizeComponentName,
  toKebabCase,
} from './generate.js';

const DEFAULT_COMPONENT_ROOTS = [
  ['src', 'components'],
  ['components'],
  ['packages', 'face-ui-react'],
  ['packages', 'uf'],
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function hasComponentContract(dirPath) {
  const base = path.basename(dirPath);
  return fs.existsSync(path.join(dirPath, 'face.json'))
    || fs.existsSync(path.join(dirPath, `${base}.face.json`));
}

function inferTargetFromChangedFile(filePath, cwd) {
  const normalized = normalizePath(filePath);
  if (!normalized) return '';

  const segments = normalized.split('/').filter(Boolean);
  for (const rootSegments of DEFAULT_COMPONENT_ROOTS) {
    const rootLength = rootSegments.length;
    const matchesRoot = rootSegments.every((segment, index) => segments[index] === segment);
    if (matchesRoot && segments.length > rootLength) {
      return path.join(...segments.slice(0, rootLength + 1));
    }
  }

  const absoluteFile = path.resolve(cwd, normalized);
  let cursor = fs.existsSync(absoluteFile) && fs.statSync(absoluteFile).isDirectory()
    ? absoluteFile
    : path.dirname(absoluteFile);

  while (cursor && cursor !== cwd && cursor.startsWith(cwd)) {
    if (hasComponentContract(cursor)) {
      return normalizePath(path.relative(cwd, cursor));
    }
    cursor = path.dirname(cursor);
  }

  return '';
}

function readCommandOption(args, flag) {
  const tokens = String(args || '').split(/\s+/).filter(Boolean);
  const index = tokens.indexOf(flag);
  return index >= 0 && index + 1 < tokens.length ? tokens[index + 1] : '';
}

export function readGitHubWebhookBody(readable) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    readable.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

export function verifyGitHubWebhookSignature(args) {
  const secret = String(args.secret || '').trim();
  const signature = String(args.signature || '').trim();
  if (!secret || !signature || !signature.startsWith('sha256=')) {
    return false;
  }

  const digest = crypto
    .createHmac('sha256', secret)
    .update(args.rawBody)
    .digest('hex');
  const expected = Buffer.from(`sha256=${digest}`);
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

export function parseUserfaceCommand(body) {
  const text = String(body || '').trim();
  if (!/@userface\b/i.test(text)) return null;

  const validateMatch = text.match(/@userface\s+validate(?:\s+(.*))?$/i);
  if (validateMatch) {
    return {
      name: 'validate',
      args: String(validateMatch[1] || '').trim(),
    };
  }

  const generateMatch = text.match(/@userface\s+generate\s+([^\s]+)/i);
  if (generateMatch) {
    return {
      name: 'generate',
      target: String(generateMatch[1] || '').trim(),
    };
  }

  return null;
}

function extractCommandBody(payload, eventName) {
  const commentBody = String(payload?.comment?.body || '').trim();
  const issueBody = String(payload?.issue?.body || '').trim();
  if (commentBody && /@userface\b/i.test(commentBody)) return commentBody;
  if ((eventName === 'issues' || eventName === 'issue_comment') && issueBody && /@userface\b/i.test(issueBody)) {
    return issueBody;
  }
  return commentBody || issueBody;
}

function buildGenerationBranchName(componentName, issueNumber) {
  const base = toKebabCase(componentName) || 'component';
  const suffix = issueNumber ? `-${issueNumber}` : '';
  return `userface/generate-${base}${suffix}`.slice(0, 120);
}

function buildGenerationPullRequestBody(args) {
  const lines = [
    '## Summary',
    `- scaffolded \`${args.componentName}\` in \`${args.componentsRoot}\``,
    '- generated a matching face.json contract',
    '- updated the component barrel export',
    '',
    '## Notes',
    '- this PR is a generated starting point and may need product-specific behavior before merge',
  ];

  if (args.issueNumber) {
    lines.push('');
    lines.push(`Closes #${args.issueNumber}`);
  }

  return lines.join('\n');
}

export function inferValidationTargetsFromFiles(files, options = {}) {
  const cwd = options.cwd || process.cwd();
  const targets = new Set();
  for (const file of Array.isArray(files) ? files : []) {
    const inferred = inferTargetFromChangedFile(file, cwd);
    if (inferred) targets.add(normalizePath(inferred));
  }
  return [...targets].sort();
}

export async function handleGitHubWebhook(args) {
  const payload = args.payload || {};
  const eventName = String(args.eventName || '').trim();
  const command = parseUserfaceCommand(extractCommandBody(payload, eventName));
  if (!command) {
    return {
      ok: true,
      ignored: true,
      reason: 'no_userface_command',
    };
  }

  if (command.name === 'generate') {
    const owner = String(payload?.repository?.owner?.login || payload?.repository?.owner?.name || '').trim();
    const repo = String(payload?.repository?.name || '').trim();
    const issueNumber = Number(payload?.issue?.number || payload?.number || 0);
    const pullRequestRef = payload?.issue?.pull_request || payload?.pull_request;
    if (!owner || !repo || !issueNumber || pullRequestRef) {
      return {
        ok: true,
        ignored: false,
        command: 'generate',
        supported: false,
        message: '@userface generate works on issues, not pull requests.',
      };
    }

    const scaffold = buildGeneratedComponentFiles({
      name: normalizeComponentName(command.target),
      cwd: args.repoRoot || process.cwd(),
    });
    const branch = buildGenerationBranchName(scaffold.name, issueNumber);

    if (args.dryRun) {
      return {
        ok: true,
        ignored: false,
        command: 'generate',
        supported: true,
        componentName: scaffold.name,
        branch,
        files: scaffold.files.map((file) => file.path),
        pullRequest: null,
      };
    }

    const repository = await getRepository({
      owner,
      repo,
      token: args.githubToken,
      fetchImpl: args.fetchImpl,
    });
    const defaultBranch = String(repository?.default_branch || 'main').trim() || 'main';

    const existingComponent = await getRepositoryContent({
      owner,
      repo,
      token: args.githubToken,
      fetchImpl: args.fetchImpl,
      path: `${scaffold.componentDir}/${scaffold.name}.tsx`,
      ref: defaultBranch,
      allow404: true,
    });
    if (existingComponent?.sha) {
      const body = buildGenerationIssueComment({
        componentName: scaffold.name,
        branch,
        files: scaffold.files.map((file) => file.path),
        message: `A component named \`${scaffold.name}\` already exists on \`${defaultBranch}\`.`,
      });
      const comment = await upsertIssueComment({
        owner,
        repo,
        issueNumber,
        token: args.githubToken,
        fetchImpl: args.fetchImpl,
        marker: '<!-- userface-generate -->',
        body,
      });
      return {
        ok: true,
        ignored: false,
        command: 'generate',
        supported: false,
        componentName: scaffold.name,
        branch,
        files: scaffold.files.map((file) => file.path),
        comment,
        message: `Component "${scaffold.name}" already exists on ${defaultBranch}.`,
      };
    }

    const existingPullRequest = await findOpenPullRequestByHead({
      owner,
      repo,
      branch,
      token: args.githubToken,
      fetchImpl: args.fetchImpl,
    });
    if (existingPullRequest?.html_url) {
      const body = buildGenerationIssueComment({
        componentName: scaffold.name,
        branch,
        files: scaffold.files.map((file) => file.path),
        pullRequest: existingPullRequest,
        message: 'An open pull request already exists for this generated scaffold.',
      });
      const comment = await upsertIssueComment({
        owner,
        repo,
        issueNumber,
        token: args.githubToken,
        fetchImpl: args.fetchImpl,
        marker: '<!-- userface-generate -->',
        body,
      });
      return {
        ok: true,
        ignored: false,
        command: 'generate',
        supported: true,
        componentName: scaffold.name,
        branch,
        files: scaffold.files.map((file) => file.path),
        comment,
        pullRequest: existingPullRequest,
      };
    }

    const defaultRef = await getBranchRef({
      owner,
      repo,
      token: args.githubToken,
      fetchImpl: args.fetchImpl,
      branch: defaultBranch,
    });
    const branchRef = await getBranchRef({
      owner,
      repo,
      token: args.githubToken,
      fetchImpl: args.fetchImpl,
      branch,
      allow404: true,
    });
    if (!branchRef?.object?.sha) {
      await createBranchRef({
        owner,
        repo,
        token: args.githubToken,
        fetchImpl: args.fetchImpl,
        branch,
        sha: defaultRef?.object?.sha,
      });
    }

    for (const file of scaffold.files) {
      const existingFile = await getRepositoryContent({
        owner,
        repo,
        token: args.githubToken,
        fetchImpl: args.fetchImpl,
        path: file.path,
        ref: branch,
        allow404: true,
      });
      await putRepositoryContent({
        owner,
        repo,
        token: args.githubToken,
        fetchImpl: args.fetchImpl,
        path: file.path,
        branch,
        message: `feat(userface): scaffold ${scaffold.name} component`,
        content: file.content,
        sha: existingFile?.sha,
      });
    }

    const pullRequest = await createPullRequest({
      owner,
      repo,
      token: args.githubToken,
      fetchImpl: args.fetchImpl,
      branch,
      base: defaultBranch,
      title: `feat: add ${scaffold.name} component scaffold`,
      body: buildGenerationPullRequestBody({
        componentName: scaffold.name,
        componentsRoot: scaffold.componentsRoot,
        issueNumber,
      }),
    });
    const body = buildGenerationIssueComment({
      componentName: scaffold.name,
      branch,
      files: scaffold.files.map((file) => file.path),
      pullRequest,
      message: 'Generated scaffold and opened a pull request.',
    });
    const comment = await upsertIssueComment({
      owner,
      repo,
      issueNumber,
      token: args.githubToken,
      fetchImpl: args.fetchImpl,
      marker: '<!-- userface-generate -->',
      body,
    });

    return {
      ok: true,
      ignored: false,
      command: 'generate',
      supported: true,
      componentName: scaffold.name,
      branch,
      files: scaffold.files.map((file) => file.path),
      pullRequest,
      comment,
    };
  }

  if (eventName !== 'issue_comment') {
    return {
      ok: true,
      ignored: false,
      command: command.name,
      supported: false,
      message: `Unsupported GitHub event "${eventName}" for @userface validate.`,
    };
  }

  const owner = String(payload?.repository?.owner?.login || payload?.repository?.owner?.name || '').trim();
  const repo = String(payload?.repository?.name || '').trim();
  const issueNumber = Number(payload?.issue?.number || 0);
  const pullRequestRef = payload?.issue?.pull_request;
  if (!owner || !repo || !issueNumber || !pullRequestRef) {
    return {
      ok: true,
      ignored: false,
      command: 'validate',
      supported: false,
      message: '@userface validate currently works only on pull request comments.',
    };
  }

  const files = await listPullRequestFiles({
    owner,
    repo,
    pullNumber: issueNumber,
    token: args.githubToken,
    fetchImpl: args.fetchImpl,
  });
  const filePaths = files.map((file) => String(file?.filename || '')).filter(Boolean);
  const targets = inferValidationTargetsFromFiles(filePaths, {
    cwd: args.repoRoot || process.cwd(),
  });

  if (targets.length === 0) {
    const emptyBody = [
      '<!-- userface-validation -->',
      '## Userface Component Validation',
      '',
      'No component-like targets were inferred from the changed files in this pull request.',
      '',
      'Try running `userface validate <path>` manually or comment on a PR that changes component files.',
      '',
    ].join('\n');
    const comment = args.dryRun
      ? null
      : await upsertIssueComment({
          owner,
          repo,
          issueNumber,
          token: args.githubToken,
          fetchImpl: args.fetchImpl,
          body: emptyBody,
        });
    return {
      ok: true,
      ignored: false,
      command: 'validate',
      supported: true,
      files: filePaths,
      targets,
      comment,
      report: null,
    };
  }

  const modeArg = String(readCommandOption(command.args, '--mode') || args.mode || 'standard').trim();
  const failOn = String(readCommandOption(command.args, '--fail-on') || args.failOn || 'error').trim();
  const reports = [];
  for (const target of targets) {
    reports.push(await validateTarget(target, {
      cwd: args.repoRoot || process.cwd(),
      failOn,
      forwardedArgs: ['--mode', modeArg],
    }));
  }
  const report = mergeValidationReports(reports, {
    root: targets.length === 1 ? targets[0] : 'changed-components',
    failOn,
  });
  const body = buildValidationPullRequestComment(report);
  const comment = args.dryRun
    ? null
    : await upsertIssueComment({
        owner,
        repo,
        issueNumber,
        token: args.githubToken,
        fetchImpl: args.fetchImpl,
        body,
      });

  return {
    ok: true,
    ignored: false,
    command: 'validate',
    supported: true,
    files: filePaths,
    targets,
    report,
    comment,
  };
}
