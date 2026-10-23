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

# Contributing

## Public repository

The public repository, [snowflakedb/sar-sdk](https://github.com/snowflakedb/sar-sdk), is a
read-only mirror of Snowflake's private development repository. It doesn't accept pull requests.
To report a bug or propose a change, open an issue. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md).

The rest of this guide, and the language guides it links to, are for Snowflake maintainers working
in the private repository. Push branches and open pull requests only there. Only the mirror
automation writes to snowflakedb/sar-sdk, so if a push or pull request to the private repository
fails, stop and ask for help instead of trying the public repository.

## Language guides

Each language directory has its own toolchain, checks, and changelog. Its guide covers the
workflow, API rules, versioning, and release checklist:

- [Node.js](nodejs/CONTRIBUTING.md), in `nodejs/`
