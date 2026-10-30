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

# SAR SDK

The **Snowflake App Runtime (SAR)** SDK separates Snowflake access from application frameworks:
caller identity, owned SQL sessions, bounded results, secrets, and account HTTP.

| Language | Directory                     | Package              | Status                                |
| -------- | ----------------------------- | -------------------- | ------------------------------------- |
| Node.js  | [`nodejs/`](nodejs/README.md) | `@snowflake/sar-sdk` | Development releases on npm (`@next`) |

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Public repository

Snowflake develops this SDK in a private repository. The public repository,
[snowflakedb/sar-sdk](https://github.com/snowflakedb/sar-sdk), is a read-only mirror that is
updated automatically as changes land. It doesn't accept pull requests. To report a bug or
suggest a change, open an issue. Report security vulnerabilities as described in
[SECURITY.md](SECURITY.md).

## Repository map

```text
nodejs/     Node.js SDK: package, tests, examples, and npm toolchain
.github/    CI workflows and pull request template
```

Each language directory is self-contained, with its own toolchain, checks, changelog, and guides.
The repository root holds what they share: [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md), [AGENTS.md](AGENTS.md) for coding agents, and the license.

## License

Copyright (c) Snowflake Inc. All rights reserved.

Licensed under the Apache 2.0 license.
