'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => '₹' + Number(n).toLocaleString('en-IN');
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {weekday:'short', day:'numeric', month:'short', year:'numeric'});
const todayStr = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

let me = null, meta = {services: [], vehicles: [], slots: [], modes: []};
let userCoords = null, homeVehicle = 'Car', garageCache = {}, myVehicles = [], bookingCtx = null, ownerGarages = [], editingGarage = null, ownerTab = 'pending';
const VIEWS = ['home','services','prices','garages','bookings','account','garage','how','contact','legal'];

/* ---------- API ---------- */
async function api(path, method = 'GET', body) {
  const isGet = method === 'GET'; let res;
  for (let attempt = 0; ; attempt++) {   // transient failures on reads are retried quietly
    try { res = await fetch('/api' + path, {method, headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin'}); break; }
    catch (netErr) {
      console.warn('Heeben API unreachable:', method, '/api' + path, netErr);
      if (isGet && attempt < 2) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
      const err = new Error(navigator.onLine === false ? 'You appear to be offline.' : isGet ? 'Couldn\u2019t load this right now.' : 'The Heeben server isn\u2019t reachable, so that couldn\u2019t be saved.');
      err.network = true; err.silent = isGet; throw err;   // silent: shown inline by the page, never as a popup
    }
  }
  let data = {}, bad = false; try { data = await res.json(); } catch { bad = true; }
  if (bad && isGet && (res.ok || res.status === 404 || res.status >= 502)) { const err = new Error('Couldn\u2019t load this right now.'); err.network = err.silent = true; throw err; }  // not the Heeben API (static host / proxy error page)
  if (!res.ok) { const err = new Error(data.error || 'Something went wrong'); err.status = res.status; throw err; }
  return data;
}
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200); }
const fail = e => { if (e && e.silent) return; toast(e.message || 'Something went wrong'); };
async function guard(btn, fn) { // disable a button while a request runs
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { fail(e); } finally { if (btn) btn.disabled = false; }
}

/* ---------- routing ---------- */
function go(view) { if (!VIEWS.includes(view)) view = 'home'; if (location.hash.slice(1) !== view) location.hash = view; else show(view); }
function show(view) {
  if (!VIEWS.includes(view)) view = 'home';
  $$('.view').forEach(v => v.classList.toggle('active', v.id === view));
  $$('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#mainNav').classList.remove('open'); $('#mobileMenu').setAttribute('aria-expanded', 'false');
  window.scrollTo({top: 0});
  document.title = (view === 'home' ? '' : view.charAt(0).toUpperCase() + view.slice(1) + ' · ') + 'Heeben — We Care Beyond the Drive';
  ({home: renderHome, services: renderServices, prices: renderPrices, garages: loadGarages, bookings: renderBookings, account: renderAccount, garage: renderGarageDash}[view] || (() => {}))();
}
window.addEventListener('hashchange', () => show(location.hash.slice(1) || 'home'));

/* ---------- auth ---------- */
let authMode = 'signup', authRole = 'customer';
function openModal(id) { const m = $('#' + id); m.classList.add('open'); setTimeout(() => m.querySelector('input:not([type=hidden]),select,textarea,button:not(.modal-close)')?.focus(), 30); }
function closeModals() { $$('.modal-backdrop.open').forEach(m => m.classList.remove('open')); }
function openAuth(mode, role) {
  authMode = mode; if (role) authRole = role;
  $('#authTitle').textContent = mode === 'signup' ? 'Create your account.' : 'Welcome back.';
  $('#authSubmit').textContent = mode === 'signup' ? 'Create account' : 'Log in';
  $('#nameField').style.display = $('#roleToggle').style.display = mode === 'signup' ? '' : 'none';
  $('#authName').required = mode === 'signup';
  $('#authPassword').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
  $('#switchAuth').textContent = mode === 'signup' ? 'Already have an account? Log in' : 'New here? Create an account';
  $$('#roleToggle button').forEach(b => b.classList.toggle('selected', b.dataset.role === authRole));
  $('#authMessage').textContent = ''; openModal('authModal');
}
function setUser(u) {
  me = u;
  $('#loginBtn').textContent = u ? 'Hi, ' + u.name.split(' ')[0] : 'Log in';
  $('#signupBtn').innerHTML = u ? 'Log out' : 'Sign up <span aria-hidden="true">↗</span>';
  $('#navBookings').style.display = u && u.role === 'owner' ? 'none' : '';
  $('#navGarage').textContent = u && u.role === 'owner' ? 'My garage' : 'For garages';
}
$('#authForm').onsubmit = async e => {
  e.preventDefault(); const msg = $('#authMessage'); msg.textContent = '';
  const body = {email: $('#authEmail').value.trim(), password: $('#authPassword').value};
  if (authMode === 'signup') { body.name = $('#authName').value.trim(); body.role = authRole; }
  try {
    const r = await api(authMode === 'signup' ? '/signup' : '/login', 'POST', body);
    setUser(r.user); closeModals(); $('#authForm').reset(); toast(`Welcome${authMode === 'signup' ? '' : ' back'}, ${r.user.name.split(' ')[0]}!`);
    const after = pendingAfterAuth; pendingAfterAuth = null;
    if (after) after(); else if (r.user.role === 'owner' && location.hash !== '#garage') go('garage'); else show(location.hash.slice(1) || 'home');
  } catch (err) { msg.textContent = err.message; }
};
let pendingAfterAuth = null;
function requireLogin(role, then) {
  if (!me) { pendingAfterAuth = then; openAuth('login', role); toast('Please log in or create an account first.'); return false; }
  return true;
}
$('#loginBtn').onclick = () => me ? go('account') : openAuth('login');
$('#signupBtn').onclick = async () => { if (!me) return openAuth('signup', 'customer'); await api('/logout', 'POST', {}).catch(() => {}); setUser(null); go('home'); show('home'); toast('Logged out.'); };
$('#switchAuth').onclick = () => openAuth(authMode === 'signup' ? 'login' : 'signup');
$('#roleToggle').onclick = e => { const b = e.target.closest('[data-role]'); if (b) { authRole = b.dataset.role; $$('#roleToggle button').forEach(x => x.classList.toggle('selected', x === b)); } };

/* ---------- global events ---------- */
document.addEventListener('click', e => {
  const t = e.target;
  if (t.matches('.modal-backdrop')) return t.classList.remove('open');
  if (t.closest('[data-close]')) return closeModals();
  const v = t.closest('[data-view]'); if (v) { e.preventDefault(); return go(v.dataset.view); }
  const g = t.closest('[data-go]'); if (g) {
    const to = g.dataset.go; if (to === 'partners') return go('garage'); return go(to);
  }
  const sv = t.closest('[data-service]'); if (sv) { $('#garageService').value = sv.dataset.service; return go('garages'); }
  const a = t.closest('[data-action]'); if (a) actions[a.dataset.action]?.(a, e);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });
$('#mobileMenu').onclick = () => { const n = $('#mainNav'); const o = n.classList.toggle('open'); $('#mobileMenu').setAttribute('aria-expanded', o); };

const actions = {
  save: async b => { if (!requireLogin('customer', () => actions.save(b))) return; if (me.role !== 'customer') return toast('Saving garages is for customer accounts.');
    const r = await api('/garages/' + b.dataset.id + '/save', 'POST', {}).catch(fail); if (!r) return; toast(r.saved ? 'Saved to your shortlist.' : 'Removed from your shortlist.'); refreshCurrent(); },
  viewGarage: b => openGarageDetail(b.dataset.id),
  book: b => openBooking(b.dataset.id, b.dataset.svc),
  cancel: b => { if (confirm('Cancel this booking request?')) guard(b, async () => { await api(`/bookings/${b.dataset.id}/cancel`, 'POST', {}); toast('Booking cancelled.'); renderBookings(); }); },
  review: b => { $('#reviewBookingId').value = b.dataset.id; $('#reviewText').value = ''; openModal('reviewModal'); },
  respond: b => { const st = b.dataset.status; $('#noteBookingId').value = b.dataset.id; $('#noteStatus').value = st; $('#noteText').value = '';
    $('#noteTitle').textContent = {Confirmed: 'Accept this request.', Rejected: 'Decline this request.', Completed: 'Mark as completed.'}[st]; $('#noteSubmit').textContent = {Confirmed: 'Accept', Rejected: 'Decline', Completed: 'Mark completed'}[st]; openModal('noteModal'); },
  delVehicle: b => guard(b, async () => { await api('/vehicles/' + b.dataset.id, 'DELETE'); renderAccount(); }),
  delReminder: b => guard(b, async () => { await api('/reminders/' + b.dataset.id, 'DELETE'); renderBookings(); }),
  editGarage: b => { editingGarage = ownerGarages.find(g => g.id == b.dataset.id) || null; renderGarageDash(); $('#garageForm')?.scrollIntoView({behavior: 'smooth'}); },
  newGarage: () => { editingGarage = null; renderGarageDash(); },
  toggleGarage: b => guard(b, async () => { const r = await api(`/garages/${b.dataset.id}/active`, 'POST', {}); toast(r.active ? 'Garage is live again.' : 'Garage hidden from search.'); renderGarageDash(); }),
  ownerTab: b => { ownerTab = b.dataset.tab; renderOwnerBookings(); },
  useGarageLoc: async b => { b.disabled = true; b.textContent = 'Locating…';
    try { const p = await bestPosition({target: 30, maxWait: 15000, onFix: p => b.textContent = `Improving… ±${fmtAcc(p.coords.accuracy)}`}); $('#gLat').value = p.coords.latitude.toFixed(6); $('#gLng').value = p.coords.longitude.toFixed(6); b.textContent = `✓ Location set (±${fmtAcc(p.coords.accuracy)})`; }
    catch (e) { b.textContent = '⌖ Use my current location'; toast(geoErrorMsg(e)); } finally { b.disabled = false; } },
  retry: () => loadGarages(),
  signupOwner: () => openAuth('signup', 'owner'),
};
const refreshCurrent = () => show(location.hash.slice(1) || 'home');

/* ---------- garages ---------- */
function garageCard(g, compact) {
  const dist = g.distance_km != null ? ` · ${g.distance_km} km away` : '';
  const rating = g.rating ? `<span class="stars">★ ${g.rating} <small>(${g.review_count})</small></span>` : '<span class="stars new">New</span>';
  return `<article class="garage-card ${compact ? 'featured-garage' : ''}"><div class="garage-card-art g${(g.id - 1) % 6 + 1}"><span class="garage-card-kicker">${g.is_sample ? 'SAMPLE LISTING' : 'HEEBEN PARTNER'}</span>
  <button class="save-garage ${g.saved ? 'saved' : ''}" data-action="save" data-id="${g.id}" aria-label="${g.saved ? 'Remove from saved' : 'Save garage'}">${g.saved ? '♥' : '♡'}</button></div>
  <div class="garage-card-content"><div class="garage-top"><h3>${esc(g.name)}</h3>${rating}</div><p>⌖ ${esc(g.area)}${dist}${g.lat != null ? ` <a class="dir-link" href="${directionsUrl(g)}" target="_blank" rel="noopener">Directions ↗</a>` : ''}</p>
  <div>${g.services.slice(0, 3).map(x => `<span class="tag">${esc(x.service)}</span>`).join('')}</div>
  <div class="garage-card-bottom"><span><b>${g.min_price != null ? 'From ' + money(g.min_price) : '—'}</b><small>Indicative starting price</small></span>
  <span class="card-btns"><button class="btn btn-outline" data-action="viewGarage" data-id="${g.id}">Details</button><button class="btn btn-navy" data-action="book" data-id="${g.id}">Request ↗</button></span></div></div></article>`;
}
let usingFallback = false;
async function fetchGarages(params) {
  const p = new URLSearchParams(params); if (userCoords) { p.set('lat', userCoords.lat); p.set('lng', userCoords.lng); }
  let list;
  try { list = (await api('/garages?' + p)).garages; usingFallback = false; }
  catch (e) {
    if (!e.network) throw e;
    usingFallback = true; list = fallbackGarages({...params, radius: +params.radius || 0, lat: userCoords?.lat, lng: userCoords?.lng});
  }
  list.forEach(g => garageCache[g.id] = g); return list;
}
let garageReq = 0;
async function loadGarages() {
  const id = ++garageReq, grid = $('#garageGrid');
  grid.innerHTML = '<p class="muted">Loading garages…</p>';
  try {
    const list = await fetchGarages({q: $('#garageSearch').value.trim(), service: $('#garageService').value, vehicle: $('#garageVehicle').value, sort: $('#garageSort').value, ...(userCoords && $('#garageRadius').value ? {radius: $('#garageRadius').value} : {})});
    if (id !== garageReq) return;
    $('#nearStatus').textContent = userCoords ? (coordsSource === 'gps' ? 'Distances are from your current location.' : 'Distances are from the area you searched.') : ($('#garageRadius').value ? 'Tap "Garages near me" so we can filter by distance.' : '');
    $('#garageNotice').hidden = !usingFallback;
    $('#garageCount').textContent = list.length ? `${list.length} garage${list.length > 1 ? 's' : ''} found` : '';
    grid.innerHTML = list.length ? list.map(g => garageCard(g)).join('') : `<div class="empty-shortlist">${userCoords && $('#garageRadius').value ? `No garages within ${$('#garageRadius').value} km. Try a larger distance.` : 'No garages match your filters yet. Try clearing the search or choosing a different service.'}</div>`;
  } catch (e) { grid.innerHTML = `<p class="muted">${esc(e.message)} <button class="btn btn-outline" data-action="retry">Retry</button></p>`; }
}
let debounce; ['garageSearch'].forEach(i => $('#' + i).addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(loadGarages, 250); }));
['garageService', 'garageVehicle', 'garageSort'].forEach(i => $('#' + i).addEventListener('change', loadGarages));

