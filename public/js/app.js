/* Friend Atlas main app: homepage, atlas view, adding places, sharing, and
   owner tools. Depends on fa-core.js (window.FA) and fa-map.js (window.FAMap). */
(function () {
  'use strict';

  const {
    RELATION_ORDER, REC_CATEGORIES, esc, initials, relation, recCategory, flag,
    cityName, placeLabel, timeAgo, plural, api, toast, storage, groupByCity, groupByPerson, personKey, placeInput,
  } = window.FA;

  const $ = (id) => document.getElementById(id);
  const local = storage('local');
  const session = storage('session');
  const mobileQuery = window.matchMedia('(max-width: 760px)');
  const isMobile = () => mobileQuery.matches;

  const state = {
    atlas: null,
    entries: [],
    stats: {},
    tab: 'cities',
    view: null, // { type: 'city', key } | { type: 'person', key }
    query: '',
    relations: new Set(RELATION_ORDER),
    inviteToken: null,
    myIds: [],
    myName: '',
    map: null,
    sheet: 'peek',
  };

  // ---------- storage helpers ----------
  const keys = {
    pins: (code) => `my-pins-${code}`,
    pin: (code) => `my-pin-${code}`,
    name: (code) => `my-name-${code}`,
    invite: (code) => `invite-token-${code}`,
  };

  function readJson(key, fallback) {
    try { const v = JSON.parse(local.getItem(key) || 'null'); return v ?? fallback; } catch { return fallback; }
  }

  function loadMine(code) {
    const ids = readJson(keys.pins(code), []);
    const legacy = Number(local.getItem(keys.pin(code)) || 0);
    state.myIds = [...new Set([...(Array.isArray(ids) ? ids : []), legacy].map(Number).filter(Boolean))];
    state.myName = local.getItem(keys.name(code)) || '';
  }

  function saveMine() {
    const code = state.atlas.code;
    local.setItem(keys.pins(code), JSON.stringify(state.myIds));
    if (state.myName) local.setItem(keys.name(code), state.myName);
  }

  function rememberRecent(atlas) {
    const recent = readJson('fa-recent', []).filter((r) => r && r.code !== atlas.code);
    recent.unshift({ code: atlas.code, name: atlas.mapName || `${atlas.ownerName}'s Friend Atlas`, owner: !!atlas.isOwner, at: Date.now() });
    local.setItem('fa-recent', JSON.stringify(recent.slice(0, 6)));
    local.setItem('lastAtlas', atlas.code);
  }

  function forgetRecent(code) {
    local.setItem('fa-recent', JSON.stringify(readJson('fa-recent', []).filter((r) => r && r.code !== code)));
    if (local.getItem('lastAtlas') === code) local.removeItem('lastAtlas');
  }

  const isMine = (entry) => state.myIds.includes(Number(entry.id));
  const mapTitle = () => state.atlas.mapName || `${state.atlas.ownerName}'s Friend Atlas`;
  const canContribute = () => state.atlas && !state.atlas.contributionsLocked
    && (state.atlas.isOwner || !state.atlas.contributionTokenRequired || !!state.inviteToken);

  // ---------- dialogs ----------
  function openDialog(id) {
    const dialog = $(id);
    dialog.classList.toggle('as-sheet', true);
    if (!dialog.open) dialog.showModal();
    return dialog;
  }

  function closeDialog(id) {
    const dialog = $(id);
    if (dialog.open) dialog.close();
  }

  function showError(id, message) {
    const el = $(id);
    el.textContent = message || '';
    el.classList.toggle('show', !!message);
  }

  function confirmAction({ title, text, ok = 'Remove', danger = true, typeToConfirm = null }) {
    return new Promise((resolve) => {
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text || '';
      $('confirmOk').textContent = ok;
      $('confirmOk').className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
      $('confirmExtra').hidden = !typeToConfirm;
      $('confirmInput').value = '';
      if (typeToConfirm) $('confirmInputLabel').textContent = `Type ${typeToConfirm} to confirm`;
      const dialog = openDialog('confirmDialog');
      const onClose = () => {
        dialog.removeEventListener('close', onClose);
        const ok = dialog.returnValue === 'ok' && (!typeToConfirm || $('confirmInput').value.trim().toUpperCase() === typeToConfirm);
        if (dialog.returnValue === 'ok' && typeToConfirm && !ok) toast('That did not match, so nothing was deleted');
        resolve(ok);
      };
      dialog.returnValue = '';
      dialog.addEventListener('close', onClose);
    });
  }

  // ---------- boot ----------
  async function boot() {
    const params = new URLSearchParams(location.search);
    const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
    const pathMatch = location.pathname.match(/^\/join\/([A-Za-z0-9]{6})\/?$/);
    const code = (pathMatch ? pathMatch[1] : params.get('code') || '').toUpperCase();
    const invite = fragment.get('invite') || params.get('invite');
    if (code && invite) {
      session.setItem(keys.invite(code), invite);
      local.setItem(keys.invite(code), invite);
    }
    wireHome();
    wireAtlas();
    wireDialogs();
    if (code) {
      try {
        await openAtlas(code);
        return;
      } catch (error) {
        forgetRecent(code);
        history.replaceState(null, '', '/');
        showHome();
        toast(error.status === 404 ? 'We could not find that map. Check the code.' : 'That map did not load. Try again in a moment.');
        return;
      }
    }
    showHome();
  }

  // ---------- home ----------
  let heroMap = null;
  function showHome() {
    document.body.classList.remove('in-atlas');
    $('atlas').hidden = true;
    $('home').hidden = false;
    document.title = 'Friend Atlas · Know someone there';
    renderRecent();
    if (!heroMap && window.maplibregl) startHeroGlobe();
  }

  function renderRecent() {
    const recent = readJson('fa-recent', []).filter((r) => r && /^[A-Z0-9]{6}$/.test(r.code));
    $('recent').hidden = !recent.length;
    $('recentList').innerHTML = recent.map((r) => `<a class="recent-item" href="/join/${esc(r.code)}">${esc(r.name)} <small>${r.owner ? 'yours' : esc(r.code)}</small></a>`).join('');
  }

  function startHeroGlobe() {
    const sample = [
      ['Sarah K', 'New York City', 'USA', 40.71, -74.0, 'current'], ['Vince L', 'Miami', 'USA', 25.76, -80.19, 'current'],
      ['Marc D', 'Lisbon', 'Portugal', 38.72, -9.14, 'current'], ['Ana P', 'Lisbon', 'Portugal', 38.72, -9.14, 'hometown'],
      ['Diego R', 'Mexico City', 'Mexico', 19.43, -99.13, 'hometown'], ['Priya S', 'London', 'UK', 51.51, -0.13, 'current'],
      ['Kenji T', 'Tokyo', 'Japan', 35.68, 139.69, 'hometown'], ['Lea M', 'Buenos Aires', 'Argentina', -34.6, -58.38, 'know'],
      ['Nina A', 'Tel Aviv', 'Israel', 32.09, 34.78, 'hometown'], ['Tom B', 'Sydney', 'Australia', -33.87, 151.21, 'current'],
      ['Ola N', 'Lagos', 'Nigeria', 6.52, 3.38, 'hometown'], ['Jules F', 'Paris', 'France', 48.86, 2.35, 'lived'],
    ].map(([name, city, country, lat, lng, pinType], id) => ({ id, name, city, country, lat, lng, pinType, recommendations: [] }));
    heroMap = window.FAMap.create($('heroGlobe'), { interactive: false, globe: true, center: [-30, 24], zoom: isMobile() ? 1.25 : 1.6, clusterRadius: 0 });
    heroMap.ready.then((m) => { if (m) document.querySelector('.globe-static').hidden = true; });
    heroMap.setGroups(groupByCity(sample));
    heroMap.spin(4);
  }

  function wireHome() {
    $('startBtn').addEventListener('click', () => openCreate());
  }

  function openCreate() {
    showError('createError', '');
    $('createName').value = '';
    $('createMapName').value = '';
    openDialog('createDialog');
    setTimeout(() => $('createName').focus(), 60);
  }

  // ---------- atlas load ----------
  async function openAtlas(code, { push = false } = {}) {
    const data = await api(`/api/atlas/code/${encodeURIComponent(code)}`);
    applyAtlas(data);
    rememberRecent(state.atlas);
    const url = `/join/${state.atlas.code}`;
    if (push && location.pathname !== url) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    showAtlas();
  }

  function applyAtlas(data) {
    const previous = state.atlas?.code;
    state.atlas = data.atlas;
    state.entries = (data.friends || []).map((f) => ({ ...f, lat: Number(f.lat), lng: Number(f.lng), pinType: f.pinType || 'current', recommendations: f.recommendations || [] }));
    state.stats = data.stats || {};
    if (previous !== state.atlas.code) {
      state.inviteToken = session.getItem(keys.invite(state.atlas.code)) || local.getItem(keys.invite(state.atlas.code)) || null;
      loadMine(state.atlas.code);
      state.view = null;
      state.query = '';
      $('search').value = '';
    }
    // Drop remembered ids for entries that no longer exist.
    const ids = new Set(state.entries.map((e) => Number(e.id)));
    state.myIds = state.myIds.filter((id) => ids.has(id));
    saveMine();
  }

  async function refresh() {
    const data = await api(`/api/atlas/code/${state.atlas.code}`);
    applyAtlas(data);
    render({ fit: false });
  }

  function showAtlas() {
    $('home').hidden = true;
    $('atlas').hidden = false;
    document.body.classList.add('in-atlas');
    document.title = `${mapTitle()} · Friend Atlas`;
    if (!state.map) {
      state.map = window.FAMap.create($('map'), { onSelect: (group) => openCity(group.key, { fly: false }), controlsPosition: 'bottom-right' });
    }
    renderHeader();
    setSheet(state.entries.length ? 'peek' : 'half', { silent: true });
    updateMapPadding();
    render({ fit: true });
    setTimeout(() => state.map.resize(), 50);
    if (document.fonts?.ready) document.fonts.ready.then(() => { setSheet(state.sheet, { silent: true }); updateMapPadding(); });
  }

  // ---------- filtering ----------
  function visibleEntries() {
    return state.entries.filter((e) => state.relations.has(e.pinType));
  }

  function matches(entry, q) {
    if (!q) return true;
    const recs = (entry.recommendations || []).map((r) => `${r.name} ${r.note || ''}`).join(' ');
    return `${entry.name} ${cityName(entry)} ${entry.country || ''} ${entry.note || ''} ${recs}`.toLowerCase().includes(q);
  }

  // ---------- render ----------
  function render({ fit = false } = {}) {
    renderHeader();
    renderLegend();
    const entries = visibleEntries();
    const groups = groupByCity(entries);
    const q = state.query.trim().toLowerCase();
    state.map.setGroups(groups, { fit, animate: false });
    state.map.dim(q ? groups.filter((g) => g.entries.some((e) => matches(e, q))).map((g) => g.key) : null);
    $('nCities').textContent = groups.length ? ` ${groups.length}` : '';
    $('nPeople').textContent = entries.length ? ` ${groupByPerson(entries).length}` : '';
    const recCount = entries.reduce((s, e) => s + e.recommendations.length, 0);
    $('nRecs').textContent = recCount ? ` ${recCount}` : '';
    renderPanel();
  }

  function renderHeader() {
    const a = state.atlas;
    const entries = state.entries;
    const people = groupByPerson(entries).length;
    const cities = groupByCity(entries).length;
    const recs = entries.reduce((s, e) => s + e.recommendations.length, 0);
    $('mapTitle').textContent = mapTitle();
    const parts = [`by <strong>${esc(a.ownerName)}</strong>`];
    if (people) parts.push(plural(people, 'person', 'people'), plural(cities, 'city', 'cities'));
    if (recs) parts.push(plural(recs, 'rec'));
    $('mapSub').innerHTML = parts.join(' · ');
    const addBtn = $('addBtn');
    const mine = state.entries.some(isMine);
    if (a.contributionsLocked) { addBtn.textContent = 'Closed to new entries'; addBtn.disabled = true; }
    else if (!canContribute()) { addBtn.textContent = 'View only'; addBtn.disabled = true; addBtn.title = `Ask ${a.ownerName} for the invite link to add yourself`; }
    else { addBtn.textContent = mine ? 'Add another place' : 'Add yourself'; addBtn.disabled = false; addBtn.title = ''; }
    $('inviteBtn').hidden = !a.isOwner && !canContribute();
  }

  function renderLegend() {
    const present = new Set(state.entries.map((e) => e.pinType));
    const types = RELATION_ORDER.filter((t) => present.has(t));
    $('legend').hidden = types.length < 2;
    $('legend').innerHTML = types.map((t) => `<button class="chip" type="button" data-rel="${t}" aria-pressed="${state.relations.has(t)}" style="--c:${relation(t).color}">${esc(relation(t).label)}</button>`).join('');
  }

  function renderPanel() {
    document.querySelectorAll('.tab').forEach((tab) => {
      const on = tab.dataset.tab === state.tab && !state.view;
      tab.classList.toggle('active', tab.dataset.tab === state.tab);
      tab.setAttribute('aria-selected', String(on));
    });
    const body = $('panelBody');
    if (state.view?.type === 'city') body.innerHTML = cityDetailHtml(state.view.key);
    else if (state.view?.type === 'person') body.innerHTML = personDetailHtml(state.view.key);
    else if (!state.entries.length) body.innerHTML = emptyHtml();
    else if (state.tab === 'people') body.innerHTML = peopleHtml();
    else if (state.tab === 'recs') body.innerHTML = recsHtml();
    else body.innerHTML = citiesHtml();
  }

  function facesHtml(entries, max = 3) {
    const seen = new Set();
    const out = [];
    for (const e of entries) {
      const k = personKey(e);
      if (seen.has(k)) continue;
      seen.add(k);
      if (out.length < max) out.push(`<span class="fa-face" style="--c:${relation(e.pinType).color}">${esc(initials(e.name))}</span>`);
    }
    return `<span class="faces">${out.join('')}</span>`;
  }

  function emptyHtml() {
    const a = state.atlas;
    if (a.isOwner) {
      const mine = state.entries.some(isMine);
      return `<div class="empty">
        <h3>Your map is ready.</h3>
        <p>Two things and it comes alive:</p>
        <ul class="checklist"><li class="${mine ? 'done' : ''}">Add your own places</li><li>Send the link to a few friends</li></ul>
        ${canContribute() ? '<button class="btn btn-primary btn-block" type="button" data-action="add">Add your places</button>' : ''}
        <button class="btn btn-soft btn-block" type="button" data-action="invite">Invite friends</button>
      </div>`;
    }
    return `<div class="empty">
      <h3>No one is on this map yet.</h3>
      <p>${canContribute() ? 'Be the first. It takes about 30 seconds.' : `Ask ${esc(a.ownerName)} for the invite link to add yourself.`}</p>
      ${canContribute() ? '<button class="btn btn-primary btn-block" type="button" data-action="add">Add yourself</button>' : ''}
    </div>`;
  }

  function noResults() {
    return `<div class="no-results">No matches for "${esc(state.query)}".</div>`;
  }

  function citiesHtml() {
    const q = state.query.trim().toLowerCase();
    const groups = groupByCity(visibleEntries()).filter((g) => !q || g.entries.some((e) => matches(e, q)));
    if (!groups.length) return q ? noResults() : '<div class="no-results">Nothing to show with these filters.</div>';
    return groups.map((g) => `
      <button class="row" type="button" data-city="${esc(g.key)}">
        <span class="row-flag">${flag(g.country) || '📍'}</span>
        <span class="row-main"><strong>${esc(g.city)}</strong><span>${esc(g.country)}</span></span>
        <span class="row-end">${facesHtml(g.entries)}<span class="count">${plural(g.people, 'person', 'people')}${g.recs ? ` · ${plural(g.recs, 'rec')}` : ''}</span></span>
      </button>`).join('');
  }

  function peopleHtml() {
    const q = state.query.trim().toLowerCase();
    const people = groupByPerson(visibleEntries()).filter((p) => !q || p.entries.some((e) => matches(e, q)));
    if (!people.length) return q ? noResults() : '<div class="no-results">Nothing to show with these filters.</div>';
    return people.map((p) => {
      const summary = p.entries.map((e) => `${relation(e.pinType).verb} ${cityName(e)}`).join(' · ');
      const me = p.entries.some(isMine) ? '<span class="you">YOU</span>' : '';
      return `<button class="row" type="button" data-person="${esc(p.key)}">
        <span class="avatar">${esc(initials(p.name))}</span>
        <span class="row-main"><strong>${esc(p.name)}${me}</strong><span>${esc(summary)}</span></span>
        <span class="row-end">${p.recs ? `<span class="count">${plural(p.recs, 'rec')}</span>` : ''}</span>
      </button>`;
    }).join('');
  }

  function recHtml(rec, entry, { showBy = false } = {}) {
    const cat = recCategory(rec.category);
    const by = showBy ? `<div class="rec-by">${esc(entry.name)}, ${esc(relation(entry.pinType).label.toLowerCase())}</div>` : '';
    const remove = state.atlas.isOwner ? `<button class="rec-x" type="button" data-remove-rec="${rec.id}" aria-label="Remove this recommendation" title="Remove">×</button>` : '';
    return `<div class="rec"><span class="rec-icon">${cat.icon}</span><div>
      <div><span class="rec-name">${esc(rec.name)}</span><span class="rec-cat">${esc(cat.label)}</span></div>
      ${rec.note ? `<div class="rec-note">${esc(rec.note)}</div>` : ''}${by}</div>${remove}</div>`;
  }

  function recsHtml() {
    const q = state.query.trim().toLowerCase();
    const groups = groupByCity(visibleEntries());
    const blocks = [];
    for (const g of groups) {
      const items = [];
      for (const e of g.entries) {
        for (const r of e.recommendations) {
          if (q && !`${r.name} ${r.note || ''} ${g.city} ${g.country} ${e.name}`.toLowerCase().includes(q)) continue;
          items.push(recHtml(r, e, { showBy: true }));
        }
      }
      if (items.length) {
        blocks.push(`<div class="section-label"><button class="link-btn" type="button" data-city="${esc(g.key)}">${flag(g.country)} ${esc(g.city)}</button></div><div class="recs" style="margin-left:0">${items.join('')}</div>`);
      }
    }
    if (!blocks.length) {
      if (q) return noResults();
      return `<div class="empty"><h3>No recommendations yet.</h3><p>When people add themselves they can drop a favorite spot, meal, or tip for each city.</p>${canContribute() ? '<button class="btn btn-primary btn-block" type="button" data-action="add">Add yours</button>' : ''}</div>`;
    }
    return blocks.join('');
  }

  function entryActions(entry) {
    const actions = [];
    if (state.atlas.isOwner) actions.push(`<button class="link-btn" type="button" data-edit="${entry.id}">Correct</button>`);
    if (state.atlas.isOwner || isMine(entry)) actions.push(`<button class="link-btn danger" type="button" data-remove="${entry.id}">Remove</button>`);
    return actions.length ? `<div class="entry-actions">${actions.join('')}</div>` : '';
  }

  function cityDetailHtml(key) {
    const group = groupByCity(visibleEntries()).find((g) => g.key === key) || groupByCity(state.entries).find((g) => g.key === key);
    if (!group) { state.view = null; return citiesHtml(); }
    const sections = RELATION_ORDER.map((type) => {
      const list = group.entries.filter((e) => e.pinType === type);
      if (!list.length) return '';
      return `<div class="section-label"><span class="rel-dot" style="background:${relation(type).color}"></span>${esc(relation(type).label)}</div>` + list.map((e) => `
        <div class="person">
          <div class="person-top"><span class="avatar">${esc(initials(e.name))}</span>
            <div><button class="place-city" type="button" data-person="${esc(personKey(e))}">${esc(e.name)}</button>${isMine(e) ? '<span class="you">YOU</span>' : ''}</div></div>
          ${e.note ? `<p class="person-note">${esc(e.note)}</p>` : ''}
          ${e.recommendations.length ? `<div class="recs">${e.recommendations.map((r) => recHtml(r, e)).join('')}</div>` : ''}
          ${entryActions(e)}
        </div>`).join('');
    }).join('');
    const guidance = state.atlas.connectionGuidance ? `<div class="connect-note">${esc(state.atlas.connectionGuidance)}</div>` : '';
    return `<div class="detail">
      <button class="back" type="button" data-back>← All ${state.tab === 'people' ? 'people' : state.tab === 'recs' ? 'recs' : 'cities'}</button>
      <div class="detail-head"><span class="detail-flag">${flag(group.country) || '📍'}</span><div><h2>${esc(group.city)}</h2><p>${esc(group.country)}${group.country ? ' · ' : ''}${plural(group.people, 'person', 'people')}${group.recs ? ` · ${plural(group.recs, 'rec')}` : ''}</p></div></div>
      ${sections}${guidance}
    </div>`;
  }

  function personDetailHtml(key) {
    const person = groupByPerson(state.entries).find((p) => p.key === key);
    if (!person) { state.view = null; return peopleHtml(); }
    const places = person.entries.map((e) => `
      <div class="place-line">
        <span class="row-flag">${flag(e.country) || '📍'}</span>
        <div class="grow">
          <button class="place-city" type="button" data-city="${esc(window.FA.cityKey(e))}">${esc(placeLabel(e))}</button>
          <div style="margin-top:4px"><span class="rel-badge" style="--c:${relation(e.pinType).color}">${esc(relation(e.pinType).label)}</span></div>
          ${e.note ? `<p class="person-note">${esc(e.note)}</p>` : ''}
          ${e.recommendations.length ? `<div class="recs">${e.recommendations.map((r) => recHtml(r, e)).join('')}</div>` : ''}
          ${entryActions(e)}
        </div>
      </div>`).join('');
    const guidance = state.atlas.connectionGuidance ? `<div class="connect-note">${esc(state.atlas.connectionGuidance.replace('{name}', person.name))}</div>` : '';
    const added = person.entries.map((e) => e.createdAt).sort()[0];
    return `<div class="detail">
      <button class="back" type="button" data-back>← All ${state.tab === 'cities' ? 'cities' : state.tab}</button>
      <div class="detail-head"><span class="avatar avatar-lg">${esc(initials(person.name))}</span><div><h2>${esc(person.name)}${person.entries.some(isMine) ? '<span class="you">YOU</span>' : ''}</h2><p>${plural(person.entries.length, 'place')}${person.recs ? ` · ${plural(person.recs, 'rec')}` : ''}${added ? ` · joined ${esc(timeAgo(added))}` : ''}</p></div></div>
      ${places}${guidance}
    </div>`;
  }

  // ---------- navigation within the panel ----------
  function openCity(key, { fly = true } = {}) {
    state.view = { type: 'city', key };
    state.map.select(key, { fly });
    renderPanel();
    $('panelBody').scrollTop = 0;
    if (isMobile() && state.sheet === 'peek') setSheet('half');
  }

  function openPerson(key) {
    state.view = { type: 'person', key };
    const person = groupByPerson(state.entries).find((p) => p.key === key);
    state.map.select(null, { fly: false });
    if (person) state.map.fitGroups(groupByCity(person.entries), { maxZoom: 5 });
    renderPanel();
    $('panelBody').scrollTop = 0;
    if (isMobile() && state.sheet === 'peek') setSheet('half');
  }

  function closeDetail() {
    state.view = null;
    state.map.select(null, { fly: false });
    renderPanel();
  }

  // ---------- mobile sheet ----------
  function sheetOffsets() {
    const panel = $('panel');
    const h = panel.offsetHeight || window.innerHeight - 64;
    const peekVisible = Math.min(h, $('panelGrab').offsetHeight + $('panelHead').offsetHeight + 8);
    return { peek: h - peekVisible, half: Math.max(0, h - Math.round(window.innerHeight * 0.56)), full: 0, height: h };
  }

  function setSheet(next, { silent = false } = {}) {
    state.sheet = next;
    if (!isMobile()) { $('panel').style.removeProperty('--sheet-y'); return; }
    const offsets = sheetOffsets();
    $('panel').style.setProperty('--sheet-y', `${offsets[next]}px`);
    $('panelGrab').setAttribute('aria-expanded', String(next !== 'peek'));
    if (!silent) updateMapPadding();
  }

  function updateMapPadding() {
    if (!state.map) return;
    if (isMobile()) {
      const offsets = sheetOffsets();
      const visible = offsets.height - offsets[state.sheet === 'full' ? 'half' : state.sheet];
      state.map.setPadding({ top: 70, left: 40, right: 40, bottom: Math.min(visible + 30, window.innerHeight * 0.6) });
    } else {
      const panel = $('panel').getBoundingClientRect();
      state.map.setPadding({ top: 90, right: 80, bottom: 70, left: panel.right + 50 });
    }
  }

  function wireSheet() {
    const panel = $('panel');
    let startY = 0;
    let startOffset = 0;
    let dragging = false;
    let moved = false;
    const start = (e) => {
      if (!isMobile()) return;
      if (e.target.closest('button:not(#panelGrab), a, input')) return;
      dragging = true; moved = false;
      startY = e.clientY;
      startOffset = sheetOffsets()[state.sheet];
      panel.classList.add('dragging');
      e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      const offsets = sheetOffsets();
      panel.style.setProperty('--sheet-y', `${Math.max(0, Math.min(offsets.peek, startOffset + dy))}px`);
    };
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      panel.classList.remove('dragging');
      const offsets = sheetOffsets();
      if (!moved) { setSheet(state.sheet === 'peek' ? 'half' : state.sheet === 'half' ? 'full' : 'peek'); return; }
      const current = startOffset + (e.clientY - startY);
      const nearest = ['full', 'half', 'peek'].reduce((best, s) => (Math.abs(offsets[s] - current) < Math.abs(offsets[best] - current) ? s : best), 'peek');
      setSheet(nearest);
    };
    for (const el of [$('panelGrab'), $('panelHead')]) {
      el.addEventListener('pointerdown', start);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    }
    $('search').addEventListener('focus', () => { if (isMobile()) setSheet('full'); });
    mobileQuery.addEventListener('change', () => { setSheet(state.sheet); updateMapPadding(); state.map?.resize(); });
    window.addEventListener('resize', () => { if (state.atlas) { setSheet(state.sheet, { silent: true }); updateMapPadding(); } });
  }

  // ---------- menu ----------
  function openMenu(anchor) {
    const menu = $('menu');
    const a = state.atlas;
    const owner = a.isOwner ? `
      <div class="menu-label">Owner tools</div>
      <button type="button" data-menu="rename">Rename map</button>
      <button type="button" data-menu="settings">Contact &amp; connecting</button>
      <button type="button" data-menu="lock">${a.contributionsLocked ? 'Reopen to new entries' : 'Close to new entries'}</button>
      <button type="button" data-menu="rotate">Reset the invite link</button>
      <button type="button" data-menu="export">Export data (JSON)</button>
      <button type="button" data-menu="delete" class="danger">Delete this map</button>
      <hr>` : '';
    menu.innerHTML = `${owner}
      <button type="button" data-menu="copyview">Copy view-only link</button>
      <button type="button" data-menu="new">Make your own atlas</button>
      <a href="/" data-menu="home">All maps</a>
      <a href="/privacy">Privacy &amp; safety</a>`;
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    const width = 250;
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 10)}px`;
    menu.style.left = `${Math.max(10, Math.min(r.right - width, window.innerWidth - width - 10))}px`;
    menu.style.width = `${width}px`;
    menu.querySelector('button, a')?.focus();
  }

  function closeMenu() { $('menu').hidden = true; }

  async function handleMenu(action) {
    closeMenu();
    const a = state.atlas;
    if (action === 'rename') {
      showError('renameError', '');
      $('renameMap').value = mapTitle();
      $('renameOwner').value = a.ownerName;
      openDialog('renameDialog');
    } else if (action === 'settings') {
      showError('settingsError', '');
      $('settingsContact').value = a.ownerContact || '';
      $('settingsConnect').value = a.connectionGuidance || '';
      openDialog('settingsDialog');
    } else if (action === 'lock') {
      const next = !a.contributionsLocked;
      const ok = await confirmAction({
        title: next ? 'Close to new entries?' : 'Reopen the map?',
        text: next ? 'Nobody will be able to add places or recommendations until you reopen it. Everything stays visible.' : 'People with the invite link will be able to add themselves again.',
        ok: next ? 'Close it' : 'Reopen', danger: false,
      });
      if (!ok) return;
      try {
        const d = await api(`/api/atlas/code/${a.code}/settings`, { method: 'PATCH', body: JSON.stringify({ contributionsLocked: next }) });
        a.contributionsLocked = d.contributionsLocked;
        render();
        toast(next ? 'Closed to new entries' : 'Reopened');
      } catch (error) { toast(error.message); }
    } else if (action === 'rotate') {
      const ok = await confirmAction({ title: 'Reset the invite link?', text: 'Old invite links will stop letting people add themselves. View links keep working. You will get a new link to send.', ok: 'Reset link', danger: false });
      if (!ok) return;
      try {
        const d = await api(`/api/atlas/code/${a.code}/rotate-invite`, { method: 'POST' });
        state.inviteToken = d.contributionToken;
        local.setItem(keys.invite(a.code), state.inviteToken);
        session.setItem(keys.invite(a.code), state.inviteToken);
        a.contributionTokenRequired = true;
        render();
        openShare();
        toast('New invite link created');
      } catch (error) { toast(error.message); }
    } else if (action === 'export') {
      try {
        const d = await api(`/api/atlas/${a.id}/export`);
        const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `friend-atlas-${a.code}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      } catch (error) { toast(error.message); }
    } else if (action === 'delete') {
      const ok = await confirmAction({ title: 'Delete this map?', text: 'This permanently deletes the map, every entry, and every recommendation. It cannot be undone.', ok: 'Delete forever', typeToConfirm: a.code });
      if (!ok) return;
      try {
        await api(`/api/atlas/code/${a.code}`, { method: 'DELETE' });
        forgetRecent(a.code);
        local.removeItem(keys.invite(a.code));
        location.href = '/';
      } catch (error) { toast(error.message); }
    } else if (action === 'copyview') {
      copy(`${location.origin}/join/${a.code}`, 'View-only link copied');
    } else if (action === 'new') {
      history.pushState(null, '', '/');
      showHome();
      openCreate();
    }
  }

  // ---------- add places ----------
  const placeRows = [];

  function relationOptions(name, selected) {
    return RELATION_ORDER.map((t) => `<label class="rel-option"><input type="radio" name="${name}" value="${t}"${t === selected ? ' checked' : ''}><span style="--c:${relation(t).color}">${esc(relation(t).label.replace('Knows it well', 'Know it well').replace('Lives here', 'Live here'))}</span></label>`).join('');
  }

  const NOTE_HINTS = {
    current: 'Anything to add? e.g. "Moved here in 2023, happy to show you around"',
    hometown: 'Anything to add? e.g. "Grew up here, family still lives here"',
    lived: 'Anything to add? e.g. "Studied abroad here"',
    know: 'Anything to add? e.g. "Go every summer"',
  };

  function addPlaceRow(type) {
    const used = new Set(placeRows.map((r) => r.type()));
    const pick = type || ['current', 'hometown', 'know', 'lived'].find((t) => !used.has(t)) || 'know';
    const id = `pr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const card = document.createElement('div');
    card.className = 'place-card';
    card.innerHTML = `
      <div class="place-card-head"><span class="label">Place ${placeRows.length + 1}</span></div>
      ${placeRows.length ? '<button class="icon-btn remove-place" type="button" aria-label="Remove this place">×</button>' : ''}
      <div class="rel-options" role="radiogroup" aria-label="How do you know this place?">${relationOptions(id, pick)}</div>
      <input class="input city" type="text" maxlength="200" placeholder="Start typing a city" aria-label="City">
      <input class="input note" type="text" maxlength="300" aria-label="Context (optional)">
      <div class="rec-list"></div>
      <button class="link-btn add-rec" type="button">+ Add a favorite spot here <span style="color:var(--muted);font-weight:500">(optional)</span></button>`;
    $('placeCards').appendChild(card);
    const ac = placeInput(card.querySelector('.city'), {
      onPick: (place) => {
        card.querySelector('.add-rec').firstChild.textContent = place ? `+ Add a favorite spot in ${place.name} ` : '+ Add a favorite spot here ';
      },
    });
    const note = card.querySelector('.note');
    const setHint = () => { note.placeholder = NOTE_HINTS[row.type()] || ''; };
    const row = {
      card,
      ac,
      type: () => card.querySelector(`input[name="${id}"]:checked`)?.value || 'current',
      note: () => note.value.trim(),
      recs: () => [...card.querySelectorAll('.rec-edit')].map((el) => ({
        category: el.querySelector('.cat').value,
        name: el.querySelector('.name').value.trim(),
        note: el.querySelector('.why').value.trim(),
      })).filter((r) => r.name),
    };
    card.querySelectorAll(`input[name="${id}"]`).forEach((radio) => radio.addEventListener('change', setHint));
    setHint();
    card.querySelector('.add-rec').addEventListener('click', () => addRecRow(card));
    card.querySelector('.remove-place')?.addEventListener('click', () => {
      placeRows.splice(placeRows.indexOf(row), 1);
      card.remove();
      renumberPlaces();
    });
    placeRows.push(row);
    $('addPlaceBtn').hidden = placeRows.length >= 4;
    return row;
  }

  function renumberPlaces() {
    placeRows.forEach((r, i) => { r.card.querySelector('.place-card-head .label').textContent = `Place ${i + 1}`; });
    $('addPlaceBtn').hidden = placeRows.length >= 4;
  }

  function addRecRow(card) {
    const list = card.querySelector('.rec-list');
    if (list.children.length >= 3) { toast('Three favorites per place is plenty'); return; }
    const el = document.createElement('div');
    el.className = 'rec-edit';
    el.innerHTML = `
      <select class="input cat" aria-label="Kind of recommendation">${Object.entries(REC_CATEGORIES).map(([k, v]) => `<option value="${k}">${v.icon} ${esc(v.label)}</option>`).join('')}</select>
      <input class="input name" maxlength="160" placeholder="Place or tip" aria-label="Place or tip">
      <button class="icon-btn" type="button" aria-label="Remove this recommendation">×</button>
      <input class="input why" maxlength="400" placeholder="Why? (optional)" aria-label="Why you recommend it">`;
    el.querySelector('.icon-btn').addEventListener('click', () => el.remove());
    list.appendChild(el);
    el.querySelector('.name').focus();
  }

  function openAdd() {
    if (!canContribute()) {
      toast(state.atlas.contributionsLocked ? 'This map is closed to new entries' : `Ask ${state.atlas.ownerName} for the invite link to add yourself`);
      return;
    }
    placeRows.splice(0).forEach((r) => r.card.remove());
    const mine = state.entries.some(isMine);
    $('addTitle').textContent = mine ? 'Add another place' : 'Add yourself';
    $('addSub').textContent = `to ${mapTitle()}. Add where you live, where you're from, or places you know well.`;
    $('addName').value = state.myName || '';
    showError('addError', '');
    $('addFormView').hidden = false;
    $('addFormView').style.display = 'contents';
    $('addSuccessView').hidden = true;
    const myTypes = new Set(state.entries.filter(isMine).map((e) => e.pinType));
    addPlaceRow(mine ? (['current', 'hometown'].find((t) => !myTypes.has(t)) || 'know') : 'current');
    openDialog('addDialog');
    setTimeout(() => (state.myName ? placeRows[0].card.querySelector('.city') : $('addName')).focus(), 60);
  }

  async function submitAdd(submitter) {
    showError('addError', '');
    const name = $('addName').value.trim();
    if (!name) { showError('addError', 'Add your name first.'); $('addName').focus(); return; }
    const ready = [];
    for (const row of placeRows) {
      const typed = row.card.querySelector('.city').value.trim();
      if (!typed) continue;
      const place = await row.ac.resolve();
      if (!place) {
        showError('addError', `Pick "${typed}" from the list of cities (or choose the nearest larger city).`);
        row.card.querySelector('.city').focus();
        return;
      }
      ready.push({ row, place });
    }
    if (!ready.length) { showError('addError', 'Add at least one city.'); placeRows[0]?.card.querySelector('.city').focus(); return; }
    for (const only of ['current', 'hometown']) {
      if (ready.filter(({ row }) => row.type() === only).length > 1) {
        showError('addError', `Pick just one "${relation(only).label.replace('Lives here', 'Live here')}" city. Use "Lived here" or "Know it well" for the others.`);
        return;
      }
    }
    submitter.disabled = true;
    submitter.textContent = 'Adding you…';
    const saved = [];
    try {
      for (const { row, place } of ready) {
        const type = row.type();
        const body = {
          name,
          city: [place.name, place.region].filter(Boolean).join(', '),
          country: place.country,
          lat: place.lat,
          lng: place.lng,
          note: row.note() || null,
          pinType: type,
          color: relation(type).color,
          recommendations: row.recs(),
          inviteToken: state.inviteToken || null,
        };
        const d = await api(`/api/atlas/code/${state.atlas.code}/join-anon`, { method: 'POST', body: JSON.stringify(body) });
        if (d.friend) saved.push(d.friend);
      }
    } catch (error) {
      showError('addError', saved.length ? `${saved.length} saved, but one place failed: ${error.message}` : error.message);
    } finally {
      submitter.disabled = false;
      submitter.textContent = 'Add me to the map';
    }
    if (!saved.length) return;
    state.myName = name;
    state.myIds = [...new Set([...state.myIds, ...saved.map((f) => Number(f.id))])];
    saveMine();
    await refresh().catch(() => {});
    const first = saved[0];
    $('addFormView').style.display = 'none';
    $('addFormView').hidden = true;
    $('addSuccessView').hidden = false;
    $('addSuccessText').textContent = `${name}, you're pinned in ${saved.map((f) => cityName(f)).join(' and ')}. ${state.atlas.isOwner ? 'Now send the link to a few friends.' : `${state.atlas.ownerName} will be glad you did.`}`;
    $('successInvite').textContent = state.atlas.isOwner ? 'Invite friends' : 'Invite a friend';
    $('successOwn').hidden = !!state.atlas.isOwner;
    if (first) state.map.select(window.FA.cityKey(first));
  }

  // ---------- share ----------
  function contributionUrl() {
    const url = new URL(`/join/${state.atlas.code}`, location.origin);
    if (state.inviteToken) url.hash = `invite=${encodeURIComponent(state.inviteToken)}`;
    return url.toString();
  }

  function defaultMessage(url) {
    if (state.atlas.isOwner) {
      return `I'm making a map of where my friends live and grew up, so when any of us travels we know who's there and where to go. Add yourself and a favorite spot or two, it takes about 30 seconds: ${url}`;
    }
    return `I just added myself to ${mapTitle()}. It's a map of where our friends live and grew up, with their favorite spots. Add yourself, it takes about 30 seconds: ${url}`;
  }

  function openShare() {
    if (state.atlas.contributionTokenRequired && !state.inviteToken) {
      if (state.atlas.isOwner) toast('This browser does not have the invite link. Use "Reset the invite link" in the menu to make a new one.');
      else toast('Only people with the invite link can share it.');
      return;
    }
    const url = contributionUrl();
    $('shareUrl').textContent = url;
    $('shareMessage').value = defaultMessage(url);
    $('shareNote').textContent = state.atlas.contributionsLocked
      ? 'This map is closed to new entries right now, so people can look but not add themselves.'
      : 'Anyone with this link can see the map and add themselves. Keep it to your people.';
    updateShareLinks();
    $('shareNative').hidden = !navigator.share;
    openDialog('shareDialog');
  }

  function updateShareLinks() {
    const message = $('shareMessage').value;
    $('shareSms').href = `sms:?&body=${encodeURIComponent(message)}`;
    $('shareWa').href = `https://wa.me/?text=${encodeURIComponent(message)}`;
    $('shareEmail').href = `mailto:?subject=${encodeURIComponent(`Add yourself to ${mapTitle()}`)}&body=${encodeURIComponent(message)}`;
  }

  async function copy(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message || 'Copied');
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); toast(message || 'Copied'); } catch { toast('Copy did not work. Press and hold to copy instead.'); }
      area.remove();
    }
  }

  // ---------- owner edits ----------
  let editing = null;
  let editAc = null;
  function openEdit(entry) {
    editing = { entry, place: null };
    showError('editError', '');
    $('editName').value = entry.name;
    $('editNote').value = entry.note || '';
    $('editRel').innerHTML = relationOptions('editRelType', entry.pinType);
    if (!editAc) editAc = placeInput($('editCity'), { onPick: (p) => { if (editing) editing.place = p; } });
    editAc.clear();
    $('editCity').value = placeLabel(entry);
    openDialog('editDialog');
  }

  async function submitEdit() {
    const { entry } = editing;
    const name = $('editName').value.trim();
    if (!name) { showError('editError', 'Name is required.'); return; }
    const typed = $('editCity').value.trim();
    let place = editing.place;
    if (!place && typed !== placeLabel(entry)) place = await editAc.resolve();
    if (!place && typed !== placeLabel(entry)) { showError('editError', 'Pick the city from the list.'); return; }
    const pinType = document.querySelector('input[name="editRelType"]:checked')?.value || entry.pinType;
    const body = place
      ? { city: [place.name, place.region].filter(Boolean).join(', '), country: place.country, lat: place.lat, lng: place.lng }
      : { city: entry.city, country: entry.country, lat: entry.lat, lng: entry.lng };
    try {
      await api(`/api/atlas/code/${state.atlas.code}/friend/${entry.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...body, name, note: $('editNote').value.trim() || null, pinType, color: relation(pinType).color }),
      });
      closeDialog('editDialog');
      await refresh();
      toast('Entry updated');
    } catch (error) { showError('editError', error.message); }
  }

  async function removeEntry(entry) {
    const mine = isMine(entry);
    const ok = await confirmAction({
      title: mine ? 'Remove your place?' : `Remove ${entry.name} in ${cityName(entry)}?`,
      text: 'This removes the place and its recommendations from the map. It cannot be undone.',
    });
    if (!ok) return;
    try {
      await api(`/api/atlas/${state.atlas.id}/friend/${entry.id}`, { method: 'DELETE' });
      state.myIds = state.myIds.filter((id) => id !== Number(entry.id));
      saveMine();
      await refresh();
      toast('Removed');
    } catch (error) { toast(error.message); }
  }

  async function removeRec(id) {
    const ok = await confirmAction({ title: 'Remove this recommendation?', text: 'It will disappear from the map for everyone.' });
    if (!ok) return;
    try {
      await api(`/api/atlas/code/${state.atlas.code}/recommendation/${id}`, { method: 'DELETE' });
      await refresh();
      toast('Recommendation removed');
    } catch (error) { toast(error.message); }
  }

  // ---------- wiring ----------
  function wireAtlas() {
    $('addBtn').addEventListener('click', openAdd);
    $('inviteBtn').addEventListener('click', openShare);
    $('menuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('menu').hidden ? openMenu(e.currentTarget) : closeMenu(); });
    $('mobileMenuBtn').addEventListener('click', (e) => { e.stopPropagation(); $('menu').hidden ? openMenu(e.currentTarget) : closeMenu(); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#menu')) closeMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    $('menu').addEventListener('click', (e) => {
      const item = e.target.closest('[data-menu]');
      if (!item || item.dataset.menu === 'home') return;
      e.preventDefault();
      handleMenu(item.dataset.menu);
    });

    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      state.view = null;
      state.map.select(null, { fly: false });
      renderPanel();
      $('panelBody').scrollTop = 0;
      if (isMobile() && state.sheet === 'peek') setSheet('half');
    }));

    $('search').addEventListener('input', () => {
      state.query = $('search').value;
      state.view = null;
      render();
    });
    $('search').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const first = $('panelBody').querySelector('[data-city], [data-person]');
      if (first) first.click();
    });

    $('legend').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-rel]');
      if (!chip) return;
      const t = chip.dataset.rel;
      if (state.relations.has(t) && state.relations.size === 1) { state.relations = new Set(RELATION_ORDER); }
      else if (state.relations.has(t)) state.relations.delete(t);
      else state.relations.add(t);
      render();
    });

    $('panelBody').addEventListener('click', (e) => {
      const target = e.target.closest('[data-city],[data-person],[data-back],[data-action],[data-edit],[data-remove],[data-remove-rec]');
      if (!target) return;
      const find = (id) => state.entries.find((x) => String(x.id) === String(id));
      if (target.dataset.city) openCity(target.dataset.city);
      else if (target.dataset.person) openPerson(target.dataset.person);
      else if (target.hasAttribute('data-back')) closeDetail();
      else if (target.dataset.action === 'add') openAdd();
      else if (target.dataset.action === 'invite') openShare();
      else if (target.dataset.edit) openEdit(find(target.dataset.edit));
      else if (target.dataset.remove) removeEntry(find(target.dataset.remove));
      else if (target.dataset.removeRec) removeRec(Number(target.dataset.removeRec));
    });

    wireSheet();
    window.addEventListener('popstate', () => {
      const m = location.pathname.match(/^\/join\/([A-Za-z0-9]{6})/);
      if (m) openAtlas(m[1].toUpperCase()).catch(() => showHome());
      else showHome();
    });
  }

  function formHandler(formId, handler) {
    $(formId).addEventListener('submit', (e) => {
      e.preventDefault();
      handler(e.submitter || $(formId).querySelector('[type="submit"]'));
    });
  }

  function wireDialogs() {
    document.querySelectorAll('[data-open]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.dataset.open === 'joinDialog') { showError('joinError', ''); $('joinCode').value = ''; }
      openDialog(btn.dataset.open);
    }));
    // Close buttons, and clicks on the backdrop, dismiss a dialog.
    document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (e) => {
      if (e.target === dialog || e.target.closest('[data-close]')) dialog.close('cancel');
    }));

    $('createName').addEventListener('input', () => {
      const n = $('createName').value.trim();
      $('createMapName').placeholder = n ? `${n}'s Friend Atlas` : "Jesse's Friend Atlas";
    });
    formHandler('createForm', async (btn) => {
      showError('createError', '');
      const name = $('createName').value.trim();
      if (!name) { showError('createError', 'Add your name.'); return; }
      btn.disabled = true;
      try {
        const d = await api('/api/atlas/create', { method: 'POST', body: JSON.stringify({ name, mapName: $('createMapName').value.trim() || null }) });
        if (d.contributionToken) {
          local.setItem(keys.invite(d.atlas.code), d.contributionToken);
          session.setItem(keys.invite(d.atlas.code), d.contributionToken);
        }
        local.setItem(keys.name(d.atlas.code), name);
        closeDialog('createDialog');
        state.atlas = null;
        await openAtlas(d.atlas.code, { push: true });
        setTimeout(openAdd, 350);
      } catch (error) {
        showError('createError', error.message);
      } finally { btn.disabled = false; }
    });

    $('joinCode').addEventListener('input', () => { $('joinCode').value = $('joinCode').value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); });
    formHandler('joinForm', async () => {
      const code = $('joinCode').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) { showError('joinError', 'Codes are 6 letters and numbers.'); return; }
      try {
        await openAtlas(code, { push: true });
        closeDialog('joinDialog');
      } catch (error) {
        showError('joinError', error.status === 404 ? 'No map with that code. Double check it with your friend.' : error.message);
      }
    });

    $('addPlaceBtn').addEventListener('click', () => { const row = addPlaceRow(); row.card.querySelector('.city').focus(); });
    formHandler('addForm', (btn) => submitAdd(btn));
    $('successExplore').addEventListener('click', () => { closeDialog('addDialog'); state.tab = 'cities'; state.view = null; render({ fit: true }); if (isMobile()) setSheet('half'); });
    $('successInvite').addEventListener('click', () => { closeDialog('addDialog'); openShare(); });
    $('successOwn').addEventListener('click', () => { closeDialog('addDialog'); history.pushState(null, '', '/'); showHome(); openCreate(); });

    $('shareMessage').addEventListener('input', updateShareLinks);
    $('copyLinkBtn').addEventListener('click', () => copy(contributionUrl(), 'Link copied'));
    $('copyMessageBtn').addEventListener('click', () => copy($('shareMessage').value, 'Message copied. Paste it anywhere.'));
    $('shareNative').addEventListener('click', async () => {
      try { await navigator.share({ title: mapTitle(), text: $('shareMessage').value }); } catch { /* cancelled */ }
    });

    formHandler('renameForm', async () => {
      const mapName = $('renameMap').value.trim();
      const ownerName = $('renameOwner').value.trim();
      if (!ownerName) { showError('renameError', 'Your name is required.'); return; }
      try {
        const a = state.atlas;
        if (mapName !== mapTitle()) {
          const d = await api(`/api/atlas/code/${a.code}/rename-map`, { method: 'PATCH', body: JSON.stringify({ mapName: mapName || null }) });
          a.mapName = d.mapName;
        }
        if (ownerName !== a.ownerName) {
          await api(`/api/atlas/code/${a.code}/rename`, { method: 'PATCH', body: JSON.stringify({ name: ownerName }) });
          a.ownerName = ownerName;
        }
        closeDialog('renameDialog');
        rememberRecent(a);
        document.title = `${mapTitle()} · Friend Atlas`;
        render();
        toast('Saved');
      } catch (error) { showError('renameError', error.message); }
    });

    formHandler('settingsForm', async () => {
      try {
        const d = await api(`/api/atlas/code/${state.atlas.code}/settings`, {
          method: 'PATCH',
          body: JSON.stringify({ ownerContact: $('settingsContact').value.trim(), connectionGuidance: $('settingsConnect').value.trim() }),
        });
        state.atlas.ownerContact = d.ownerContact;
        state.atlas.connectionGuidance = d.connectionGuidance;
        closeDialog('settingsDialog');
        renderPanel();
        toast('Saved');
      } catch (error) { showError('settingsError', error.message); }
    });

    formHandler('editForm', () => submitEdit());
    formHandler('confirmForm', () => { $('confirmDialog').close('ok'); });
  }

  boot();
})();
