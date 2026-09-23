/* Friend Atlas map: MapLibre GL + OpenFreeMap vector tiles (free, no API key),
   restyled to the Friend Atlas palette, with city markers that cluster when
   they would overlap. Requires window.maplibregl and window.FA. */
(function () {
  'use strict';

  const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
  const PALETTE = {
    land: '#f1ece2',
    water: '#c8dcdf',
    waterLabel: '#5f8790',
    green: '#e0e6d0',
    residential: '#ebe4d6',
    ice: '#f7f5f0',
    building: '#e4dbcc',
    border: '#b9ae9b',
    borderSoft: '#d4cab9',
    roadCasing: '#e2d8c6',
    road: '#fbf8f2',
    label: '#4a4439',
    labelSoft: '#7d7466',
    halo: '#f6f2ea',
  };
  const HIDDEN_LAYERS = /shield|highway-name|airport|label_other|label_village|aeroway|railway|building|tunnel|bridge|pier|path|minor/;
  const EN_NAME = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];

  let stylePromise = null;

  function themeStyle(style) {
    for (const layer of style.layers) {
      const id = layer.id;
      layer.paint = layer.paint || {};
      layer.layout = layer.layout || {};
      if (HIDDEN_LAYERS.test(id)) { layer.layout.visibility = 'none'; continue; }
      if (layer.type === 'background') layer.paint['background-color'] = PALETTE.land;
      else if (id === 'water') layer.paint['fill-color'] = PALETTE.water;
      else if (id === 'waterway') layer.paint['line-color'] = PALETTE.water;
      else if (id === 'park' || id === 'landcover_wood') { layer.paint['fill-color'] = PALETTE.green; layer.paint['fill-opacity'] = 0.55; }
      else if (id === 'landuse_residential') { layer.paint['fill-color'] = PALETTE.residential; layer.paint['fill-opacity'] = 0.6; }
      else if (/landcover_(ice|glacier)/.test(id)) layer.paint['fill-color'] = PALETTE.ice;
      else if (id === 'boundary_2' || id === 'boundary_disputed') layer.paint['line-color'] = PALETTE.border;
      else if (id === 'boundary_3') layer.paint['line-color'] = PALETTE.borderSoft;
      else if (layer.type === 'line' && /highway/.test(id)) layer.paint['line-color'] = /casing/.test(id) ? PALETTE.roadCasing : PALETTE.road;

      if (layer.type === 'symbol' && layer.layout['text-field']) {
        layer.layout['text-field'] = EN_NAME;
        const water = /water/.test(id);
        const country = /country/.test(id);
        layer.paint['text-color'] = water ? PALETTE.waterLabel : country ? PALETTE.labelSoft : PALETTE.label;
        layer.paint['text-halo-color'] = PALETTE.halo;
        layer.paint['text-halo-width'] = 1.4;
      }
    }
    return style;
  }

  function fallbackStyle() {
    return { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': PALETTE.land } }] };
  }

  function loadStyle() {
    if (!stylePromise) {
      stylePromise = fetch(STYLE_URL)
        .then((r) => { if (!r.ok) throw new Error(`style ${r.status}`); return r.json(); })
        .then(themeStyle)
        .catch((error) => { console.warn('Map style unavailable, using plain background', error); stylePromise = null; return fallbackStyle(); });
    }
    return stylePromise.then((style) => JSON.parse(JSON.stringify(style)));
  }

  function facesHtml(entries) {
    const { esc, initials, relation } = window.FA;
    const seen = new Set();
    const faces = [];
    for (const entry of entries) {
      const key = String(entry.name || '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      faces.push(`<span class="fa-face" style="--c:${relation(entry.pinType).color}">${esc(initials(entry.name))}</span>`);
      if (faces.length === 3) break;
    }
    return faces.join('');
  }

  function markerEl(group) {
    const { esc, plural, flag } = window.FA;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'fa-pin';
    el.dataset.key = group.key;
    el.setAttribute('aria-label', `${group.city}${group.country ? `, ${group.country}` : ''}: ${plural(group.people, 'person', 'people')}`);
    const extra = group.people > 3 ? `<span class="fa-pin-more">+${group.people - 3}</span>` : '';
    el.innerHTML = `
      <span class="fa-pin-body">${facesHtml(group.entries)}${extra}</span>
      <span class="fa-pin-label">${flag(group.country)} ${esc(group.city)}</span>`;
    return el;
  }

  function clusterEl(cluster) {
    const { plural } = window.FA;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'fa-cluster';
    const people = cluster.groups.reduce((s, g) => s + g.people, 0);
    el.setAttribute('aria-label', `${plural(cluster.groups.length, 'city', 'cities')}, ${plural(people, 'person', 'people')}. Zoom in.`);
    el.innerHTML = `<span class="fa-cluster-num">${people}</span><span class="fa-cluster-sub">${plural(cluster.groups.length, 'city', 'cities')} · zoom in</span>`;
    return el;
  }

  function create(container, options = {}) {
    const opts = {
      interactive: true,
      globe: false,
      cooperative: false,
      padding: { top: 60, right: 60, bottom: 60, left: 60 },
      clusterRadius: 58,
      onSelect: null,
      ...options,
    };
    let map = null;
    let groups = [];
    let markers = [];
    let selectedKey = null;
    let dimmed = null;
    let padding = { ...opts.padding };
    let failed = false;

    const ready = (async () => {
      if (!window.maplibregl) throw new Error('Map library did not load');
      const style = await loadStyle();
      if (opts.globe) style.projection = { type: 'globe' };
      map = new window.maplibregl.Map({
        container,
        style,
        center: opts.center || [-20, 28],
        zoom: opts.zoom ?? 1.3,
        minZoom: 0.8,
        maxZoom: 13,
        interactive: opts.interactive,
        cooperativeGestures: opts.cooperative,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: { compact: true },
        renderWorldCopies: !opts.globe,
        fadeDuration: 150,
      });
      if (opts.interactive) {
        map.touchZoomRotate.disableRotation();
        map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), opts.controlsPosition || 'bottom-right');
      }
      map.on('zoomend', () => renderMarkers());
      map.on('moveend', () => { if (map._faPendingRender) { map._faPendingRender = false; renderMarkers(); } });
      // Markers and camera moves do not need tiles, so show people right away
      // and let the basemap stream in underneath.
      renderMarkers();
      return map;
    })().catch((error) => {
      failed = true;
      console.warn('Map failed to start', error);
      container.classList.add('fa-map-failed');
      container.innerHTML = '<div class="fa-map-fallback"><strong>The map could not load here.</strong><span>Everything is still in the list.</span></div>';
      return null;
    });

    function clusters() {
      if (!map || !groups.length) return [];
      const placed = [];
      const sorted = [...groups].sort((a, b) => b.people - a.people);
      for (const group of sorted) {
        const p = map.project([group.lng, group.lat]);
        const hit = placed.find((c) => Math.hypot(c.x - p.x, c.y - p.y) < opts.clusterRadius);
        if (hit && group.key !== selectedKey && !hit.groups.some((g) => g.key === selectedKey)) hit.groups.push(group);
        else placed.push({ x: p.x, y: p.y, groups: [group] });
      }
      return placed;
    }

    function renderMarkers() {
      if (!map) return;
      markers.forEach((m) => m.remove());
      markers = [];
      for (const cluster of clusters()) {
        // MapLibre owns the wrapper's position and transform; our styled
        // button lives inside it so hover and selection effects never fight it.
        const wrap = document.createElement('div');
        wrap.className = 'fa-marker';
        if (cluster.groups.length === 1) {
          const group = cluster.groups[0];
          const el = markerEl(group);
          if (group.key === selectedKey) { el.classList.add('is-selected'); wrap.classList.add('is-top'); }
          if (dimmed && !dimmed.has(group.key)) el.classList.add('is-dim');
          el.addEventListener('click', (e) => { e.stopPropagation(); if (opts.onSelect) opts.onSelect(group); });
          wrap.appendChild(el);
          markers.push(new window.maplibregl.Marker({ element: wrap, anchor: 'bottom' }).setLngLat([group.lng, group.lat]).addTo(map));
        } else {
          const el = clusterEl(cluster);
          if (dimmed && !cluster.groups.some((g) => dimmed.has(g.key))) el.classList.add('is-dim');
          const lng = cluster.groups.reduce((s, g) => s + g.lng, 0) / cluster.groups.length;
          const lat = cluster.groups.reduce((s, g) => s + g.lat, 0) / cluster.groups.length;
          el.addEventListener('click', (e) => { e.stopPropagation(); fitGroups(cluster.groups, { maxZoom: Math.min(13, map.getZoom() + 3) }); });
          wrap.appendChild(el);
          markers.push(new window.maplibregl.Marker({ element: wrap, anchor: 'center' }).setLngLat([lng, lat]).addTo(map));
        }
      }
    }

    function boundsFor(list) {
      const bounds = new window.maplibregl.LngLatBounds();
      list.forEach((g) => bounds.extend([g.lng, g.lat]));
      return bounds;
    }

    function fitGroups(list, { maxZoom = 5, animate = true } = {}) {
      if (!map || !list.length) return;
      if (list.length === 1) {
        map.easeTo({ center: [list[0].lng, list[0].lat], zoom: Math.max(map.getZoom(), 4), padding, duration: animate ? 700 : 0 });
        return;
      }
      map.fitBounds(boundsFor(list), { padding, maxZoom, duration: animate ? 800 : 0 });
    }

    return {
      ready,
      get map() { return map; },
      get failed() { return failed; },
      setGroups(next, { fit = false, animate = false } = {}) {
        groups = next;
        ready.then(() => {
          if (!map) return;
          if (fit) this.fitAll({ animate });
          renderMarkers();
        });
      },
      fitAll({ animate = true } = {}) {
        if (!map) return;
        if (!groups.length) { map.easeTo({ center: [-20, 28], zoom: 1.3, duration: animate ? 600 : 0 }); return; }
        fitGroups(groups, { maxZoom: 4.5, animate });
      },
      fitGroups,
      select(key, { fly = true } = {}) {
        selectedKey = key;
        const group = groups.find((g) => g.key === key);
        if (map && group && fly) {
          map._faPendingRender = true;
          map.easeTo({ center: [group.lng, group.lat], zoom: Math.max(map.getZoom(), 4.2), padding, duration: 700 });
        }
        renderMarkers();
      },
      dim(keys) {
        dimmed = keys ? new Set(keys) : null;
        renderMarkers();
      },
      setPadding(next) {
        padding = { ...padding, ...next };
      },
      resize() { if (map) map.resize(); },
      spin(speed = 3) {
        // Slow rotation for decorative globes. Degrees per second.
        ready.then(() => {
          if (!map) return;
          let last = performance.now();
          const step = (now) => {
            if (!map) return;
            const center = map.getCenter();
            center.lng -= ((now - last) / 1000) * speed;
            last = now;
            map.jumpTo({ center });
            if (!document.hidden) requestAnimationFrame(step);
            else document.addEventListener('visibilitychange', () => { last = performance.now(); requestAnimationFrame(step); }, { once: true });
          };
          if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) requestAnimationFrame(step);
        });
      },
    };
  }

  window.FAMap = { create, loadStyle };
})();
