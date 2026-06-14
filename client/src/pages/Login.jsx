import { useAuth } from '../AuthContext.jsx';

export default function Login() {
  const { login } = useAuth();
  return (
    <section
      className="panel"
      style={{ maxWidth: 480, margin: '40px auto', textAlign: 'center' }}
    >
      <h2 style={{ marginBottom: 12 }}>Welcome</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Upload your games, analyse mistakes with Stockfish, and chat with an
        AI coach about what to fix.
      </p>
      <button
        type="button"
        className="primary"
        onClick={login}
        style={{ marginTop: 20, padding: '12px 24px', fontSize: 14 }}
      >
        Sign in with Google
      </button>
    </section>
  );
}