async function renderHome() {
  const el = $('#featuredGarages');
  try { const list = await fetchGarages({sort: 'rating'}); el.innerHTML = list.slice(0, 3).map(g => garageCard(g, true)).join('') || '<p class="muted">Garages will appear here soon.</p>'; } catch { el.innerHTML = ''; }
}
function renderServices() {
  const icons = ['✧', '◷', '⌁', '◉', 'ϟ'], desc = ['Exterior wash, interior cleaning, deep cleaning and polishing.', 'Periodic service, oil change, filters and general inspection.', 'Brake work, clutch and gear repair, engine diagnostics, suspension.', 'Tyre check, puncture repair, battery check and replacement.', 'Electrical checks, diagnostics, EV inspection and charging support.'];
  $('#vehicleSelect').innerHTML = [['', 'Any vehicle'], ...meta.vehicles.map(v => [v, v])].map(([v, l]) => `<button class="vehicle-option ${$('#garageVehicle').value === v ? 'selected' : ''}" data-vehicle="${esc(v)}"><b>${esc(l)}</b></button>`).join('');
  $('#serviceCatalog').innerHTML = meta.services.map((n, i) => `<div class="catalog-item"><div><h4>${icons[i] || '•'} &nbsp;${esc(n)}</h4><p>${desc[i] || ''}</p>${SERVICE_HINTS[n] ? `<p class="price-hint">Typical: ${esc(SERVICE_HINTS[n])}</p>` : ''}</div><button class="btn btn-outline" data-service="${esc(n)}">Find garages ↗</button></div>`).join('');
}
$('#vehicleSelect').addEventListener('click', e => { const b = e.target.closest('[data-vehicle]'); if (!b) return; $('#garageVehicle').value = b.dataset.vehicle; renderServices(); });

