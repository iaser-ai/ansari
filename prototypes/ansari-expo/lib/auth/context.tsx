import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
  login: (email: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  loginAsGuest: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<StoredSession | null>(null);

  // A ref mirrors `session` so the transport-layer getters (called outside
  // React, e.g. from `customFetch` / the SSE reader) always read the latest
  // token without re-registering on every change.
  const sessionRef = useRef<StoredSession | null>(null);
  const refreshInFlight = useRef<Promise<string | null> | null>(null);

  const applySession = useCallback((next: StoredSession | null) => {
    sessionRef.current = next;
    setSession(next);
    setStatus(next ? 'signedIn' : 'signedOut');
  }, []);

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
  }, []);

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

  // Restore any persisted session on startup.
  useEffect(() => {
    let active = true;
    (async () => {
      const restored = await loadSession();
      if (!active) return;
      applySession(restored);
    })();
    return () => {
      active = false;
    };
  }, [applySession]);

  const login = useCallback(
    async (email: string, password: string) => {
      const result = await loginRequest(email, password);
      const next: StoredSession = {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        firstName: result.firstName,
        lastName: result.lastName,
      };
      await saveSession(next);
      applySession(next);
    },
    [applySession],
  );

  const register = useCallback(
    async (input: RegisterInput) => {
      const creds = await registerRequest(input);
      // Register's response carries no names, so keep what the user typed for
      // display.
      const next: StoredSession = {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        firstName: input.firstName ?? '',
        lastName: input.lastName ?? '',
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
        await login(stored.email, stored.password);
        return;
      } catch {
        // Stored guest no longer works (e.g. deleted server-side) — fall through
        // and mint a fresh one.
      }
    }
    const creds = generateGuestCredentials();
    await register(creds);
    await saveGuestCredentials({ email: creds.email, password: creds.password });
  }, [login, register]);

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
    () => ({ status, session, login, register, loginAsGuest, logout }),
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
