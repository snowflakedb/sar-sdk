# Next.js Template for Snowflake Apps

Minimal Next.js app deployed as a Snowflake App. Queries Snowflake using the SAR SDK (`@snowflake/sar-sdk`, built on the [Node.js driver](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver)) and demonstrates server-side rendering, API routes, caller's rights, and secret access.

> **This README is the build guide for this template.** It is the authoritative, self-contained reference for what the template provides and how to modify its code to implement an application. The `snowflake-apps` skill scaffolds this template and then follows this README. Platform concerns that are the same for every template — where `app.yml` deploys, `snow app deploy`, and post-deploy operations — are driven by the skill, not this file.

---

## What this template already provides (DO NOT recreate)

| File                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/snowflake.ts`                          | Exports `snowflake`, the app's single SAR SDK client (owner's rights), and `asCaller()`, which returns the caller's-rights view for the current request. The SDK handles platform auth, local-dev auth, queries, secrets, and account REST calls. The client reads its connection on first use, so `next build` needs no Snowflake connection. Import from `@/lib/snowflake` in server code.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `node_modules/@snowflake/sar-sdk/README.md` | The SDK's own README, and the API reference for everything `lib/snowflake.ts` exposes. `@snowflake/sar-sdk` is a normal npm dependency pinned to an exact version in `package.json`; read this file rather than guessing at the API.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lib/constants.ts`                          | `APP_TITLE` and `LOGO_SRC`, used by the page metadata in `app/layout.tsx` and the welcome page. Edit this file to rebrand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lib/run-as.ts`                             | `withCaller(load)` runs a loader with the caller's-rights client in a deployed app; `queryAsCaller(sql)` is its single-query shorthand. Missing caller context and query failures propagate without retrying as the owner, so row access and masking policies keep evaluating against the viewer. The result includes `identity: "caller" \| "dev"`. `"dev"` means local dev or a Workspaces preview, where queries use the developer's connection: never label those results as the viewer's. `resolveDatabase(client?)` returns a quoted database name to qualify `INFORMATION_SCHEMA` table functions with (they fail when the session has no current database). `quoteIdent(name)` quotes an identifier for `SHOW`, `DESCRIBE` and object names, which cannot take bind values; never interpolate an unquoted name. |
| `lib/clipboard.ts`                          | `copyText(text)` returns `true` only when the copy worked, falling back to a hidden textarea where the Clipboard API is blocked (Snowsight runs apps in an iframe). Show "copied" only on `true`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `next.config.mjs`                           | Standalone output, unoptimized images, **and the Next.js workspace-root pin** (`turbopack.root` + `outputFileTracingRoot` set to `__dirname`). The pin is critical: Next.js 16 + Turbopack walks upward looking for a lockfile and silently re-roots the project if it finds one in a parent directory, which breaks `/` (404) and chunk URLs and corrupts `outputFileTracingRoot` at deploy time. **Do not remove the pin** when adding new config; merge with the existing object instead.                                                                                                                                                                                                                                                                                                                            |
| `lib/format.ts`                             | Display formatters for query results: `formatNumber`, `formatCompact`, `formatCurrency`, `formatPercent`, `formatDate`, `formatDateTime`, `formatRelative` ("5 min ago"), `formatDuration` (ms), `formatBytes`, `formatValue` (any cell), and `isNumeric`. All accept number, numeric string, `Date`, or null and return `"—"` for missing values. Use these instead of ad-hoc `toLocaleString` calls.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `components/chart-utils.tsx`                | `CHART_COLORS` and `CHART_THEME` (series, grid and axis colors from the theme's `--chart-*` tokens), `getYAxisWidth`, `formatTick`, and `ChartTooltip`. Use them in any chart so it follows the theme.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `public/icon.svg`                           | Default app icon used by browser metadata and the app's `icon` manifest field. **Replace this with a custom SVG that clearly represents the specific app being built.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Installed and ready, but none of it is required. They are here because adding a dependency is awkward in a Snowsight workspace, not because every app should use them:

- **API fetching**: `@tanstack/react-query`. Client components that fetch API routes should use `useQuery`: `const { data, error, isPending } = useQuery({ queryKey: ["orders"], queryFn: async () => { const r = await fetch("/api/orders"); const body = await r.json(); if (!r.ok) throw new Error(body.error ?? "Request failed"); return body } })`. Check `r.ok`: without it an error response becomes `data`. The `QueryProvider` in `components/query-provider.tsx` wraps the root layout.
- **Styling**: Tailwind CSS v4, theme tokens, system font stacks and motion utilities in `app/globals.css` (see Designing the app).
- **UI primitives**: shadcn/ui is configured (`components.json`). `Button`, `Card`, `Alert`, `Badge`, `Separator`, `Skeleton`, `Table`, `Sheet` and `Dialog` are in `components/ui/`. They are building blocks with no layout opinion. `Table` adds `striped` and `bordered` props on `<Table>` and a `numeric` prop on `TableHead`/`TableCell` that right-aligns with tabular figures. `Badge` adds `success` and `warning` variants. `CardTitle` is `text-base`, not shadcn's `text-2xl`; re-running `npx shadcn add card` resets it. Run `npx shadcn@latest add <component>` only for components not yet present.
- **Charts**: `recharts`, with `components/chart-utils.tsx` for theme-aware colors.
- **Icons**: `lucide-react`.
- **Dark mode**: `components/theme-provider.tsx` follows the OS setting and stores an override; `components/theme-toggle.tsx` is a ready-made switch. Where (or whether) the toggle appears is up to the app.
- **Motion**: `animate-rise`, `animate-grow-x` and `CountUp` (`components/count-up.tsx`), plus `tw-animate-css` (used by `Sheet` and `Dialog`). See Designing the app.

**Do NOT modify `lib/snowflake.ts` or `next.config.mjs` unless requirements demand it.** If you do edit `next.config.mjs`, also check for `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` in any parent directory of the app folder. If one exists, it will silently re-root the workspace and undo the workspace-root pin — warn the user.

---

## Implementing your app

Modify the scaffolded project **in one pass** to fully implement everything the user asked for. The template provides the skeleton; you fill in the real application.

**CRITICAL: NEVER use mock or hardcoded data. Every route/page must query real Snowflake tables.**

### The welcome page (replace it)

`app/page.tsx` is a branded welcome page: it shows the connection (user, role, warehouse, and whether caller's rights is active) and three next steps. It exists so a freshly copied template works and says what to do. It is not a layout to build on.

When you build the user's app, **replace `app/page.tsx` entirely and delete `components/welcome/`** (the copy-prompt button). Do not keep its single-column shell, connection list or step list unless the app genuinely needs them. `app/layout.tsx` renders no header or navigation, so add whatever shell the app needs (or none).

Keep `components/ui/`, `chart-utils.tsx`, `lib/format.ts`, `lib/run-as.ts`, `lib/clipboard.ts`, `lib/describe-property.ts`, and `app/api/query/` (the caller's-rights example route).

What you MUST create or modify:

1. **`app/page.tsx`** — Replace the demo page with the real application UI. This is a Server Component by default.
   - Use `export const dynamic = "force-dynamic"` on any page that queries Snowflake.
   - Import `snowflake` (and `asCaller` for caller's rights) from `@/lib/snowflake` for server-side data fetching.
2. **`app/api/` routes** — Replace or add API route handlers for any data the frontend needs to fetch client-side.
   - Every route must query Snowflake through `@/lib/snowflake` with real SQL — no mocks. `query()` waits up to 10 minutes. For work that must outlive the HTTP request, use `submitDetached()` and `pollQuery()` (see the SDK README).
   - Always include `export const dynamic = "force-dynamic"`.
3. **`app/layout.tsx`** — Update the page title and description to match the app.
4. **`app/globals.css`** — Adjust the theme tokens to suit the app. Keep both the light and dark blocks.
5. **Client Components** — Create as many `"use client"` components as needed. Place them in `app/` or `components/`.
   - Client components CANNOT import `@/lib/snowflake` directly. They must `fetch()` an API route.
6. **Additional libraries** — If the app needs charting, UI components, or icons, add them to `package.json` under `dependencies`. Good defaults:
   - **Charts**: `recharts` (already installed), with `components/chart-utils.tsx` for `CHART_COLORS` / `CHART_THEME`, `getYAxisWidth` (prevents Y-axis label clipping) and `ChartTooltip` (readable on dark backgrounds).
   - **UI components**: shadcn/ui (`npx shadcn@latest add <component>`)
   - **Icons**: `lucide-react` (already installed)
   - **Date handling**: `date-fns`
7. **`public/icon.svg`** — Replace the template/default SVG with a relevant custom app icon. This is required, not optional (see below).

### App icon requirement

Before finishing, update `public/icon.svg`. Do not leave the template/default icon in place.

- Generate a simple, original SVG icon that matches the app's domain, data, or primary workflow.
- Keep it self-contained in `public/icon.svg`; do not reference external fonts, images, or remote assets.
- Prefer readable shapes, restrained color, and a professional Snowflake Apps style over generic logos or decorative gradients.
- Verify `app/layout.tsx` still references `/icon.svg`, and that the top-level `icon` key in `app.yml` points at `public/icon.svg`.

---

## Querying Snowflake

`snowflake` is a `SarClient` from `@snowflake/sar-sdk`. The SDK's README (`node_modules/@snowflake/sar-sdk/README.md`) is the reference for everything below; read it before using an API not shown here.

The template pins `@snowflake/sar-sdk` to `0.1.0`, the first release under npm's `latest` tag. Before 1.0, breaking changes bump the minor version; the exact pin keeps installs reproducible. Read the installed SDK README and changelog before upgrading.

`createSarClient` accepts no arguments (default connection), a provider from `createConnectionOptions()`, or `SarClientComponents` containing `queryClient`, `fetchClient`, and `secretsClient`. It does not accept a general options object. This template composes components so it can inject the configured driver and logger into `createConnectionManager(options, { driver, logger })` from `/connections`. Result and query-timeout settings belong on `createQueryClient(manager, settings)` from `/query`; HTTP settings belong on `createFetchClient(options, settings)` from `/http`. Secrets use `createSecretsClient()` from `/secrets`. SQL and HTTP share the same connection-options provider, including the development-only `callerAsOwner` setting.

- **`query(sql, options?)`** runs one statement and resolves to `{ rows, columns, queryId, rowCount }`. Rows are objects keyed by column name. In the default JSON format, NUMBER values are decimal strings and timestamps are strings, not `Date` objects. It waits up to 10 minutes by default (`waitTimeoutMs`).
- **`stream(sql, options?)`** returns an async iterable of rows for results too large to hold in memory.
- **`submitDetached()` / `pollQuery()`** run work that must outlive one HTTP request: the browser polls an API route until the result is ready. See "Detached queries across requests and instances" in the SDK README.
- **`withConnection(callback)`** gives raw driver access for transactions and multi-statement work.
- **`secrets`** reads Snowflake `SECRET` values (see **Secrets** below), and **`fetch(path, init?)`** makes authenticated calls to account REST APIs such as `/api/v2/...`.

Pass `{ warehouse }` and `{ binds }` on `query()` when a statement needs them. Errors are `SarError`s with a stable `code` (check with `isSarError` from `@snowflake/sar-sdk`). When Snowflake rejects a query, `details.errorCode` holds its numeric code (`002003` missing or unauthorized object, `003001` insufficient privileges, `000904` invalid identifier). Snowflake's own message can quote SQL literals, so the SDK keeps it out of `message` and `toJSON()`: `console.error(error)` prints it to the server log. Never send `cause` to the browser; map `errorCode` to a plain message instead (see Critical error handling below).

---

## Auth modes: owner's rights vs caller's rights

Both modes can be used in the same app. Use `snowflake.query(sql)` for data the service can always access, and `(await asCaller()).query(sql)` for data that must respect the calling user's permissions. In a route handler you can also pass the request's headers directly: `snowflake.asCaller({ headers: request.headers })`.

- **Owner's Rights**: queries run as the service identity. Use for shared/reference data that all users can see.
- **Caller's Rights**: queries run as the user who opened the app. Required for row-level security, column masking, or per-user data isolation. See [SPCS caller's rights docs](https://docs.snowflake.com/en/developer-guide/snowpark-container-services/tutorials/advanced/tutorial-7-callers-rights).

### Caller's rights needs no `app.yml` configuration

There is nothing to enable. Snowflake declares every App Runtime app caller's-rights-capable and injects the `sf-context-current-user-token` header on every ingress request. Do not add an `executeAsCaller` key to `app.yml` — `run:` accepts only `command`, and unknown keys are silently ignored, so it looks applied while doing nothing.

Two things are on you:

1. **Use the caller view per query.** Owner's rights is the default for `snowflake.*`, so every query that must respect row access policies or masking must run on the view returned by `asCaller()`. Create the view inside the request that uses it; never store it across requests.
2. **Caller grants must exist on the app's owning role.** Without them, queries fail even though the calling user has access. See `references/permissions.md`.

If a caller's-rights query returns the wrong identity or no rows, see the troubleshooting section in `references/debugging.md`.

> **Local dev note:** Local requests have no platform caller token; a Workspaces preview can send one, but it does not behave as deployed app ingress does. `lib/snowflake.ts` sets `callerAsOwner` on `createConnectionOptions()` when `NODE_ENV` is `development` (`next dev`, including a workspace preview), so caller views use the developer's connection there. A deployed app runs `next start` and does not set it. Don't widen that condition.

---

## Code patterns

**Owner's Rights — Server Component:**

```typescript
import { snowflake } from "@/lib/snowflake"
export const dynamic = "force-dynamic"

