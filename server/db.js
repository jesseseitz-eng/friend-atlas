const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => console.error('Database pool error:', err));

async function initialize() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(255) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        profile_picture VARCHAR(500),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS atlases (
        id SERIAL PRIMARY KEY,
        code VARCHAR(6) UNIQUE NOT NULL,
        owner_id VARCHAR(255) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        owner_name VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS friends (
        id SERIAL PRIMARY KEY,
        atlas_id INTEGER NOT NULL REFERENCES atlases(id) ON DELETE CASCADE,
        user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
        session_id VARCHAR(64),
        name VARCHAR(100) NOT NULL,
        city VARCHAR(255) NOT NULL,
        country VARCHAR(100),
        lat DECIMAL(10, 7) NOT NULL,
        lng DECIMAL(10, 7) NOT NULL,
        note VARCHAR(500),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(atlas_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_atlases_code ON atlases(code);
      CREATE INDEX IF NOT EXISTS idx_atlases_owner ON atlases(owner_id);
      CREATE INDEX IF NOT EXISTS idx_friends_atlas ON friends(atlas_id);
      CREATE INDEX IF NOT EXISTS idx_friends_session ON friends(session_id);

      -- Add session_id column if it doesn't exist (migration for existing DBs)
      DO $$ BEGIN
        ALTER TABLE friends ADD COLUMN IF NOT EXISTS session_id VARCHAR(64);
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Add color column for custom pin colors
      DO $$ BEGIN
        ALTER TABLE friends ADD COLUMN IF NOT EXISTS color VARCHAR(7);
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Add referred_by column for invite attribution
      DO $$ BEGIN
        ALTER TABLE friends ADD COLUMN IF NOT EXISTS referred_by VARCHAR(100);
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Add map_name column so the atlas itself can have a label distinct from owner_name
      DO $$ BEGIN
        ALTER TABLE atlases ADD COLUMN IF NOT EXISTS map_name VARCHAR(120);
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Add pin_type so a single person can have multiple pins (home, current, etc.)
      DO $$ BEGIN
        ALTER TABLE friends ADD COLUMN IF NOT EXISTS pin_type VARCHAR(20) DEFAULT 'current';
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Track owner-added pins (seeded by atlas creator on someone's behalf)
      DO $$ BEGIN
        ALTER TABLE friends ADD COLUMN IF NOT EXISTS added_by_owner BOOLEAN DEFAULT false;
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Drop the old unique constraint that limited 1 pin per (atlas, user) — now multiple pins per person are allowed
      DO $$ BEGIN
        ALTER TABLE friends DROP CONSTRAINT IF EXISTS friends_atlas_id_user_id_key;
      EXCEPTION WHEN others THEN NULL;
      END $$;

      -- Recommendations table — each pin can have a list of restaurant/bar/activity picks
      CREATE TABLE IF NOT EXISTS recommendations (
        id SERIAL PRIMARY KEY,
        friend_id INTEGER NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
        category VARCHAR(30) NOT NULL,
        name VARCHAR(160) NOT NULL,
        note VARCHAR(500),
        url VARCHAR(500),
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_recs_friend ON recommendations(friend_id);

      CREATE TABLE IF NOT EXISTS jterm_private_recs (
        id SERIAL PRIMARY KEY,
        atlas_id INTEGER NOT NULL REFERENCES atlases(id) ON DELETE CASCADE,
        friend_id INTEGER REFERENCES friends(id) ON DELETE CASCADE,
        session_id VARCHAR(64),
        name VARCHAR(100) NOT NULL,
        place VARCHAR(255) NOT NULL,
        notes TEXT NOT NULL,
        other_notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_jterm_private_recs_atlas ON jterm_private_recs(atlas_id);
    `);
  } finally {
    client.release();
  }
}

async function findOrCreateUser({ id, email, name, profilePicture }) {
  const result = await pool.query(
    `INSERT INTO users (id, email, name, profile_picture) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, profile_picture = EXCLUDED.profile_picture
     RETURNING *`,
    [id, email, name, profilePicture]
  );
  return result.rows[0];
}

async function createAtlas(code, ownerId, ownerName, mapName) {
  const result = await pool.query(
    'INSERT INTO atlases (code, owner_id, owner_name, map_name) VALUES ($1, $2, $3, $4) RETURNING *',
    [code.toUpperCase(), ownerId, ownerName, mapName || null]
  );
  return result.rows[0];
}

async function getAtlasByCode(code) {
  const result = await pool.query('SELECT * FROM atlases WHERE code = $1', [code.toUpperCase()]);
  return result.rows[0];
}

async function getAtlasesByOwner(ownerId) {
  const result = await pool.query(
    `SELECT a.*, COUNT(f.id) as friend_count FROM atlases a
     LEFT JOIN friends f ON f.atlas_id = a.id WHERE a.owner_id = $1
     GROUP BY a.id ORDER BY a.created_at DESC`,
    [ownerId]
  );
  return result.rows;
}

async function deleteAtlas(atlasId, ownerId) {
  const result = await pool.query(
    'DELETE FROM atlases WHERE id = $1 AND owner_id = $2 RETURNING *',
    [atlasId, ownerId]
  );
  return result.rows[0];
}

async function addOrUpdateFriend(atlasId, userId, name, city, country, lat, lng, note) {
  const result = await pool.query(
    `INSERT INTO friends (atlas_id, user_id, name, city, country, lat, lng, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (atlas_id, user_id) DO UPDATE SET
       name = EXCLUDED.name, city = EXCLUDED.city, country = EXCLUDED.country,
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, note = EXCLUDED.note
     RETURNING *`,
    [atlasId, userId, name, city, country, lat, lng, note || null]
  );
  return result.rows[0];
}

async function getFriendsByAtlas(atlasId) {
  const result = await pool.query(
    `SELECT f.*, u.profile_picture FROM friends f
     LEFT JOIN users u ON f.user_id = u.id WHERE f.atlas_id = $1
     ORDER BY f.created_at DESC`,
    [atlasId]
  );
  return result.rows;
}

async function removeFriend(friendId, atlasOwnerId) {
  const result = await pool.query(
    `DELETE FROM friends f USING atlases a
     WHERE f.id = $1 AND f.atlas_id = a.id AND a.owner_id = $2 RETURNING f.*`,
    [friendId, atlasOwnerId]
  );
  return result.rows[0];
}

async function getAtlasStats(atlasId) {
  const result = await pool.query(
    `SELECT
       COUNT(DISTINCT COALESCE(f.session_id, LOWER(f.name))) as total_friends,
       COUNT(DISTINCT f.id) as total_places,
       COUNT(DISTINCT f.country) as countries,
       COUNT(DISTINCT f.city) as cities,
       COUNT(DISTINCT r.id) as recommendations
     FROM friends f
     LEFT JOIN recommendations r ON r.friend_id = f.id
     WHERE f.atlas_id = $1`,
    [atlasId]
  );
  return result.rows[0];
}

async function exportAtlas(atlasId, ownerId) {
  const atlas = await pool.query('SELECT * FROM atlases WHERE id = $1 AND owner_id = $2', [atlasId, ownerId]);
  if (!atlas.rows[0]) return null;
  const friends = await getFriendsByAtlas(atlasId);
  return { atlas: atlas.rows[0], friends, exportedAt: new Date().toISOString() };
}

async function addAnonymousFriend(atlasId, sessionId, opts) {
  const { name, city, country, lat, lng, note, color, referredBy, pinType } = opts;
  const type = pinType || 'current';
  // Keep "live here" and "from here" as one editable place per person.
  // Let "lived here" and "know well" be additive so friends can add many cities.
  const shouldUpdateExisting = ['current', 'hometown'].includes(type);
  const existing = shouldUpdateExisting
    ? await pool.query(
      'SELECT id FROM friends WHERE atlas_id = $1 AND session_id = $2 AND pin_type = $3',
      [atlasId, sessionId, type]
    )
    : { rows: [] };
  if (shouldUpdateExisting && existing.rows[0]) {
    const result = await pool.query(
      `UPDATE friends SET name = $1, city = $2, country = $3, lat = $4, lng = $5,
         note = $6, color = $7, updated_at = NOW()
       WHERE atlas_id = $8 AND session_id = $9 AND pin_type = $10 RETURNING *`,
      [name, city, country, lat, lng, note || null, color || null, atlasId, sessionId, type]
    );
    return result.rows[0];
  }
  const result = await pool.query(
    `INSERT INTO friends (atlas_id, user_id, session_id, name, city, country, lat, lng,
       note, color, referred_by, pin_type)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [atlasId, sessionId, name, city, country, lat, lng, note || null, color || null, referredBy || null, type]
  );
  return result.rows[0];
}

// Owner-add: atlas owner seeds a pin for someone else (no session_id, marked added_by_owner)
async function addOwnerPin(atlasId, opts) {
  const { name, city, country, lat, lng, note, color, pinType } = opts;
  const type = pinType || 'current';
  const result = await pool.query(
    `INSERT INTO friends (atlas_id, user_id, session_id, name, city, country, lat, lng,
       note, color, pin_type, added_by_owner)
     VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8, $9, true) RETURNING *`,
    [atlasId, name, city, country, lat, lng, note || null, color || null, type]
  );
  return result.rows[0];
}

// ---------- Recommendations ----------
async function getRecsForFriend(friendId) {
  const r = await pool.query(
    'SELECT * FROM recommendations WHERE friend_id = $1 ORDER BY category, sort_order, id',
    [friendId]
  );
  return r.rows;
}
async function addRec(friendId, opts) {
  const { category, name, note, url } = opts;
  const r = await pool.query(
    `INSERT INTO recommendations (friend_id, category, name, note, url)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [friendId, category, name, note || null, url || null]
  );
  return r.rows[0];
}
async function replaceRecsForFriend(friendId, recommendations) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM recommendations WHERE friend_id = $1', [friendId]);
    const rows = [];
    for (let i = 0; i < recommendations.length; i++) {
      const { category, name, note, url } = recommendations[i];
      const r = await client.query(
        `INSERT INTO recommendations (friend_id, category, name, note, url, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [friendId, category, name, note || null, url || null, i]
      );
      rows.push(r.rows[0]);
    }
    await client.query('COMMIT');
    return rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function deleteRec(recId) {
  const r = await pool.query('DELETE FROM recommendations WHERE id = $1 RETURNING *', [recId]);
  return r.rows[0];
}

async function addJtermPrivateRec({ atlasId, friendId, sessionId, name, place, notes, otherNotes }) {
  const result = await pool.query(
    `INSERT INTO jterm_private_recs (atlas_id, friend_id, session_id, name, place, notes, other_notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [atlasId, friendId || null, sessionId || null, name, place, notes, otherNotes || null]
  );
  return result.rows[0];
}

async function getFriendById(friendId) {
  const r = await pool.query('SELECT * FROM friends WHERE id = $1', [friendId]);
  return r.rows[0];
}

async function claimAnonymousFriends(sessionId, userId) {
  const result = await pool.query(
    `UPDATE friends SET user_id = $1, session_id = NULL, updated_at = NOW()
     WHERE session_id = $2 AND user_id IS NULL RETURNING *`,
    [userId, sessionId]
  );
  return result.rows;
}

async function removeFriendBySession(friendId, sessionId) {
  const result = await pool.query(
    'DELETE FROM friends WHERE id = $1 AND session_id = $2 RETURNING *',
    [friendId, sessionId]
  );
  return result.rows[0];
}

async function getMembershipsByUser(userId) {
  const result = await pool.query(
    `SELECT a.*, COUNT(f2.id) as friend_count FROM friends f
     JOIN atlases a ON f.atlas_id = a.id
     LEFT JOIN friends f2 ON f2.atlas_id = a.id
     WHERE f.user_id = $1 AND a.owner_id != $1
     GROUP BY a.id ORDER BY f.created_at DESC`,
    [userId]
  );
  return result.rows;
}

module.exports = {
  pool, initialize, findOrCreateUser, createAtlas, getAtlasByCode,
  getAtlasesByOwner, deleteAtlas, addOrUpdateFriend, getFriendsByAtlas,
  removeFriend, getAtlasStats, exportAtlas, addAnonymousFriend,
  addOwnerPin, claimAnonymousFriends, removeFriendBySession,
  getMembershipsByUser, getFriendById,
  getRecsForFriend, addRec, replaceRecsForFriend, deleteRec, addJtermPrivateRec,
};
