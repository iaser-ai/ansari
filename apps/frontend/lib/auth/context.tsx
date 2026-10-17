import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setAuthTokenGetter } from '@/vendor/api-client-react/custom-fetch';
import {
  setAccessTokenGetter,
  setUnauthorizedHandler,
} from '@/lib/api/auth-bridge';
import {
  clearSession,
  loadGuestCredentials,
  loadSession,
  saveGuestCredentials,
  saveSession,
  type StoredSession,
} from '@/lib/auth/store';
import { AuthError, type AuthSession, type RegisterInput } from '@/lib/auth/api';
import { authApi } from '@/lib/auth/client';
import { deleteAccountRequest } from '@/lib/auth/delete-account';
import { AccountDeleteNotSentError, AccountSessionEndedError } from '@/lib/auth/errors';
import { ApiError } from '@/vendor/api-client-react/custom-fetch';
import { generateGuestCredentials } from '@/lib/auth/guest';

/**
 * The ONLY failure that means a stored guest is gone for good: apps/auth
 * refused its credentials (the account no longer exists, or the password no
 * longer verifies). A 429, a 5xx, a network error or a failed `/token` are
 * transient, and must never orphan the device's guest and its threads.
 */
function storedGuestRejected(error: unknown): boolean {
  return error instanceof AuthError && error.endpoint === 'sign-in' && error.status === 401;
}

type AuthStatus = 'loading' | 'signedIn' | 'signedOut';