export default async function Page() {
  const { rows } = await snowflake.query("SELECT * FROM DB.SCHEMA.LOOKUP_TABLE")
  return <div>{/* render rows */}</div>
}
```

**Owner's Rights — API route:**

```typescript
import { snowflake } from '@/lib/snowflake';
export const dynamic = 'force-dynamic';

export async function GET() {
  const { rows } = await snowflake.query('SELECT ...');
  return Response.json(rows);
}
```

**Caller's Rights — Server Component:**

```typescript
import { asCaller } from "@/lib/snowflake"
export const dynamic = "force-dynamic"

export default async function Page() {
  const { rows } = await (await asCaller()).query("SELECT * FROM DB.SCHEMA.SENSITIVE_TABLE")
  return <div>{/* render rows */}</div>
}
```

**Caller's Rights — API route:**

```typescript
import { snowflake } from '@/lib/snowflake';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { rows } = await snowflake.asCaller({ headers: request.headers }).query('SELECT ...');
  return Response.json(rows);
}
```

**Bind parameters (always use for user-supplied values — prevents SQL injection):**

```typescript
import { snowflake } from '@/lib/snowflake';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  // Use `?` placeholders and pass values via `binds` — never string-concatenate input into SQL.
  const { rows } = await snowflake.query('SELECT * FROM DB.SCHEMA.ORDERS WHERE id = ?', {
    binds: [id],
  });
  return Response.json(rows);
}
```

**Work that outlives the request** uses `submitDetached()` on the first request and `pollQuery()` on later ones. Read "Detached queries across requests and instances" in the SDK README before writing that route. `query()` already waits up to 10 minutes, so a slow statement that finishes inside one request does not need a second helper.

**Client component consuming an API route (same for both auth modes):**

```typescript
"use client"
import { useEffect, useState } from "react"

