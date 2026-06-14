import { createContext, useContext, useEffect, useState } from 'react';
import { api, setUnauthenticatedHandler } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Any 401 from a gated route (e.g. session expired mid-session) clears
    // local user state, which makes RequireAuth swap in the Login screen.
    setUnauthenticatedHandler(() => setUser(null));

    let cancelled = false;
    (async () => {
      try {
        const { data } = await api.get('/auth/me');
        if (!cancelled) setUser(data);
      } catch {
        // 401 means not logged in — that's a normal initial state for a
        // fresh visitor, not an error.
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // login(): OAuth is fully server-side — we full-page redirect to the
  // Google initiator. Don't fetch this; the browser must follow the
  // resulting 302 to Google's consent screen.
  function login() {
    window.location.href = 'http://localhost:3001/api/auth/google';
  }

  // logout(): hit the server, then clear local state regardless of the
  // network result so the UI reliably returns to the logged-out view.
  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      // Ignore — we still clear local state below.
    }
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// react-refresh wants .jsx files to export components only. The hook lives
// here for proximity to the provider; HMR still works fine in practice.
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return ctx;
}