interface AuthContextValue {
  status: AuthStatus;
  session: StoredSession | null;
  /** True while the active session is an auto-provisioned guest (not a real account). */
  isGuest: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  loginAsGuest: () => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Checks a real account's session against apps/auth now (one `/token`):
   * a dead session (a reset elsewhere, a ban) is dropped locally at once.
   * Does nothing for a guest or with no session.
   */
  checkSession: () => Promise<void>;
  /** Deletes the signed-in (non-guest) account, then returns to the guest. */
  deleteAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  deferGuest = false,
}: {
  children: React.ReactNode;
  /**
   * Hold off provisioning a guest while true. A shared thread is public: a
   * visitor opening one needs no identity, and viewing must not mint an
   * account. With nothing stored, the provider then stays `loading` until
   * the flag drops (the visitor moves on into the app), and provisions then.
   */
  deferGuest?: boolean;
}) {
  const queryClient = useQueryClient();
  const deferGuestRef = useRef(deferGuest);
  useEffect(() => {
    deferGuestRef.current = deferGuest;
  }, [deferGuest]);
  const [guestHeld, setGuestHeld] = useState(false);
  const heldGuestSent = useRef(false);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<StoredSession | null>(null);

  // A ref mirrors `session` so the transport-layer getters (called outside
  // React, e.g. from `customFetch` / the SSE reader) always read the latest
  // token without re-registering on every change.
  const sessionRef = useRef<StoredSession | null>(null);
  const refreshInFlight = useRef<Promise<string | null> | null>(null);

  // Every call to this is a PRINCIPAL TRANSITION (sign-in, guest sign-in,
  // logout, or startup restore). Wipe the React Query cache so one account's
  // cached threads can never render for the next — the guest→register flow makes
  // switching principal on one device routine. (Refresh SUCCESS keeps the same
  // principal and deliberately does NOT go through here.)
  const applySession = useCallback(
    (next: StoredSession | null) => {
      queryClient.clear();
      sessionRef.current = next;
      setSession(next);
      setStatus(next ? 'signedIn' : 'signedOut');
    },
    [queryClient],
  );

  // Single-flight refresh: on a 401 the transport calls this; concurrent callers
  // share one round-trip to apps/auth's `/token`, which mints a fresh JWT from
  // the session. Only a 401 there (the session is dead: signed out elsewhere,
  // reset, banned, expired) signs the user out; any other failure keeps the
  // session, and the request that 401'd fails on its own.
  const refresh = useCallback(async (): Promise<string | null> => {
    if (!sessionRef.current) return null;
    if (refreshInFlight.current) return refreshInFlight.current;
    refreshInFlight.current = (async () => {
      const current = sessionRef.current;
      if (!current) return null;
      try {
        const accessToken = await authApi.mintJwt(current.sessionToken);
        // A sign-out or sign-in landed during the await: the result belongs
        // to a principal that is gone, so writing it back would re-persist
        // cleared tokens or revert the new principal.
        if (sessionRef.current !== current) return null;
        const updated: StoredSession = { ...current, accessToken };
        sessionRef.current = updated;
        await saveSession(updated);
        setSession(updated);
        return accessToken;
      } catch (error) {
        if (!(error instanceof AuthError && error.status === 401)) return null;
        // Same guard: only the session that failed may be signed out.
        if (sessionRef.current !== current) return null;
        // Failed refresh is a principal transition (→ signed out): clear the
        // cache too, so a subsequent sign-in never inherits stale threads.
        queryClient.clear();
        sessionRef.current = null;
        await clearSession();
        setSession(null);
        setStatus('signedOut');
        return null;
      } finally {
        refreshInFlight.current = null;
      }
    })();
    return refreshInFlight.current;
  }, [queryClient]);

  // Register transport bridges ONCE. The getters read the ref, so they stay
  // current across logins/refreshes without re-registration.
  useEffect(() => {
    const getToken = () => sessionRef.current?.accessToken ?? null;
    setAuthTokenGetter(getToken);
    setAccessTokenGetter(getToken);
    setUnauthorizedHandler(refresh);
    return () => {
      setAuthTokenGetter(null);
      setAccessTokenGetter(null);
      setUnauthorizedHandler(null);
    };
  }, [refresh]);

  // A new apps/auth session becomes the app's session: mint its first JWT,
  // persist both tokens, and switch principal.
  const startSession = useCallback(
    async (auth: AuthSession, isGuest: boolean) => {
      const accessToken = await authApi.mintJwt(auth.sessionToken);
      const next: StoredSession = {
        accessToken,
        sessionToken: auth.sessionToken,
        firstName: auth.firstName,
        lastName: auth.lastName,
        isGuest,
      };
      await saveSession(next);
      applySession(next);
    },
    [applySession],
  );

  const login = useCallback(
    async (
      email: string,
      password: string,
      opts: { guest?: boolean } = {},
    ) => {
      await startSession(await authApi.signIn(email, password), opts.guest ?? false);
    },
    [startSession],
  );

  const register = useCallback(
    async (input: RegisterInput, opts: { guest?: boolean } = {}) => {
      await startSession(await authApi.signUp(input), opts.guest ?? false);
    },
    [startSession],
  );

  // Continue as guest. A device reuses its ONE guest account: if credentials are
  // stored, sign back into that same account. A new guest is signed up only when
  // none is stored, or when apps/auth refuses the stored credentials (401 from
  // sign-in). Every other failure is thrown with the stored credentials kept, so
  // a rate limit or an outage never mints a new guest and orphans the old one.
  //
  // Single-flight: the re-guest effect and the sheet's "Continue as guest" can
  // both call this; concurrent callers share one attempt, so a device with no
  // stored guest never signs up two. And the new guest's credentials are saved
  // the moment apps/auth creates the account, BEFORE the `/token` exchange: if
  // that exchange fails, the next attempt signs back into the same guest
  // instead of signing up another (and spending the sign-up budget).
  const guestInFlight = useRef<Promise<void> | null>(null);
  const loginAsGuest = useCallback((): Promise<void> => {
    if (guestInFlight.current) return guestInFlight.current;
    guestInFlight.current = (async () => {
      const stored = await loadGuestCredentials();
      if (stored) {
        try {
          await login(stored.email, stored.password, { guest: true });
          return;
        } catch (error) {
          if (!storedGuestRejected(error)) throw error;
        }
      }
      const creds = generateGuestCredentials();
      const auth = await authApi.signUp(creds);
      await saveGuestCredentials({ email: creds.email, password: creds.password });
      await startSession(auth, true);
    })().finally(() => {
      guestInFlight.current = null;
    });
    return guestInFlight.current;
  }, [login, startSession]);

  // Restore any persisted session on startup. With nothing stored, provision a
  // guest rather than sit tokenless: `apps/api` has NO anonymous path — every
  // thread call needs a bearer token — so "accountless" means an
  // auto-provisioned guest (credentials cached and reused; see `lib/auth/guest`).
  // Stays `loading` through the guest round-trip so no screen mounts and 401s in
  // the gap.
  useEffect(() => {
    let active = true;
    (async () => {
      const restored = await loadSession();
      if (!active) return;
      if (restored) {
        applySession(restored);
        return;
      }
      if (deferGuestRef.current) {
        setGuestHeld(true);
        return;
      }
      try {
        await loginAsGuest();
      } catch {
        // Offline, rate-limited or apps/auth down: land signed-out with the
        // stored guest kept. Screens surface their own load errors, and the
        // "Continue as guest" control shows this error when tapped again.
        if (active) applySession(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [applySession, loginAsGuest]);

  // The held guest, once the public page is left: still `loading`, so the
  // gate keeps the app back until the transport has a token.
  useEffect(() => {
    if (!guestHeld || deferGuest || heldGuestSent.current) return;
    heldGuestSent.current = true;
    loginAsGuest().catch(() => applySession(null));
  }, [guestHeld, deferGuest, loginAsGuest, applySession]);

  // Never stay tokenless. Any time the app lands signed-out AFTER startup —
  // principally just after `logout()` from a real account — fall straight back
  // to the device's guest identity. One attempt per signed-out transition (the
  // ref guards re-entry; a persistent failure waits for the next transition).
  const reguesting = useRef(false);
  useEffect(() => {
    // Not on a public page (`deferGuest`): viewing a share never mints an
    // account. Leaving it re-runs this, and the guest comes then.
    if (status !== 'signedOut' || deferGuest || reguesting.current) return;
    reguesting.current = true;
    loginAsGuest()
      .catch(() => {
        // Transient (offline, rate-limited, apps/auth down): stay signed-out
        // with the stored guest kept; the next transition or tap retries.
      })
      .finally(() => {
        reguesting.current = false;
      });
  }, [status, deferGuest, loginAsGuest]);

  const logout = useCallback(async () => {
    const current = sessionRef.current;
    if (current) {
      try {
        await authApi.signOut(current.sessionToken);
      } catch {
        // Even if the server call fails, clear locally so the device is signed out.
      }
    }
    sessionRef.current = null;
    await clearSession();
    applySession(null);
  }, [applySession]);

  const checkSession = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || current.isGuest) return;
    await refresh();
  }, [refresh]);

  // The account is gone once apps/api answers 2xx: its session and JWT are
  // dead (the JWT gets 401 on data routes at once). So the session is ended
  // locally only, with no sign-out call and no refresh attempt, and the
  // signed-out transition then returns the device to its guest. The guest's
  // stored credentials are a different account and are kept.
  //
  // The JWT lives 15 minutes and is refreshed only when a request 401s, so a
  // user who signed in earlier holds an expired one, and /delete-account makes
  // no request before the DELETE. So a fresh JWT is minted first (one `/token`):
  // - `/token` 401: the session is dead (a reset or ban elsewhere). `refresh`
  //   has already ended it locally; `AccountSessionEndedError` says so.
  // - any other `/token` failure: nothing is sent and the session is kept.
  // - DELETE 401 with the fresh JWT: only the tombstone answers that (an
  //   earlier confirm committed and its response was lost): it ends locally.
  // Single-flight: a double tap shares one attempt.
  const deleteInFlight = useRef<Promise<void> | null>(null);
  const deleteAccount = useCallback((): Promise<void> => {
    if (deleteInFlight.current) return deleteInFlight.current;
    const current = sessionRef.current;
    if (!current || current.isGuest) {
      return Promise.reject(new Error('Sign in to the account you want to delete.'));
    }
    deleteInFlight.current = (async () => {
      const token = await refresh();
      // `refresh` answers null both for a dead session (cleared) and for a
      // transient failure (kept), so the session is re-read after the await.
      // The DELETE goes out only with the JWT just minted, never a stale one.
      const fresh = sessionRef.current;
      if (!fresh) throw new AccountSessionEndedError();
      if (token === null || fresh.accessToken !== token) throw new AccountDeleteNotSentError();
      const endLocally = async () => {
        // A sign-out or sign-in during the request already left this account.
        if (sessionRef.current !== fresh) return;
        sessionRef.current = null;
        await clearSession();
        applySession(null);
      };
      try {
        await deleteAccountRequest();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          await endLocally();
          throw new AccountSessionEndedError();
        }
        throw error;
      }
      await endLocally();
    })().finally(() => {
      deleteInFlight.current = null;
    });
    return deleteInFlight.current;
  }, [applySession, refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      isGuest: session?.isGuest ?? false,
      login,
      register,
      loginAsGuest,
      logout,
      checkSession,
      deleteAccount,
    }),
    [status, session, login, register, loginAsGuest, logout, checkSession, deleteAccount],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within an <AuthProvider>');
  }
  return value;
}
