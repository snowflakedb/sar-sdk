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

# Instructions for coding agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) before changing code. The Node.js SDK lives in `nodejs/`.
Its [contributing guide](nodejs/CONTRIBUTING.md) has the workflow, the API and extension rules, and
the release checklist, and its [directory map](nodejs/CONTRIBUTING.md#directory-map) shows where
code and tests live.

## Commands

Run these in `nodejs/`, with Node.js 22 or 24 and npm 11.18.0.

| Purpose                | Command                                        |
| ---------------------- | ---------------------------------------------- |
| Install                | `npm ci --ignore-scripts --no-audit --no-fund` |
| Run one test file      | `npx vitest run tests/<name>.test.ts`          |
| Lint and typecheck     | `npm run lint` and `npm run typecheck`         |
| Format                 | `npm run format`                               |
| Run everything CI runs | `npm run check`                                |

To list the files the mirror publishes, run `bash scripts/mirroring/copybara.sh verify` from the
repository root. It needs Docker and checks `HEAD`.

## Done means

- `npm run check` passes in `nodejs/`.
- A behavior change comes with a regression test. Tests stay offline: no Snowflake connections,
  and no real credentials or local configuration files.
- A user-visible change has an entry under Unreleased in
  [nodejs/CHANGELOG.md](nodejs/CHANGELOG.md), and a breaking one starts with **Breaking:**.
- A change to the export map, public types, defaults, error codes, or fallback rules is called out
  for compatibility review in the pull request.

## Git and pull requests

- Push branches and open pull requests only in Snowflake's private development repository.
- Pull requests are squash-merged, and their commit messages and title become the published
  commit. Write them for a public reader.
- In the pull request description, state the intent and how you verified the change.

## Ask before

- Adding, removing, or upgrading a dependency, or editing `nodejs/package-lock.json`.
- Changing `.github/workflows/`, `scripts/mirroring/`, or the coverage thresholds.
- Deleting or skipping a test, or weakening an assertion to make a test pass.

## Never

- Push to [snowflakedb/sar-sdk](https://github.com/snowflakedb/sar-sdk), open pull requests or
  issues on it, or add it as a remote, even if it's the origin of your checkout. It's a read-only
  mirror that only the mirror automation writes to.
- Retry a failed push or pull request against another remote or repository. Stop and report the
  error.
- Approve a pull request, or reply to a review on someone's behalf without saying you're an agent.
- Commit secrets or credentials.
- Put internal links, ticket numbers, or hostnames in commit messages, pull request titles, or
  published files.