export function DataTable() {
  const [data, setData] = useState([])
  useEffect(() => {
    fetch("/api/data").then(r => r.json()).then(setData)
  }, [])
  return <table>{/* render data */}</table>
}
```

**Critical error handling:**

```typescript
import { isSarError } from "@snowflake/sar-sdk"

try {
   ...
} catch (e) {
  // The full error, including Snowflake's message, goes to the server log only.
  console.error(new Date().toISOString(), "[useful message]", e)
  const code = isSarError(e) ? e.details.errorCode : undefined
  const message =
    code === "002003" ? "That object does not exist or you cannot see it." :
    code === "003001" ? "Your role does not have access to that." :
    "The query failed. Check the server log for details."
  return Response.json({ error: message, code }, { status: 500 })
}
```

---

## Designing the app

**Before you design the UI, load the `snowflake-apps` skill's `references/design.md`** and follow it: write the design brief, build to it, then review screenshots. The app should look stunning and purpose-built. It does not need to look like Snowflake, like the welcome page, or like any other app made from this template. This section covers only the code-level pieces.

### Palette, type and atmosphere

- **Palette:** `app/globals.css` defines every color as a CSS variable, with a light block (`:root`) and a dark block (`.dark`). The values shipped are a neutral starting point: **replace them with the app's own palette** in both blocks. Components, focus rings and charts follow the variables, so use tokens (`bg-card`, `text-muted-foreground`, `border`, `bg-chart-2`...) rather than hard-coded colors. Set `DEFAULT_THEME` in `lib/constants.ts` to the app's designed default (`'light'`, `'dark'` or `'system'`); viewers can still switch with the toggle. If the app has only one theme, set it and drop the toggle.
- **Fonts:** the template uses system font stacks. Choose fonts that fit the app's direction:
  1. `npm install @fontsource-variable/<font>` (for example `@fontsource-variable/fraunces`) and `import '@fontsource-variable/<font>'` in `app/layout.tsx`. The CSS family name is the font's name plus `Variable`, for example `'Fraunces Variable'`.
  2. In `app/globals.css`, point `--font-sans` / `--font-mono` in the `@theme inline` block at the new families (add a `--font-display` if you use a display face).
  3. Do not use `next/font/google`: it downloads at build time, and the build may have no internet access. In a Snowsight workspace, a new dependency also needs the `install` phase described in the `sar-actions-workspaces` skill.
- **Atmosphere:** plain CSS is enough: a tinted or dark panel, `radial-gradient` dot or grid textures, a gradient behind the focal element. Keep it static and tied to the subject.

### Motion

- `animate-rise` (fade and rise in) and `animate-grow-x` (grow from the left edge; set `origin-right` to grow from the right) are defined in `app/globals.css`. Stagger them with `style={{ animationDelay: '120ms' }}`. Both switch off under `prefers-reduced-motion`.
- `components/count-up.tsx` exports `CountUp`, which counts a number up once on load (`<CountUp value={n} format={formatBytes} />`). It is safe under React's development double effects.
- `tw-animate-css` provides `animate-in fade-in slide-in-from-bottom-2` and friends.
- **Turn off Recharts' own draw animation** (`isAnimationActive={false}`) and animate the section instead: Recharts restarts its animation on every resize, which can leave a chart blank.

### Charts

`recharts` is installed. `components/chart-utils.tsx` provides `CHART_COLORS` / `CHART_THEME` (from the `--chart-*` tokens), `niceTicks` (round ticks fitted to the data, so trends are visible), `formatTick`, `getYAxisWidth` and `ChartTooltip`. Style charts to the app's palette: gradient fills via `<defs><linearGradient>`, minimal gridlines, a custom tooltip. Choose the chart form that answers the question; a hand-built SVG or CSS chart (a share bar, a diverging bar, a heat strip) is often better than a default Recharts bar chart. For hand-built SVG, draw at the measured container width (a `ResizeObserver` with a callback ref) rather than scaling a fixed `viewBox`, which shrinks text to unreadable sizes on mobile. Keep axis labels inside the chart's own column so they never collide with neighbouring text.

### Every app must

- show a loading state, an empty state for zero rows, and an error state for failed queries on every piece of data;
- right-align number columns with tabular figures (`numeric` on `TableHead`/`TableCell`);
- page, limit or virtualize long lists: a first page of 10 to 50 rows with a way to see more, not hundreds at once;
- work at 390px wide with no sideways page scroll: give grid and flex children `min-w-0` (including wrapper divs that only exist for an animation delay), use `truncate` or `break-all` on long text (a long identifier in a sentence overflows too), keep wide tables inside `<Table>` (its wrapper scrolls), and drop or stack secondary columns on small screens;
- meet contrast (body text at least 4.5:1 against its background) and keep visible focus states, whatever the palette.

### Screenshot recipe

`references/design.md` requires reviewing screenshots before you finish. With the dev server running, run `scripts/screenshot.py` from the project root (the folder with `app.yml`). It captures desktop and mobile, in light and dark, once the data has loaded, and prints where it saved them:

```
uv run --with playwright python scripts/screenshot.py http://localhost:3000/
```

If Chromium is missing, run `uv run --with playwright playwright install chromium` once.

---

## Local development

> **In a Snowsight workspace, click **Preview** (or ask CoCo to open it via `sar_action open_preview`) — the commands below are for CoCo CLI / Desktop only.** The Snowsight workspace filesystem is a stage mount, so running `npm install` / `npm run dev` from the workspace shell will hang or silently fail. See the `sar-actions-workspaces` skill for the workspace flow.

```bash
npm install
npm run dev
```

The app reads credentials through `fromDefault()`: the mounted platform token when deployed, otherwise the default [Snowflake CLI](https://docs.snowflake.com/en/developer-guide/snowflake-cli/connecting/specify-credentials) profile. Locally the SDK honors `SNOWFLAKE_HOME` for the configuration directory, reads `config.toml` and `connections.toml`, and selects `default_connection_name` or the profile named `default`.

The SDK does not inherit another tool's active connection or apply connection environment-variable overrides. To use a named profile, explicitly replace `fromDefault()` in `lib/snowflake.ts` with `fromToml({ name: 'myconn' })` from `@snowflake/sar-sdk/auth` for local development, retaining `fromDefault()` for deployed credentials. For another source, pass driver connection options you construct to `createConnectionOptions()`; keep credentials in server-side credential storage, not source code.

The app runs at `http://localhost:<port>` (read the actual port from the dev-server output — Next.js auto-increments away from 3000 when busy). On first API request, the browser opens for Snowflake SSO authentication.

