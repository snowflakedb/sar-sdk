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

# Node.js SDK security and trust boundaries

This page covers the Node.js SDK. To report a vulnerability, follow the
[repository's security policy](../SECURITY.md).

## Trust boundaries

- Application configuration and providers are trusted server code. They are not a
  sandbox for untrusted plugins and must never be constructed from request-supplied targets.
- Caller headers must come from trusted Snowflake ingress. Extraction is not authentication.
  A caller view without caller context, or with a blank token, is rejected; nothing falls back to
  the app's credentials. `callerAsOwner: true`, an option of `createConnectionOptions()`, runs
  every caller view with the app's rights, even with caller context present or missing; enable it
  only where every user may act as the app, such as local development.
- Caller views are request-scoped and cannot expose app secrets or shut down the parent.
  The application must still enforce its authorization policy; Snowflake enforces SQL rights.
- Detached query references are unsigned server-side metadata, not access tokens. Never
  accept a reference directly from a browser: load a trusted shared record by query ID
  and verify application, authenticated subject, mode, decoder policy, and expiry.
  SDK lookup also verifies the current Snowflake organization/account, user, active role,
  and owner/caller mode. Detached caller operations never switch to owner credentials unless the
  connection options were explicitly created with `callerAsOwner: true`.
  Fresh authentication does not retroactively re-evaluate every policy on cached results.
- Sessions are not pooled across callers. Do not retain, share, or destroy connections
  passed to `withConnection`, or borrow another client's session/master tokens.
- Reusable mode is opt-in. Reset hooks must restore the application's entire session
  contract, including transaction/context/temporary state; the SDK cannot verify that.
  Reuse stays within one immutable caller view or owner scope. Credential rotation is
  not proof of revocation and does not drain established SQL sessions.
- Connection-options getters intentionally return credentials to trusted server code.
  Never serialize their results, persist them, or return them to an HTTP caller.
  Custom structural providers own their caller/credential policy; they are not sandboxed.
  Errors thrown by custom providers can preserve their message and `SarError.details`, including
  `nextStep`; keep these values free of secrets and paths before they reach logs or responses.
  Native pools capture snapshots and do not refresh them for future connections.
- Relative account HTTP paths, managed auth headers, and rejected redirects protect
  account scoping. A configured OAuth secret endpoint is trusted application configuration.
  Normal SQL connection methods do not automatically grant account HTTP capability.
- Preserve proxy/CA configuration. Never disable TLS verification to make a test pass.
- Secret mounts take precedence over local environment values. A mount already observed
  for a name cannot disappear into a stale environment fallback. Pair-atomic password
  rotation is not guaranteed by independently updated platform files.

## Errors and observability

Use `SarError.toJSON()` for operational logging. Do not serialize `cause`, driver objects,
raw HTTP bodies, SQL/binds, rows, secrets, or configuration wholesale. Underlying driver
causes can contain sensitive data. Caller-supplied provider IDs and application callback
errors are also trusted application data, not automatically safe for public responses.

The SDK adds no telemetry. The pinned Node driver has its own logging and telemetry;
inspect and configure those through its documented controls in the application.

## Shutdown and limitations

Timeout/abort stops local waiting and requests best-effort cleanup. It is not proof of
server cancellation, rollback, or termination of driver background downloads. HTTP
response bodies are caller-owned and are aborted on client shutdown. Always consume or
cancel them. Provider or driver work that never settles may outlive an SDK deadline.

Detached queries intentionally outlive HTTP responses and SDK shutdown after acknowledgement.
Use explicit `cancelQuery()` when intended, and apply distributed job quotas outside the SDK.
Their finite server statement limit does not guarantee rollback or bound separately spawned
work. Incompatible detached-query/autocommit policy fails closed rather than being disabled.
Connections use no client heartbeat, but retained server sessions follow Snowflake policies;
local connection capacity does not cap retained server sessions or detached query credit usage.
The pinned driver's public stream destruction cannot guarantee cancellation of all in-flight
chunk downloads. Lookup abort/timeout cleanup stops SDK consumption, not all possible driver activity.

Browser clients schedule requests, not server background workers. Each detached result lookup
checks status once and returns pending only for observed nonterminal work; errors and timeouts
must not be presented as pending. Closing the browser does not cancel the query in Snowflake.

Persist query records before responding and avoid SQL replay after uncertain submission.
A crash before durable registration can leave an unregistered query. Application expiry
does not extend Snowflake result retention; use separate result storage when needed.
Do not infer deployment or multi-user authorization guarantees from synthetic query registries.

Dependency advisories and live platform testing are release gates.
Do not treat offline fixtures or coverage percentages as evidence of authorization safety
in a deployed app.
