// Express middleware that gates an admin-only route. Must run AFTER
// isAuthenticated — relies on req.user being populated. Returns 403
// (not 401) because the user IS authenticated; they just don't have
// the role this route needs.
function isAdmin(req, res, next) {
  if (req.user?.role === 'admin') {
    return next();
  }
  return res.status(403).json({ error: 'Admin access required' });
}

module.exports = { isAdmin };