const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();
const db = require('../db');
// No auth required — all operations use anonymous sessions

const SESSION_COOKIE = {
  maxAge: 365 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

function generateContributionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashContributionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function tokenMatches(atlas, token) {
  if (!atlas.contribution_token_hash) return true;
  if (!token) return false;
  const expected = Buffer.from(atlas.contribution_token_hash, 'hex');
  const actual = Buffer.from(hashContributionToken(token), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function currentOwnerIds(req) {
  const sessionId = req.cookies?.anon_session;
  if (!sessionId) return [];
  // Keep legacy 16-character owner IDs working while new atlases use the
  // entire 256-bit browser secret as their ownership credential.
  return [`anon_${sessionId}`, `anon_${sessionId.slice(0, 16)}`];
}

function isAtlasOwner(req, atlas) {
  return currentOwnerIds(req).includes(atlas.owner_id);
}

const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  message: { error: 'Too many incorrect atlas codes. Please try again later.' },
});

// Generous because a whole class can share one campus IP address.
const contributionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 200,
  message: { error: 'Too many contribution attempts. Please try again later.' },
});

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

const REC_CATEGORIES = new Set(['eat', 'drink', 'coffee', 'do', 'stay', 'tip']);
const PIN_TYPES = new Set(['current', 'hometown', 'lived', 'know']);

function sanitizeRecommendations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((rec) => ({
      category: REC_CATEGORIES.has(rec.category) ? rec.category : 'tip',
      name: String(rec.name || '').trim().slice(0, 160),
      note: String(rec.note || '').trim().slice(0, 500),
      url: String(rec.url || '').trim().slice(0, 500),
    }))
    .filter((rec) => rec.name)
    .slice(0, 5);
}

function mapFriend(friend, recommendations = []) {
  return {
    id: friend.id, name: friend.name, city: friend.city, country: friend.country,
    lat: parseFloat(friend.lat), lng: parseFloat(friend.lng), note: friend.note,
    color: friend.color, profilePicture: friend.profile_picture, createdAt: friend.created_at, updatedAt: friend.updated_at,
    pinType: friend.pin_type || 'current', addedByOwner: !!friend.added_by_owner,
    recommendations: recommendations.map((rec) => ({
      id: rec.id,
      category: rec.category,
      name: rec.name,
      note: rec.note,
      url: rec.url,
    })),
  };
}

router.post('/create',
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Name is required'),
  body('mapName').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }).withMessage('Map name too long (max 120 chars)'),
  validate,
  async (req, res) => {
  try {
    const ownerName = req.body.name.trim();
    let code, attempts = 0;
    do {
      code = generateCode();
      const existing = await db.getAtlasByCode(code);
      if (!existing) break;
      attempts++;
    } while (attempts < 10);
    if (attempts >= 10) return res.status(500).json({ error: 'Could not generate unique code' });

    // Ownership is tied to a long-lived random browser cookie (no accounts).
    let sessionId = req.cookies?.anon_session;
    if (!sessionId) {
      sessionId = crypto.randomBytes(32).toString('hex');
      res.cookie('anon_session', sessionId, SESSION_COOKIE);
    }
    const ownerId = `anon_${sessionId}`;
    await db.findOrCreateUser({ id: ownerId, email: `${ownerId}@anon.local`, name: ownerName, profilePicture: null });

    const mapName = (req.body.mapName || '').trim() || null;
    const contributionToken = generateContributionToken();
    const atlas = await db.createAtlas(code, ownerId, ownerName, mapName, {
      contributionTokenHash: hashContributionToken(contributionToken),
      ownerContact: process.env.OWNER_CONTACT || null,
    });
    res.json({
      success: true,
      contributionToken,
      atlas: {
        id: atlas.id,
        code: atlas.code,
        ownerName: atlas.owner_name,
        mapName: atlas.map_name,
        contributionsLocked: false,
        contributionTokenRequired: true,
        isOwner: true,
        createdAt: atlas.created_at,
      },
    });
  } catch (error) {
    console.error('Create atlas error:', error);
    res.status(500).json({ error: 'Failed to create atlas' });
  }
});

