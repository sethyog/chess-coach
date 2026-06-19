import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  Navigate,
  useLocation,
} from 'react-router-dom';
import { useState, useEffect } from 'react';
import Dashboard from './pages/Dashboard.jsx';
import GameReview from './pages/GameReview.jsx';
import Coaching from './pages/Coaching.jsx';
import Onboarding from './pages/Onboarding.jsx';
import PatternAnalysis from './pages/PatternAnalysis.jsx';
import Admin from './pages/Admin.jsx';
import Login from './pages/Login.jsx';
import { AuthProvider, useAuth } from './AuthContext.jsx';
import { api } from './api.js';

// Renders the Login screen in place of any protected content until /auth/me
// has confirmed a session. Once logged in, children render normally.
function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="panel">
        <div className="empty">Loading…</div>
      </div>
    );
  }
  if (!user) return <Login />;
  return children;
}

function OnboardingGate({ children }) {
  const location = useLocation();
  // Fast path: localStorage is set on this device already.
  const [status, setStatus] = useState(
    localStorage.getItem('onboardingComplete') ? 'done' : 'loading'
  );

  useEffect(() => {
    if (status !== 'loading') return;
    // No localStorage flag — check the server to avoid re-asking users who
    // already submitted a rating on a different device.
    api.get('/profile').then(({ data }) => {
      if (data?.reported_rating != null) {
        localStorage.setItem('onboardingComplete', '1');
        setStatus('done');
      } else {
        setStatus('needed');
      }
    }).catch(() => setStatus('needed'));
  }, [status]);

  if (status === 'loading') return null;
  if (status === 'needed' && location.pathname !== '/onboarding') {
    return <Navigate to="/onboarding" replace />;
  }
  return children;
}

function HeaderRight() {
  const { user, logout } = useAuth();
  if (!user) {
    return <span className="subtitle">Socratic review · Pattern recognition</span>;
  }
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      {user.avatar_url && (
        <img
          src={user.avatar_url}
          alt=""
          referrerPolicy="no-referrer"
          width={28}
          height={28}
          style={{ borderRadius: '50%', border: '1px solid var(--border)' }}
        />
      )}
      <span style={{ fontSize: 13, color: 'var(--text)' }}>
        {user.name || user.email}
      </span>
      {user.role === 'admin' && (
        <Link
          to="/admin"
          style={{ fontSize: 12, color: 'var(--gold)', textDecoration: 'none' }}
        >
          Admin
        </Link>
      )}
      <button
        type="button"
        onClick={logout}
        style={{ padding: '4px 10px', fontSize: 12 }}
      >
        Sign out
      </button>
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>
          <Link to="/" style={{ color: 'var(--gold)' }}>
            Chess Coach
          </Link>
        </h1>
        <HeaderRight />
      </header>
      {children}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Shell>
          <RequireAuth>
            <OnboardingGate>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/onboarding" element={<Onboarding />} />
                <Route path="/patterns" element={<PatternAnalysis />} />
                <Route path="/game/:id" element={<GameReview />} />
                <Route path="/game/:id/move/:moveId" element={<Coaching />} />
                <Route path="/admin" element={<Admin />} />
              </Routes>
            </OnboardingGate>
          </RequireAuth>
        </Shell>
      </AuthProvider>
    </BrowserRouter>
  );
}