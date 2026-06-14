// Express middleware that gates a route on a valid Passport session.
// Returns 401 (not 403) so the React app can branch on auth state and
// redirect to the login screen without ambiguity.
function isAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated() && req.user) {
    return next();
  }
  return res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { isAuthenticated };