router.get('/code/:code', lookupLimiter, param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(), validate, async (req, res) => {
  try {
    const atlas = await db.getAtlasByCode(req.params.code);
    if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
    const [friends, stats] = await Promise.all([db.getFriendsByAtlas(atlas.id), db.getAtlasStats(atlas.id)]);
    const recsByFriend = await db.getRecsForFriends(friends.map((friend) => friend.id));
    res.json({
      atlas: {
        id: atlas.id,
        code: atlas.code,
        ownerName: atlas.owner_name,
        mapName: atlas.map_name,
        contributionsLocked: !!atlas.contributions_locked,
        contributionTokenRequired: !!atlas.contribution_token_hash,
        isOwner: isAtlasOwner(req, atlas),
        ownerContact: atlas.owner_contact || process.env.OWNER_CONTACT || null,
        connectionGuidance: atlas.connection_guidance || null,
        createdAt: atlas.created_at,
        updatedAt: atlas.updated_at,
      },
      friends: friends.map((f) => mapFriend(f, recsByFriend.get(f.id) || [])),
      stats: {
        totalFriends: parseInt(stats.total_friends),
        totalPlaces: parseInt(stats.total_places),
        countries: parseInt(stats.countries),
        cities: parseInt(stats.cities),
        recommendations: parseInt(stats.recommendations),
      },
    });
  } catch (error) {
    console.error('Get atlas error:', error);
    res.status(500).json({ error: 'Failed to get atlas' });
  }
});