Start the dev server **in the background** — it's a long-running process.

### Two valid local-preview commands, one anti-pattern

| Command                              | When to use                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` (`next dev`)           | Iterative development with hot reload. Default choice for code changes.                                                         |
| `npm run start` (`next start`)       | Production-mode preview before deploy — useful when you want to test against the same code path Next.js will run in production. |
| ❌ `node .next/standalone/server.js` | **Never use this for local preview.**                                                                                           |

**Why `node .next/standalone/server.js` is wrong locally:** The standalone server is a deployment artifact for the Snowflake App Runtime container image — it serves _only_ the minimum needed at runtime and does **not** serve `.next/static` or `/public`. Symptoms when you run it locally: pages render unstyled, all `/_next/static/chunks/*.js|*.css` return 404, client components never hydrate so the UI stays on "Loading…". Reserve the standalone server for deploy verification, not iteration.

### Dev-server output signatures to watch for

`next dev` prints compile and request problems to the shell it runs in. After it starts, and after each edit that triggers a recompile, read that output and act on these signatures:

| Signature in the output                       | What it means                                                  | Where to look                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `Failed to compile`                           | TypeScript/JSX build error — the page won't render until fixed | The file + line in the block right below it                                                                 |
| `Module not found: Can't resolve '…'`         | Bad import path or a missing dependency                        | Fix the import, or add the package to `package.json` and re-`npm install`                                   |
| `Type error:` / `TS####:`                     | TypeScript type error                                          | The cited file:line                                                                                         |
| Lines beginning `   at`                       | A runtime stack trace — read upward past the framework frames  | The first frame pointing into `app/`, `components/`, or `lib/`                                              |
| `GET /… 500` (or a `500` on an `/api/*` line) | A server-side crash in a route/page                            | The `[snowflake]` / `console.error` lines just above it — usually auth, a missing grant, or wrong warehouse |
| `⨯` prefix                                    | Next.js error marker for the line that follows                 | The message after the marker                                                                                |

Distinguish these from benign noise that resolves on its own: `✓ Compiled`, hot-reload / Fast Refresh notices, and the one-time SSO browser prompt on the first Snowflake query are **not** failures. A `500` seen while you're mid-edit may clear once the recompile finishes — confirm it persists before chasing it.

### Verify before declaring success

> **In a Snowsight workspace, verify with `sar_action open_preview` + `get_preview_logs` instead** — see the `sar-actions-workspaces` skill. The curl checks below rely on `localhost` and apply to CoCo CLI / Desktop local dev only.

After starting a local preview (either `npm run dev` or `npm run start`), run all three checks and confirm they pass before reporting back to the user:

```bash
# 1. Homepage returns 200 with non-empty body
curl -fsS http://localhost:<port>/ | head -c 200

# 2. At least one /api/* route returns 200 with JSON
curl -fsS http://localhost:<port>/api/<your-route>

# 3. Static chunks resolve (catches the standalone-server / re-rooted-workspace bugs)
curl -fsS -o /dev/null -w "%{http_code}\n" http://localhost:<port>/_next/static/chunks/<any-chunk>.js
```

If any check fails — particularly chunks 404'ing — diagnose before telling the user the app is up. Common causes:

- **404 on `/_next/static/chunks/*`**: you ran the standalone server (use `next dev` / `next start` instead) **or** `next.config.mjs` lost its `turbopack.root` / `outputFileTracingRoot` pin and Turbopack re-rooted to a parent directory with a stray lockfile. Re-pin and rebuild.
- **404 on `/`**: same re-root cause (chunk URLs end up under `/<app-dir>/app/...`).
- **API route returns 500**: look at the dev-server output for the specific Snowflake error — typically auth, missing grant, or wrong warehouse.

---

## Testing

The template ships with [Vitest](https://vitest.dev/) pre-wired and working example tests in `__tests__/` — extend these rather than introducing a different test runner.

| File                              | What it covers                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `vitest.config.ts`                | Node environment, `@` path alias                                                                                          |
| `__tests__/lib/snowflake.test.ts` | Unit tests for `lib/snowflake.ts`: one shared client created on first use, and `asCaller()` scoped to the request headers |
| `__tests__/api/query.test.ts`     | Route-handler tests that mock `snowflake` and `asCaller` and assert on the `Response` shape                               |
| `__tests__/lib/format.test.ts`    | Unit tests for the formatters                                                                                             |

```bash
npm test   # vitest run
```

**Caller's rights is on under Vitest.** `callersRightsActive()` is true whenever `NODE_ENV` is not `development`, and Vitest sets `test`, so `withCaller()` calls `asCaller()`. A route test must mock `asCaller` to resolve a client (`asCaller: vi.fn(async () => ({ query: callerQuery }))`), as `query.test.ts` does; `asCaller: vi.fn()` alone crashes. To test error mapping, throw a real SDK error: `new SarError("QUERY_FAILED", "failed", { errorCode: "002003" })` (import `SarError` from `@snowflake/sar-sdk`).

**Pattern: mock `lib/snowflake`, test everything around it.** Don't hit real Snowflake in unit tests. Mock the `snowflake` client exported by `lib/snowflake` (for example `vi.mock("../../lib/snowflake", () => ({ snowflake: { query: vi.fn() }, asCaller: vi.fn() }))`, resolving `{ rows: [...] }`) and assert on route logic, response shape, and error handling, following `query.test.ts`. This keeps tests fast and deterministic.

**Code coverage** is standard Vitest, not a Snowflake-specific feature — add `@vitest/coverage-v8` and a `coverage` block to `vitest.config.ts` if the project needs it; nothing here configures thresholds for you.

**Integration tests against real Snowflake data** run the same way local dev does: `npm run dev` / `npm run start` already authenticate through the developer's `snow` CLI connection (see Local development above), so integration-style tests can call the running app's routes and hit real tables. For a staged environment, declare `dev`/`stage`/`prod` `targets` in `app.yml` (see `references/manifests.md`) and run integration tests against the `dev`/`stage` URL before promoting to `prod`.

**Pre-deploy sanity checks** (manifest and bundle correctness, not app logic) don't require a deploy:

```bash
snow app validate   # confirms the target database/schema resolve and the project can be bundled
snow app bundle     # copies resolved artifacts to ./output/bundle so you can inspect what would be uploaded
```

**CI/CD**: `snow app deploy` is a standard CLI command callable from any pipeline. The common pattern is `npm ci && npm test` (plus `snow app validate`) as a gate before `snow app deploy --target <name>`, authenticating via OIDC (workload identity federation) rather than long-lived credentials. Don't hand-write this: use the `ci-cd` skill for the full setup on GitHub Actions, GitLab CI, or Azure DevOps — service user, network policy, secrets, checkpoints, and verification. It detects this as a Snowflake App Runtime project and pulls the deploy-step content (which `snow app deploy` phase/target to run) from `references/cicd.md`.

---

## API route pitfalls

### History table functions and columns

- `INFORMATION_SCHEMA.QUERY_HISTORY*` and `TASK_HISTORY()` reject a start time of exactly 7 days ago (error 001426): stay a few minutes inside the limit (for example `DATEADD('hour', -167, CURRENT_TIMESTAMP())`). They also lack some columns `ACCOUNT_USAGE` views have.
- `ACCOUNT_USAGE` days are UTC and the current day is partial: leave it out of daily comparisons, or label it.
- `ERROR_MESSAGE` columns in history views can quote SQL and literals, just like `SarError` causes. Group by `ERROR_CODE` and show your own labels rather than raw messages.
- Some "flag" columns are strings, not booleans: `LOGIN_HISTORY.IS_SUCCESS` is `'YES'` / `'NO'`.

### Slow queries: load sections independently

`SNOWFLAKE.ACCOUNT_USAGE` views and account-wide `INFORMATION_SCHEMA` table functions (such as `TASK_HISTORY()`) can take from several seconds to minutes, and `ACCOUNT_USAGE` data lags by up to a few hours. Give each slow piece of data its own API route and its own loading state, so the fast parts of the page render first. When several sections read the same slow table function, one scan that returns tagged rows (`UNION ALL` of aggregates, each with a section label) is faster than one query per section. Aggregate and limit in SQL so responses stay small. If you cache a result on the server, key the cache by viewer (role and user) under caller's rights, and drop or refresh anything time-sensitive (an "up next" list) before it goes stale. Tell the viewer how fresh the data is.

### OBJECT, ARRAY and MAP columns need `format: "native"` or a VARIANT cast

The default JSON result format rejects OBJECT, ARRAY and MAP columns with `RESULT_CONVERSION_UNSUPPORTED`. That includes `DESCRIBE TABLE` output and `SELECT *` on any table that has such a column. Cast the column to VARIANT (`col::VARIANT`) to get its exact JSON text, or pass `{ format: "native" }` to `query()` for the driver's own conversion. When you don't know the columns in advance (a table browser, `SELECT *`), use `format: "native"`.

### Route files can only export route handlers

`app/api/**/route.ts` may export only `GET`, `POST` and the other handlers plus route config such as `dynamic`. Exporting anything else (a SQL constant, a helper) fails the build. Put SQL and helpers in `lib/` and import them.

### Result values are JSON-safe strings by default

`snowflake.query()` uses the SDK's default JSON format. NUMBER values are decimal strings, and `TIMESTAMP_*` values are strings such as `2026-06-03T09:14:52.000000000`, not JavaScript `Date` objects. `lib/format.ts` accepts both numbers and numeric strings. Convert a NUMBER to a number only when it is exactly representable; a value such as `9007199254740993` must stay a string. The SDK README's "Queries and Ownership" section lists every type.

`String(date)` on a real `Date` (only if you opt into `format: "native"`) produces locale text like `"Tue Jun 03 2026 09:14:52 GMT+0000 (UTC)"`, which breaks `.slice(0, 10)` and chronological sorts. This template does not use native format. If a route does, convert with `date.toISOString()` before putting the value in a response.

---

## Secrets

How this template reads sensitive values (API keys, username/password credentials, OAuth2 tokens) at runtime, both locally and in SPCS.

### Golden rule

**Always read secrets through `snowflake.secrets` from `@/lib/snowflake`.** Do NOT:

- Read `process.env.SNOWFLAKE_SECRET_*` directly — `snowflake.secrets` prefers the mounted secret file in SPCS and only falls back to the env var for local dev; reading the env var yourself skips the mounted file.
- Query the `SECRET` object at runtime (e.g. `SYSTEM$GET_SECRET`, `SELECT ... FROM SECRET`) — this is insecure and not supported in app code.

`snowflake.secrets` already abstracts the local-dev vs SPCS difference, so the same app code works in both environments. Call it only in server code (Server Components or API route handlers) — never expose a secret value to a client component or include it in a response sent to the browser. Every method is async.

### API

```typescript
import { snowflake } from '@/lib/snowflake';

