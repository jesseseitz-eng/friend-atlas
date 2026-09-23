const express = require('express');
const rateLimit = require('express-rate-limit');
const places = require('../places');

const router = express.Router();

// Autocomplete fires on keystrokes, and a whole class can share one campus IP.
const searchLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many searches. Please wait a moment.' },
});

router.get('/search', searchLimiter, (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q.length < 2) return res.json({ results: [] });
  res.set('Cache-Control', 'public, max-age=86400');
  res.json({ results: places.search(q, 8) });
});

module.exports = router;
