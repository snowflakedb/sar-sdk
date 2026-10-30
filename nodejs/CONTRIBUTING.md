<!--
Copyright 2026 Snowflake Inc.
SPDX-License-Identifier: Apache-2.0

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Contributing to the Node.js SDK

This directory contains a pre-release Node.js SDK licensed under the
Apache License, Version 2.0. Keep changes reviewable: fix observable behavior,
add a regression test, and describe compatibility effects.

Read the [repository's contributing guide](../CONTRIBUTING.md) first: it covers the public
repository and where to push. Run the commands below in this directory.

## Development

Use Node.js 22 or 24 and npm **11.18.0**, matching CI. The lockfile is maintained with that npm
version; consumers of the compiled package need not use npm.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

`check` runs formatting, lint, source/example/public-type checks, offline tests with
coverage, ESM/CommonJS builds, and actual packed-consumer checks. The package test
installs into a temporary consumer and requires npm registry access. No test needs
a Snowflake connection or real credential. Test inputs are synthetic and transports
are injected or mocked. Do not add tests that silently discover developer credentials.

| Command                 | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `npm run format`        | Format this directory, the root Markdown, and `.github/`   |
| `npm run lint`          | Run Biome's recommended rules and catch unawaited promises |
| `npm run knip`          | Find unused files, exports, and dependencies               |
| `npm run typecheck`     | Check source, examples, and positive/negative API usage    |
| `npm test`              | Run offline regression tests                               |
| `npm run test:coverage` | Report coverage; generated files stay untracked            |
| `npm run test:package`  | Build, pack, install, and validate real consumers          |
| `npm run check`         | Run all local release-quality checks                       |

CI runs `npm run check` on Node 22 and 24 on Linux, macOS, and Windows. Local success is not a
claim that every CI combination or deployed platform has been exercised.

### Directory map

```text
src/            Public API and implementation
api/            Public API snapshot, checked by npm run api:check
tests/          Driver-contract, lifecycle, config, auth, secrets, HTTP tests
tests/types/    Compile-only consumer contracts, including invalid usage
examples/       Small typechecked public-API examples
scripts/        Declaration build, API snapshot check, and packed-consumer verification
README.md       Usage guide, shipped with the package
CHANGELOG.md    Release notes, shipped with the package
```

## Workflow

1. Install with `npm ci --ignore-scripts --no-audit --no-fund`, using the toolchain in
   [Development](#development).
2. Add a focused test for the intended behavior. Prefer controlled promises and fake
   clocks to wall-clock sleeps. Exercise failure, cancellation, and late completion.
3. Implement in the owning module; keep framework dependencies outside the SDK.
4. Run `npm run format`, `npm run check`, and `git diff --check`.
5. Update package README/JSDoc and the Unreleased changelog for user-visible behavior.
6. Request review of lifecycle, credential boundaries, and public-type changes.

Pull request checks fail when `src/` changes without a changelog entry, or when the
pull request runs fewer tests than its base. Add the `no-changelog` label for a change that isn't
user-visible, or the `fewer-tests` label when removing tests is intended.

Never connect to Snowflake or use local credential/configuration files in routine tests.
Test provider inputs are trusted synthetic fixtures, not credentials copied from a user.
Driver-private imports are permitted only in pinned-version characterization tests;
production uses public driver APIs.

## API and extension rules

- Keep client construction lazy and free of login/network/timer side effects.
- Preserve immutable owner/caller scopes and default fresh-session ownership. Reuse is
  opt-in, exclusive, and requires a reset contract; a new caller view is a new scope.
- Do not add automatic SQL retries; completion may be unknown after a transport error.
- Validate JavaScript inputs, not just TypeScript types. Optional `undefined` means absent.
- Prefer small structural provider interfaces over inheritance or global registration.
- Keep configuration snapshots separate from rotating `acquire()` values.
- Treat `withConnection` as first-class native driver access, not permission to
  retain/destroy the SDK's session. Driver injection is version-qualified compatibility.
- Keep standalone components independent. Query clients borrow managers; shared native-options
  providers are borrowed. A component's close must not close a borrowed dependency.
- Do not add an SDK global driver configuration, cache, signal handler, or telemetry sink.
- Keep JSON and native result contracts distinct. Test SQL null, duplicate columns,
  large numbers, binary, temporal precision, empty rows, and unsupported types.
- Detached work changes ownership at submission acknowledgement. Test request abort and
  shutdown on both sides, retrieval with a different client, identity mismatch, and late
  result callbacks. Never serialize credentials or turn a generic error into pending.
- Detached HTTP submission returns the query ID without a status lookup. Each later browser
  request makes one status check; never add a server-side polling loop, interval, or work
  that must survive between requests. Test pending cleanup and replacement instances.
- Changes to the export map, public types, defaults, error codes, or fallback rules
  require compatibility review even before 1.0.
- `npm run api:check`, part of `npm run check`, compares the built declarations with the snapshot
  in `api/`. When it fails, run `npm run api:update`, review the snapshot diff, and
  call out the change for compatibility review.

## Distribution and dependency maintenance

`npm run test:package` builds first and checks the installed tarball, not source imports.
It checks ESM/CJS, declarations, export encapsulation, lazy loading, browser rejection,
contents, and a reviewed size budget. TypeScript sources and ESM source maps are
included for debugging; split CommonJS output omits maps because the build tool's
CJS map pass embeds machine-local generated-chunk paths.
Its SPDX license identifier is `Apache-2.0`.

This directory's `.npmrc` turns off install scripts and skips versions published in the last
seven days, and Dependabot waits the same seven days. Because pre- and post-scripts don't run,
`npm pack` doesn't build first: run `npm run build` before packing by hand.

Review dependency-update PRs; do not merge lockfile changes solely because install passes.
Driver upgrades require the characterization suite and a new live qualification matrix.
Do not use `npm audit fix --force`. Review public advisories and license changes before release.

Coverage is a regression signal, not certification. CI enforces the measured floor in
`vitest.config.ts`; do not lower it to accommodate untested code without explanation.
No coverage uploads or other external telemetry are configured.

## Versioning and release notes

The package follows [Semantic Versioning](https://semver.org/). Before 1.0, a breaking change
bumps the minor version (0.1.0 to 0.2.0) and any other change bumps the patch version. npm's caret
ranges don't cross a 0.x minor version, so `^0.1.0` never installs a breaking release. From 1.0,
breaking changes bump the major version, features the minor version, and fixes the patch version.

A breaking change is any change that needs compatibility review under the API rules above, a
higher minimum Node.js version, or a driver upgrade that changes behavior. Development releases
such as `0.1.0-dev.1` come first, published under the `next` dist-tag with no compatibility
promise. The first final version is 0.1.0. Move to 1.0.0 once the release checklist's qualification
is complete and the API is stable.

[CHANGELOG.md](CHANGELOG.md) is the release notes, and it ships in the
package. Add user-visible changes under Unreleased in the pull request that makes them, and start
breaking ones with **Breaking:**. Release candidates use a prerelease version such as `0.2.0-rc.1`
and are published under the `next` dist-tag. Only final versions are published under `latest`.

To prepare a release, open one pull request that:

1. Sets the version with
   `npm version <version> --no-git-tag-version --ignore-scripts`, which
   updates both the package manifest and the lockfile.
2. Renames Unreleased to `<version> - <YYYY-MM-DD>` and adds an empty Unreleased section above it.
3. Groups the release's entries under Added, Changed, Deprecated, Removed, Fixed, and Security
   headings, as in [Keep a Changelog](https://keepachangelog.com/), and omits empty headings.

## Release checklist

This checklist gates final versions. A development release needs only passing checks and a
reviewed release pull request.

- [ ] Full checks and the Node 22/24 three-OS matrix pass on the release commit.
- [ ] Independent reviewers approve public API, resource ownership, and credential handling.
- [ ] README examples compile against the public entry points; changelog matches behavior.
- [ ] Driver version and dependency/security/license review are recorded.
- [ ] SPCS and Serverless/preview qualification covers owner/caller, proxy/CA, mounts, and shutdown.
- [ ] Detached queries are qualified on both platforms for independent replicas/restarts,
      two different users, cancellation, inherited session policies, and unavailable results.
      Verify finite server limits and cleanup.
- [ ] Local fresh-session SSO/MFA, real rotation, multi-user rights, and load are qualified.
- [ ] Distribution is tested in actual deployment images; no secrets or unwanted files ship.
- [ ] Only then: choose the version as described in
      [Versioning and release notes](#versioning-and-release-notes), remove publication guards
      through review, and publish with provenance. No release credentials in CI code.
