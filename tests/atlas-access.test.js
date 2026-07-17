process.env.NODE_ENV = 'test';
process.env.USE_IN_MEMORY_DB = 'true';
process.env.SESSION_SECRET = 'test-only-session-secret';
process.env.APP_URL = 'http://localhost:3000';
process.env.OWNER_CONTACT = 'organizer@example.com';
process.env.JTERM_ADMIN_KEY = 'test-jterm-administrator-key-1234567890';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const db = require('../server/db');
const { app } = require('../server/index');

test.before(async () => {
  await db.initialize();
});

test('owner, contribution, export, rotation, and moderation boundaries', async () => {
  const owner = request.agent(app);
  const contributor = request.agent(app);
  const outsider = request.agent(app);

  const created = await owner
    .post('/api/atlas/create')
    .send({ name: 'Owner', mapName: 'Boundary Test Atlas' })
    .expect(200);

  const { code, id: atlasId } = created.body.atlas;
  const firstToken = created.body.contributionToken;
  assert.match(firstToken, /^[A-Za-z0-9_-]{40,}$/);

  const publicAtlas = await outsider.get(`/api/atlas/code/${code}`).expect(200);
  assert.equal(publicAtlas.body.atlas.isOwner, false);
  assert.equal(publicAtlas.body.atlas.contributionTokenRequired, true);
  assert.equal('ownerId' in publicAtlas.body.atlas, false);

  const ownerView = await owner.get(`/api/atlas/code/${code}`).expect(200);
  assert.equal(ownerView.body.atlas.isOwner, true);

  const place = {
    name: 'Maya R.', city: 'Lisbon, Portugal', country: 'Portugal',
    lat: 38.7223, lng: -9.1393, pinType: 'current', color: '#3b82f6',
    recommendations: [{ category: 'eat', name: 'Prado', note: 'Book ahead.' }],
  };

  await contributor.post(`/api/atlas/code/${code}/join-anon`).send(place).expect(403);
  const joined = await contributor
    .post(`/api/atlas/code/${code}/join-anon`)
    .send({ ...place, inviteToken: firstToken })
    .expect(200);
  const friendId = joined.body.friend.id;
  const recommendationId = joined.body.friend.recommendations[0].id;

  await contributor.get(`/api/atlas/${atlasId}/export`).expect(403);
  const exported = await owner.get(`/api/atlas/${atlasId}/export`).expect(200);
  assert.equal(exported.body.friends.length, 1);
  assert.equal('contribution_token_hash' in exported.body.atlas, false);
  assert.equal('session_id' in exported.body.friends[0], false);

  await contributor.patch(`/api/atlas/code/${code}/settings`).send({ contributionsLocked: true }).expect(403);
  await owner.patch(`/api/atlas/code/${code}/settings`).send({ contributionsLocked: true }).expect(200);
  await outsider.post(`/api/atlas/code/${code}/join-anon`).send({ ...place, inviteToken: firstToken, name: 'Blocked' }).expect(423);
  await owner.patch(`/api/atlas/code/${code}/settings`).send({ contributionsLocked: false }).expect(200);

  const rotated = await owner.post(`/api/atlas/code/${code}/rotate-invite`).expect(200);
  const secondToken = rotated.body.contributionToken;
  assert.notEqual(secondToken, firstToken);
  await outsider.post(`/api/atlas/code/${code}/join-anon`).send({ ...place, inviteToken: firstToken, name: 'Old Link' }).expect(403);
  await outsider.post(`/api/atlas/code/${code}/join-anon`).send({ ...place, inviteToken: secondToken, name: 'New Link', pinType: 'know' }).expect(200);

  await contributor.delete(`/api/atlas/code/${code}/recommendation/${recommendationId}`).expect(403);
  await owner.delete(`/api/atlas/code/${code}/recommendation/${recommendationId}`).expect(200);

  await outsider.delete(`/api/atlas/${atlasId}/friend/${friendId}`).expect(404);
  await owner.patch(`/api/atlas/code/${code}/friend/${friendId}`).send({
    name: 'Maya R.', city: 'Porto, Portugal', country: 'Portugal',
    lat: 41.1579, lng: -8.6291, pinType: 'current', color: '#3b82f6', note: 'Corrected by owner',
  }).expect(200);
  await owner.delete(`/api/atlas/${atlasId}/friend/${friendId}`).expect(200);

  await outsider.delete(`/api/atlas/code/${code}`).expect(403);
  await owner.delete(`/api/atlas/code/${code}`).expect(200);
  await outsider.get(`/api/atlas/code/${code}`).expect(404);
});

test('J-Term saves the person before the optional recommendation', async () => {
  const participant = request.agent(app);
  const outsider = request.agent(app);
  const administrator = request.agent(app);

  const joined = await participant.post('/api/jterm/join').send({
    name: 'Alex P.',
    location: 'Lisbon, Portugal',
    relationship: 'know',
    notes: '',
  }).expect(200);

  assert.ok(joined.body.friend.id);
  const atlasBefore = await participant.get('/api/atlas/code/CBSJ27').expect(200);
  const saved = atlasBefore.body.friends.find(friend => friend.id === joined.body.friend.id);
  assert.equal(saved.pinType, 'know');
  assert.deepEqual(saved.recommendations, []);

  await outsider.post('/api/jterm/recommendation').send({
    friendId: saved.id,
    category: 'tip',
    name: 'Use the metro card',
  }).expect(401);

  await participant.post('/api/jterm/recommendation').send({
    friendId: saved.id,
    category: 'eat',
    name: 'Prado',
    note: 'Book ahead for dinner.',
  }).expect(200);

  const atlasAfter = await participant.get('/api/atlas/code/CBSJ27').expect(200);
  const updated = atlasAfter.body.friends.find(friend => friend.id === saved.id);
  assert.equal(updated.recommendations.length, 1);
  assert.equal(updated.recommendations[0].name, 'Prado');

  await administrator.post('/api/jterm/claim-owner').send({ key: 'wrong-key-that-is-still-long-enough-123' }).expect(403);
  await administrator.post('/api/jterm/claim-owner').send({ key: process.env.JTERM_ADMIN_KEY }).expect(200);
  const adminView = await administrator.get('/api/atlas/code/CBSJ27').expect(200);
  assert.equal(adminView.body.atlas.isOwner, true);
  await administrator.patch('/api/atlas/code/CBSJ27/settings').send({ contributionsLocked: true }).expect(200);
  await administrator.patch('/api/atlas/code/CBSJ27/settings').send({ contributionsLocked: false }).expect(200);
});