const apiKey = await snowflake.secrets.getString('API_KEY'); // => string
const { username, password } = await snowflake.secrets.getPassword('DB_CREDS'); // => { username, password }
const token = await snowflake.secrets.getAccessToken('MY_OAUTH'); // => string
```

### Supported secret types

| Method           | Snowflake `SECRET` type | Returns                           | Mounted file(s) in SPCS                                | Env-var fallback (local dev)                                                              |
| ---------------- | ----------------------- | --------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `getString`      | `GENERIC_STRING`        | `Promise<string>`                 | `/secrets/<name>/secret_string`                        | `SNOWFLAKE_SECRET_<NAME>_SECRET_STRING`                                                   |
| `getPassword`    | `PASSWORD`              | `Promise<{ username, password }>` | `/secrets/<name>/username`, `/secrets/<name>/password` | `SNOWFLAKE_SECRET_<NAME>_USERNAME`, `SNOWFLAKE_SECRET_<NAME>_PASSWORD`                    |
| `getAccessToken` | `OAUTH2`                | `Promise<string>`                 | `/secrets/<name>/access_token` (auto-rotated)          | client-credentials refresh flow (see [Local development setup](#local-development-setup)) |

OAuth tokens expire in minutes. In SPCS `getAccessToken` reads the auto-rotated mounted token fresh on every call. Locally it mints and refreshes tokens via the OAuth2 client-credentials grant (cached in memory, refreshed just before expiry). An empty mounted file fails closed and does not fall back to a stale env var.

### Resolution order

For string and password secrets, `snowflake.secrets`:

1. Reads the **mounted file** `/secrets/<name>/<field>` (present in SPCS). `<name>` matches the `secrets[].name` in `app.yml`.
2. If the file is absent (e.g. local dev), falls back to the **env var** `SNOWFLAKE_SECRET_<NAME>_<FIELD>` (upper-cased).
3. If neither is available, throws a `SarError`.

The env-var name is always upper-cased, so `getString("api_key")` and `getString("API_KEY")` resolve to the same fallback env var. Username and password must come from the same source.

### Required: declare the secret in `app.yml`

For a secret to be mounted in SPCS, it MUST be listed under `secrets:` in `app.yml`. Each entry maps a logical name (used in `snowflake.secrets`) to a fully-qualified Snowflake `SECRET` object.

> **CRITICAL — `secrets:` is a TOP-LEVEL key.** It is a sibling of `install:` and `run:` — at column 0. **Do NOT nest it under `run:`** (next to `command:`). A `secrets:` block placed under `run:` is ignored and the secret will not be mounted in SPCS. The same applies to the top-level `environment_variables:` block.

Here is a complete `app.yml` showing the correct placement (note `secrets:` and `environment_variables:` are at the same indentation level as `install:`/`run:`):

```yaml
install:
  commands:
    - ['npm', 'ci', '--include=dev']

