process.env.NODE_ENV = 'test';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.APP_URL = 'http://localhost:3000';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../server/db');
const places = require('../server/places');
const { app } = require('../server/index');

test.before(async () => {
  await db.initialize();
});

test('city search ranks big, well-known cities first and understands aliases', () => {
  assert.equal(places.search('lis')[0].label, 'Lisbon, Portugal');
  assert.equal(places.search('nyc')[0].label, 'New York City, NY, USA');
  assert.equal(places.search('portland, me')[0].label, 'Portland, ME, USA');
  assert.equal(places.search('krakow')[0].name, 'Kraków');
  assert.equal(places.search('washington')[0].label, 'Washington, D.C., DC, USA');
  assert.equal(places.resolve('Somewhere Nowhere'), null);
  assert.equal(places.resolve('Lima').country, 'Peru');
});

test('places endpoint returns results and ignores one-letter queries', async () => {
  const res = await request(app).get('/api/places/search?q=bogo').expect(200);
  assert.equal(res.body.results[0].name, 'Bogotá');
  const empty = await request(app).get('/api/places/search?q=b').expect(200);
  assert.deepEqual(empty.body.results, []);
});

test('atlas owner can add places without the invite token; others cannot', async () => {
  const owner = request.agent(app);
  const other = request.agent(app);
  const created = await owner.post('/api/atlas/create').send({ name: 'Owner' }).expect(200);
  const { code } = created.body.atlas;
  const place = { name: 'Owner', city: 'Lisbon', country: 'Portugal', lat: 38.72, lng: -9.14, pinType: 'current' };
  await owner.post(`/api/atlas/code/${code}/join-anon`).send(place).expect(200);
  await other.post(`/api/atlas/code/${code}/join-anon`).send({ ...place, name: 'Stranger' }).expect(403);
});

test('J-Term accepts a picked place without geocoding it', async () => {
  const agent = request.agent(app);
  const joined = await agent.post('/api/jterm/join').send({
    name: 'Picked P.',
    location: 'Guayaquil, Ecuador',
    relationship: 'hometown',
    place: { city: 'Guayaquil', country: 'Ecuador', lat: -2.19, lng: -79.88 },
  }).expect(200);
  const atlas = await agent.get('/api/atlas/code/CBSJ27').expect(200);
  const saved = atlas.body.friends.find((f) => f.id === joined.body.friend.id);
  assert.equal(saved.city, 'Guayaquil');
  assert.equal(saved.country, 'Ecuador');
});

test('pages get versioned assets and per-atlas share previews', async () => {
  const owner = request.agent(app);
  const created = await owner.post('/api/atlas/create').send({ name: 'Maya', mapName: 'Maya <Travel> Map' }).expect(200);
  const html = (await request(app).get(`/join/${created.body.atlas.code}`).expect(200)).text;
  assert.ok(!html.includes('__V__') && !html.includes('__ORIGIN__'));
  assert.match(html, /<meta property="og:title" content="Maya &lt;Travel&gt; Map">/);
  assert.match(html, /og:image" content="http:\/\/localhost:3000\/og\.png"/);
  const home = await request(app).get('/').expect(200);
  assert.match(home.text, /\/js\/app\.js\?v=[0-9a-f]{10}/);
  const jterm = await request(app).get('/jterm').expect(200);
  assert.equal(jterm.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
});

test('retired pages redirect and unknown API paths are JSON 404s', async () => {
  const res = await request(app).get('/startupnation').expect(302);
  assert.equal(res.headers.location, '/join/STNATN');
  await request(app).get('/test1').expect(200); // falls back to the app shell
  const missing = await request(app).get('/api/nope').expect(404);
  assert.equal(missing.body.error, 'Not found');
});
