import { createAuthApi } from '@/lib/auth/api';
import { clientId } from '@/lib/auth/client-id';
import { resolveAuthUrl } from '@/lib/api/config';

/**
 * The app's one apps/auth client: the session context signs in, signs up
 * and signs out through it, and the reset screens request and consume
 * resets through it. apps/api only ever sees the JWT minted from the session.
 */
export const authApi = createAuthApi({ baseUrl: resolveAuthUrl(), clientId: clientId() });
