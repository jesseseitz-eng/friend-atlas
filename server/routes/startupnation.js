const express = require('express');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const db = require('../db');

const router = express.Router();

const STARTUP_NATION_CODE = (process.env.STARTUP_NATION_ATLAS_CODE || 'STNATN').toUpperCase();
const OWNER_ID = 'startupnation_owner';
const OWNER_NAME = 'Startup Nation';
const MAP_NAME = 'Startup Nation Atlas';

const FALLBACK_GEO = [
  ['miami', 'Miami', 'USA', 25.7617, -80.1918],
  ['miami fl', 'Miami', 'USA', 25.7617, -80.1918],
  ['new york', 'New York City', 'USA', 40.7128, -74.006],
  ['nyc', 'New York City', 'USA', 40.7128, -74.006],
  ['lima', 'Lima', 'Peru', -12.0464, -77.0428],
  ['lisbon', 'Lisbon', 'Portugal', 38.7223, -9.1393],
  ['madrid', 'Madrid', 'Spain', 40.4168, -3.7038],
  ['tokyo', 'Tokyo', 'Japan', 35.6762, 139.6503],
  ['mexico city', 'Mexico City', 'Mexico', 19.4326, -99.1332],
  ['cdmx', 'Mexico City', 'Mexico', 19.4326, -99.1332],
  ['sao paulo', 'Sao Paulo', 'Brazil', -23.5505, -46.6333],
  ['london', 'London', 'UK', 51.5074, -0.1278],
  ['paris', 'Paris', 'France', 48.8566, 2.3522],
  ['tel aviv', 'Tel Aviv', 'Israel', 32.0853, 34.7818],
  ['tel aviv yafo', 'Tel Aviv', 'Israel', 32.0853, 34.7818],
  ['jerusalem', 'Jerusalem', 'Israel', 31.7683, 35.2137],
  ['haifa', 'Haifa', 'Israel', 32.794, 34.9896],
  ['singapore', 'Singapore', 'Singapore', 1.3521, 103.8198],
  ['hong kong', 'Hong Kong', 'China', 22.3193, 114.1694],
  ['seoul', 'Seoul', 'South Korea', 37.5665, 126.978],
  ['dubai', 'Dubai', 'UAE', 25.2048, 55.2708],
  ['buenos aires', 'Buenos Aires', 'Argentina', -34.6037, -58.3816],
  ['bogota', 'Bogota', 'Colombia', 4.711, -74.0721],
  ['toronto', 'Toronto', 'Canada', 43.6532, -79.3832],
];

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
}