let priceSize = 'h';
function renderPrices() {
  $$('#sizeToggle [data-size]').forEach(b => b.classList.toggle('selected', b.dataset.size === priceSize));
  $('#priceBody').innerHTML = PRICE_GUIDE.map(g => `<div class="panel price-group"><div class="price-group-head"><div><h3>${g.icon} &nbsp;${esc(g.title)}</h3><p class="muted">${esc(g.note)}</p></div><button class="btn btn-outline" data-service="${esc(g.service)}">Find garages ↗</button></div>
    <ul class="price-list">${g.items.map(i => { const r = i[priceSize] || i.all; const val = i.text || `${LAKH(r[0])} – ${LAKH(r[1])}${i.plus ? '+' : ''}`; return `<li><span>${esc(i.name)}</span><b>${esc(val)}</b></li>`; }).join('')}</ul></div>`).join('');
}
$('#sizeToggle').addEventListener('click', e => { const b = e.target.closest('[data-size]'); if (b) { priceSize = b.dataset.size; renderPrices(); } });

/* ---------- location ---------- */
let coordsSource = null, gpsArea = '', locating = false;
const GEO_KEY = 'hb_loc';
try { const s = JSON.parse(sessionStorage.getItem(GEO_KEY) || 'null'); if (s && Date.now() - s.t < 30 * 60000) { userCoords = {lat: s.lat, lng: s.lng, acc: s.acc}; coordsSource = 'gps'; gpsArea = s.area || ''; } } catch {}
const saveCoords = () => { try { sessionStorage.setItem(GEO_KEY, JSON.stringify({...userCoords, area: gpsArea, t: Date.now()})); } catch {} };
const fmtAcc = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
const geoErrorMsg = e => ({'-1': 'Location needs a secure (https) page. Enter your area instead.', 0: 'GPS is not available in this browser. Enter your area instead.',
  1: 'Location is blocked. Allow it in your browser’s site settings, or enter your area.', 2: 'Couldn’t work out your position. Turn on device location, or enter your area.',
  3: 'Location timed out. Move to an open spot and try again, or enter your area.'}[e?.code] || 'Could not detect your location. Enter your area instead.');

