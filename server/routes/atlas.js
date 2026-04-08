const express = require('express');
const crypto = require('crypto');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();
const db = require('../db');
// No auth required — all operations use anonymous sessions

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

router.post('/create',
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Name is required'),
  validate,
  async (req, res) => {
  try {
    const ownerName = req.body.name || (req.session.user && req.session.user.name) || 'Anonymous';
    let code, attempts = 0;
    do {
      code = generateCode();
      const existing = await db.getAtlasByCode(code);
      if (!existing) break;
      attempts++;
    } while (attempts < 10);
    if (attempts >= 10) return res.status(500).json({ error: 'Could not generate unique code' });

    // Use session user ID if authenticated, otherwise generate an anonymous owner ID
    let ownerId = req.session.user?.id;
    if (!ownerId) {
      let sessionId = req.cookies?.anon_session;
      if (!sessionId) {
        sessionId = crypto.randomBytes(32).toString('hex');
        res.cookie('anon_session', sessionId, {
          maxAge: 365 * 24 * 60 * 60 * 1000,
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
        });
      }
      ownerId = `anon_${sessionId.slice(0, 16)}`;
      // Ensure anonymous user exists in users table
      await db.findOrCreateUser({ id: ownerId, email: `${ownerId}@anon.local`, name: ownerName, profilePicture: null });
    }

    const atlas = await db.createAtlas(code, ownerId, ownerName);
    res.json({ success: true, atlas: { id: atlas.id, code: atlas.code, ownerName: atlas.owner_name, createdAt: atlas.created_at } });
  } catch (error) {
    console.error('Create atlas error:', error);
    res.status(500).json({ error: 'Failed to create atlas' });
  }
});

router.get('/code/:code', param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(), validate, async (req, res) => {
  try {
    const atlas = await db.getAtlasByCode(req.params.code);
    if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
    const friends = await db.getFriendsByAtlas(atlas.id);
    const stats = await db.getAtlasStats(atlas.id);
    res.json({
      atlas: { id: atlas.id, code: atlas.code, ownerName: atlas.owner_name, ownerId: atlas.owner_id, createdAt: atlas.created_at },
      friends: friends.map(f => ({
        id: f.id, name: f.name, city: f.city, country: f.country,
        lat: parseFloat(f.lat), lng: parseFloat(f.lng), note: f.note,
        profilePicture: f.profile_picture, createdAt: f.created_at,
      })),
      stats: { totalFriends: parseInt(stats.total_friends), countries: parseInt(stats.countries), cities: parseInt(stats.cities) },
    });
  } catch (error) {
    console.error('Get atlas error:', error);
    res.status(500).json({ error: 'Failed to get atlas' });
  }
});