router.get('/:id/export', param('id').isInt(), validate, async (req, res) => {
  try {
    const atlas = await db.pool.query('SELECT * FROM atlases WHERE id = $1', [req.params.id]);
    if (!atlas.rows[0]) return res.status(404).json({ error: 'Atlas not found' });
    if (!isAtlasOwner(req, atlas.rows[0])) return res.status(403).json({ error: 'Only the atlas owner can export data' });
    const friends = await db.getFriendsByAtlas(req.params.id);
    const recsByFriend = await db.getRecsForFriends(friends.map((friend) => friend.id));
    res.json({
      atlas: {
        id: atlas.rows[0].id,
        code: atlas.rows[0].code,
        ownerName: atlas.rows[0].owner_name,
        mapName: atlas.rows[0].map_name,
        contributionsLocked: !!atlas.rows[0].contributions_locked,
        createdAt: atlas.rows[0].created_at,
        updatedAt: atlas.rows[0].updated_at,
      },
      friends: friends.map((friend) => mapFriend(friend, recsByFriend.get(friend.id) || [])),
      exportedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Export atlas error:', error);
    res.status(500).json({ error: 'Failed to export atlas' });
  }
});

// Anonymous join — no auth required, tracks by session cookie
router.post('/code/:code/join-anon',
  contributionLimiter,
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Name is required (max 100 chars)'),
  body('city').isString().trim().isLength({ min: 1, max: 255 }).withMessage('City is required'),
  body('country').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }).withMessage('Invalid country'),
  body('lat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  body('note').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 }).withMessage('Note too long (max 500 chars)'),
  body('color').optional({ values: 'falsy' }).isString().matches(/^#[0-9a-fA-F]{6}$/).withMessage('Invalid color'),
  body('referredBy').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }).withMessage('Invalid referrer'),
  body('pinType').optional({ values: 'falsy' }).isString().custom(value => PIN_TYPES.has(value)).withMessage('Invalid place type'),
  body('recommendations').optional({ values: 'falsy' }).isArray({ max: 5 }).withMessage('Too many recommendations'),
  body('recommendations.*.category').optional({ values: 'falsy' }).isString().isLength({ max: 30 }).withMessage('Invalid recommendation category'),
  body('recommendations.*.name').optional({ values: 'falsy' }).isString().trim().isLength({ max: 160 }).withMessage('Recommendation name too long'),
  body('recommendations.*.note').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 }).withMessage('Recommendation note too long'),
  body('recommendations.*.url').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 }).withMessage('Recommendation URL too long'),
  body('inviteToken').optional({ values: 'falsy' }).isString().isLength({ max: 256 }).withMessage('Invalid invitation token'),
  validate,
  async (req, res) => {
    try {
      const { name, city, country, lat, lng, note, color, referredBy, pinType } = req.body;
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      if (atlas.contributions_locked) return res.status(423).json({ error: 'This atlas is currently closed to new contributions' });
      if (!tokenMatches(atlas, req.body.inviteToken) && !isAtlasOwner(req, atlas)) {
        return res.status(403).json({ error: 'Open the contribution link from the atlas owner to add a place' });
      }

      // Generate or reuse session ID for anonymous users
      let sessionId = req.cookies?.anon_session;
      if (!sessionId) {
        sessionId = crypto.randomBytes(32).toString('hex');
      }

      const friend = await db.addAnonymousFriend(atlas.id, sessionId, {
        name,
        city,
        country: country || null,
        lat,
        lng,
        note,
        color: color || null,
        referredBy: referredBy || null,
        pinType: pinType || 'current',
      });
      const recommendations = sanitizeRecommendations(req.body.recommendations);
      const savedRecommendations = await db.replaceRecsForFriend(friend.id, recommendations);

      // Long-lived cookie so the contributor can edit or remove the entry later.
      res.cookie('anon_session', sessionId, SESSION_COOKIE);

      res.json({
        success: true,
        friend: mapFriend(friend, savedRecommendations),
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
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      if (!isAtlasOwner(req, atlas)) return res.status(403).json({ error: 'Only the atlas creator can rename' });
      await db.pool.query('UPDATE atlases SET owner_name = $1, updated_at = NOW() WHERE id = $2', [req.body.name, atlas.id]);
      res.json({ success: true, name: req.body.name });
    } catch (error) {
      console.error('Rename atlas error:', error);
      res.status(500).json({ error: 'Failed to rename atlas' });
    }
  }
);

// Rename the atlas's MAP NAME (the label of the map itself, e.g. "CBS Summer Map")
router.patch('/code/:code/rename-map',
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  body('mapName').optional({ values: 'null' }).isString().trim().isLength({ max: 120 }).withMessage('Map name too long (max 120 chars)'),
  validate,
  async (req, res) => {
    try {
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      if (!isAtlasOwner(req, atlas)) return res.status(403).json({ error: 'Only the atlas creator can rename the map' });
      const mapName = (req.body.mapName || '').trim() || null;
      await db.pool.query('UPDATE atlases SET map_name = $1, updated_at = NOW() WHERE id = $2', [mapName, atlas.id]);
      res.json({ success: true, mapName });
    } catch (error) {
      console.error('Rename map error:', error);
      res.status(500).json({ error: 'Failed to rename map' });
    }
  }
);

router.patch('/code/:code/settings',
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  body('contributionsLocked').optional().isBoolean().withMessage('Invalid lock setting'),
  body('ownerContact').optional({ values: 'null' }).isString().trim().isLength({ max: 255 }).withMessage('Contact is too long'),
  body('connectionGuidance').optional({ values: 'null' }).isString().trim().isLength({ max: 255 }).withMessage('Connection guidance is too long'),
  validate,
  async (req, res) => {
    try {
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      if (!isAtlasOwner(req, atlas)) return res.status(403).json({ error: 'Only the atlas owner can change settings' });
      const updated = await db.updateAtlasSettings(atlas.id, atlas.owner_id, req.body);
      res.json({
        success: true,
        contributionsLocked: !!updated.contributions_locked,
        ownerContact: updated.owner_contact,
        connectionGuidance: updated.connection_guidance,
      });
    } catch (error) {
      console.error('Update atlas settings error:', error);
      res.status(500).json({ error: 'Failed to update atlas settings' });
    }
  }
);

router.post('/code/:code/friend/:friendId/recommendation',
  contributionLimiter,
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  param('friendId').isInt(),
  body('category').optional({ values: 'falsy' }).isString().custom(value => REC_CATEGORIES.has(value)).withMessage('Invalid category'),
  body('name').isString().trim().isLength({ min: 1, max: 160 }).withMessage('Recommendation is required'),
  body('note').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 }).withMessage('Recommendation note is too long'),
  validate,
  async (req, res) => {
    try {
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      if (atlas.contributions_locked && !isAtlasOwner(req, atlas)) {
        return res.status(423).json({ error: 'This atlas is currently closed to contributions' });
      }
      const friend = await db.getFriendById(req.params.friendId);
      if (!friend || friend.atlas_id !== atlas.id) return res.status(404).json({ error: 'Entry not found' });
      const ownsEntry = !!req.cookies?.anon_session && friend.session_id === req.cookies.anon_session;
      if (!ownsEntry && !isAtlasOwner(req, atlas)) {
        return res.status(403).json({ error: 'You can only add recommendations to your own entry' });
      }
      const recommendation = await db.addRec(friend.id, {
        category: req.body.category || 'tip',
        name: req.body.name,
        note: req.body.note || null,
        url: null,
      });
      res.json({ success: true, recommendation });
    } catch (error) {
      console.error('Add recommendation error:', error);
      res.status(500).json({ error: 'Failed to add the recommendation' });
    }
  }
);

