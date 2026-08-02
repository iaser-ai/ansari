import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

// Never serve this probe from a build-time cache — it must reflect live DB state
// on every request (Railway gates deploys on it via railway.toml).
export const dynamic = 'force-dynamic';

// Hard cap on the DB check. The pool's own connectionTimeoutMillis is 5000ms, so
// against an unreachable host `db.execute` can hang ~5s; race it against this
// shorter timer so the probe fails fast with a 503 instead.
const DB_PING_TIMEOUT_MS = 2000;

async function pingDatabase(): Promise<void> {
  // Import lazily: lib/db/index builds the pool at module scope and throws if
  // DATABASE_URL is unset. A top-level import would surface that as a 500 at
  // import time; importing here lets the try/catch below turn it into a 503 —
  // exactly the broken-DATABASE_URL deploy this probe exists to catch.
  const { db } = await import('@/lib/db/index');

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('database health check timed out')), DB_PING_TIMEOUT_MS);
  });

  // If the timeout wins the race, this query promise is still pending and will
  // reject later (up to the pool's 5000ms connect timeout). Attach a no-op catch
  // so that late rejection isn't logged as an unhandled rejection on every probe
  // against a dead database. The race below still sees the real rejection first
  // when the query fails fast.
  const query = Promise.resolve(db.execute(sql`SELECT 1`));
  query.catch(() => {});

  try {
    await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const timestamp = new Date().toISOString();

  try {
    await pingDatabase();
    return NextResponse.json({
      status: 'ok',
      service: 'ansari-backend',
      timestamp,
    });
  } catch (error) {
    // Log the real cause server-side; never leak DB internals in the response body.
    console.error('Health check failed:', error);
    return NextResponse.json(
      {
        status: 'error',
        service: 'ansari-backend',
        timestamp,
      },
      { status: 503 }
    );
  }
}
