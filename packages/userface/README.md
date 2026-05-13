# userface

Umbrella CLI for the Userface ecosystem.

## Commands

```bash
userface add engine
userface add face-ui-react
userface add all
userface validate src/components --ci
userface generate EmptyState
```

## Scope

This package is the branded entrypoint for:

- `@userface/engine`
- `@userface/face-ui-react`

It is not the runtime package for the full desktop app.

`userface add ...` installs the requested publishable package set into an existing project.

`userface validate ...` runs Userface component validation in CI-friendly aggregate mode. It wraps `@userface/engine` and can emit JSON or GitHub Actions annotations.

`userface generate ...` creates a local component scaffold with a matching `face.json` contract and updates the component barrel export when an `index.ts` file is present.

## GitHub Automation

This repo now ships a local GitHub Action at `.github/actions/validate-components` for PR validation.

Example workflow step:

```yaml
- uses: ./.github/actions/validate-components
  with:
    root: packages/face-ui-react
    mode: standard
    fail-on: error
    changed-only: true
    comment-on-pr: true
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

The reusable bot helpers live in:

- `packages/userface/lib/github-bot.js`
- `packages/userface/lib/github-webhook.js`
- `packages/userface/lib/generate.js`

For server-side webhook handling, the repo includes `apps/web/pages/api/github/userface.ts`. Configure:

- `USERFACE_GITHUB_WEBHOOK_SECRET`
- `USERFACE_GITHUB_BOT_TOKEN`
- `USERFACE_GITHUB_REPO_ROOT` (optional, defaults to the current checkout)

Supported GitHub commands:

- PR comment: `@userface validate`
- Issue or issue comment: `@userface generate Button`
