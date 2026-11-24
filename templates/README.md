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

# Templates

Starter projects for Snowflake App Runtime apps. Each directory is one template: a working app
with an `app.yml` deployment manifest and a `README.md` on how to build on it.

| Template                     | Runtime | Use it for                                                                         |
| ---------------------------- | ------- | ---------------------------------------------------------------------------------- |
| [`nextjs`](nextjs/README.md) | Node.js | The default. Next.js, TypeScript and React, with Tailwind CSS, shadcn/ui, Recharts |

## Create an app from a template

Snowflake CLI lists the templates and creates a project from one:

```bash
snow app templates
snow app init my-app --template nextjs
```

`snow app init` reads the templates at the `templates-v1` tag, which marks the released templates.
It checks every file against the catalog, and fills in where the app deploys from your account's
defaults. `--ref main` reads the unreleased templates instead.

## Placeholders

A template's `app.yml` leaves where the app deploys to whoever creates the project:

| Placeholder           | Value                                                          |
| --------------------- | -------------------------------------------------------------- |
| `<%APP_NAME%>`        | The app's name in upper case: letters, digits, and underscores |
| `<%DATABASE%>`        | The database the app deploys to                                |
| `<%SCHEMA%>`          | The schema the app deploys to                                  |
| `<%QUERY_WAREHOUSE%>` | The warehouse the app's queries run on                         |
| `<%LABEL%>`           | The app's display name                                         |

`snow app init` and Snowsight Workspaces replace them from the account's defaults, and add
`build_eai` after `query_warehouse` when the account sets one. To use a template another way, copy
its directory and replace the placeholders yourself: `snow app setup --app-name=<app_name> --dry-run`
prints your account's values.

The first line of `app.yml` records where the project came from. `snow app init` replaces it with
`# created-by: snow-app-init; template=<id>; ref=<ref>; commit=<commit>`.

## Catalog

[`catalog.json`](catalog.json) lists the templates for clients that offer a choice. It is
generated, so don't edit it by hand. Each entry has:

- `id`, the template's directory name, and `path`, the directory in this repository.
- The metadata from the template's `template.json`: `title`, `summary`, `when_to_use`,
  `when_not_to_use`, `runtime`, `framework`, `requires`, `surfaces`, and `default`. `requires`
  lists the account capabilities the app needs, named as `snow app setup --capabilities` reports
  them. `surfaces` lists where the template is offered: `cli`, `workspaces`, or both. Exactly one
  template sets `default`.
- `files`: the path, size, and SHA-256 digest of every file a new project gets, which is every
  file in the directory except `template.json`.
- `digest`: the SHA-256 digest of that file list as `sha256sum` prints it. From the template's
  directory in a checkout,
  `git ls-files | grep -vx template.json | LC_ALL=C sort | xargs sha256sum | sha256sum` prints
  the same digest.

`catalog_version` changes only when a change to the format would break existing clients. Each
version has its own release tag, `templates-v<catalog_version>`, so existing clients keep reading
releases in the format they know.

## Add or change a template

1. To add a template, create a directory named after its ID, in lowercase letters, digits, and
   hyphens. Put the app in it, with an `app.yml` that uses the placeholders above and a
   `README.md` on how to build on it. Add a `template.json` with its catalog metadata:

   ```json
   {
     "title": "Next.js",
     "summary": "What the app is and what it ships with.",
     "when_to_use": "The requests it suits.",
     "when_not_to_use": "The requests another template suits better.",
     "runtime": "node",
     "framework": "nextjs",
     "requires": [],
     "surfaces": ["cli", "workspaces"],
     "default": false
   }
   ```

   The generator rejects unknown fields, a `runtime`, `requires`, or `surfaces` value it doesn't
   know, and a catalog without exactly one default template.

2. Check that the app still installs, builds, runs locally, and deploys.
3. From the repository root, regenerate the catalog and commit it with the change:

   ```bash
   node scripts/templates/catalog.mjs          # writes templates/catalog.json
   node scripts/templates/catalog.mjs --check  # fails if it is out of date
   ```

Every file in a template's directory except `template.json` is copied into each new project, so
keep build output, local configuration, and secrets out of it.
