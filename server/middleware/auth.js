function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required', loginUrl: '/auth/login' });
  }
  next();
}

function optionalAuth(req, res, next) {
  // Attaches user if session exists, but doesn't block if missing
  next();
}

module.exports = { requireAuth, optionalAuth };
