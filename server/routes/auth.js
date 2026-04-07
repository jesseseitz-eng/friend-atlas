const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/login', (req, res) => {
  try {
    const workos = req.app.get('workos');
    if (req.query.return) req.session.returnTo = req.query.return;
    const authorizationUrl = workos.userManagement.getAuthorizationUrl({
      provider: 'authkit',
      redirectUri: process.env.WORKOS_REDIRECT_URI,
      clientId: process.env.WORKOS_CLIENT_ID,
    });
    res.redirect(authorizationUrl);
  } catch (error) {
    console.error('Login error:', error);
    res.redirect('/?error=login_failed');
  }
});

router.get('/callback', async (req, res) => {
  const { code, error: authError } = req.query;
  if (authError || !code) return res.redirect('/?error=auth_denied');
  try {
    const workos = req.app.get('workos');
    const { user } = await workos.userManagement.authenticateWithCode({
      code,
      clientId: process.env.WORKOS_CLIENT_ID,
    });
    let displayName = user.email.split('@')[0];
    if (user.firstName) displayName = user.lastName ? `${user.firstName} ${user.lastName}`.trim() : user.firstName;
    const dbUser = await db.findOrCreateUser({
      id: user.id,
      email: user.email,
      name: displayName,
      profilePicture: user.profilePictureUrl || null,
    });
    req.session.user = {
      id: dbUser.id,
      email: dbUser.email,
      name: dbUser.name,
      profilePicture: dbUser.profile_picture,
    };
    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (error) {
    console.error('Auth callback error:', error);
    res.redirect('/?error=auth_failed');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

router.get('/session', (req, res) => {
  res.json({ authenticated: !!req.session.user, user: req.session.user || null });
});

module.exports = router;
