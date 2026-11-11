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

# Changelog

## Unreleased

- **Breaking:** `fromToml()`, and `fromDefault()` when it reads a profile, turn on the driver's
  token cache for profiles that log in with `EXTERNALBROWSER` or `OAUTH_AUTHORIZATION_CODE`
  (`clientStoreTemporaryCredential`), and its MFA token cache for `USERNAME_PASSWORD_MFA`
  (`clientRequestMFAToken`). Each owner operation opens a fresh session, so without the cache
  every query logged in again, opening a browser each time for SSO. Set
  `client_store_temporary_credential` or `client_request_mfa_token` to `false` in the profile to
  keep the old behavior.
- The SDK now depends on `snowflake-sdk` 3.4.1 instead of 3.4.0. That release changes how the
  driver handles a failed session token renewal: requests queued during the renewal fail instead
  of being sent, and reading a result on the disconnected connection reports the original error.

## 0.1.0

First release. Before 1.0, a breaking change bumps the minor version, so `^0.1.0` never
installs one.

## 0.1.0-dev.1

Initial development version of the SDK.