run:
  command: ['node', '.next/standalone/server.js']

label: 'My App'
description: '...'

secrets: # ← top-level, NOT under run:
  - name: SOME_API_KEY
    secret: DB.SCHEMA.API_KEY
  - name: SOME_USER_PASS
    secret: DB.SCHEMA.API_KEY_2

environment_variables: # ← also top-level (non-secret config)
  - name: SOME_ENV_TEST
    value: 'PIZZA'
  - name: LOG_LEVEL
    value: 'INFO'
```

- `name`: the logical name passed to `snowflake.secrets` (e.g. `snowflake.secrets.getString("SOME_API_KEY")`) and the directory name under `/secrets/`.
- `secret`: the fully-qualified name of an existing Snowflake `SECRET` object. A bare name is also accepted and is qualified with the app's database and schema.
- Non-secret configuration goes under `environment_variables:` (plain `name`/`value` pairs), not `secrets:`.

If a secret is used in code but missing from `app.yml`, the app will work locally (if the fallback env var is set) but fail in SPCS. Always keep `app.yml` `secrets:` in sync with the `snowflake.secrets` calls in the code. This cuts both ways: the deploy is declarative, so removing a secret from the manifest also unmounts it from the running service on the next deploy.

For the full list of accepted `app.yml` keys, see `references/manifests.md` (`version: 2` manifest).

### Local development setup

In SPCS the runtime mounts each secret as files under `/secrets/<name>/`. Locally there are no mounted files, so provide the fallback env vars yourself, typically in `.env.local` (already git-ignored):

```bash
# GENERIC_STRING
SNOWFLAKE_SECRET_SOME_API_KEY_SECRET_STRING=sk-local-dev-key

