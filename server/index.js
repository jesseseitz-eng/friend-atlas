require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const atlasRoutes = require('./routes/atlas');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "unpkg.com", "cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "unpkg.com"],
      fontSrc: ["'self'", "fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "*.basemaps.cartocdn.com", "*.tile.openstreetmap.org", "*.googleusercontent.com", "*.githubusercontent.com", "*.workos.com"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(compression());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts, please try again later.' },
});

app.use('/api/', limiter);
app.use('/auth/', authLimiter);

app.use(cors({
  origin: isProd ? process.env.APP_URL : 'http://localhost:3000',
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: isProd ? 'strict' : 'lax',
  },
}));

app.use(express.static(path.join(__dirname, '../public'), {
  maxAge: isProd ? '1d' : 0,
  etag: true,
}));

app.use('/api/atlas', atlasRoutes);

// Simple session-based auth endpoints (no WorkOS needed)
app.get('/auth/session', (req, res) => {
  res.json({ authenticated: !!req.cookies?.anon_session, user: null });
});
app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/health', async (req, res) => {
  try {
    await db.pool.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: 'Database connection failed' });
  }
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// Read index.html template once at startup for OG tag injection
const indexHtml = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

// Pretty share URL with dynamic OG meta tags
app.get('/join/:code', async (req, res) => {
  const code = req.params.code.toUpperCase();
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

  try {
    const atlas = await db.getAtlasByCode(code);
    if (atlas) {
      const stats = await db.getAtlasStats(atlas.id);
      const friendCount = parseInt(stats.total_friends);
      const cityCount = parseInt(stats.cities);
      const countryCount = parseInt(stats.countries);

      // Sanitize for HTML attribute injection
      const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const ownerName = esc(atlas.owner_name);

      const ogTitle = `Join ${ownerName}'s Friend Atlas`;
      const ogDesc = friendCount > 0
        ? `${friendCount} friend${friendCount !== 1 ? 's' : ''} across ${cityCount} cit${cityCount !== 1 ? 'ies' : 'y'} in ${countryCount} countr${countryCount !== 1 ? 'ies' : 'y'} — drop your pin!`
        : `Drop your pin on ${ownerName}'s map!`;
      const ogUrl = `${appUrl}/join/${code}`;
      const ogImage = `${appUrl}/api/atlas/code/${code}/og-image`;

      const ogTags = `
    <meta property="og:type" content="website">
    <meta property="og:title" content="${ogTitle}">
    <meta property="og:description" content="${ogDesc}">
    <meta property="og:image" content="${ogImage}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:url" content="${ogUrl}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${ogTitle}">
    <meta name="twitter:description" content="${ogDesc}">
    <meta name="twitter:image" content="${ogImage}">`;

      const html = indexHtml.replace(
        '<meta name="description" content="Map your friendships across the world">',
        `<meta name="description" content="${ogDesc}">${ogTags}`
      );
      return res.send(html);
    }
  } catch (error) {
    console.error('OG tag injection error:', error);
  }

  // Fallback: serve index.html with default meta
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
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

async function start() {
  try {
    await db.initialize();
    console.log('✓ Database initialized');
    app.listen(PORT, () => {
      console.log(`✓ Friend Atlas running on port ${PORT}`);
    });
  } catch (error) {
    console.error('✗ Failed to start server:', error);
    process.exit(1);
  }
}

start();
