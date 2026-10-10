# Contributing

Thanks for helping make coding agents less loopy. Issues and pull requests are welcome.

## Development

```bash
git clone https://github.com/T5A111/Token-Sentinel.git && cd Token-Sentinel
npm ci
npm run typecheck     # strict TypeScript, src + tests
npm test              # self-verification suite (tests/self-test.ts)
npm run test:pack     # build the npm tarball, install it into a clean project, smoke-test CLI + MCP
npm run mcp           # run the MCP server from source (stdio)
npx tsx src/cli/index.ts <command>   # run the CLI from source
```

Requirements: Node.js ≥ 20 and git. CI runs on Linux, macOS and Windows with Node 20, 22 and 24. Please keep all three green.

### Guidelines

- **Fail open in hooks.** A sentinel bug must never block the user's editor. Hooks catch everything and exit 0 unless they are deliberately blocking a write.
- **Never touch the user's git state.** No commits on their branch, no changes to the index or stash. Snapshots live under `refs/sentinel/*`.
- **Stay local.** No network calls and no telemetry.
- Add or extend a case in `tests/self-test.ts` for every behavior change.
- Hook payloads differ between editors and versions. If you have a real payload from Cursor or Windsurf, a PR adding it as a test fixture is very valuable.

## Releasing (maintainers)

Releases are published to npm by `.github/workflows/release.yml` when a `v*.*.*` tag is pushed.

One-time setup:

1. Create an npm account and an **Automation** (or granular, publish-only) access token at <https://www.npmjs.com/settings/~/tokens>.
2. Add it as the repository secret **`NPM_TOKEN`**: GitHub → Settings → Secrets and variables → Actions → New repository secret.

Each release:

```bash
# 1. bump the version (updates package.json + package-lock.json, no tag yet)
npm version patch --no-git-tag-version   # or: minor | major | 0.2.0  (skip for the first release, 0.1.0)
# 2. move the "Unreleased" notes in CHANGELOG.md under the new version
# 3. commit, merge to main, then tag the merge commit:
git tag v0.1.0 && git push origin v0.1.0
```

The workflow checks that the tag matches `package.json`, runs typecheck, tests and the package smoke test, publishes with npm provenance, and creates a GitHub Release.
