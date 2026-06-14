const express = require('express');
const router = express.Router();
const passport = require('passport');

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// Step 1 of the OAuth dance — redirects the browser to Google's consent screen.
// prompt: 'select_account' forces Google to show the account picker every
// time, even when the user has already consented before. Without this,
// Google silently re-uses the previously-chosen account.
router.get(
  '/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
  })
);

// Google redirects back here after the user consents. Passport's
// authenticate middleware runs the verify callback (find-or-create user) and
// populates req.user; we then bounce the user to the React app.
router.get(
  '/google/callback',
  passport.authenticate('google', {
    failureRedirect: `${CLIENT_URL}/login?error=oauth`,
  }),
  (req, res) => {
    res.redirect(CLIENT_URL);
  }
);

// Returns the current logged-in user, or 401 if there is no valid session.
// Returns only the fields the client needs — never expose google_id.
// `role` is included so the React app can show/hide the admin link.
router.get('/me', (req, res) => {
  if (!req.isAuthenticated() || !req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { id, email, name, avatar_url, role } = req.user;
  res.json({ id, email, name, avatar_url, role });
});

// Destroys the session and clears the session cookie.
router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy((destroyErr) => {
      if (destroyErr) return next(destroyErr);
      // 'connect.sid' is express-session's default cookie name.
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });
});

module.exports = router;