# PASSWORD
SNOWFLAKE_SECRET_SOME_USER_PASS_USERNAME=local_user
SNOWFLAKE_SECRET_SOME_USER_PASS_PASSWORD=local_pass

# OAUTH2 — client-credentials refresh flow (recommended; auto-refreshes before expiry)
SNOWFLAKE_SECRET_MY_OAUTH_OAUTH_TOKEN_URL=https://provider.example.com/oauth2/token
SNOWFLAKE_SECRET_MY_OAUTH_OAUTH_CLIENT_ID=local-client-id
SNOWFLAKE_SECRET_MY_OAUTH_OAUTH_CLIENT_SECRET=local-client-secret
SNOWFLAKE_SECRET_MY_OAUTH_OAUTH_SCOPE=api.read        # optional
# OAUTH2 — OR a static short-lived token (no auto-refresh; expires):
# SNOWFLAKE_SECRET_MY_OAUTH_ACCESS_TOKEN=eyJhbGci...
```

### Secret scenarios

**1. Use secrets while creating a new app** — Implement the reads with `snowflake.secrets`, declare every secret under `secrets:` in `app.yml`, and tell the user which `SECRET` objects must exist in their account (and to set the fallback env vars for `npm run dev`). The skill does not create the `SECRET` object itself — see scenario 3.

**2. Read an existing secret in an existing app**

1. Confirm the secret name and type (`GENERIC_STRING`, `PASSWORD`, or `OAUTH2`).
2. Add the `snowflake.secrets.getString` / `getPassword` / `getAccessToken` call in the relevant server code and `await` it. If the code currently reads `process.env.SNOWFLAKE_SECRET_*` or queries the `SECRET` object directly, replace it with `snowflake.secrets`.
3. Ensure the secret is declared under `secrets:` in `app.yml`.
4. Remind the user to set the matching fallback env var(s) for local dev.

**3. Create a new secret** — **Delegate the creation of the `SECRET` object to Coco** (Cortex Code) — do not author `CREATE SECRET` SQL as part of this skill. Once the secret exists in Snowflake, the **usage** in the app is this template's job:

1. Add it to `app.yml` under `secrets:` (`name` + fully-qualified `secret`).
2. Read it in code with `snowflake.secrets`.
3. Set the fallback env var(s) so it works under `npm run dev`.

---

## Add an MCP server (only when asked)

Serve the app's tools to agents such as the Cortex Code CLI at `/api/mcp`. Most apps do not need this, so the template does not ship the dependency; add it only when the user asks. `references/mcp.md` in the `snowflake-apps` skill is the contract (stateless, POST only, whose rights tools run with, how to connect); this section is the Next.js code.

1. Install the SDK and its schema library in this app:

   ```bash
   npm install @modelcontextprotocol/sdk zod
   ```

2. Add `app/api/mcp/route.ts`. Replace the example tool with tools that call the same `snowflake.query` queries the app's pages and routes already use, and `(await asCaller()).query` wherever those queries use caller's rights:

   ```typescript
   /**
    * MCP server for agents such as the Cortex Code CLI. Stateless: a new server and transport per
    * request, so it works across instances and restarts. The ingress has already signed the caller in.
    */
   import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
   import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
   import { z } from 'zod';
   import { snowflake } from '@/lib/snowflake';

   export const dynamic = 'force-dynamic';

   const MAX_ROWS = 200;

   function createServer(): McpServer {
     const server = new McpServer({ name: 'my-app', version: '1.0.0' });

     // Call the same helpers the app's pages and API routes use, so MCP and the UI agree.
     server.registerTool(
       'list_orders',
       {
         description:
           'Orders for one region, newest first. Returns ORDER_ID, ORDER_DATE (ISO date) and AMOUNT (USD).',
         inputSchema: {
           region: z.enum(['AMER', 'EMEA', 'APJ']).describe('Sales region'),
           limit: z.number().int().min(1).max(MAX_ROWS).default(50),
         },
       },
       async ({ region, limit }) => {
         try {
           const { rows } = await snowflake.query(
             'SELECT ORDER_ID, ORDER_DATE, AMOUNT FROM DB.SCHEMA.ORDERS WHERE REGION = ? ORDER BY ORDER_DATE DESC LIMIT ?',
             { binds: [region, limit] },
           );
           return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
         } catch (e) {
           console.error('[mcp] list_orders failed', e);
           return { content: [{ type: 'text', text: 'Query failed' }], isError: true };
         }
       },
     );

     return server;
   }

   async function handle(request: Request): Promise<Response> {
     const startedAt = Date.now();
     const server = createServer();
     const transport = new WebStandardStreamableHTTPServerTransport({
       sessionIdGenerator: undefined,
       enableJsonResponse: true,
     });
     await server.connect(transport);
     const response = await transport.handleRequest(request);
     console.log(`[mcp] ${request.method} status=${response.status} ms=${Date.now() - startedAt}`);
     return response;
   }

   // POST only. Next.js answers GET and DELETE with 405; in stateless mode the SDK would otherwise
   // hold a GET open as an empty event stream.
   export const POST = handle;
   ```

3. Test it as "Test it" in `references/mcp.md` describes, with the dev server running.

Each MCP request logs one `[mcp]` line, so the app's logs show what an agent called.

---

## Deploy

`app.yml` is the deployment manifest (`version: 2`). `snow app init` and Snowsight Workspaces fill in its `name`, `database`, `schema` and `query_warehouse` from your account's defaults when they create the project; in a copy made any other way they hold placeholders such as `<%APP_NAME%>`, and `snow app setup --app-name=<app_name> --dry-run` prints the values to put there. Set the app's display metadata (`label`, `description`, `icon`), then run `snow app deploy`. Once deployed, the app is reachable at its `.snowflakecomputing.app` endpoint URL.
