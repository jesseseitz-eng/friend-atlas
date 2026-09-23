require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const atlasRoutes = require('./routes/atlas');
const jtermRoutes = require('./routes/jterm');
const placesRoutes = require('./routes/places');
const { normalize } = require('./places');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, '../public');
const STARTUP_NATION_CODE = (process.env.STARTUP_NATION_ATLAS_CODE || 'STNATN').toUpperCase();

// Render terminates TLS at a proxy that sets X-Forwarded-For. Trusting the
// first hop keeps express-rate-limit keyed on the real client address.
if (isProd) {
  app.set('trust proxy', 1);
}

const MAP_HOSTS = ['https://tiles.openfreemap.org'];

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com', 'unpkg.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:', ...MAP_HOSTS],
      connectSrc: ["'self'", ...MAP_HOSTS],
      workerSrc: ["'self'", 'blob:'],
      childSrc: ['blob:'],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
}));

// Participant names and locations should never be indexed as directory pages.
// This is privacy defense in depth, not access control.
app.use((req, res, next) => {
  if (/^\/(join\/|jterm\/?$|cbsj27\/?$|startupnation|api\/)/i.test(req.path)) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  next();
});

app.use(compression());

app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

app.use(cors({
  origin: isProd ? process.env.APP_URL : 'http://localhost:3000',
  credentials: true,
}));

app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// HTML pages reference /css and /js with ?v=<hash> so a deploy never mixes a
// new page with day-old cached scripts.
function assetVersion() {
  const hash = crypto.createHash('sha1');
  for (const dir of ['css', 'js']) {
    const full = path.join(PUBLIC_DIR, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full).sort()) hash.update(fs.readFileSync(path.join(full, file)));
  }
  return hash.digest('hex').slice(0, 10);
}
const ASSET_VERSION = assetVersion();
const ORIGIN = (process.env.APP_URL || 'https://friendatlas.com').replace(/\/$/, '');
const templates = {};
function page(name) {
  if (!templates[name] || !isProd) {
    templates[name] = fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8').replace(/__V__/g, ASSET_VERSION).replace(/__ORIGIN__/g, ORIGIN);
  }
  return templates[name];
}

// Same people and city counting as the browser (public/js/fa-core.js).
function summarize(friends) {
  const people = new Set();
  const cities = new Set();
  for (const f of friends) {
    people.add(String(f.name || '').trim().toLowerCase());
    let city = String(f.city || '');
    const country = String(f.country || '');
    if (country && city.toLowerCase().endsWith(`, ${country.toLowerCase()}`)) city = city.slice(0, -(country.length + 2));
    cities.add(`${normalize(city.split(',')[0])}|${normalize(country)}|${Math.round(Number(f.lat))}|${Math.round(Number(f.lng))}`);
  }
  return { people: people.size, cities: cities.size };
}

function escapeAttr(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

app.use(express.static(PUBLIC_DIR, {
  index: false,
  maxAge: isProd ? '7d' : 0,
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  },
}));

app.use('/api/jterm', jtermRoutes);
app.use('/api/atlas', atlasRoutes);
app.use('/api/places', placesRoutes);

app.get('/health', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
  }
});

app.get('/api/public-config', (req, res) => {
  res.json({
    ownerContact: process.env.OWNER_CONTACT || null,
    serviceName: 'Friend Atlas',
  });
});

app.get(['/jterm', '/jterm/', '/cbsj27', '/cbsj27/'], async (req, res) => {
  let html = page('jterm.html');
  try {
    // Once a few people have joined, the link preview shows the live count.
    const atlas = await db.getAtlasByCode((process.env.JTERM_ATLAS_CODE || 'CBSJ27').toUpperCase());
    if (atlas) {
      const { people, cities } = summarize(await db.getFriendsByAtlas(atlas.id));
      if (people >= 3) {
        const description = `${people} J-Termers in ${cities} ${cities === 1 ? 'city' : 'cities'} so far. See who is where, grab their recs, and add yourself.`;
        html = html
          .replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeAttr(description)}">`)
          .replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapeAttr(description)}">`);
      }
    }
  } catch (error) {
    console.error('J-Term preview error:', error);
  }
  res.set('Cache-Control', 'no-cache').type('html').send(html);
});

// The Startup Nation class page is retired; its map lives on in the main app.
app.get(['/startupnation', '/startupnation/', '/startupnationv2', '/startupnationv2/'], (req, res) => {
  res.redirect(302, `/join/${STARTUP_NATION_CODE}`);
});

app.get(['/privacy', '/privacy/'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'privacy.html')));

app.get('/join/:code', async (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  let html = page('index.html');

  try {
    const atlas = /^[A-Z0-9]{6}$/.test(code) ? await db.getAtlasByCode(code) : null;
    if (atlas) {
      const { people, cities } = summarize(await db.getFriendsByAtlas(atlas.id));
      const title = atlas.map_name || `${atlas.owner_name}'s Friend Atlas`;
      const description = people > 0
        ? `${people} ${people === 1 ? 'person' : 'people'} in ${cities} ${cities === 1 ? 'city' : 'cities'}. See who you know around the world, and add yourself.`
        : 'A shared map of where our friends live, where they are from, and the places they recommend. Add yourself.';
      const tags = `
    <meta property="og:title" content="${escapeAttr(title)}">
    <meta property="og:description" content="${escapeAttr(description)}">
    <meta property="og:url" content="${escapeAttr(`${appUrl}/join/${code}`)}">
    <meta name="twitter:title" content="${escapeAttr(title)}">
    <meta name="twitter:description" content="${escapeAttr(description)}">
  </head>`;
      html = html
        .replace(/<meta property="og:title"[^>]*>\s*/, '')
        .replace(/<meta property="og:description"[^>]*>\s*/, '')
        .replace('</head>', tags);
    }
  } catch (error) {
    console.error('OG tag injection error:', error);
  }

  res.set('Cache-Control', 'no-cache').type('html').send(html);
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'no-cache').type('html').send(page('index.html'));
});

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({ error: isProd ? 'Something went wrong' : err.message });
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await db.pool.end();
  process.exit(0);
});

// The Startup Nation class finished in May 2026. Keep its map readable but
// closed to new entries unless explicitly reopened.
async function closeFinishedClassAtlases() {
  if (process.env.STARTUP_NATION_OPEN === 'true') return;
  try {
    await db.pool.query(
      'UPDATE atlases SET contributions_locked = true, updated_at = NOW() WHERE code = $1 AND contributions_locked = false',
      [STARTUP_NATION_CODE]
    );
  } catch (error) {
    console.warn('Could not lock the Startup Nation atlas:', error.message);
  }
}

async function start(port = PORT) {
  try {
    await db.initialize();
    await closeFinishedClassAtlases();
    console.log('✓ Database initialized');
    return app.listen(port, () => {
      console.log(`✓ Friend Atlas running on port ${port}`);
    });
  } catch (error) {
    console.error('✗ Failed to start server:', error);
    process.exit(1);
  }
}

if (require.main === module) start();

module.exports = { app, start };