function normalizeLocation(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\bflorida\b/g, 'fl')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function splitPlaces(value) {
  return String(value || '')
    .split(/[;\n]/)
    .flatMap((part) => {
      const trimmed = part.trim();
      if (/,\s*[A-Za-z]{2,3}$/.test(trimmed)) return [trimmed];
      return trimmed.split(',');
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function cleanNote(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

async function ensureStartupNationAtlas() {
  const existing = await db.getAtlasByCode(STARTUP_NATION_CODE);
  if (existing) return existing;

  await db.findOrCreateUser({
    id: OWNER_ID,
    email: 'startupnation@friendatlas.local',
    name: OWNER_NAME,
    profilePicture: null,
  });

  try {
    return await db.createAtlas(STARTUP_NATION_CODE, OWNER_ID, OWNER_NAME, MAP_NAME);
  } catch (error) {
    const createdByAnotherRequest = await db.getAtlasByCode(STARTUP_NATION_CODE);
    if (createdByAnotherRequest) return createdByAnotherRequest;
    throw error;
  }
}

async function geocodeLocation(query) {
  const raw = String(query || '').trim();
  const normalized = normalizeLocation(raw);
  const fallback = FALLBACK_GEO.find(([key]) => normalized === key || normalized.startsWith(`${key} `));
  if (fallback) {
    const [, city, country, lat, lng] = fallback;
    return { city, country, lat, lng };
  }

  if (typeof fetch === 'function') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('limit', '1');
      url.searchParams.set('q', raw);
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'FriendAtlas/1.0 (https://friendatlas.com)',
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        const results = await response.json();
        const match = results && results[0];
        if (match) {
          const address = match.address || {};
          const city = address.city || address.town || address.village || address.municipality || address.county || raw.split(',')[0].trim();
          const country = address.country || raw.split(',').slice(1).join(',').trim() || null;
          return {
            city,
            country,
            lat: parseFloat(match.lat),
            lng: parseFloat(match.lon),
          };
        }
      }
    } catch (error) {
      console.warn('Startup Nation geocode failed:', error.message);
    }
  }

  return null;
}

function linesFromNote(text) {
  const cleaned = cleanNote(text, 1200);
  if (!cleaned) return [];
  return cleaned
    .split(/\n|;/)
    .map((line) => line.replace(/^[-*•\d.)\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function recommendationsFromNote(text, placeName) {
  const escapedPlace = String(placeName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return linesFromNote(text).map((line) => {
    const withoutPlacePrefix = line.replace(new RegExp(`^${escapedPlace}\\s*[-:–—]\\s*`, 'i'), '').trim();
    const split = withoutPlacePrefix.match(/^(.{3,80}?)(?:\s[-:–—]\s|\s+-\s+)(.+)$/);
    const name = (split ? split[1] : withoutPlacePrefix).slice(0, 120);
    const note = (split ? split[2] : withoutPlacePrefix).slice(0, 500);
    return { category: 'tip', name, note };
  });
}

function noteForPlace(text, placeName) {
  const lines = linesFromNote(text);
  if (!lines.length) return '';
  const key = normalizeLocation(placeName).split(' ')[0];
  const matching = lines.filter((line) => normalizeLocation(line).includes(key));
  return (matching.length ? matching : lines).join('\n').slice(0, 500);
}

async function savePlace({ atlasId, sessionId, name, place, note, pinType, color, publishRecommendations = true }) {
  const geo = await geocodeLocation(place);
  if (!geo || Number.isNaN(geo.lat) || Number.isNaN(geo.lng)) {
    const error = new Error(`I could not find "${place}". Try "City, Country" or a nearby major city.`);
    error.statusCode = 400;
    throw error;
  }

  const friend = await db.addAnonymousFriend(atlasId, sessionId, {
    name,
    city: geo.city,
    country: geo.country,
    lat: geo.lat,
    lng: geo.lng,
    note: cleanNote(note),
    color,
    referredBy: 'startupnation',
    pinType,
  });

  const recs = publishRecommendations ? recommendationsFromNote(note, geo.city) : [];
  const savedRecommendations = await db.replaceRecsForFriend(friend.id, recs);
  return { ...friend, recommendations: savedRecommendations };
}

router.post('/join',
  body('name').isString().trim().isLength({ min: 1, max: 100 }).withMessage('Name is required'),
  body('location').isString().trim().isLength({ min: 1, max: 255 }).withMessage('One location is required'),
  body('current').optional({ values: 'falsy' }).isString().trim().isLength({ max: 255 }).withMessage('Current city is too long'),
  body('known').optional({ values: 'falsy' }).isString().trim().isLength({ max: 500 }).withMessage('Other places is too long'),
  body('notes').isString().trim().isLength({ min: 1, max: 1200 }).withMessage('Add one rec to unlock the map'),
  body('otherNotes').optional({ values: 'falsy' }).isString().trim().isLength({ max: 1200 }).withMessage('Other recs are too long'),
  body('shareScope').optional({ values: 'falsy' }).isString().custom(value => ['everyone', 'private', 'host', 'jesse'].includes(value)).withMessage('Invalid sharing choice'),
  validate,
  async (req, res) => {
    try {
      const atlas = await ensureStartupNationAtlas();
      let sessionId = req.cookies?.anon_session;
      if (!sessionId) sessionId = crypto.randomBytes(32).toString('hex');

      const name = req.body.name.trim();
      const primaryLocation = req.body.location.trim();
      const current = String(req.body.current || '').trim();
      const knownPlaces = splitPlaces(req.body.known);
      const notes = cleanNote(req.body.notes, 1200);
      const otherNotes = cleanNote(req.body.otherNotes, 1200);
      const shareScope = ['private', 'host', 'jesse'].includes(req.body.shareScope) ? 'private' : 'everyone';
      const publishRecs = shareScope === 'everyone';
      const savedPlaces = [];

      savedPlaces.push(await savePlace({
        atlasId: atlas.id,
        sessionId,
        name,
        place: primaryLocation,
        note: publishRecs ? notes : 'Rec shared privately with the class host.',
        pinType: 'hometown',
        color: '#0891b2',
        publishRecommendations: publishRecs,
      }));

      if (!publishRecs) {
        await db.addJtermPrivateRec({
          atlasId: atlas.id,
          friendId: savedPlaces[0]?.id,
          sessionId,
          name,
          place: primaryLocation,
          notes,
          otherNotes,
        });
      }

      const seen = new Set([normalizeLocation(primaryLocation)]);
      if (current && !seen.has(normalizeLocation(current))) {
        seen.add(normalizeLocation(current));
        savedPlaces.push(await savePlace({
          atlasId: atlas.id,
          sessionId,
          name,
          place: current,
          note: 'Current city',
          pinType: 'current',
          color: '#2563eb',
        }));
      }

      for (const place of knownPlaces) {
        const normalized = normalizeLocation(place);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        const placeNote = noteForPlace(otherNotes, place);
        savedPlaces.push(await savePlace({
          atlasId: atlas.id,
          sessionId,
          name,
          place,
          note: publishRecs ? placeNote : (placeNote ? 'Rec shared privately with the class host.' : ''),
          pinType: 'know',
          color: '#177a5c',
          publishRecommendations: publishRecs,
        }));
      }

      res.cookie('anon_session', sessionId, {
        maxAge: 365 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
      });

      res.json({
        success: true,
        atlas: { id: atlas.id, code: atlas.code, mapName: atlas.map_name || MAP_NAME },
        friends: savedPlaces.map((place) => ({ id: place.id, name: place.name })),
        shareScope,
        redirectUrl: `/join/${atlas.code}`,
      });
    } catch (error) {
      console.error('Startup Nation join error:', error);
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to join the Startup Nation Atlas' });
    }
  }
);

module.exports = router;
