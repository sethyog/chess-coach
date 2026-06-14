import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';

export default function Onboarding() {
  const navigate = useNavigate();
  const [rating, setRating] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  function finish() {
    localStorage.setItem('onboardingComplete', '1');
    navigate('/', { replace: true });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const ratingNum = Number(rating);
    if (!Number.isFinite(ratingNum) || ratingNum <= 0) {
      setError('Enter a positive number, or use Skip.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await api.post('/profile/rating', { reported_rating: ratingNum });
      finish();
    } catch (err) {
      setError(
        err.response?.data?.error || err.message || 'Could not save rating'
      );
      setSubmitting(false);
    }
  }

  return (
    <section className="panel">
      <h2>Welcome</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Tell us your chess.com rating so the coach can calibrate explanations
        to your level. You can change this anytime — and your level
        recalibrates automatically as you upload more games.
      </p>
      <form className="form-stack" onSubmit={handleSubmit}>
        <input
          type="number"
          min="1"
          step="1"
          placeholder="Your chess.com rating (e.g. 1300)"
          value={rating}
          onChange={(e) => setRating(e.target.value)}
          disabled={submitting}
          autoFocus
        />
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={finish} disabled={submitting}>
            Skip
          </button>
          <button
            type="submit"
            className="primary"
            disabled={submitting || !rating.trim()}
          >
            {submitting ? 'Saving…' : 'Get started'}
          </button>
        </div>
      </form>
    </section>
  );
}