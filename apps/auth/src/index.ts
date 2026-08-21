// apps/auth — the runnable Better Auth service (the "face").
//
// A minimal Express server that mounts Better Auth at /api/auth/* and nothing
// else. Keeping this a SEPARATE service (rather than mounting Better Auth inside
// apps/api via toNextJsHandler) is what makes issue #59 additive: it touches no
// existing route or table. Whether the end state keeps two services or folds
// auth into apps/api is #60's call.
import 'dotenv/config';
import { createAuth } from '@ansari/auth';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import cors from 'cors';
import express from 'express';

// Construct the configured Better Auth instance once, here at the app
// entrypoint — this is where the env-validation + db-client side effect belongs
// (the library exports a factory rather than a module-level singleton so it can
// be imported without opening a DB connection).
const auth = createAuth();

const app = express();

// CORS must allow credentials so the browser stores/sends the session cookie.
const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:3100';
app.use(
  cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// Better Auth reads the RAW request body, so its handler must be mounted BEFORE
// express.json() (which would consume the stream). All /api/auth/* routes
// (sign-up/email, sign-in/email, get-session, sign-out, ...) live here.
app.all('/api/auth{/*path}', toNodeHandler(auth));

// express.json() is only for our own routes below, after the auth handler.
app.use(express.json());

// Liveness probe.
app.get('/', (_req, res) => {
  res.status(200).send('OK');
});

// Proves an AUTHENTICATED request works end to end: resolves the session from
// the request's cookie. 200 + user when signed in, 401 when not.
app.get('/api/me', async (req, res) => {
  const sessionData = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!sessionData) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }

  res.status(200).json(sessionData);
});

const port = Number(process.env.PORT ?? 3100);
app.listen(port, () => {
  console.log(`auth service listening on http://localhost:${port}`);
});
