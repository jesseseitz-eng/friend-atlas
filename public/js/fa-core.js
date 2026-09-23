/* Friend Atlas shared helpers: formatting, API calls, relations, flags,
   grouping, and the city autocomplete. Used by the main app and J-Term page. */
(function () {
  'use strict';

  const RELATIONS = {
    current: { label: 'Lives here', short: 'Lives', verb: 'Lives in', color: '#2f68c5', hint: 'Where you live now' },
    hometown: { label: 'From here', short: 'From', verb: 'From', color: '#d65e4d', hint: 'Where you grew up' },
    lived: { label: 'Lived here', short: 'Lived', verb: 'Lived in', color: '#7a5bbf', hint: 'A past home, school, or job' },
    know: { label: 'Knows it well', short: 'Knows', verb: 'Knows', color: '#177a5c', hint: 'Somewhere you can vouch for' },
  };
  const RELATION_ORDER = ['current', 'hometown', 'lived', 'know'];

  const REC_CATEGORIES = {
    eat: { label: 'Eat', icon: '🍽️' },
    drink: { label: 'Drink', icon: '🍸' },
    coffee: { label: 'Coffee', icon: '☕' },
    do: { label: 'Do', icon: '🎟️' },
    stay: { label: 'Stay', icon: '🛏️' },
    tip: { label: 'Tip', icon: '💡' },
  };

  const AVATAR_COLORS = ['#177a5c', '#2f68c5', '#d65e4d', '#b98221', '#7a5bbf', '#0f7c8c', '#b44d7a', '#4d6b2f'];

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    return (parts.slice(0, 2).map((p) => p[0]).join('') || '?').toUpperCase();
  }

  function colorFor(name) {
    let h = 0;
    const s = String(name || '').toLowerCase();
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }

  function relation(type) {
    return RELATIONS[type] || RELATIONS.know;
  }

  function recCategory(cat) {
    return REC_CATEGORIES[cat] || REC_CATEGORIES.tip;
  }

  function countryCode(country) {
    if (!country) return null;
    const table = window.FA_COUNTRIES || {};
    if (table[country]) return table[country];
    const lower = String(country).toLowerCase();
    for (const [name, code] of Object.entries(table)) if (name.toLowerCase() === lower) return code;
    return null;
  }

  function flag(country) {
    const code = countryCode(country);
    if (!code || code.length !== 2) return '';
    return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
  }

  // Older entries store "Lisbon, Portugal" in city; newer ones store "Lisbon".
  function cityName(entry) {
    let city = String(entry.city || '').trim();
    const country = String(entry.country || '').trim();
    if (country && city.toLowerCase().endsWith(`, ${country.toLowerCase()}`)) city = city.slice(0, -(country.length + 2));
    return city;
  }

  function placeLabel(entry) {
    const city = cityName(entry);
    return entry.country ? `${city}, ${entry.country}` : city;
  }

  function timeAgo(iso) {
    const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : (many || `${one}s`)}`;
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let body = null;
    try { body = await response.json(); } catch { /* empty */ }
    if (!response.ok) {
      const error = new Error(body?.error || `Something went wrong (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function toast(message, ms = 2600) {
    let el = document.getElementById('fa-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'fa-toast';
      el.className = 'fa-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  }

  function storage(kind = 'local') {
    try {
      const s = kind === 'session' ? window.sessionStorage : window.localStorage;
      const probe = '__fa__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch {
      const memory = new Map();
      return {
        getItem: (k) => (memory.has(k) ? memory.get(k) : null),
        setItem: (k, v) => memory.set(k, String(v)),
        removeItem: (k) => memory.delete(k),
      };
    }
  }

  // ---------- grouping ----------
  function norm(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // Same city name and country, within about a degree. This merges entries
  // saved with slightly different coordinates for one city (older entries used
  // a smaller city list) while keeping Portland, OR and Portland, ME apart.
  function cityKey(entry) {
    const name = norm(cityName(entry).split(',')[0]);
    return `${name}|${norm(entry.country)}|${Math.round(Number(entry.lat))}|${Math.round(Number(entry.lng))}`;
  }

  function groupByCity(entries) {
    const groups = new Map();
    for (const entry of entries) {
      const key = cityKey(entry);
      if (!groups.has(key)) {
        groups.set(key, { key, city: cityName(entry).split(',')[0], country: entry.country || '', lat: 0, lng: 0, entries: [] });
      }
      groups.get(key).entries.push(entry);
    }
    for (const group of groups.values()) {
      group.lat = group.entries.reduce((s, e) => s + Number(e.lat), 0) / group.entries.length;
      group.lng = group.entries.reduce((s, e) => s + Number(e.lng), 0) / group.entries.length;
      group.people = [...new Set(group.entries.map((e) => personKey(e)))].length;
      group.recs = group.entries.reduce((sum, e) => sum + (e.recommendations || []).length, 0);
      group.relations = [...new Set(group.entries.map((e) => e.pinType || 'current'))];
    }
    return [...groups.values()].sort((a, b) => b.people - a.people || b.recs - a.recs || a.city.localeCompare(b.city));
  }

  function personKey(entry) {
    return String(entry.name || '').trim().toLowerCase();
  }

  function groupByPerson(entries) {
    const people = new Map();
    for (const entry of entries) {
      const key = personKey(entry);
      if (!people.has(key)) people.set(key, { key, name: entry.name, entries: [] });
      people.get(key).entries.push(entry);
    }
    for (const person of people.values()) {
      person.entries.sort((a, b) => RELATION_ORDER.indexOf(a.pinType) - RELATION_ORDER.indexOf(b.pinType));
      person.recs = person.entries.reduce((sum, e) => sum + (e.recommendations || []).length, 0);
    }
    return [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- city autocomplete ----------
  // Attaches a dropdown to an <input>. Calls onPick(place) with
  // { name, region, country, countryCode, lat, lng, label } or null.
  function placeInput(input, { onPick, placeholder } = {}) {
    if (placeholder) input.placeholder = placeholder;
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    const wrap = document.createElement('div');
    wrap.className = 'fa-ac';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const list = document.createElement('div');
    list.className = 'fa-ac-list';
    list.setAttribute('role', 'listbox');
    list.id = `fa-ac-${Math.random().toString(36).slice(2, 9)}`;
    input.setAttribute('aria-controls', list.id);
    wrap.appendChild(list);

    let results = [];
    let active = -1;
    let picked = null;
    let lastQuery = '';
    const cache = new Map();

    function close() {
      list.classList.remove('open');
      input.setAttribute('aria-expanded', 'false');
      active = -1;
    }

    function render() {
      if (!results.length) {
        list.innerHTML = lastQuery.length >= 2 ? '<div class="fa-ac-empty">No matching city. Try a nearby larger city.</div>' : '';
        list.classList.toggle('open', lastQuery.length >= 2);
        return;
      }
      list.innerHTML = results.map((r, i) => `
        <div class="fa-ac-opt${i === active ? ' active' : ''}" role="option" id="${list.id}-${i}" data-i="${i}" aria-selected="${i === active}">
          <span class="fa-ac-flag">${flag(r.country) || '📍'}</span>
          <span class="fa-ac-name">${esc(r.name)}${r.region ? `<span class="fa-ac-region">, ${esc(r.region)}</span>` : ''}</span>
          <span class="fa-ac-country">${esc(r.country)}</span>
        </div>`).join('');
      list.classList.add('open');
      input.setAttribute('aria-expanded', 'true');
      if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    }

    function pick(place) {
      picked = place;
      input.value = place ? place.label : input.value;
      input.classList.toggle('is-picked', !!place);
      close();
      if (onPick) onPick(place);
    }

    const fetchResults = debounce(async (query) => {
      if (cache.has(query)) {
        results = cache.get(query);
      } else {
        try {
          const data = await api(`/api/places/search?q=${encodeURIComponent(query)}`);
          results = data.results || [];
          cache.set(query, results);
        } catch {
          results = [];
        }
      }
      if (query !== lastQuery) return;
      active = results.length ? 0 : -1;
      render();
    }, 120);

    input.addEventListener('input', () => {
      if (picked) {
        picked = null;
        input.classList.remove('is-picked');
        if (onPick) onPick(null);
      }
      lastQuery = input.value.trim();
      if (lastQuery.length < 2) { results = []; close(); list.innerHTML = ''; return; }
      fetchResults(lastQuery);
    });

    input.addEventListener('keydown', (e) => {
      if (!list.classList.contains('open') || !results.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(results.length - 1, active + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) pick(results[active]); }
      else if (e.key === 'Escape') { close(); }
    });

    list.addEventListener('mousedown', (e) => {
      const opt = e.target.closest('.fa-ac-opt');
      if (!opt) return;
      e.preventDefault();
      pick(results[Number(opt.dataset.i)]);
    });

    input.addEventListener('blur', () => setTimeout(close, 120));

    return {
      get value() { return picked; },
      set(place) { picked = place || null; input.value = place ? place.label : ''; input.classList.toggle('is-picked', !!place); },
      clear() { picked = null; input.value = ''; input.classList.remove('is-picked'); results = []; close(); },
      // If the user typed a city but never picked, take a confident top match.
      async resolve() {
        if (picked) return picked;
        const query = input.value.trim();
        if (query.length < 2) return null;
        try {
          const data = await api(`/api/places/search?q=${encodeURIComponent(query)}`);
          const top = (data.results || [])[0];
          const typedCity = query.split(',')[0].trim().toLowerCase();
          if (top && top.name.toLowerCase().startsWith(typedCity)) { pick(top); return top; }
        } catch { /* fall through */ }
        return null;
      },
      input,
    };
  }

  window.FA = {
    RELATIONS, RELATION_ORDER, REC_CATEGORIES,
    esc, initials, colorFor, relation, recCategory, flag, countryCode, cityName, placeLabel,
    timeAgo, plural, api, toast, debounce, storage,
    cityKey, groupByCity, groupByPerson, personKey, placeInput,
  };
})();