// Dynamic OG image generation (SVG → served as image)
router.get('/code/:code/og-image', param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(), validate, async (req, res) => {
  try {
    const atlas = await db.getAtlasByCode(req.params.code);
    if (!atlas) return res.status(404).send('Not found');
    const stats = await db.getAtlasStats(atlas.id);
    const friends = await db.getFriendsByAtlas(atlas.id);
    const friendCount = parseInt(stats.total_friends);
    const cityCount = parseInt(stats.cities);
    const countryCount = parseInt(stats.countries);

    // Sanitize for SVG text injection
    const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // Generate dots for friend locations on a simple world map projection
    const dots = friends.slice(0, 30).map(f => {
      const x = ((parseFloat(f.lng) + 180) / 360) * 1100 + 50;
      const y = ((90 - parseFloat(f.lat)) / 180) * 500 + 65;
      return `<circle cx="${x}" cy="${y}" r="6" fill="#818cf8" opacity="0.9"/><circle cx="${x}" cy="${y}" r="3" fill="#c7d2fe"/>`;
    }).join('');

    const ownerName = esc(atlas.owner_name);
    const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <rect width="1200" height="630" fill="#09090b"/>
      <rect x="40" y="55" width="1120" height="520" rx="16" fill="#18181b" stroke="#3f3f46" stroke-width="1"/>
      ${dots}
      <text x="600" y="42" text-anchor="middle" fill="#a1a1aa" font-family="system-ui,sans-serif" font-size="16" font-weight="600">FRIEND ATLAS</text>
      <rect x="340" y="590" width="520" height="36" rx="18" fill="#18181b" stroke="#3f3f46" stroke-width="1"/>
      <text x="600" y="614" text-anchor="middle" fill="#fafafa" font-family="system-ui,sans-serif" font-size="16" font-weight="700">${ownerName}'s Atlas</text>
      <text x="160" y="614" text-anchor="middle" fill="#818cf8" font-family="system-ui,sans-serif" font-size="15" font-weight="700">${friendCount} friend${friendCount !== 1 ? 's' : ''}</text>
      <text x="1040" y="614" text-anchor="middle" fill="#818cf8" font-family="system-ui,sans-serif" font-size="15" font-weight="700">${cityCount} cit${cityCount !== 1 ? 'ies' : 'y'} · ${countryCount} countr${countryCount !== 1 ? 'ies' : 'y'}</text>
    </svg>`;

    res.set({
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=3600',
    });
    res.send(svg);
  } catch (error) {
    console.error('OG image error:', error);
    res.status(500).send('Error');
  }
});

router.get('/:id/export', param('id').isInt(), validate, async (req, res) => {
  try {
    // Export is public for now (no auth)
    const atlas = await db.pool.query('SELECT * FROM atlases WHERE id = $1', [req.params.id]);
    if (!atlas.rows[0]) return res.status(404).json({ error: 'Atlas not found' });
    const friends = await db.getFriendsByAtlas(req.params.id);
    res.json({ atlas: atlas.rows[0], friends, exportedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Export atlas error:', error);
    res.status(500).json({ error: 'Failed to export atlas' });
  }
});

// Anonymous join — no auth required, tracks by session cookie
router.post('/code/:code/join-anon',
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Name is required (max 100 chars)'),
  body('city').isString().trim().isLength({ min: 1, max: 255 }).withMessage('City is required'),
  body('country').optional().isString().trim().isLength({ max: 100 }),
  body('lat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  body('note').optional().isString().trim().isLength({ max: 500 }),
  validate,
  async (req, res) => {
    try {
      const { name, city, country, lat, lng, note } = req.body;
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });

      // Generate or reuse session ID for anonymous users
      let sessionId = req.cookies?.anon_session;
      if (!sessionId) {
        sessionId = crypto.randomBytes(32).toString('hex');
      }

      const friend = await db.addAnonymousFriend(atlas.id, sessionId, name, city, country || null, lat, lng, note);

      // Set long-lived cookie so anonymous user can edit their pin later
      res.cookie('anon_session', sessionId, {
        maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      });

      res.json({
        success: true,
        friend: {
          id: friend.id, name: friend.name, city: friend.city,
          country: friend.country, lat: parseFloat(friend.lat),
          lng: parseFloat(friend.lng), note: friend.note,
          createdAt: friend.created_at,
        },
      });
    } catch (error) {
      console.error('Anonymous join error:', error);
      res.status(500).json({ error: 'Failed to join atlas' });
    }
  }
);

// Rename atlas owner (by anon session — only the creator can rename)
router.patch('/code/:code/rename',
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Name is required (max 100 chars)'),
  validate,
  async (req, res) => {
    try {
      const sessionId = req.cookies?.anon_session;
      if (!sessionId) return res.status(401).json({ error: 'No session' });
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      const ownerId = `anon_${sessionId.slice(0, 16)}`;
      if (atlas.owner_id !== ownerId) return res.status(403).json({ error: 'Only the atlas creator can rename' });
      await db.pool.query('UPDATE atlases SET owner_name = $1, updated_at = NOW() WHERE id = $2', [req.body.name, atlas.id]);
      res.json({ success: true, name: req.body.name });
    } catch (error) {
      console.error('Rename atlas error:', error);
      res.status(500).json({ error: 'Failed to rename atlas' });
    }
  }
);

// Remove a friend pin (by anon session)
router.delete('/:atlasId/friend/:friendId', param('atlasId').isInt(), param('friendId').isInt(), validate, async (req, res) => {
  try {
    const sessionId = req.cookies?.anon_session;
    if (!sessionId) return res.status(401).json({ error: 'No session' });
    const deleted = await db.removeFriendBySession(req.params.friendId, sessionId);
    if (!deleted) return res.status(404).json({ error: 'Friend not found or unauthorized' });
    res.json({ success: true });
  } catch (error) {
    console.error('Remove friend error:', error);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

module.exports = router;
