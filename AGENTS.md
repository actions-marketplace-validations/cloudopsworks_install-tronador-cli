# AGENTS.md

Guidance for agents working in `cloudopsworks/install-tronador-cli`.

## Repository ownership

- This is a standalone GitHub Action repository. It is not generated from a CloudOps Works
  template and has no `.cloudopsworks/` directory.
- This repository owns its GitHub workflows. Edits to `.github/workflows/*.yml` are made and
  reviewed here, like any other source change.
- There is no `_VERSION` file. The version comes from git tags.

## Build and test

- `src/` holds the action code. `dist/index.mjs` is the ncc bundle the runner executes, and
  it is committed. Run `npm run build` and commit `dist/` whenever `src/` or dependencies
  change: CI fails if `dist/` is stale.
- Run `npm ci && npm test` before opening a PR. The tests use a local HTTP server and never
  contact github.com.
- `README.yaml` is the documentation source of truth. Regenerate `README.md` with
  `tronador readme build` using the tronador version CI uses (see `.github/workflows/ci.yml`),
  because CI fails if `README.md` differs.

## Releases

- Work lands through `feature/*` or `hotfix/*` branches and PRs into `master`, merged with a
  merge commit once CI passes.
- No workflow publishes releases. After merge, the maintainer tags locally:
  - an immutable `vX.Y.Z` tag;
  - a GitHub release for that tag;
  - the floating major tag `vX`, force-moved to the same commit so `uses: ...@vX` users
    receive the release.
- Move a floating major tag only after its `vX.Y.Z` release is published.
