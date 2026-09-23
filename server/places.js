// Offline city search backed by server/data/places.json (GeoNames, CC BY 4.0).
// Used for the city autocomplete and to turn "City, Country" text into
// coordinates without depending on a third-party geocoder.
const path = require('path');

const data = require(path.join(__dirname, 'data', 'places.json'));

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const ALIASES = {
  nyc: 'new york city', ny: 'new york city', 'new york': 'new york city',
  sf: 'san francisco', la: 'los angeles', dc: 'washington d c', 'washington dc': 'washington d c',
  philly: 'philadelphia', nola: 'new orleans', vegas: 'las vegas', atl: 'atlanta', chi: 'chicago',
  bk: 'brooklyn', cdmx: 'mexico city', df: 'mexico city', 'ciudad de mexico': 'mexico city',
  bkk: 'bangkok', hk: 'hong kong', sg: 'singapore', ldn: 'london', ams: 'amsterdam', bcn: 'barcelona',
  ba: 'buenos aires', rio: 'rio de janeiro', sp: 'sao paulo', sampa: 'sao paulo', tlv: 'tel aviv',
  saigon: 'ho chi minh city', hcmc: 'ho chi minh city', bombay: 'mumbai', bangalore: 'bengaluru',
  calcutta: 'kolkata', madras: 'chennai', kiev: 'kyiv', munchen: 'munich', muenchen: 'munich',
  lisboa: 'lisbon', roma: 'rome', milano: 'milan', napoli: 'naples', firenze: 'florence',
  venezia: 'venice', wien: 'vienna', praha: 'prague', warszawa: 'warsaw', cologne: 'koln',
  bruxelles: 'brussels', 'den haag': 'the hague', kobenhavn: 'copenhagen', geneve: 'geneva',
  peking: 'beijing', canton: 'guangzhou', 'st pete': 'saint petersburg', dxb: 'dubai',
  marrakech: 'marrakesh', majorca: 'mallorca', 'koh samui': 'ko samui', aruba: 'oranjestad',
  'st barths': 'gustavia', 'st barts': 'gustavia', oahu: 'honolulu', hamptons: 'the hamptons',
  gurugram: 'gurgaon', 'tel aviv yafo': 'tel aviv',
};

// Applied only when the query has no country or state qualifier.
const BARE_ALIASES = { washington: 'washington d c' };

const COUNTRY_ALIASES = {
  us: 'US', usa: 'US', 'united states': 'US', 'united states of america': 'US', america: 'US',
  uk: 'GB', 'united kingdom': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', britain: 'GB',
  'great britain': 'GB', 'northern ireland': 'GB', uae: 'AE', emirates: 'AE',
  korea: 'KR', 'south korea': 'KR', holland: 'NL', czechia: 'CZ', turkiye: 'TR',
};

const US_STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

const countries = data.countries;
const countryByNorm = new Map();
for (const [code, name] of Object.entries(countries)) {
  countryByNorm.set(normalize(name), code);
  countryByNorm.set(code.toLowerCase(), code);
}
for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) countryByNorm.set(alias, code);

const entries = data.places.map(([name, countryCode, region, lat, lng, population]) => {
  const norm = normalize(name);
  return {
    name,
    countryCode,
    country: countries[countryCode] || countryCode,
    region: region || '',
    lat,
    lng,
    population: population || 0,
    norm,
    words: norm.split(' '),
    weight: Math.log10((population || 0) + 10),
  };
});

function formatPlace(entry) {
  return {
    name: entry.name,
    region: entry.region || null,
    country: entry.country,
    countryCode: entry.countryCode,
    lat: entry.lat,
    lng: entry.lng,
    label: [entry.name, entry.region, entry.country].filter(Boolean).join(', '),
  };
}

function parseQuery(query) {
  const raw = String(query || '').slice(0, 120);
  const [cityRaw, ...rest] = raw.split(',');
  let city = normalize(cityRaw);
  let qualifier = normalize(rest.join(' '));
  // "Brooklyn NY" or "Portland Oregon" without a comma.
  if (!qualifier) {
    const words = city.split(' ');
    if (words.length > 1) {
      const last = words[words.length - 1];
      const lastTwo = words.slice(-2).join(' ');
      if (US_STATES[lastTwo] && words.length > 2) {
        qualifier = lastTwo; city = words.slice(0, -2).join(' ');
      } else if ((last.length === 2 && Object.values(US_STATES).includes(last.toUpperCase())) || US_STATES[last] || countryByNorm.has(last)) {
        if (!ALIASES[city] && !entries.some((e) => e.norm === city)) {
          qualifier = last; city = words.slice(0, -1).join(' ');
        }
      }
    }
  }
  if (ALIASES[city]) city = ALIASES[city];
  else if (!qualifier && BARE_ALIASES[city]) city = BARE_ALIASES[city];
  return { city, qualifier };
}

function qualifierMatches(entry, qualifier) {
  if (!qualifier) return true;
  const code = countryByNorm.get(qualifier);
  if (code && entry.countryCode === code) return true;
  const state = US_STATES[qualifier] || (qualifier.length === 2 ? qualifier.toUpperCase() : null);
  if (state && entry.region === state) return true;
  if (entry.region && normalize(entry.region) === qualifier) return true;
  return normalize(entry.country).startsWith(qualifier);
}

function search(query, limit = 8) {
  const { city, qualifier } = parseQuery(query);
  if (!city) return [];
  const scored = [];
  for (const entry of entries) {
    let score = 0;
    // Short exact matches ("san", "bar") are usually the start of a longer name.
    if (entry.norm === city) score = city.length >= 4 ? 100 : 72;
    else if (entry.norm.startsWith(city)) score = 80;
    else if (city.length >= 3 && entry.words.some((word) => word.startsWith(city))) score = 40;
    else continue;
    if (!qualifierMatches(entry, qualifier)) continue;
    scored.push({ entry, rank: score + entry.weight * 10 });
  }
  scored.sort((a, b) => b.rank - a.rank);
  const seen = new Set();
  const results = [];
  for (const { entry } of scored) {
    const key = `${entry.norm}|${entry.countryCode}|${entry.region}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(formatPlace(entry));
    if (results.length >= limit) break;
  }
  return results;
}

// Resolve free text such as "Lisbon, Portugal" to a single confident match.
function resolve(text) {
  const { city } = parseQuery(text);
  if (!city) return null;
  const [top] = search(text, 1);
  if (!top) return null;
  const topNorm = normalize(top.name);
  if (topNorm === city) return top;
  const entry = entries.find((e) => e.name === top.name && e.countryCode === top.countryCode && e.region === (top.region || ''));
  if (entry && topNorm.startsWith(city) && entry.population >= 50000) return top;
  return null;
}

module.exports = { search, resolve, normalize, attribution: data.attribution, size: entries.length };
