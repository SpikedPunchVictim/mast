# Releasing `@spikedpunch/mast`

Releases are tag-driven. `.github/workflows/release.yml` builds, verifies, and publishes
on any `v*` tag — with one exception, described first because it only happens once.

## The first release must be published from a laptop

npm's **Trusted Publishing** is a trust relationship between an existing package and a
specific workflow file in a specific repository. The package must exist before it can be
configured, and the configuration must exist before CI can publish — so the first version
cannot come from CI.

```bash
# 1. Log in as the account that will own the package.
npm login

# 2. Publish. prepublishOnly runs the build, so dist/ cannot be stale or missing.
pnpm publish --access public
```

Then, once on npmjs.com:

**Package settings → Publishing access → Trusted Publisher**, and register:

| field | value |
|---|---|
| Provider | GitHub Actions |
| Organization / user | `SpikedPunchVictim` |
| Repository | `mast` |
| Workflow filename | `release.yml` |

There is **no `NPM_TOKEN`**, and there should not be one. The workflow's `id-token: write`
permission lets npm exchange a short-lived OIDC token for publish credentials and sign a
provenance attestation. A long-lived token in repository secrets is exactly what this
replaces — renaming `release.yml`, or moving the repository, breaks the trust relationship
and must be re-registered rather than worked around with a token.

## Every release after that

```bash
# 1. Bump the version. package.json is the single source — src/cli/version.ts reads it,
#    and package-identity.test.ts fails if they ever disagree.
npm version minor --no-git-tag-version     # or patch / major / 0.3.0

# 2. Commit and tag. The tag must match the version, or the workflow stops before
#    publishing rather than after building.
git commit -am "release: v$(node -p "require('./package.json').version")"
git tag "v$(node -p "require('./package.json').version")"
git push --follow-tags
```

The workflow then runs typecheck, lint, build, and the full suite, asserts the freshly
built binary reports the version being released, and publishes with provenance.

## Bumping the index schema

`CURRENT_SCHEMA_VERSION` in `src/store/config.ts` is independent of the package version.
Changing it makes every existing index invalid: `bootstrapState` discards derived state
and reindexes from scratch on the next `serve` or `index`.

That is the correct behaviour — the index is derived state and rebuilding is cheap
relative to serving wrong answers — but it is not free, and it is invisible to a user
running `pnpm up`. When a release bumps the schema:

- say so in the release notes, in terms of what the user will experience (a one-off
  reindex, and roughly how long for a large repository);
- remember that `mast upgrade` reads this and warns automatically, but only for users who
  run it before upgrading.

## Checklist

- [ ] `package.json` version bumped
- [ ] `pnpm typecheck && pnpm lint && pnpm build && pnpm test` green locally
- [ ] Schema change, if any, called out in the release notes
- [ ] Tag matches the version exactly
- [ ] Trusted Publisher registered (first release only)
