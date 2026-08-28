import { customFetch, ApiError } from '@/vendor/api-client-react/custom-fetch';
import { handleUnauthorized } from '@/lib/api/auth-bridge';

/**
 * JSON transport for the adapter. Wraps the vendored `customFetch` (which
 * prepends the base URL and attaches the bearer token) with one-shot
 * refresh-on-401 recovery:
 *
 *   1. Make the request.
 *   2. On HTTP 401, ask the auth session to refresh (single-flight, owned by the
 *      AuthProvider). If it yields a fresh token, retry the request exactly once.
 *   3. If refresh fails (session gone) or the retry still 401s, rethrow — the
 *      AuthProvider has already signed the user out.
 *
 * Any other error (including a ZodError thrown by a caller's `.parse()`)
 * propagates unchanged so react-query surfaces it as an error state.
 */
export async function apiFetch<T>(
  input: string,
  options?: Parameters<typeof customFetch>[1],
): Promise<T> {
  try {
    return await customFetch<T>(input, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const refreshed = await handleUnauthorized();
      if (refreshed) {
        // customFetch re-invokes the token getter, which now returns the fresh
        // token, so a plain retry carries the new credential.
        return await customFetch<T>(input, options);
      }
    }
    throw error;
  }
}
