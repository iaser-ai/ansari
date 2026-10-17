// `GET /health`: 200 only once the auth database answers `select 1`, so a
// deploy is not marked healthy while its database is unreachable.
import { pingDatabase, type Db } from '@ansari/auth';
import type { Request, Response } from 'express';

export function health(db: Db) {
  return async (_req: Request, res: Response): Promise<void> => {
    res.set('Cache-Control', 'no-store');
    try {
      await pingDatabase(db);
      res.status(200).json({ status: 'ok' });
    } catch (err) {
      // Never the raw driver error: it can carry connection details.
      console.error('health: auth database unreachable', err instanceof Error ? err.name : 'unknown');
      res.status(503).json({ status: 'unavailable' });
    }
  };
}