// Best-effort fix: watch GPS, keep the most accurate reading, stop when good enough or when readings stop improving.
function bestPosition({target = 50, maxWait = 15000, settle = 4000, onFix} = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject({code: 0});
    if (window.isSecureContext === false) return reject({code: -1});
    let best = null, done = false, fellBack = false, wid, maxTimer, settleTimer;
    const stop = () => { done = true; if (wid != null) navigator.geolocation.clearWatch(wid); clearTimeout(maxTimer); clearTimeout(settleTimer); };
    const finish = (err) => { if (done) return; stop(); best ? resolve(best) : reject(err); };
    const coarse = () => { if (fellBack || done) return; fellBack = true; if (wid != null) navigator.geolocation.clearWatch(wid); clearTimeout(settleTimer);
      navigator.geolocation.getCurrentPosition(p => { if (!best) best = p; finish(); }, e => finish(e), {enableHighAccuracy: false, timeout: 8000, maximumAge: 300000}); };
    wid = navigator.geolocation.watchPosition(p => {
      if (!best || p.coords.accuracy < best.coords.accuracy) { best = p; onFix?.(p); }
      if (p.coords.accuracy <= target) return finish();
      clearTimeout(settleTimer); settleTimer = setTimeout(() => finish(), settle);
    }, e => { if (e.code === 1) finish(e); else if (!best) coarse(); }, {enableHighAccuracy: true, timeout: 10000, maximumAge: 0});
    maxTimer = setTimeout(() => best ? finish() : coarse(), maxWait);
  });
}
async function timedJson(url, ms = 6000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, {signal: ac.signal, headers: {'Accept-Language': 'en'}}); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
}
async function locateMe(setStatus) {
  if (locating) return null; locating = true;
  setStatus('Finding your location…');
  try {
    const pos = await bestPosition({onFix: p => setStatus(`Improving accuracy… (±${fmtAcc(p.coords.accuracy)})`)});
    userCoords = {lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy}; coordsSource = 'gps'; gpsArea = ''; saveCoords();
    setStatus(`Location found (accurate to ~${fmtAcc(userCoords.acc)}). Nearest garages come first.`);
    timedJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${userCoords.lat}&lon=${userCoords.lng}`).then(j => {
      const a = j?.address || {}, area = a.suburb || a.neighbourhood || a.city_district || a.town || a.city || '';
      if (area) { gpsArea = area; $('#homeLocation').value = area; saveCoords(); }
    });
    return userCoords;
  } catch (e) { setStatus(geoErrorMsg(e)); return null; } finally { locating = false; }
}
const geoCache = new Map();
async function geocodeArea(text) {
  const k = text.toLowerCase(); if (geoCache.has(k)) return geoCache.get(k);
  const j = await timedJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(text)}`);
  const r = j?.[0] ? {lat: +j[0].lat, lng: +j[0].lon, acc: null} : null; if (r) geoCache.set(k, r); return r;
}
$$('[data-home-vehicle]').forEach(btn => btn.addEventListener('click', () => { homeVehicle = btn.dataset.homeVehicle; $$('[data-home-vehicle]').forEach(x => x.classList.toggle('selected', x === btn)); }));
$('#useMyLocation').addEventListener('click', () => locateMe(m => $('#gpsStatus').textContent = m));
$('#nearMeBtn').addEventListener('click', async () => {
  const btn = $('#nearMeBtn'); btn.disabled = true;
  const c = await locateMe(m => $('#nearStatus').textContent = m); btn.disabled = false;
  if (c) { $('#garageSort').value = 'distance'; $('#garageSearch').value = ''; loadGarages(); }
});
$('#garageRadius').addEventListener('change', loadGarages);
$('#findNearbyBtn').addEventListener('click', async () => {
  const btn = $('#findNearbyBtn'), text = $('#homeLocation').value.trim(), st = $('#gpsStatus'); let useText = false;
  $('#garageVehicle').value = homeVehicle; $('#garageService').value = '';
  if (text && !(coordsSource === 'gps' && userCoords && (!gpsArea || text === gpsArea))) {   // typed area: turn it into coordinates
    btn.disabled = true; st.textContent = 'Locating that area…';
    const c = await geocodeArea(text); btn.disabled = false;
    if (c) { userCoords = c; coordsSource = 'area'; st.textContent = `Showing garages closest to ${text}.`; } else { useText = true; if (coordsSource === 'area') userCoords = null; st.textContent = 'Couldn’t pin that area on the map, so searching by name instead.'; }
  }
  $('#garageSearch').value = useText ? text : '';
  $('#garageSort').value = userCoords ? 'distance' : 'recommended'; go('garages'); if (location.hash === '#garages') loadGarages();
});
const directionsUrl = g => g.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${g.lat},${g.lng}` : '';

/* ---------- garage detail ---------- */
async function openGarageDetail(id) {
  openModal('garageModal'); const box = $('#garageDetail'); box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const {garage: g} = await api('/garages/' + id);
    box.innerHTML = `<p class="eyebrow">${g.is_sample ? 'SAMPLE LISTING' : 'HEEBEN PARTNER'}</p><h2>${esc(g.name)}</h2>
    <p class="muted">⌖ ${esc(g.area)}${g.lat != null ? ` · <a href="${directionsUrl(g)}" target="_blank" rel="noopener">Directions ↗</a>` : ''} · ☎ <a href="tel:${esc(g.phone)}">${esc(g.phone)}</a></p>
    ${g.description ? `<p>${esc(g.description)}</p>` : ''}
    <p class="eyebrow mt">SERVICES &amp; STARTING PRICES</p><ul class="price-list">${g.services.map(s => `<li><span>${esc(s.service)}</span><b>${money(s.price)}</b></li>`).join('')}</ul>
    <p class="hint">Works on: ${g.vehicles.map(esc).join(', ')}. Final price is confirmed by the garage after inspection.</p>
    <button class="btn btn-navy" data-action="book" data-id="${g.id}">Request a booking ↗</button>
    <p class="eyebrow mt">REVIEWS ${g.rating ? `· ★ ${g.rating} (${g.review_count})` : ''}</p>
    ${g.reviews.length ? g.reviews.map(r => `<div class="review"><b>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</b> <small>${esc(r.name)} · ${esc(r.created.slice(0, 10))}</small>${r.text ? `<p>${esc(r.text)}</p>` : ''}</div>`).join('') : '<p class="muted">No reviews yet. Reviews appear after completed bookings.</p>'}`;
  } catch (e) { box.innerHTML = `<p>${esc(e.message)}</p>`; }
}

/* ---------- booking ---------- */
async function openBooking(id, svc) {
  closeModals();
  if (!requireLogin('customer', () => openBooking(id, svc))) return;
  if (me.role !== 'customer') return toast('Garage-owner accounts cannot book. Sign up as a vehicle owner to request services.');
  let g = garageCache[id]; if (!g) { try { g = (await api('/garages/' + id)).garage; } catch (e) { return fail(e); } }
  try { myVehicles = (await api('/vehicles')).vehicles; } catch { myVehicles = []; }
  bookingCtx = {garage: g, slot: null};
  $('#bookingTitle').textContent = 'Book with ' + g.name;
  $('#bookingService').innerHTML = g.services.map(s => `<option value="${esc(s.service)}" ${s.service === (svc || $('#garageService').value) ? 'selected' : ''}>${esc(s.service)} — from ${money(s.price)}</option>`).join('');
  $('#bookingVehicleSel').innerHTML = myVehicles.map(v => `<option value="${esc(v.model)}">${esc(v.model)} (${esc(v.type)})</option>`).join('') + '<option value="__new">+ Another vehicle…</option>';
  $('#bookingVehicleNewWrap').style.display = myVehicles.length ? 'none' : ''; $('#bookingVehicleNew').value = '';
  $('#bookingMode').innerHTML = meta.modes.map(m => `<option>${esc(m)}</option>`).join('');
  $('#bookingDate').min = $('#bookingDate').value = todayStr(); $('#bookingNotes').value = ''; $('#bookingPhone').value = me.phone || ''; $('#bookingMessage').textContent = '';
  openModal('bookingModal'); loadSlots();
}
$('#bookingVehicleSel').onchange = () => { $('#bookingVehicleNewWrap').style.display = $('#bookingVehicleSel').value === '__new' ? '' : 'none'; };
async function loadSlots() {
  const grid = $('#slotGrid'), d = $('#bookingDate').value; bookingCtx.slot = null;
  if (!d) { grid.innerHTML = ''; return; }
  grid.innerHTML = '<span class="hint">Checking availability…</span>';
  try {
    const {slots} = await api(`/garages/${bookingCtx.garage.id}/slots?date=${d}`);
    grid.innerHTML = slots.map(s => `<button type="button" class="slot" role="radio" aria-checked="false" data-slot="${esc(s.time)}" ${s.available ? '' : 'disabled'}>${esc(s.time)}${s.available ? '' : '<small>Full</small>'}</button>`).join('');
  } catch (e) { grid.innerHTML = `<span class="hint">${esc(e.message)}</span>`; }
}
$('#bookingDate').onchange = loadSlots;
$('#slotGrid').onclick = e => { const b = e.target.closest('.slot'); if (!b || b.disabled) return; $$('#slotGrid .slot').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-checked', x === b); }); bookingCtx.slot = b.dataset.slot; };
$('#bookingForm').onsubmit = async e => {
  e.preventDefault(); const msg = $('#bookingMessage'); msg.textContent = '';
  const sel = $('#bookingVehicleSel').value, vehicle = (sel === '__new' || !myVehicles.length) ? $('#bookingVehicleNew').value.trim() : sel;
  if (!vehicle) return msg.textContent = 'Please enter your vehicle model.';
  if (!bookingCtx.slot) return msg.textContent = 'Please choose a time slot.';
  const btn = $('#bookingSubmit'); btn.disabled = true;
  try {
    await api('/bookings', 'POST', {garage_id: bookingCtx.garage.id, service: $('#bookingService').value, vehicle, date: $('#bookingDate').value, time: bookingCtx.slot, mode: $('#bookingMode').value, notes: $('#bookingNotes').value.trim(), phone: $('#bookingPhone').value.trim()});
    if (me && !me.phone) me.phone = $('#bookingPhone').value.trim();
    closeModals(); toast('Request sent! The garage will confirm shortly.'); go('bookings'); if (location.hash === '#bookings') renderBookings();
  } catch (err) { msg.textContent = err.message; if (err.status === 409) loadSlots(); } finally { btn.disabled = false; }
};

const STATUS_NOTE = {Requested: 'Waiting for the garage to respond', Confirmed: 'The garage accepted your request', Rejected: 'The garage could not take this request', Cancelled: 'This request was cancelled', Completed: 'Service completed'};
const statusPill = s => `<span class="status ${s.toLowerCase()}">${s}</span><div class="status-caption">${STATUS_NOTE[s]}</div>`;

/* ---------- customer: bookings ---------- */
function gate(el, title, text, btns) { el.innerHTML = `<div class="panel narrow"><h3>${title}</h3><p class="muted">${text}</p><div class="btn-row">${btns}</div></div>`; }
async function renderBookings() {
  const el = $('#bookingsBody');
  if (!me) return gate(el, 'Log in to see your bookings', 'Create a free account to request services and track them here.', '<button class="btn btn-navy" id="gateLogin">Log in</button> <button class="btn btn-outline" id="gateSignup">Create account</button>'), bindGate();
  if (me.role === 'owner') return gate(el, 'You are signed in as a garage', 'Booking requests from customers appear in your garage dashboard.', '<button class="btn btn-navy" data-go="garage">Open dashboard</button>');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const [{bookings}, {garages: saved}, {reminders}] = await Promise.all([api('/bookings'), api('/saved'), api('/reminders')]);
    const t = todayStr();
    const card = b => `<article class="booking-card"><div><h4>${esc(b.service)} · ${esc(b.garage_name)}</h4><p>${esc(b.vehicle)} · ${fmtDate(b.date)} at ${esc(b.time)}</p><p>${esc(b.mode)} · Pay at garage</p><p>⌖ ${esc(b.garage_area)} · ☎ ${esc(b.garage_phone)}</p>${b.notes ? `<p class="booking-note">Your note: ${esc(b.notes)}</p>` : ''}${b.garage_note ? `<p class="booking-note">Garage says: ${esc(b.garage_note)}</p>` : ''}${b.review ? `<p>Your review: ${'★'.repeat(b.review.rating)} ${esc(b.review.text)}</p>` : ''}</div>
      <div class="booking-actions"><div class="booking-status-wrap">${statusPill(b.status)}</div>${['Requested', 'Confirmed'].includes(b.status) ? `<button class="btn btn-outline" data-action="cancel" data-id="${b.id}">Cancel</button>` : ''}${b.status === 'Completed' && !b.review ? `<button class="btn btn-navy" data-action="review" data-id="${b.id}">Review</button>` : ''}</div></article>`;
    const up = bookings.filter(b => ['Requested', 'Confirmed'].includes(b.status) && b.date >= t).reverse(), past = bookings.filter(b => !up.includes(b));
    el.innerHTML = `<div class="dashboard-top"><div><h2>Upcoming</h2></div><button class="btn btn-navy" data-go="garages">Find a garage ↗</button></div>
      <div class="booking-list">${up.length ? up.map(card).join('') : '<div class="panel"><p class="muted">No upcoming bookings. Find a garage and send your first request.</p></div>'}</div>
      ${past.length ? `<h2 class="mt">History</h2><div class="booking-list">${past.map(card).join('')}</div>` : ''}
      <div class="saved-panel"><div class="section-heading"><div><p class="eyebrow">YOUR SHORTLIST</p><h2>Saved garages</h2></div></div><div class="saved-garage-list">${saved.length ? saved.map(g => garageCard(g, true)).join('') : '<div class="empty-shortlist">No saved garages yet. Tap the ♡ on a garage card to add it here.</div>'}</div></div>
      <div class="panel reminder-panel"><div><p class="eyebrow">DON'T MISS A CHECK-UP</p><h3>Service reminders</h3><p class="muted">Reminders are saved to your account (in-app only for now).</p></div>
      <form id="reminderForm" class="inline-form"><input required id="reminderText" maxlength="100" placeholder="e.g. Oil change" aria-label="Reminder"><input required type="date" id="reminderDate" min="${t}" aria-label="Date"><button class="btn btn-navy">Add reminder</button></form>
      <div class="reminders">${reminders.map(r => `<span class="reminder-chip ${r.date < t ? 'overdue' : ''}">◷ ${esc(r.text)} · ${fmtDate(r.date)} <button data-action="delReminder" data-id="${r.id}" aria-label="Delete reminder">×</button></span>`).join('') || '<span class="hint">No reminders yet.</span>'}</div></div>`;
    $('#reminderForm').onsubmit = async ev => { ev.preventDefault(); try { await api('/reminders', 'POST', {text: $('#reminderText').value, date: $('#reminderDate').value}); renderBookings(); } catch (er) { fail(er); } };
  } catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
function bindGate() { $('#gateLogin').onclick = () => openAuth('login'); $('#gateSignup').onclick = () => openAuth('signup', 'customer'); }
$('#reviewForm').onsubmit = async e => { e.preventDefault(); try { await api(`/bookings/${$('#reviewBookingId').value}/review`, 'POST', {rating: $('#reviewRating').value, text: $('#reviewText').value}); closeModals(); toast('Thanks for your feedback!'); renderBookings(); } catch (er) { fail(er); } };

/* ---------- account ---------- */
async function renderAccount() {
  const el = $('#accountBody');
  if (!me) return gate(el, 'Log in to manage your account', 'Save your vehicles and details to book faster.', '<button class="btn btn-navy" id="gateLogin">Log in</button> <button class="btn btn-outline" id="gateSignup">Create account</button>'), bindGate();
  let vehicles = []; if (me.role === 'customer') vehicles = (await api('/vehicles').catch(() => ({vehicles: []}))).vehicles;
  el.innerHTML = `<div class="dashboard-grid"><div class="stack-col">
    <div class="panel"><p class="eyebrow">PROFILE</p><h2>${esc(me.name)}</h2><p class="muted">${esc(me.email)} · ${me.role === 'owner' ? 'Garage owner' : 'Vehicle owner'}</p>
    <form id="profileForm" class="stack-form"><label class="field">Full name<input required id="profName" maxlength="80" value="${esc(me.name)}"></label><label class="field">Phone<input id="profPhone" type="tel" maxlength="18" value="${esc(me.phone)}" placeholder="+91 98xxxxxxxx"></label><button class="btn btn-navy">Save profile</button></form></div>
    <div class="panel"><p class="eyebrow">SECURITY</p><h3>Change password</h3><form id="pwForm" class="stack-form"><label class="field">Current password<input required type="password" id="pwCur" autocomplete="current-password"></label><label class="field">New password (8+ characters)<input required type="password" id="pwNew" minlength="8" autocomplete="new-password"></label><button class="btn btn-outline">Update password</button></form></div></div>
    <div class="stack-col">${me.role === 'customer' ? `<div class="panel"><p class="eyebrow">MY VEHICLES</p><h2>Garage at home.</h2>
      <div class="vehicle-list">${vehicles.map(v => `<div class="vehicle-row"><span><b>${esc(v.model)}</b><small>${esc(v.type)}${v.reg ? ' · ' + esc(v.reg) : ''}</small></span><button class="btn btn-quiet" data-action="delVehicle" data-id="${v.id}">Remove</button></div>`).join('') || '<p class="muted">No vehicles saved yet.</p>'}</div>
      <form id="vehicleForm" class="stack-form"><div class="two-fields"><label class="field">Type<select id="vType">${meta.vehicles.map(v => `<option>${esc(v)}</option>`).join('')}</select></label><label class="field">Model<input required id="vModel" maxlength="60" placeholder="e.g. Honda City"></label></div><label class="field">Registration no. (optional)<input id="vReg" maxlength="20" placeholder="KA01AB1234"></label><button class="btn btn-navy">Add vehicle</button></form></div>` : ''}
    <div class="panel"><button class="btn btn-outline" id="logoutBtn">Log out</button></div></div></div>`;
  $('#profileForm').onsubmit = async e => { e.preventDefault(); try { setUser((await api('/me', 'PUT', {name: $('#profName').value, phone: $('#profPhone').value})).user); toast('Profile saved.'); renderAccount(); } catch (er) { fail(er); } };
  $('#pwForm').onsubmit = async e => { e.preventDefault(); try { await api('/me/password', 'POST', {current: $('#pwCur').value, new: $('#pwNew').value}); $('#pwForm').reset(); toast('Password updated.'); } catch (er) { fail(er); } };
  $('#vehicleForm')?.addEventListener('submit', async e => { e.preventDefault(); try { await api('/vehicles', 'POST', {type: $('#vType').value, model: $('#vModel').value, reg: $('#vReg').value}); renderAccount(); } catch (er) { fail(er); } });
  $('#logoutBtn').onclick = () => $('#signupBtn').click();
}

/* ---------- garage-owner dashboard ---------- */
let ownerBookings = [];
async function renderGarageDash() {
  const el = $('#garageBody');
  if (!me) return el.innerHTML = `<div class="panel narrow"><p class="eyebrow">PARTNER WITH HEEBEN</p><h2>Get discovered by drivers nearby.</h2><p class="muted">Create a garage-owner account, list your services and prices, and receive booking requests you can accept or decline. Free during launch.</p><div class="btn-row"><button class="btn btn-navy" data-action="signupOwner">Create garage account</button><button class="btn btn-outline" id="gateLogin">Log in</button></div></div>`, $('#gateLogin').onclick = () => openAuth('login', 'owner');
  if (me.role !== 'owner') return gate(el, 'This area is for garage owners', 'You are signed in as a vehicle owner. To list a garage, log out and create a garage-owner account with a different email.', '<button class="btn btn-navy" data-go="garages">Find a garage</button>');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try { [ownerGarages, ownerBookings] = await Promise.all([api('/owner/garages').then(r => r.garages), api('/owner/bookings').then(r => r.bookings)]); } catch (e) { return el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
  const g = editingGarage, sel = new Set(g?.services.map(s => s.service)), price = Object.fromEntries((g?.services || []).map(s => [s.service, s.price])), veh = new Set(g?.vehicles || ['Car']);
  const pending = ownerBookings.filter(b => b.status === 'Requested').length, upcoming = ownerBookings.filter(b => b.status === 'Confirmed' && b.date >= todayStr()).length, done = ownerBookings.filter(b => b.status === 'Completed').length;
  el.innerHTML = `<div class="stats"><div><b>${pending}</b><small>New requests</small></div><div><b>${upcoming}</b><small>Upcoming jobs</small></div><div><b>${done}</b><small>Completed</small></div><div><b>${ownerGarages.length}</b><small>Garages listed</small></div></div>
  <div class="dashboard-grid"><div class="stack-col"><div class="panel"><p class="eyebrow">BOOKING MANAGEMENT</p><h2>Requests.</h2><div class="tabs" id="ownerTabs"></div><div id="partnerBookings" class="booking-list"></div></div></div>
  <div class="stack-col"><div class="panel"><p class="eyebrow">YOUR GARAGES</p>${ownerGarages.length ? ownerGarages.map(x => `<div class="vehicle-row"><span><b>${esc(x.name)}</b><small>${esc(x.area)} · ${x.active ? 'Live' : 'Hidden'}${x.is_sample ? ' · Sample' : ''}</small></span><span class="card-btns"><button class="btn btn-outline" data-action="editGarage" data-id="${x.id}">Edit</button><button class="btn btn-quiet" data-action="toggleGarage" data-id="${x.id}">${x.active ? 'Hide' : 'Show'}</button></span></div>`).join('') : '<p class="muted">You have not listed a garage yet. Use the form below.</p>'}</div>
  <div class="panel"><p class="eyebrow">${g ? 'EDIT GARAGE' : 'LIST A GARAGE'}</p><h2>${g ? esc(g.name) : 'Add your garage.'}</h2>
  <form id="garageForm" class="stack-form"><label class="field">Garage name<input required id="gName" maxlength="80" value="${esc(g?.name)}"></label>
  <label class="field">Area / city<input required id="gArea" maxlength="120" placeholder="e.g. Indiranagar, Bengaluru" value="${esc(g?.area)}"></label>
  <label class="field">Contact number<input required id="gPhone" type="tel" maxlength="18" value="${esc(g?.phone || me.phone)}"></label>
  <label class="field">About your garage<textarea id="gDesc" rows="3" maxlength="500">${esc(g?.description)}</textarea></label>
  <div class="field">Vehicles you service<div class="check-grid">${meta.vehicles.map(v => `<label><input type="checkbox" name="gVeh" value="${esc(v)}" ${veh.has(v) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div></div>
  <div class="field">Services &amp; starting price (₹)<span class="hint">See the <a href="#prices">Price guide</a> for typical market rates.</span><div class="svc-grid">${meta.services.map(s => `<label class="svc-row"><input type="checkbox" name="gSvc" value="${esc(s)}" ${sel.has(s) ? 'checked' : ''}> <span>${esc(s)}${SERVICE_HINTS[s] ? `<small class="svc-hint">${esc(SERVICE_HINTS[s])}</small>` : ''}</span><input type="number" min="1" max="1000000" step="1" data-price="${esc(s)}" value="${price[s] || ''}" placeholder="e.g. 2500" aria-label="Price for ${esc(s)}"></label>`).join('')}</div></div>
  <div class="two-fields"><label class="field">Bookings per time slot<input id="gCap" type="number" min="1" max="20" value="${g?.capacity || 2}"></label><div class="field">Map location (for “nearest”)<button type="button" class="btn btn-outline" data-action="useGarageLoc">${g?.lat != null ? '✓ Location set — update' : '⌖ Use my current location'}</button></div></div>
  <input type="hidden" id="gLat" value="${g?.lat ?? ''}"><input type="hidden" id="gLng" value="${g?.lng ?? ''}">
  <div class="btn-row"><button class="btn btn-navy">${g ? 'Save changes' : 'List my garage'}</button>${g ? '<button type="button" class="btn btn-quiet" data-action="newGarage">Cancel</button>' : ''}</div><p class="hint form-msg" id="garageMsg" role="alert"></p></form></div></div></div>`;
  renderOwnerBookings();
  $('#garageForm').onsubmit = async e => {
    e.preventDefault(); const msg = $('#garageMsg'); msg.textContent = '';
    const services = $$('input[name=gSvc]:checked').map(c => ({service: c.value, price: $(`[data-price="${CSS.escape(c.value)}"]`).value}));
    const body = {name: $('#gName').value, area: $('#gArea').value, phone: $('#gPhone').value, description: $('#gDesc').value, vehicles: $$('input[name=gVeh]:checked').map(c => c.value), services, capacity: $('#gCap').value, lat: $('#gLat').value, lng: $('#gLng').value};
    try { if (g) await api('/garages/' + g.id, 'PUT', body); else await api('/garages', 'POST', body); editingGarage = null; toast(g ? 'Garage updated.' : 'Your garage is live!'); renderGarageDash(); } catch (er) { msg.textContent = er.message; }
  };
}
function renderOwnerBookings() {
  const t = todayStr(), tabs = {pending: ['New', b => b.status === 'Requested'], upcoming: ['Upcoming', b => b.status === 'Confirmed'], all: ['All', () => true]};
  $('#ownerTabs').innerHTML = Object.entries(tabs).map(([k, [l, f]]) => `<button class="tab ${ownerTab === k ? 'active' : ''}" data-action="ownerTab" data-tab="${k}">${l} (${ownerBookings.filter(f).length})</button>`).join('');
  const list = ownerBookings.filter(tabs[ownerTab][1]); if (ownerTab !== 'all') list.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
  $('#partnerBookings').innerHTML = list.length ? list.map(b => `<article class="booking-card"><div><h4>${esc(b.service)}</h4><p><b>${esc(b.garage_name)}</b> · ${fmtDate(b.date)} at ${esc(b.time)}</p><p>${esc(b.vehicle)} · ${esc(b.mode)}</p><p>👤 ${esc(b.customer.name)} · ☎ <a href="tel:${esc(b.customer.phone)}">${esc(b.customer.phone || 'no phone')}</a></p>${b.notes ? `<p class="booking-note">Customer note: ${esc(b.notes)}</p>` : ''}${b.garage_note ? `<p class="booking-note">Your note: ${esc(b.garage_note)}</p>` : ''}</div>
    <div class="booking-actions"><div class="booking-status-wrap">${statusPill(b.status)}</div>${b.status === 'Requested' ? `<button class="btn btn-navy" data-action="respond" data-status="Confirmed" data-id="${b.id}">Accept</button><button class="btn btn-outline" data-action="respond" data-status="Rejected" data-id="${b.id}">Decline</button>` : ''}${b.status === 'Confirmed' ? `<button class="btn btn-navy" data-action="respond" data-status="Completed" data-id="${b.id}">Mark completed</button><button class="btn btn-outline" data-action="respond" data-status="Rejected" data-id="${b.id}">Cancel</button>` : ''}</div></article>`).join('') : '<p class="muted">Nothing here yet.</p>';
}
$('#noteForm').onsubmit = async e => { e.preventDefault(); try { await api(`/bookings/${$('#noteBookingId').value}/status`, 'POST', {status: $('#noteStatus').value, note: $('#noteText').value}); closeModals(); toast('Updated.'); renderGarageDash(); } catch (er) { fail(er); } };

/* ---------- contact ---------- */
$('#contactForm').onsubmit = async e => { e.preventDefault(); try { await api('/contact', 'POST', {name: $('#contactName').value, email: $('#contactEmail').value, message: $('#contactMessage').value}); $('#contactForm').reset(); toast('Thanks! We\'ll get back to you.'); } catch (er) { fail(er); } };

/* ---------- boot ---------- */
(async function init() {
  try { meta = await api('/meta'); } catch { meta = FALLBACK_META; }
  $('#garageService').insertAdjacentHTML('beforeend', meta.services.map(s => `<option>${esc(s)}</option>`).join(''));
  $('#garageVehicle').insertAdjacentHTML('beforeend', meta.vehicles.map(s => `<option>${esc(s)}</option>`).join(''));
  try { setUser((await api('/me')).user); } catch { setUser(null); }
  show(location.hash.slice(1) || 'home');
})();
