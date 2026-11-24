// Welcome page. It confirms the app can reach Snowflake and says what to do
// next. Replace this file with your app and delete components/welcome/.

import { ThemeToggle } from '@/components/theme-toggle';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CopyPrompt } from '@/components/welcome/copy-prompt';
import { APP_TITLE, LOGO_SRC } from '@/lib/constants';
import { queryAsCaller, type Identity } from '@/lib/run-as';
import { isSarError } from '@snowflake/sar-sdk';
import Image from 'next/image';

// Required: Snowflake is not reachable during the build.
export const dynamic = 'force-dynamic';

const SESSION_SQL = `
  SELECT CURRENT_USER() AS "USER", CURRENT_ROLE() AS ROLE, CURRENT_WAREHOUSE() AS WAREHOUSE,
         CURRENT_ACCOUNT_NAME() AS ACCOUNT, CURRENT_REGION() AS REGION
`;

type Session = {
  user: string;
  role: string;
  warehouse: string | null;
  account: string;
  region: string;
};

async function loadSession(): Promise<
  { session: Session; identity: Identity } | { error: string }
> {
  try {
    const { rows, identity } = await queryAsCaller(SESSION_SQL);
    const r = rows[0] ?? {};
    return {
      identity,
      session: {
        user: String(r.USER ?? ''),
        role: String(r.ROLE ?? ''),
        warehouse: r.WAREHOUSE ? String(r.WAREHOUSE) : null,
        account: String(r.ACCOUNT ?? ''),
        // CURRENT_REGION() includes the region group, e.g. PUBLIC.AWS_US_WEST_2.
        region: String(r.REGION ?? '').replace(/^PUBLIC\./, ''),
      },
    };
  } catch (e) {
    // Log the details on the server; the page only gets the SDK's error code.
    console.error('Welcome page query failed', e);
    return { error: isSarError(e) ? e.code : 'UNKNOWN' };
  }
}

const code = 'rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground';

export default async function Home() {
  const result = await loadSession();
  const connected = !('error' in result);

  return (
    <div className="min-h-screen">
      <div className="h-1 w-full bg-brand" />

      <main className="mx-auto flex min-h-[calc(100vh-4px)] w-full max-w-5xl flex-col px-5 py-8 sm:px-8">
        <header className="flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-2.5">
            <Image src={LOGO_SRC} alt="" width={28} height={28} className="shrink-0 rounded-md" />
            <span className="truncate text-sm font-semibold">{APP_TITLE}</span>
          </div>
          <ThemeToggle />
        </header>

        <section className="mt-16 grid items-start gap-10 sm:mt-24 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-14">
          <div className="min-w-0">
            <p className="text-sm font-medium text-primary">Snowflake App Runtime</p>
            <h1 className="mt-3 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
              Your app is live on <span className="text-primary">Snowflake</span>.
            </h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-muted-foreground sm:text-lg">
              Next.js, a Snowflake connection and caller&apos;s rights are wired up. This page is
              only here to say hello. Replace it with your app.
            </p>
          </div>

          <div className="min-w-0 rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
              <span className="text-sm font-medium">Connection</span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={`h-2 w-2 rounded-full ${connected ? 'bg-success' : 'bg-destructive'}`}
                />
                {!connected
                  ? 'Not connected'
                  : result.identity === 'caller'
                    ? "Caller's rights"
                    : 'Developer connection'}
              </span>
            </div>

            {'error' in result ? (
              <div className="p-5">
                <Alert variant="destructive">
                  <AlertTitle>Could not reach Snowflake</AlertTitle>
                  <AlertDescription>
                    {result.error === 'CALLER_CONTEXT_REQUIRED' ? (
                      <p>
                        Caller&apos;s rights needs the token Snowflake adds to requests for a
                        deployed app. Run <code className="font-mono">npm run dev</code> to use your
                        own connection locally.
                      </p>
                    ) : (
                      <p>
                        Locally, the app uses your default <code className="font-mono">snow</code>{' '}
                        CLI connection. Check it with{' '}
                        <code className="font-mono">snow connection test</code>.
                      </p>
                    )}
                    <p className="mt-2 font-mono text-xs opacity-80">Error code: {result.error}</p>
                  </AlertDescription>
                </Alert>
              </div>
            ) : (
              <>
                <div className="px-5 pt-5">
                  <p className="text-xs text-muted-foreground">Signed in as</p>
                  <p className="mt-1 truncate font-mono text-xl font-medium">
                    {result.session.user}
                  </p>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-4 p-5 text-sm">
                  {(
                    [
                      ['Role', result.session.role],
                      ['Warehouse', result.session.warehouse ?? 'None set'],
                      ['Account', result.session.account],
                      ['Region', result.session.region],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="min-w-0">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-0.5 truncate font-mono text-[13px]">{value}</dd>
                    </div>
                  ))}
                </dl>
                {result.identity === 'dev' && (
                  <p className="border-t px-5 py-3 text-xs leading-relaxed text-muted-foreground">
                    Local dev and workspace previews use your own connection. Once deployed, each
                    viewer queries with their own role.
                  </p>
                )}
              </>
            )}
          </div>
        </section>

        <section aria-labelledby="next" className="mt-20">
          <h2 id="next" className="text-sm font-medium text-muted-foreground">
            What to do next
          </h2>
          <ol className="mt-4 grid gap-4 md:grid-cols-3">
            <li className="min-w-0 rounded-xl border bg-card p-5">
              <span className="text-2xl font-semibold text-primary tabular-nums">01</span>
              <p className="mt-3 font-medium">Describe the app you want</p>
              <p className="mt-1 text-sm text-muted-foreground">Ask Cortex Code, for example:</p>
              <CopyPrompt text="Build a page that charts daily orders from SALES.PUBLIC.ORDERS." />
            </li>
            <li className="min-w-0 rounded-xl border bg-card p-5">
              <span className="text-2xl font-semibold text-primary tabular-nums">02</span>
              <p className="mt-3 font-medium">Or edit it yourself</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                This page is <code className={code}>app/page.tsx</code>. Server code queries
                Snowflake through <code className={code}>lib/snowflake.ts</code>.
              </p>
            </li>
            <li className="min-w-0 rounded-xl border bg-card p-5">
              <span className="text-2xl font-semibold text-primary tabular-nums">03</span>
              <p className="mt-3 font-medium">Deploy</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                Run <code className={code}>snow app deploy</code>, or use Deploy in a Snowsight
                workspace. Viewers see data with their own role.
              </p>
            </li>
          </ol>
        </section>

        <footer className="mt-auto pt-16 text-xs text-muted-foreground">
          Built with Next.js on Snowflake App Runtime.
        </footer>
      </main>
    </div>
  );
}
