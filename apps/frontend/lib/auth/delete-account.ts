import { customFetch } from '@/vendor/api-client-react/custom-fetch';

/**
 * `DELETE /api/v2/users/me` on apps/api, with the JWT (the contract agreed
 * with the security architect for #306). apps/api deletes the app row and
 * writes a tombstone in one transaction, then deletes the account at
 * apps/auth bound to that same JWT. The client never calls apps/auth to
 * delete.
 *
 * - Any 2xx is success, whatever its body (none is required: a 204, or a
 *   changed body, must still end the local session).
 * - It goes through `customFetch` directly, NOT the refresh-on-401 wrapper:
 *   a 401 here means the account is already gone (a retry after a response
 *   that was lost once the delete had committed: the tombstone answers 401)
 *   or the session ended. A refresh fixes neither, and would turn a deleted
 *   account into a sign-in prompt. The caller decides what a 401 means.
 */
export async function deleteAccountRequest(): Promise<void> {
  await customFetch<unknown>('/api/v2/users/me', { method: 'DELETE' });
}