router.post('/code/:code/rotate-invite',
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  validate,
  async (req, res) => {
    try {
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      if (!isAtlasOwner(req, atlas)) return res.status(403).json({ error: 'Only the atlas owner can rotate invitations' });
      const contributionToken = generateContributionToken();
      await db.rotateContributionToken(atlas.id, atlas.owner_id, hashContributionToken(contributionToken));
      res.json({ success: true, contributionToken });
    } catch (error) {
      console.error('Rotate invitation error:', error);
      res.status(500).json({ error: 'Failed to rotate the contribution link' });
    }
  }
);

router.patch('/code/:code/friend/:friendId',
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  param('friendId').isInt(),
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Name is required'),
  body('city').isString().trim().isLength({ min: 1, max: 255 }).withMessage('City is required'),
  body('country').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }).withMessage('Invalid country'),
  body('lat').isFloat({ min: -90, max: 90 }).withMessage('Invalid latitude'),
  body('lng').isFloat({ min: -180, max: 180 }).withMessage('Invalid longitude'),
  body('note').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 }).withMessage('Note is too long'),
  body('pinType').isString().custom(value => PIN_TYPES.has(value)).withMessage('Invalid place type'),
  body('color').optional({ values: 'falsy' }).isString().matches(/^#[0-9a-fA-F]{6}$/).withMessage('Invalid color'),
  validate,
  async (req, res) => {
    try {
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      if (!isAtlasOwner(req, atlas)) return res.status(403).json({ error: 'Only the atlas owner can correct entries' });
      const updated = await db.updateFriendByOwner(req.params.friendId, atlas.id, atlas.owner_id, req.body);
      if (!updated) return res.status(404).json({ error: 'Entry not found' });
      const recommendations = await db.getRecsForFriend(updated.id);
      res.json({ success: true, friend: mapFriend(updated, recommendations) });
    } catch (error) {
      console.error('Owner edit friend error:', error);
      res.status(500).json({ error: 'Failed to update the entry' });
    }
  }
);

router.delete('/code/:code/recommendation/:recommendationId',
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  param('recommendationId').isInt(),
  validate,
  async (req, res) => {
    try {
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      if (!isAtlasOwner(req, atlas)) return res.status(403).json({ error: 'Only the atlas owner can remove recommendations' });
      const deleted = await db.removeRecommendationByOwner(req.params.recommendationId, atlas.id, atlas.owner_id);
      if (!deleted) return res.status(404).json({ error: 'Recommendation not found' });
      res.json({ success: true });
    } catch (error) {
      console.error('Owner remove recommendation error:', error);
      res.status(500).json({ error: 'Failed to remove the recommendation' });
    }
  }
);

router.delete('/code/:code',
  param('code').isString().isLength({ min: 6, max: 6 }).toUpperCase(),
  validate,
  async (req, res) => {
    try {
      const atlas = await db.getAtlasByCode(req.params.code);
      if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
      if (!isAtlasOwner(req, atlas)) return res.status(403).json({ error: 'Only the atlas owner can delete the atlas' });
      await db.deleteAtlas(atlas.id, atlas.owner_id);
      res.json({ success: true });
    } catch (error) {
      console.error('Delete atlas error:', error);
      res.status(500).json({ error: 'Failed to delete the atlas' });
    }
  }
);

router.delete('/:atlasId/friend/:friendId', param('atlasId').isInt(), param('friendId').isInt(), validate, async (req, res) => {
  try {
    const sessionId = req.cookies?.anon_session;
    if (!sessionId) return res.status(401).json({ error: 'No session' });
    const atlasResult = await db.pool.query('SELECT * FROM atlases WHERE id = $1', [req.params.atlasId]);
    const atlas = atlasResult.rows[0];
    if (!atlas) return res.status(404).json({ error: 'Atlas not found' });
    const deleted = isAtlasOwner(req, atlas)
      ? await db.removeFriend(req.params.friendId, atlas.owner_id)
      : await db.removeFriendBySession(req.params.friendId, sessionId);
    if (!deleted) return res.status(404).json({ error: 'Friend not found or unauthorized' });
    res.json({ success: true });
  } catch (error) {
    console.error('Remove friend error:', error);
    res.status(500).json({ error: 'Failed to remove friend' });
  }
});

module.exports = router;
