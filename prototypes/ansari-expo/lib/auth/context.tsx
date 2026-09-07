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
import {
  loginRequest,
  logoutRequest,
  refreshRequest,
  registerRequest,
  type RegisterInput,
} from '@/lib/auth/api';
import { generateGuestCredentials } from '@/lib/auth/guest';

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
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
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
  // share one refresh round-trip. A failed refresh signs the user out.
  const refresh = useCallback(async (): Promise<string | null> => {
    if (!sessionRef.current) return null;
    if (refreshInFlight.current) return refreshInFlight.current;
    refreshInFlight.current = (async () => {
      const current = sessionRef.current;
      if (!current) return null;
      try {
        const { accessToken, refreshToken } = await refreshRequest(
          current.refreshToken,
        );
        const updated: StoredSession = { ...current, accessToken, refreshToken };
        sessionRef.current = updated;
        await saveSession(updated);
        setSession(updated);
        return accessToken;
      } catch {
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

  const login = useCallback(
    async (
      email: string,
      password: string,
      opts: { guest?: boolean } = {},
    ) => {
      const result = await loginRequest(email, password);
      const next: StoredSession = {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        firstName: result.firstName,
        lastName: result.lastName,
        isGuest: opts.guest ?? false,
      };
      await saveSession(next);
      applySession(next);
    },
    [applySession],
  );

  const register = useCallback(
    async (input: RegisterInput, opts: { guest?: boolean } = {}) => {
      const creds = await registerRequest(input);
      // Register's response carries no names, so keep what the user typed for
      // display.
      const next: StoredSession = {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        firstName: input.firstName ?? '',
        lastName: input.lastName ?? '',
        isGuest: opts.guest ?? false,
      };
      await saveSession(next);
      applySession(next);
    },
    [applySession],
  );

  // Continue as guest. A device reuses its ONE guest account: if credentials are
  // already stored, log back into that same account; only when none exist (or the
  // stored account no longer authenticates) do we register a new guest and
  // remember it. This keeps repeated taps from minting a new staging user each time.
  const loginAsGuest = useCallback(async () => {
    const stored = await loadGuestCredentials();
    if (stored) {
      try {
        await login(stored.email, stored.password, { guest: true });
        return;
      } catch {
        // Stored guest no longer works (e.g. deleted server-side) — fall through
        // and mint a fresh one.
      }
    }
    const creds = generateGuestCredentials();
    await register(creds, { guest: true });
    await saveGuestCredentials({ email: creds.email, password: creds.password });
  }, [login, register]);

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
      try {
        await loginAsGuest();
      } catch {
        // Offline at first launch: land signed-out. Screens surface their own
        // load errors, and the effect below retries on the next transition.
        if (active) applySession(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [applySession, loginAsGuest]);

  // Never stay tokenless. Any time the app lands signed-out AFTER startup —
  // principally just after `logout()` from a real account — fall straight back
  // to the device's guest identity. One attempt per signed-out transition (the
  // ref guards re-entry; a persistent failure waits for the next transition).
  const reguesting = useRef(false);
  useEffect(() => {
    if (status !== 'signedOut' || reguesting.current) return;
    reguesting.current = true;
    void loginAsGuest().finally(() => {
      reguesting.current = false;
    });
  }, [status, loginAsGuest]);

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } catch {
      // Even if the server call fails, clear locally so the device is signed out.
    }
    sessionRef.current = null;
    await clearSession();
    applySession(null);
  }, [applySession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      isGuest: session?.isGuest ?? false,
      login,
      register,
      loginAsGuest,
      logout,
    }),
    [status, session, login, register, loginAsGuest, logout],
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
