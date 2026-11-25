'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = n => '₹' + Number(n).toLocaleString('en-IN');
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', {weekday:'short', day:'numeric', month:'short', year:'numeric'});
const todayStr = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

let me = null, meta = {services: [], vehicles: [], slots: [], modes: []};
let userCoords = null, homeVehicle = 'Car', garageCache = {}, myVehicles = [], bookingCtx = null, ownerGarages = [], editingGarage = null, ownerTab = 'pending';
const CITY_OPTIONS = ['Bengaluru','Mumbai','Delhi','New Delhi','Hyderabad','Chennai','Pune','Kolkata','Ahmedabad','Jaipur','Kochi','Thiruvananthapuram','Coimbatore','Mysuru','Mangaluru','Bhubaneswar','Indore','Bhopal','Nagpur','Surat','Vadodara','Lucknow','Chandigarh','Gurugram','Noida','Bhilai','Channarayapatna','Other'];
let selectedCity = 'Bengaluru';
function initCitySelectors() {
  try { selectedCity = localStorage.getItem('heeben-city') || 'Bengaluru'; } catch {}
  ['homeCity','mapCity'].forEach(id => { const el = $('#' + id); if (!el) return; el.innerHTML = CITY_OPTIONS.map(c => `<option value="${esc(c)}">${esc(c === 'Other' ? 'Other city / enter manually' : c)}</option>`).join(''); el.value = CITY_OPTIONS.includes(selectedCity) ? selectedCity : 'Other'; });
}
function setSelectedCity(city, sourceId) {
  selectedCity = city || 'Bengaluru'; try { localStorage.setItem('heeben-city', selectedCity); } catch {}
  ['homeCity','mapCity'].forEach(id => { const el = $('#' + id); if (el && id !== sourceId) el.value = CITY_OPTIONS.includes(selectedCity) ? selectedCity : 'Other'; });
}
function locationQuery(area) {
  const city = selectedCity === 'Other' ? '' : selectedCity;
  const clean = (area || '').trim();
  if (!clean) return city;
  if (!city || clean.toLowerCase().includes(city.toLowerCase())) return clean;
  return `${clean}, ${city}, India`;
}
initCitySelectors();
const VIEWS = ['home','services','cart','extras','garages','dashboard','assistant','bookings','account','garage','how','contact','legal','founder'];

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
  ({home: renderHome, services: renderServices, cart: renderCart, garages: loadGarages, dashboard: renderCustomerDashboard, assistant: renderAssistant, bookings: renderBookings, account: renderAccount, garage: renderGarageDash}[view] || (() => {}))();
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
  // Keep these navigation entries mounted for every visitor. Logged-out users
  // can open the pages and receive the sign-in prompt instead of seeing the
  // links flash briefly and then disappear after the session check.
  $('#navDashboard').style.display = '';
  $('#navAssistant').style.display = '';
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
  const add = t.closest('[data-cart-add]'); if (add) { addToCart(add.dataset.cartAdd); return; }
  const remove = t.closest('[data-cart-remove]'); if (remove) { removeFromCart(remove.dataset.cartRemove); return; }
  if (t.closest('[data-cart-clear]')) { cart = []; saveCart(); renderCart(); toast('Cart cleared.'); return; }
  if (t.closest('[data-cart-checkout]')) { if (!cart.length) return; $('#garageService').value = cart[0].name; toast(cart.length > 1 ? 'Choose a garage for the first service. You can request other services separately.' : 'Choose a garage for this service.'); return go('garages'); }
  const sv = t.closest('[data-service]'); if (sv) { $('#garageService').value = sv.dataset.service; return go('garages'); }
  const ex = t.closest('[data-extra]'); if (ex) { const topic = ex.dataset.extra; go('contact'); $('#contactMessage').value = `I'm interested in: ${topic}.\nCity / area: \nVehicle type and model: \nDetails: `; $('#contactName').focus(); return; }
  const a = t.closest('[data-action]'); if (a) actions[a.dataset.action]?.(a, e);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModals(); });
$('#mobileMenu').onclick = () => { const n = $('#mainNav'); const o = n.classList.toggle('open'); $('#mobileMenu').setAttribute('aria-expanded', o); };

const actions = {
  redeemReward: b => { const pts=Number(b.dataset.points); const offer={100:50,200:120,500:350}[pts]; if(!offer||!confirm(`Redeem ${pts} points for a ₹${offer} service discount voucher?`)) return; guard(b,async()=>{const v=await api('/rewards/redeem','POST',{points:pts});toast(`Voucher created: ${v.code}`);renderCustomerDashboard();}); },
  copyReward: b => { navigator.clipboard?.writeText(b.dataset.code).then(()=>toast('Voucher code copied.')).catch(()=>toast('Voucher code: '+b.dataset.code)); },
  save: async b => { if (!requireLogin('customer', () => actions.save(b))) return; if (me.role !== 'customer') return toast('Saving garages is for customer accounts.');
    const r = await api('/garages/' + b.dataset.id + '/save', 'POST', {}).catch(fail); if (!r) return; toast(r.saved ? 'Saved to your shortlist.' : 'Removed from your shortlist.'); refreshCurrent(); },
  viewGarage: b => openGarageDetail(b.dataset.id),
  book: b => openBooking(b.dataset.id, b.dataset.svc),
  cancel: b => { if (confirm('Cancel this booking request?')) guard(b, async () => { await api(`/bookings/${b.dataset.id}/cancel`, 'POST', {}); toast('Booking cancelled.'); renderBookings(); }); },
  review: b => { $('#reviewBookingId').value = b.dataset.id; $('#reviewText').value = ''; openModal('reviewModal'); },
  quote: b => { $('#quoteBookingId').value = b.dataset.id; $('#quoteAmount').value = ''; $('#quoteNote').value = ''; $('#quoteHealth').value = ''; openModal('quoteModal'); },
  quoteDecision: b => guard(b, async () => { await api(`/bookings/${b.dataset.id}/quote-response`, 'POST', {decision: b.dataset.decision}); toast('Your response was sent to the garage.'); renderBookings(); }),
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
    $('#garageCount').textContent = list.length ? `${list.length} Heeben garage${list.length > 1 ? 's' : ''} found` : '';
    grid.innerHTML = list.length ? list.map(g => garageCard(g)).join('') : `<div class="empty-shortlist">${userCoords && $('#garageRadius').value ? `No garages within ${$('#garageRadius').value} km. Try a larger distance.` : 'No garages match your filters yet. Try clearing the search or choosing a different service.'}</div>`;
    renderGarageMap(list);
  } catch (e) { grid.innerHTML = `<p class="muted">${esc(e.message)} <button class="btn btn-outline" data-action="retry">Retry</button></p>`; }
}
/* ---------- nearby garage map ---------- */
let garageMap = null, garageMapLayer = null, mapRequest = 0, externalGarageCache = [];
function pinIcon(kind) {
  return L.divIcon({className:'', html:`<div class="heeben-pin ${kind}"><span>${kind === 'partner' ? 'H' : 'G'}</span></div>`, iconSize:[30,30], iconAnchor:[15,29], popupAnchor:[0,-27]});
}
function mapDirections(lat,lng,name,area) {
  if (Number.isFinite(lat) && Number.isFinite(lng)) return `https://www.google.com/maps/dir/?api=1${userCoords ? `&origin=${userCoords.lat},${userCoords.lng}` : ''}&destination=${lat},${lng}&travelmode=driving`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent((name || 'Garage') + ', ' + (area || ''))}`;
}
function ensureGarageMap() {
  if (!window.L || !$('#garageMap')) { $('#mapStatus').textContent = 'Map library could not load. Please refresh the page.'; return false; }
  if (!garageMap) {
    garageMap = L.map('garageMap', {scrollWheelZoom:false}).setView(userCoords ? [userCoords.lat,userCoords.lng] : [12.9716,77.5946], userCoords ? 13 : 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(garageMap);
    garageMapLayer = L.featureGroup().addTo(garageMap);
  }
  setTimeout(() => garageMap.invalidateSize(), 120);
  return true;
}
function safePopup(g, kind) {
  const name = esc(g.name || 'Nearby garage'), area = esc(g.area || g.address || '');
  const distance = g.distance_km != null ? `${g.distance_km} km away` : (kind === 'partner' ? 'Heeben-listed garage' : 'Nearby independent garage');
  const directions = mapDirections(g.lat == null ? NaN : Number(g.lat), g.lng == null ? NaN : Number(g.lng), g.name, g.area || g.address);
  const partnerLabel = kind === 'partner' ? '<div class="map-popup-meta">Heeben partner</div>' : '';
  const phone = String(g.phone || '').trim();
  const phoneLink = phone ? `<a class="secondary" href="tel:${esc(phone).replace(/[^+0-9]/g, '')}">Call ${esc(phone)} ☎</a>` : '<span class="map-popup-meta">Phone number not listed</span>';
  return `<div class="map-popup-title">${name}</div><div class="map-popup-meta">${area} · ${distance}</div>${partnerLabel}<div class="map-popup-actions"><a href="${directions}" target="_blank" rel="noopener">Get directions ↗</a>${phoneLink}</div>`;
}
async function fetchNearbyOSMGarages(center) {
  const radiusKm = Math.min(25, Math.max(1, Number($('#garageRadius')?.value || 10)));
  const radius = radiusKm * 1000;
  const query = `[out:json][timeout:25];
(
  nwr(around:${radius},${center.lat},${center.lng})["shop"~"^(car_repair|motorcycle_repair|motorcycle|tyres|tyres_and_batteries)$"];
  nwr(around:${radius},${center.lat},${center.lng})["craft"~"^(mechanic|car_repair)$"];
  nwr(around:${radius},${center.lat},${center.lng})["amenity"~"^(car_repair|vehicle_inspection|car_wash)$"];
  nwr(around:${radius},${center.lat},${center.lng})["service:vehicle:car"="yes"];
  nwr(around:${radius},${center.lat},${center.lng})["service:vehicle:motorcycle"="yes"];
);
out center tags;`;
  const endpoints = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass-api.de/api/interpreter'
  ];
  let lastError = null, data = null;
  for (const endpoint of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 28000);
    try {
      const response = await fetch(endpoint + '?data=' + encodeURIComponent(query), {
        method: 'GET',
        signal: controller.signal,
        headers: {'Accept':'application/json'}
      });
      if (!response.ok) throw new Error('Map data server returned HTTP ' + response.status);
      data = await response.json();
      break;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!data) throw new Error(lastError?.message || 'Nearby garage data is temporarily unavailable');
  const seen = new Set();
  return (data.elements || []).map(el => {
    const lat = Number(el.lat ?? el.center?.lat), lng = Number(el.lon ?? el.center?.lon), tags = el.tags || {};
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const name = tags.name || tags.brand || tags.operator || 'Independent vehicle repair shop';
    const key = `${name.toLowerCase()}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    return {
      name, lat, lng,
      area: [tags['addr:suburb'], tags['addr:city'], tags['addr:street']].filter(Boolean).join(', ') || 'Nearby area',
      phone: tags.phone || tags['contact:phone'] || tags['contact:mobile'] || tags.mobile || '',
      distance_km: Math.round(distanceKm(center.lat, center.lng, lat, lng) * 10) / 10
    };
  }).filter(Boolean).sort((a,b)=>a.distance_km-b.distance_km);
}
function distanceKm(a,b,c,d) { const rad=x=>x*Math.PI/180, dLat=rad(c-a), dLng=rad(d-b), h=Math.sin(dLat/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(dLng/2)**2; return 6371*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)); }
async function renderGarageMap(partners=[]) {
  if (!ensureGarageMap()) return;
  const req = ++mapRequest; garageMapLayer.clearLayers();
  const points = [];
  if (userCoords) {
    const you = L.circleMarker([userCoords.lat,userCoords.lng], {radius:8,color:'#fff',weight:3,fillColor:'#2787db',fillOpacity:1}).bindPopup(`<b>${coordsSource === 'gps' ? 'Your current location' : 'Searched location'}</b>`).addTo(garageMapLayer); points.push(you);
    $('#mapStatus').textContent = `Searching within ${$('#garageRadius')?.value || 10} km of ${coordsSource === 'gps' ? 'your location' : 'the selected area'}…`;
    garageMap.setView([userCoords.lat,userCoords.lng],13);
    try {
      externalGarageCache = await fetchNearbyOSMGarages(userCoords);
    } catch (e) {
      externalGarageCache = [];
      if (req === mapRequest) $('#mapStatus').textContent = 'Nearby garage data could not be reached right now. Please try again in a moment. ' + (e?.message || '');
    }
  } else {
    $('#mapStatus').textContent = 'Enter any area, city or PIN code above, or use your current location.';
    externalGarageCache = [];
  }
  if (req !== mapRequest) return;
  const lookupFailed = !!($('#mapStatus')?.textContent.includes('could not be reached'));
  partners.filter(g=>g.lat!=null && g.lng!=null).forEach(g=>{
    const m=L.marker([Number(g.lat),Number(g.lng)],{icon:pinIcon('partner')}).bindPopup(safePopup(g,'partner')).addTo(garageMapLayer); points.push(m);
  });
  externalGarageCache.forEach(g=>{
    const m=L.marker([g.lat,g.lng],{icon:pinIcon('nearby')}).bindPopup(safePopup(g,'nearby')).addTo(garageMapLayer); points.push(m);
  });
  const externalCount=externalGarageCache.length, partnerCount=partners.filter(g=>g.lat!=null&&g.lng!=null).length;
  if (userCoords && !lookupFailed) $('#mapStatus').textContent = `${partnerCount} mapped Heeben partner${partnerCount===1?'':'s'} and ${externalCount} nearby independent garage${externalCount===1?'':'s'} within the selected search area. ${coordsSource === 'gps' ? 'Based on your current location.' : 'Based on your searched location.'} Select a pin for directions.`;
  else if (partnerCount) $('#mapStatus').textContent = `${partnerCount} Heeben partner locations mapped. Search any area to discover more garages.`;
  const links = $('#nearbyGarageLinks');
  if (links) {
    const allMapped = [
      ...partners.filter(g=>g.lat!=null && g.lng!=null).map(g=>({...g, _kind:'partner'})),
      ...externalGarageCache.map(g=>({...g, _kind:'nearby'}))
    ];
    links.innerHTML = allMapped.length ? `<h3 class="map-list-title">Nearby garages (${allMapped.length})</h3>${allMapped.map(g=>{
      const phone = String(g.phone || '').trim(), tel = phone.replace(/[^+0-9]/g, '');
      const distance = g.distance_km != null ? ` · ${g.distance_km} km` : '';
      return `<div class="nearby-garage-row"><span><b>${esc(g.name)}</b><small>${esc(g.area || g.address || 'Nearby area')}${distance}${g._kind === 'partner' ? ' · Heeben partner' : ''}</small>${phone ? `<small>☎ <a href="tel:${esc(tel)}">${esc(phone)}</a></small>` : '<small>Phone number not listed</small>'}</span><span class="map-row-actions"><a href="${mapDirections(g.lat,g.lng,g.name,g.area || g.address)}" target="_blank" rel="noopener">Directions ↗</a>${phone ? `<a href="tel:${esc(tel)}">Call ↗</a>` : ''}</span></div>`;
    }).join('')}` : '<p class="hint">No garage locations were found in this search area. Try increasing the search radius.</p>';
  }
  if (points.length > 1) garageMap.fitBounds(L.featureGroup(points).getBounds().pad(.16),{maxZoom:15});
  else if (points.length === 1) garageMap.setView(points[0].getLatLng(),14);
}
async function searchGaragesAtEnteredLocation() {
  const input = $('#mapLocationSearch'), button = $('#mapLocationSearchBtn'), area = input?.value.trim(), query = locationQuery(area);
  if (!query) { $('#mapStatus').textContent = 'Enter a city, locality or PIN code to search.'; input?.focus(); return; }
  button.disabled = true; $('#mapStatus').textContent = `Finding ${query}…`;
  try {
    const point = await geocodeArea(query);
    if (!point) { $('#mapStatus').textContent = `Could not find “${query}”. Try a nearby locality, city or PIN code.`; return; }
    userCoords = point; coordsSource = 'area'; gpsArea = query; if (!$('#garageRadius').value) $('#garageRadius').value = '10'; saveCoords();
    $('#garageSearch').value = ''; $('#garageSort').value = 'distance';
    $('#nearStatus').textContent = `Distances are measured from ${query}.`; $('#mapStatus').textContent = `Showing garages around ${query}.`;
    await loadGarages();
    if (garageMap) garageMap.setView([point.lat, point.lng], 13);
  } finally { button.disabled = false; }
}
$('#homeCity')?.addEventListener('change', e => { setSelectedCity(e.target.value, 'homeCity'); if (e.target.value !== 'Other') { $('#homeLocation').value = ''; $('#gpsStatus').textContent = `City selected: ${e.target.value}. Add an area for a more precise search, or find garages across the city.`; } else { $('#gpsStatus').textContent = 'Enter your city and area in the location field below.'; $('#homeLocation').focus(); } });
$('#mapCity')?.addEventListener('change', e => { setSelectedCity(e.target.value, 'mapCity'); if (e.target.value !== 'Other') { $('#mapLocationSearch').value = ''; $('#mapStatus').textContent = `Selected ${e.target.value}. Search to explore garages across this city, or enter a specific area.`; } else { $('#mapStatus').textContent = 'Enter a city or area in the search field.'; $('#mapLocationSearch').focus(); } });
$('#mapLocationSearchBtn')?.addEventListener('click', searchGaragesAtEnteredLocation);
$('#mapLocationSearch')?.addEventListener('keydown', e => { if (e.key === 'Enter') searchGaragesAtEnteredLocation(); });
$('#mapLocateBtn')?.addEventListener('click', async e=>{const b=e.currentTarget;b.disabled=true;const c=await locateMe(m=>$('#mapStatus').textContent=m);b.disabled=false;if(c){$('#garageSort').value='distance';await loadGarages();}});

let debounce; ['garageSearch'].forEach(i => $('#' + i).addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(loadGarages, 250); }));
['garageService', 'garageVehicle', 'garageSort'].forEach(i => $('#' + i).addEventListener('change', loadGarages));

async function renderHome() {
  const el = $('#featuredGarages');
  try { const list = await fetchGarages({sort: 'rating'}); el.innerHTML = list.slice(0, 3).map(g => garageCard(g, true)).join('') || '<p class="muted">Garages will appear here soon.</p>'; } catch { el.innerHTML = ''; }
}
const SERVICE_GROUPS_UI = {
  'General car servicing': ['General service','Basic service','Comprehensive service','Engine oil & filter change','Air filter replacement','Coolant replacement','Periodic inspection','Routine servicing'],
  'Engine & transmission': ['Engine diagnostics & repair','Clutch repair','Gearbox / transmission repair','Radiator & cooling system repair','Exhaust system repair','Mechanical repairs'],
  'Brakes & suspension': ['Brake repair','Brake pad / shoe replacement','Suspension & steering repair','Bike brake service'],
  'Denting & painting': ['Denting & painting','Scratch removal & paint touch-up','Bumper repair / replacement','Machine polishing','Ceramic coating'],
  'Batteries': ['Battery check & replacement','Tyres & batteries'],
  'Tyres & wheels': ['Tyre replacement','Puncture repair','Wheel alignment & balancing'],
  'AC & cooling': ['AC inspection & service','AC gas refill','AC repair'],
  'Electrical & EV services': ['Electrical diagnostics','Wiring & lighting repair','EV diagnostics & battery health check','EV charger inspection','Electrical & EV care'],
  'Cleaning & detailing': ['Exterior wash','Interior deep cleaning','Full car/bike detailing','Cleaning & detailing'],
  'Glass & lights': ['Windshield / glass replacement','Headlight / tail-light replacement'],
  'Inspection & diagnostics': ['Pre-purchase vehicle inspection','Engine scanning / OBD diagnostics','Full vehicle health inspection','Pre-trip safety inspection'],
  'Two-wheeler services': ['Chain cleaning & lubrication','Chain / sprocket replacement','Scooter belt / CVT service','Bike clutch & cable repair']
};
const SERVICE_DESCRIPTIONS = {
  'General service':'Routine checks and maintenance for everyday reliability.', 'Basic service':'Essential oil, filter and safety checks.', 'Comprehensive service':'Detailed scheduled maintenance and multi-point inspection.',
  'Engine oil & filter change':'Drain and replace engine oil and oil filter.', 'Air filter replacement':'Inspect and replace a clogged air filter.', 'Coolant replacement':'Flush and refill the engine cooling system.', 'Periodic inspection':'Multi-point inspection of key vehicle systems.',
  'Engine diagnostics & repair':'Identify engine faults and repair after inspection.', 'Clutch repair':'Clutch inspection, adjustment and repair.', 'Gearbox / transmission repair':'Transmission diagnosis and repair.', 'Suspension & steering repair':'Shocks, struts, steering and related components.', 'Brake repair':'Brake inspection, repair and fluid checks.', 'Brake pad / shoe replacement':'Replace worn brake pads or shoes.', 'Radiator & cooling system repair':'Cooling-system leak and radiator work.', 'Exhaust system repair':'Inspect and repair exhaust components.',
  'AC inspection & service':'Cooling performance check and AC system inspection.', 'AC gas refill':'AC refrigerant top-up after leak checks.', 'AC repair':'AC compressor, condenser and cooling repairs.',
  'Tyre replacement':'Supply and fit replacement tyres.', 'Puncture repair':'Repair punctures where safe and suitable.', 'Wheel alignment & balancing':'Correct wheel angles and balance wheels.', 'Battery check & replacement':'Battery health test and replacement.',
  'Electrical diagnostics':'Trace electrical faults and warning lights.', 'Wiring & lighting repair':'Repair wiring, lamps and electrical connections.', 'EV diagnostics & battery health check':'EV system scan and battery health assessment.', 'EV charger inspection':'Inspect onboard charging and charging connections.',
  'Exterior wash':'Exterior wash and basic finish.', 'Interior deep cleaning':'Deep clean seats, carpets and cabin surfaces.', 'Full car/bike detailing':'Detailed interior and exterior cleaning.', 'Machine polishing':'Machine polish to improve paint finish.', 'Ceramic coating':'Protective coating; final quote after paint assessment.',
  'Denting & painting':'Repair dents and refinish damaged body panels.', 'Scratch removal & paint touch-up':'Treat minor scratches and touch up affected paint.', 'Bumper repair / replacement':'Repair or replace damaged bumpers.', 'Windshield / glass replacement':'Replace damaged vehicle glass after inspection.', 'Headlight / tail-light replacement':'Replace damaged lamps and restore safe visibility.', 'Pre-purchase vehicle inspection':'Inspect a used vehicle before you buy it.', 'Engine scanning / OBD diagnostics':'Scan vehicle systems for stored fault codes.', 'Full vehicle health inspection':'Check major mechanical, electrical and safety systems.', 'Pre-trip safety inspection':'Check key safety items before a long journey.',
  'Chain cleaning & lubrication':'Clean, adjust and lubricate motorcycle chain.', 'Chain / sprocket replacement':'Replace worn chain and sprocket set.', 'Bike brake service':'Inspect and service two-wheeler brakes.', 'Scooter belt / CVT service':'Inspect scooter drive belt and CVT assembly.', 'Bike clutch & cable repair':'Adjust or replace clutch cable and related parts.'
};
const SERVICE_GROUP_ICONS = {
  'General car servicing':'🔧','Engine & transmission':'⚙️','Brakes & suspension':'🛞','Denting & painting':'🎨',
  'Batteries':'🔋','Tyres & wheels':'🚗','AC & cooling':'❄️','Electrical & EV services':'⚡',
  'Cleaning & detailing':'✨','Glass & lights':'💡','Inspection & diagnostics':'🔍','Two-wheeler services':'🏍️'
};
function groupedServices(services) {
  const remaining = new Set(services);
  return Object.entries(SERVICE_GROUPS_UI).map(([group, names]) => ({group, items:names.filter(n => remaining.has(n))})).filter(g => g.items.length);
}
const SERVICE_ESTIMATES = {
  'General service':['₹2,500–₹9,000','2–4 hours','Car'], 'Basic service':['₹1,500–₹4,000','1.5–3 hours','Car'], 'Comprehensive service':['₹5,000–₹15,000+','4–8 hours','Car'],
  'Engine oil & filter change':['₹1,200–₹4,500','45–90 min','Car & 2W'], 'Air filter replacement':['₹300–₹1,500','20–45 min','Car & 2W'], 'Coolant replacement':['₹800–₹2,500','1–2 hours','Car'], 'Periodic inspection':['₹500–₹1,500','30–60 min','Car & 2W'], 'Routine servicing':['₹1,500–₹9,000','1.5–4 hours','Car & 2W'],
  'Engine diagnostics & repair':['₹500–₹2,000 for diagnosis; repairs extra','1–3 hours+','Car & 2W'], 'Clutch repair':['₹3,000–₹12,000','4–8 hours','Car'], 'Gearbox / transmission repair':['₹3,000–₹25,000+','1–3 days','Car'], 'Suspension & steering repair':['₹1,500–₹12,000+','2–6 hours','Car'], 'Brake repair':['₹800–₹5,000','1–3 hours','Car & 2W'], 'Brake pad / shoe replacement':['₹1,000–₹4,500','1–2 hours','Car'], 'Radiator & cooling system repair':['₹1,000–₹8,000+','2–5 hours','Car'], 'Exhaust system repair':['₹800–₹6,000+','1–3 hours','Car'], 'Mechanical repairs':['Quote after inspection','Varies by repair','Car & 2W'],
  'AC inspection & service':['₹500–₹1,500','45–90 min','Car'], 'AC gas refill':['₹1,800–₹3,500','1–2 hours','Car'], 'AC repair':['₹1,500–₹15,000+','2–8 hours','Car'],
  'Tyre replacement':['₹1,500–₹16,500+ per tyre','30–60 min','Car & 2W'], 'Puncture repair':['₹100–₹500','20–45 min','Car & 2W'], 'Wheel alignment & balancing':['₹400–₹1,500','30–60 min','Car'], 'Battery check & replacement':['₹4,000–₹17,500+','30–60 min','Car & 2W'], 'Tyres & batteries':['Varies by tyre / battery','30–60 min','Car & 2W'],
  'Electrical diagnostics':['₹500–₹2,000 diagnosis','1–3 hours','Car & 2W'], 'Wiring & lighting repair':['₹300–₹4,000+','30 min–3 hours','Car & 2W'], 'EV diagnostics & battery health check':['₹800–₹3,500','1–2 hours','EV'], 'EV charger inspection':['₹500–₹2,000','30–90 min','EV'], 'Electrical & EV care':['Quote after inspection','Varies by issue','Car & 2W / EV'],
  'Exterior wash':['₹200–₹800','20–45 min','Car & 2W'], 'Interior deep cleaning':['₹1,500–₹8,000','3–6 hours','Car'], 'Full car/bike detailing':['₹1,000–₹15,000+','3–8 hours','Car & 2W'], 'Machine polishing':['₹2,000–₹8,000','3–6 hours','Car'], 'Ceramic coating':['₹12,000–₹40,000+','1–3 days','Car'], 'Cleaning & detailing':['₹200–₹40,000+','20 min–3 days','Car & 2W'],
  'Denting & painting':['Quote after inspection','1–5 days','Car'], 'Scratch removal & paint touch-up':['₹800–₹5,000+','2–6 hours','Car'], 'Bumper repair / replacement':['Quote after inspection','4 hours–2 days','Car'], 'Windshield / glass replacement':['Quote after inspection','2–4 hours','Car'], 'Headlight / tail-light replacement':['₹500–₹12,000+','30 min–2 hours','Car & 2W'], 'Pre-purchase vehicle inspection':['₹800–₹3,000','1–2 hours','Car & 2W'], 'Engine scanning / OBD diagnostics':['₹500–₹2,000','30–90 min','Car & 2W'], 'Full vehicle health inspection':['₹500–₹2,500','45–120 min','Car & 2W'], 'Pre-trip safety inspection':['₹300–₹1,500','30–60 min','Car & 2W'],
  'Chain cleaning & lubrication':['₹150–₹500','20–40 min','2W'], 'Chain / sprocket replacement':['₹800–₹3,500','1–2 hours','2W'], 'Bike brake service':['₹300–₹1,500','30–90 min','2W'], 'Scooter belt / CVT service':['₹800–₹3,500','1–2 hours','2W'], 'Bike clutch & cable repair':['₹300–₹2,500','30–120 min','2W']
};
const CAR_CATALOG = {
  'Maruti Suzuki': {'Alto K10':'hatchback','S-Presso':'hatchback','Celerio':'hatchback','Wagon R':'hatchback','Swift':'hatchback','Ignis':'hatchback','Baleno':'hatchback','Dzire':'sedan','Ciaz':'sedan','Brezza':'compact-suv','Fronx':'compact-suv','Grand Vitara':'suv','Jimny':'suv','Ertiga':'mpv','XL6':'mpv','Invicto':'premium'},
  'Hyundai': {'Grand i10 Nios':'hatchback','i20':'hatchback','Aura':'sedan','Verna':'sedan','Venue':'compact-suv','Venue N Line':'compact-suv','Creta':'suv','Alcazar':'suv','Exter':'compact-suv','Tucson':'premium','Ioniq 5':'premium'},
  'Tata': {'Tiago':'hatchback','Tigor':'sedan','Altroz':'hatchback','Punch':'compact-suv','Nexon':'compact-suv','Curvv':'suv','Harrier':'suv','Safari':'suv','Tiago EV':'hatchback','Tigor EV':'sedan','Nexon EV':'compact-suv','Punch EV':'compact-suv'},
  'Mahindra': {'Bolero':'suv','Bolero Neo':'suv','Thar':'suv','Thar Roxx':'suv','XUV 3XO':'compact-suv','Scorpio Classic':'suv','Scorpio N':'suv','XUV700':'suv','XUV400 EV':'compact-suv','BE 6':'premium','XEV 9e':'premium'},
  'Kia': {'Sonet':'compact-suv','Seltos':'suv','Carens':'mpv','Carnival':'premium','EV6':'premium','EV9':'premium'},
  'Toyota': {'Glanza':'hatchback','Taisor':'compact-suv','Urban Cruiser Hyryder':'suv','Rumion':'mpv','Innova Crysta':'mpv','Innova Hycross':'mpv','Fortuner':'premium','Camry':'premium','Hilux':'premium','Vellfire':'luxury'},
  'Honda': {'Amaze':'sedan','City':'sedan','Elevate':'suv'},
  'Renault': {'Kwid':'hatchback','Triber':'mpv','Kiger':'compact-suv'},
  'Nissan': {'Magnite':'compact-suv','X-Trail':'premium'},
  'Skoda': {'Kylaq':'compact-suv','Kushaq':'suv','Slavia':'sedan','Kodiaq':'premium','Superb':'premium'},
  'Volkswagen': {'Taigun':'suv','Virtus':'sedan','Tiguan':'premium'},
  'MG': {'Comet EV':'hatchback','Windsor EV':'compact-suv','Astor':'suv','Hector':'suv','Hector Plus':'suv','Gloster':'premium','ZS EV':'suv','Cyberster':'luxury'},
  'Jeep': {'Compass':'premium','Meridian':'premium','Wrangler':'luxury','Grand Cherokee':'luxury'},
  'Citroën': {'C3':'hatchback','C3 Aircross':'suv','Basalt':'suv','eC3':'hatchback'},
  'BYD': {'Atto 3':'premium','eMAX 7':'premium','Seal':'luxury','Sealion 7':'luxury'},
  'BMW': {'2 Series Gran Coupe':'luxury','3 Series':'luxury','5 Series':'luxury','X1':'luxury','X3':'luxury','X5':'luxury','iX1':'luxury','i4':'luxury','i7':'luxury'},
  'Mercedes-Benz': {'A-Class Limousine':'luxury','C-Class':'luxury','E-Class':'luxury','GLA':'luxury','GLC':'luxury','GLE':'luxury','GLS':'luxury','EQS':'luxury'},
  'Audi': {'A4':'luxury','A6':'luxury','Q3':'luxury','Q5':'luxury','Q7':'luxury','Q8':'luxury','e-tron':'luxury'},
  'Volvo': {'EX30':'luxury','XC40':'luxury','XC60':'luxury','XC90':'luxury','C40 Recharge':'luxury'},
  'Lexus': {'ES':'luxury','NX':'luxury','RX':'luxury','LM':'luxury'},
  'Land Rover': {'Defender':'luxury','Discovery Sport':'luxury','Range Rover Evoque':'luxury','Range Rover Velar':'luxury','Range Rover Sport':'luxury','Range Rover':'luxury'},
  'Isuzu': {'D-Max V-Cross':'premium','MU-X':'premium'},
  'Force Motors': {'Gurkha':'premium','Trax Cruiser':'premium'},
  'MINI': {'Cooper S':'luxury','Countryman':'luxury'},
  'Porsche': {'Macan':'luxury','Cayenne':'luxury','Panamera':'luxury','911':'luxury','Taycan':'luxury'},
  'Jaguar': {'F-Pace':'luxury','F-Type':'luxury','I-Pace':'luxury'},
  'Maserati': {'Grecale':'luxury','Levante':'luxury','Quattroporte':'luxury'},
  'Lamborghini': {'Urus':'luxury','Huracan':'luxury','Revuelto':'luxury'},
  'Ferrari': {'Roma':'luxury','296 GTB':'luxury','SF90':'luxury'},
  'Rolls-Royce': {'Ghost':'luxury','Cullinan':'luxury','Spectre':'luxury'},
  'Other / not listed': {'Enter my car manually':'other'}
};
const CAR_MULTIPLIERS = {hatchback:1, sedan:1.12, 'compact-suv':1.2, suv:1.35, mpv:1.3, premium:1.65, luxury:2.15, other:1};
let selectedCar = {brand:'', model:'', year:'', segment:'', custom:''};
try { selectedCar = {...selectedCar, ...JSON.parse(localStorage.getItem('heeben-selected-car') || '{}')}; } catch {}
function carLabel() { return selectedCar.model ? `${selectedCar.brand === 'Other / not listed' ? '' : selectedCar.brand + ' '}${selectedCar.model}${selectedCar.year ? ' (' + selectedCar.year + ')' : ''}`.trim() : ''; }
function initCarPicker() {
  const brand = $('#carBrand'), model = $('#carModel'), year = $('#carYear'); if (!brand || !model || !year) return;
  brand.innerHTML = '<option value="">Select brand</option>' + Object.keys(CAR_CATALOG).map(b => `<option value="${esc(b)}">${esc(b)}</option>`).join('');
  const years = Array.from({length:26},(_,i)=>String(new Date().getFullYear()-i)); year.insertAdjacentHTML('beforeend', years.map(y=>`<option value="${y}">${y}</option>`).join(''));
  brand.value = selectedCar.brand || '';
  function updateModels() {
    const entries = Object.entries(CAR_CATALOG[brand.value] || {});
    model.disabled = !brand.value; model.innerHTML = '<option value="">Select model</option>' + entries.map(([m])=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');
    if (selectedCar.model && entries.some(([m])=>m===selectedCar.model)) model.value=selectedCar.model;
    if (brand.value === 'Other / not listed') model.insertAdjacentHTML('beforeend','<option value="My car is not listed">My car is not listed</option>');
  }
  updateModels(); year.value = selectedCar.year || ''; if(selectedCar.model) $('#garageVehicle').value='Car';
  brand.addEventListener('change',()=>{selectedCar={brand:brand.value,model:'',year:year.value,segment:''};updateModels();persistCar();renderServices();});
  model.addEventListener('change',()=>{selectedCar.model=model.value;selectedCar.segment=(CAR_CATALOG[selectedCar.brand]||{})[model.value]||'other';if(selectedCar.model)$('#garageVehicle').value='Car';persistCar();renderServices();});
  year.addEventListener('change',()=>{selectedCar.year=year.value;persistCar();renderServices();});
  $('#clearCarSelection').addEventListener('click',()=>{selectedCar={brand:'',model:'',year:'',segment:'',custom:''};brand.value='';model.disabled=true;model.innerHTML='<option value="">Select brand first</option>';year.value='';persistCar();renderServices();});
}
function persistCar(){try{localStorage.setItem('heeben-selected-car',JSON.stringify(selectedCar));}catch{};const note=$('#selectedCarNote');if(note)note.textContent=carLabel()?`Selected vehicle: ${carLabel()}. Estimates are adjusted using an indicative vehicle-segment multiplier.`:'No car selected yet. Choose your car for a more relevant estimate.';}
function adjustedEstimate(text) {
  if (!selectedCar.segment || !text || !text.includes('₹')) return text;
  const factor=CAR_MULTIPLIERS[selectedCar.segment]||1;
  return text.replace(/₹([\d,]+)/g,(_,raw)=>'₹'+(Math.round(Number(raw.replace(/,/g,''))*factor/50)*50).toLocaleString('en-IN'));
}

function renderServices() {
  const selected = $('#garageVehicle').value;
  $('#vehicleSelect').innerHTML = [['', 'Any vehicle'], ...meta.vehicles.map(v => [v, v])].map(([v, l]) => `<button class="vehicle-option ${selected === v ? 'selected' : ''}" data-vehicle="${esc(v)}"><b>${esc(l)}</b></button>`).join('');
  const q = ($('#serviceGuideSearch')?.value || '').trim().toLowerCase();
  const groups = groupedServices(meta.services).map(group => ({...group, items:group.items.filter(n => {
    const estimate = SERVICE_ESTIMATES[n] || ['Price on inspection','Depends on job','Car & 2W'];
    const fits = !selected || selected === 'Commercial vehicle' || estimate[2].toLowerCase().includes(selected === 'Electric vehicle' ? 'ev' : selected === 'Two-wheeler' ? '2w' : selected.toLowerCase());
    return fits && (!q || n.toLowerCase().includes(q) || (SERVICE_DESCRIPTIONS[n] || '').toLowerCase().includes(q));
  })})).filter(g => g.items.length);
  $('#serviceCatalog').innerHTML = groups.length ? groups.map(group => `<section class="service-group"><div class="service-category-heading"><span class="service-category-icon">${SERVICE_GROUP_ICONS[group.group] || '🔧'}</span><div><h3>${esc(group.group)}</h3><small>${group.items.length} ${group.items.length === 1 ? 'service' : 'services'}</small></div></div><div class="service-guide-grid">${group.items.map(n => { const est = SERVICE_ESTIMATES[n] || ['Price on inspection','Depends on job','Car & 2W']; const shownPrice = adjustedEstimate(est[0]); return `<article class="service-guide-card"><div class="service-guide-card-top"><span class="service-guide-category">${esc(group.group)}</span><span class="service-guide-vehicle">${esc(est[2])}</span></div><h4>${esc(n)}</h4><p>${esc(SERVICE_DESCRIPTIONS[n] || 'Ask the garage for availability and a final quote.')}</p><div class="service-estimate-row"><div><small>Approx. price</small><b>${esc(shownPrice)}</b></div><div><small>Typical time</small><b>${esc(est[1])}</b></div></div><div class="service-card-actions"><button class="btn btn-outline" data-service="${esc(n)}">Find garages ↗</button><button class="btn btn-navy" data-cart-add="${esc(n)}">＋ Add to cart</button></div></article>`; }).join('')}</div></section>`).join('') : '<p class="muted">No matching services. Try another search or vehicle type.</p>';
}
$('#vehicleSelect').addEventListener('click', e => { const b = e.target.closest('[data-vehicle]'); if (!b) return; $('#garageVehicle').value = b.dataset.vehicle; renderServices(); });
initCarPicker(); persistCar();
$('#serviceGuideSearch')?.addEventListener('input', renderServices);

/* ---------- service cart ---------- */
let cart = [];
try { cart = JSON.parse(localStorage.getItem('heeben-service-cart') || '[]'); if (!Array.isArray(cart)) cart = []; } catch { cart = []; }
function saveCart() {
  try { localStorage.setItem('heeben-service-cart', JSON.stringify(cart)); } catch {}
  const count = $('#cartCount'); if (count) count.textContent = cart.length;
}
function addToCart(name) {
  if (cart.some(item => item.name === name)) { toast('This service is already in your cart.'); return; }
  const estimate = SERVICE_ESTIMATES[name] || ['Price on inspection','Depends on job','Car & 2W'];
  cart.push({name, estimate: adjustedEstimate(estimate[0]), time: estimate[1], vehicle: carLabel() || estimate[2]});
  saveCart(); toast(`${name} added to your cart.`);
}
function removeFromCart(name) { cart = cart.filter(item => item.name !== name); saveCart(); renderCart(); }
function renderCart() {
  saveCart();
  const items = $('#cartItems'), summary = $('#cartSummary'); if (!items || !summary) return;
  if (!cart.length) {
    items.innerHTML = '<div class="panel cart-empty"><div class="cart-empty-icon">🛒</div><h2>Your cart is empty.</h2><p class="muted">Browse Heeben services and add the jobs you may need.</p><button class="btn btn-navy" data-go="services">Explore services ↗</button></div>';
    summary.innerHTML = '<p class="eyebrow">ORDER SUMMARY</p><h2>No services yet</h2><p class="hint">Your selected services will appear here.</p>';
    return;
  }
  items.innerHTML = cart.map(item => `<article class="cart-item"><div class="cart-item-icon">🔧</div><div class="cart-item-info"><h3>${esc(item.name)}</h3><p>${esc(item.vehicle)} · ${esc(item.time)}</p><small>Indicative estimate: ${esc(item.estimate)}</small></div><button class="btn btn-quiet cart-remove" data-cart-remove="${esc(item.name)}">Remove</button></article>`).join('');
  summary.innerHTML = `<p class="eyebrow">ORDER SUMMARY</p><h2>${cart.length} selected ${cart.length === 1 ? 'service' : 'services'}</h2><div class="cart-summary-line"><span>Selected services</span><b>${cart.length}</b></div><p class="hint">Prices are indicative only. The garage sets its own starting price and confirms the final quote after reviewing your vehicle and requested work.</p><button class="btn btn-navy cart-proceed" data-cart-checkout>Find garages for these services ↗</button><button class="btn btn-outline cart-clear" data-cart-clear>Clear cart</button><p class="hint">Currently, you will choose a garage for one service at a time. Multiple services are not combined into a single booking yet.</p>`;
}
saveCart();

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
      const a = j?.address || {}, area = a.suburb || a.neighbourhood || a.city_district || a.town || a.city || '', city = a.city || a.town || a.state_district || '';
      if (city && CITY_OPTIONS.includes(city)) { setSelectedCity(city); $('#homeCity').value = city; $('#mapCity').value = city; }
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
  const btn = $('#findNearbyBtn'), area = $('#homeLocation').value.trim(), text = locationQuery(area), st = $('#gpsStatus'); let useText = false;
  $('#garageVehicle').value = homeVehicle; $('#garageService').value = '';
  if (text && !(coordsSource === 'gps' && userCoords && gpsArea && text === gpsArea)) {   // typed area: turn it into coordinates
    btn.disabled = true; st.textContent = 'Locating that area…';
    const c = await geocodeArea(text); btn.disabled = false;
    if (c) { userCoords = c; coordsSource = 'area'; st.textContent = `Showing garages closest to ${text}.`; } else { useText = true; if (coordsSource === 'area') userCoords = null; st.textContent = 'Couldn’t pin that area on the map, so searching by name instead.'; }
  }
  $('#garageSearch').value = useText ? text : '';
  $('#garageSort').value = userCoords ? 'distance' : 'recommended'; go('garages'); if (location.hash === '#garages') loadGarages();
});
const directionsUrl = g => g.lat != null && g.lng != null ? `https://www.google.com/maps/dir/?api=1${userCoords ? `&origin=${userCoords.lat},${userCoords.lng}` : ''}&destination=${g.lat},${g.lng}&travelmode=driving` : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(g.name + ', ' + g.area)}`;

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
  updateBookingEstimate();
  $('#bookingVehicleSel').innerHTML = myVehicles.map(v => `<option value="${esc(v.model)}" data-type="${esc(v.type)}">${esc(v.model)} (${esc(v.type)})</option>`).join('') + '<option value="__new">+ Add another vehicle…</option>';
  $('#bookingVehicleType').innerHTML = meta.vehicles.map(v => `<option>${esc(v)}</option>`).join('');
  $('#bookingVehicleNewWrap').style.display = myVehicles.length ? 'none' : ''; $('#bookingVehicleNew').value = ''; if (myVehicles.length) $('#bookingVehicleType').value = myVehicles[0].type;
  $('#bookingMode').innerHTML = meta.modes.map(m => `<option>${esc(m)}</option>`).join('');
  $('#doorstepAddress').value = ''; updateDoorstepFields();
  $('#bookingDate').min = todayStr(); const maxDate = new Date(); maxDate.setDate(maxDate.getDate() + 30); $('#bookingDate').max = new Date(maxDate - maxDate.getTimezoneOffset() * 60000).toISOString().slice(0, 10); $('#bookingDate').value = todayStr(); $('#bookingNotes').value = ''; $('#bookingPhone').value = me.phone || ''; $('#bookingMessage').textContent = '';
  openModal('bookingModal'); loadSlots();
}
$('#bookingVehicleSel').onchange = () => { const isNew = $('#bookingVehicleSel').value === '__new'; $('#bookingVehicleNewWrap').style.display = isNew ? '' : 'none'; if (!isNew) $('#bookingVehicleType').value = $('#bookingVehicleSel').selectedOptions[0]?.dataset.type || meta.vehicles[0]; };
function updateBookingEstimate() { const chosen = bookingCtx?.garage?.services?.find(x => x.service === $('#bookingService').value); $('#bookingEstimatePrice').textContent = chosen ? 'From ' + money(chosen.price) : '—'; }
$('#bookingService').onchange = updateBookingEstimate;
$('#bookingMode').addEventListener('change', updateDoorstepFields);
function updateDoorstepFields() { const doorstep = $('#bookingMode')?.value?.startsWith('Doorstep service'); if ($('#doorstepAddressWrap')) $('#doorstepAddressWrap').hidden = !doorstep; if ($('#doorstepAvailabilityHint')) $('#doorstepAvailabilityHint').hidden = !doorstep; $('#doorstepAddress').required = !!doorstep; }
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
  const sel = $('#bookingVehicleSel').value, vehicle = (sel === '__new' || !myVehicles.length) ? $('#bookingVehicleNew').value.trim() : sel, vehicleType = $('#bookingVehicleType').value;
  if (!vehicle) return msg.textContent = 'Please enter your vehicle model.';
  if ($('#bookingMode').value.startsWith('Doorstep service') && !$('#doorstepAddress').value.trim()) return msg.textContent = 'Please enter the address for the doorstep request.';
  if (!bookingCtx.slot) return msg.textContent = 'Please choose a time slot.';
  const btn = $('#bookingSubmit'); btn.disabled = true;
  try {
    const bookingNotes = [$('#bookingNotes').value.trim(), $('#bookingMode').value.startsWith('Doorstep service') ? `Doorstep address: ${$('#doorstepAddress').value.trim()}` : ''].filter(Boolean).join('\n');
    const created = await api('/bookings', 'POST', {garage_id: bookingCtx.garage.id, service: $('#bookingService').value, vehicle, vehicle_type: vehicleType, date: $('#bookingDate').value, time: bookingCtx.slot, mode: $('#bookingMode').value, notes: bookingNotes, phone: $('#bookingPhone').value.trim()});
    if (me && !me.phone) me.phone = $('#bookingPhone').value.trim();
    closeModals(); toast(`Request ${created.booking_ref} sent! The garage will confirm shortly.`); go('bookings'); if (location.hash === '#bookings') renderBookings();
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
    const card = b => `<article class="booking-card"><div><h4>${esc(b.service)} · ${esc(b.garage_name)}</h4><p class="booking-ref">Booking ID: ${esc(b.booking_ref || ('#' + b.id))}</p><p>${esc(b.vehicle_type || 'Vehicle')} · ${esc(b.vehicle)} · ${fmtDate(b.date)} at ${esc(b.time)}</p><p>${esc(b.mode)} · Pay at garage</p><p>Garage starting price at booking: <b>${b.estimated_price ? money(b.estimated_price) : 'To be confirmed'}</b></p><p>⌖ ${esc(b.garage_area)} · ☎ ${esc(b.garage_phone)}</p>${b.notes ? `<p class="booking-note">Your note: ${esc(b.notes)}</p>` : ''}${b.garage_note ? `<p class="booking-note">Garage says: ${esc(b.garage_note)}</p>` : ''}${b.quote_amount ? `<p class="booking-note"><b>Garage quotation: ${money(b.quote_amount)}</b> · ${esc(b.quote_status)}${b.quote_note ? `<br>${esc(b.quote_note)}` : ''}</p>${b.health_report ? `<p class="booking-note">Vehicle health report: ${esc(b.health_report)}</p>` : ''}${b.quote_status === 'Pending customer approval' ? `<div class="btn-row"><button class="btn btn-navy" data-action="quoteDecision" data-id="${b.id}" data-decision="Approved">Approve quote</button><button class="btn btn-outline" data-action="quoteDecision" data-id="${b.id}" data-decision="Declined">Decline quote</button></div>` : ''}` : ''}${b.review ? `<p>Your review: ${'★'.repeat(b.review.rating)} ${esc(b.review.text)}</p>` : ''}</div>
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

/* ---------- customer dashboard, history and rewards ---------- */
async function renderCustomerDashboard() {
  const el=$('#customerDashboardBody');
  if(!me) return gate(el,'Log in to open your dashboard','Your vehicle records and rewards are saved to your account.','<button class="btn btn-navy" id="gateLogin">Log in</button> <button class="btn btn-outline" id="gateSignup">Create account</button>'),bindGate();
  if(me.role!=='customer') return gate(el,'Customer dashboard','Open your garage dashboard to manage customer bookings.','<button class="btn btn-navy" data-go="garage">Open garage dashboard</button>');
  el.innerHTML='<p class="muted">Loading your dashboard…</p>';
  try {
    // Load each dashboard area independently. A temporary failure in vehicle
    // history must not prevent rewards from appearing (and vice versa).
    const [dResult,hResult,rResult]=await Promise.allSettled([api('/dashboard'),api('/vehicle-history'),api('/rewards')]);
    if (dResult.status === 'rejected') throw dResult.reason;
    const d=dResult.value;
    const h=hResult.status === 'fulfilled' ? hResult.value : {history:[]};
    const r=rResult.status === 'fulfilled' ? rResult.value : null;
    el.innerHTML=`<div class="stats"><div><b>${d.vehicles.length}</b><small>Saved vehicles</small></div><div><b>${d.upcoming}</b><small>Active bookings</small></div><div><b>${d.completed}</b><small>Completed services</small></div><div><b>${r ? r.points : '—'}</b><small>Heeben points</small></div></div>
    <div class="dashboard-grid"><div class="stack-col"><div class="panel"><p class="eyebrow">VEHICLE PASSPORT</p><h2>Your vehicle history.</h2>${h.history.length?h.history.map(v=>`<div class="vehicle-row"><span><b>${esc(v.vehicle.model)}</b><small>${esc(v.vehicle.type)}${v.vehicle.reg?' · '+esc(v.vehicle.reg):''}</small></span><b>${v.records.length} records</b></div>${v.records.length?`<div class="booking-list">${v.records.map(b=>`<article class="booking-card"><div><h4>${esc(b.service)}</h4><p>${fmtDate(b.date)} · ${esc(b.garage_name)} · ${esc(b.garage_area)}</p><p>Status: <b>${esc(b.status)}</b>${b.quote_amount?' · Quote: '+money(b.quote_amount):''}</p>${b.health_report?`<p>${esc(b.health_report)}</p>`:''}</div></article>`).join('')}</div>`:'<p class="hint">No service records linked to this vehicle yet. Completed bookings will appear when the booking uses this saved vehicle model.</p>'}`).join(''):'<p class="muted">Add a vehicle in Profile & vehicles to start its passport.</p>'}</div>
    <div class="panel"><p class="eyebrow">BOOKING SNAPSHOT</p><h2>Recent activity.</h2>${d.bookings.slice(0,5).map(b=>`<div class="vehicle-row"><span><b>${esc(b.service)}</b><small>${esc(b.garage_name)} · ${fmtDate(b.date)}</small></span>${statusPill(b.status)}</div>`).join('')||'<p class="muted">No bookings yet.</p>'}<button class="btn btn-outline" data-view="bookings">View all bookings</button></div></div>
    <div class="stack-col"><div class="panel"><p class="eyebrow">HEEBEN REWARDS</p>${r ? `<h2>${r.points} points</h2><p class="muted">Earn 10 points for each booking completed through Heeben. Redeem them for service discounts at participating Heeben garages.</p>
    <div class="reward-offers">${r.offers.map(o=>`<article class="reward-offer"><div><b>${esc(o.label)}</b><small>${o.points} points · ${esc(o.description)}</small></div><button class="btn btn-navy" data-action="redeemReward" data-points="${o.points}" ${r.points<o.points?'disabled':''}>Redeem</button></article>`).join('')}</div>
    ${r.redemptions.length?`<h3 class="reward-subhead">Your vouchers</h3>${r.redemptions.map(v=>`<div class="vehicle-row reward-voucher"><span><b>${money(v.discount_amount)} service discount</b><small>Code: <strong>${esc(v.code)}</strong> · ${esc(v.status)} · ${fmtDate(v.created.slice(0,10))}</small></span><button class="btn btn-outline" data-action="copyReward" data-code="${esc(v.code)}">Copy code</button></div>`).join('')}<p class="hint">Show an unused voucher to a participating Heeben garage before paying. Each voucher is single-use.</p>`:''}
    <h3 class="reward-subhead">Points activity</h3>${r.transactions.map(t=>`<div class="vehicle-row"><span><b>${esc(t.reason)}</b><small>${fmtDate(t.created.slice(0,10))}</small></span><b class="${t.points<0?'reward-debit':''}">${t.points>0?'+':''}${t.points}</b></div>`).join('')||'<p class="hint">Your first completed service will earn points.</p>'}` : `<p class="muted">Your rewards could not be loaded right now. Your bookings and vehicle dashboard are still available. Please refresh to try again.</p>`}</div>
    <div class="panel"><p class="eyebrow">QUICK ACTIONS</p><div class="btn-row"><button class="btn btn-navy" data-view="garages">Find a garage</button><button class="btn btn-outline" data-view="assistant">Ask vehicle assistant</button><button class="btn btn-outline" data-view="account">Manage vehicles</button></div></div></div></div>`;
  } catch(e){el.innerHTML=`<p class="muted">${esc(e.message)}</p>`;}
}
async function renderAssistant(){
  const box=$('#assistantReplies');
  if(!me){box.innerHTML='<p class="muted">Log in to use your personal vehicle assistant.</p><button class="btn btn-navy" id="gateLogin">Log in</button>';$('#gateLogin').onclick=()=>openAuth('login');return;}
  if(me.role!=='customer'){box.innerHTML='<p class="muted">The vehicle assistant is available to customer accounts.</p>';return;}
  box.innerHTML='<p class="muted">Describe what you notice. Include your vehicle type/model and when the symptom occurs for more useful guidance.</p>';
}
$('#assistantForm').onsubmit=async e=>{e.preventDefault();const q=$('#assistantQuestion').value.trim();if(!q)return;const box=$('#assistantReplies');box.innerHTML='<p class="muted">Thinking…</p>';try{const r=await api('/assistant','POST',{message:q});box.innerHTML=`<div class="panel"><p class="eyebrow">${esc(r.category)}</p><p>${esc(r.answer)}</p><p class="hint">${esc(r.disclaimer)}</p><button class="btn btn-outline" data-view="garages">Find a relevant garage</button></div>`;}catch(er){box.textContent=er.message;}};

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
  <div class="panel"><p class="eyebrow">HEEBEN REWARDS</p><h2>Verify a customer voucher.</h2><p class="muted">Enter the customer’s single-use Heeben voucher code before applying the discount to their service bill.</p><form id="rewardVerifyForm" class="stack-form"><label class="field">Voucher code<input id="rewardVoucherCode" maxlength="20" autocomplete="off" placeholder="e.g. HB12AB34CD" required></label><button class="btn btn-navy">Verify voucher</button><p class="hint form-msg" id="rewardVerifyMessage" role="status"></p></form></div>
  <div class="panel"><p class="eyebrow">${g ? 'EDIT GARAGE' : 'LIST A GARAGE'}</p><h2>${g ? esc(g.name) : 'Add your garage.'}</h2>
  <form id="garageForm" class="stack-form"><label class="field">Garage name<input required id="gName" maxlength="80" value="${esc(g?.name)}"></label>
  <label class="field">Area / city<input required id="gArea" maxlength="120" placeholder="e.g. Indiranagar, Bengaluru" value="${esc(g?.area)}"></label>
  <label class="field">Contact number<input required id="gPhone" type="tel" maxlength="18" value="${esc(g?.phone || me.phone)}"></label>
  <label class="field">About your garage<textarea id="gDesc" rows="3" maxlength="500">${esc(g?.description)}</textarea></label>
  <div class="field">Vehicles you service<div class="check-grid">${meta.vehicles.map(v => `<label><input type="checkbox" name="gVeh" value="${esc(v)}" ${veh.has(v) ? 'checked' : ''}> ${esc(v)}</label>`).join('')}</div></div>
  <div class="field">Services &amp; starting price (₹)<span class="hint">Select every job your workshop offers and enter its starting price. You can update these anytime.</span><div class="owner-service-groups">${groupedServices(meta.services).map(group => `<section class="owner-service-group"><h3>${esc(group.group)}</h3><div class="svc-grid">${group.items.map(s => `<label class="svc-row"><input type="checkbox" name="gSvc" value="${esc(s)}" ${sel.has(s) ? 'checked' : ''}> <span>${esc(s)}${SERVICE_DESCRIPTIONS[s] ? `<small class="svc-hint">${esc(SERVICE_DESCRIPTIONS[s])}</small>` : ''}</span><input type="number" min="1" max="1000000" step="1" data-price="${esc(s)}" value="${price[s] || ''}" placeholder="₹ starting price" aria-label="Price for ${esc(s)}"></label>`).join('')}</div></section>`).join('')}</div></div>
  <div class="two-fields"><label class="field">Bookings per time slot<input id="gCap" type="number" min="1" max="20" value="${g?.capacity || 2}"></label><div class="field">Map location (for “nearest”)<button type="button" class="btn btn-outline" data-action="useGarageLoc">${g?.lat != null ? '✓ Location set — update' : '⌖ Use my current location'}</button></div></div>
  <input type="hidden" id="gLat" value="${g?.lat ?? ''}"><input type="hidden" id="gLng" value="${g?.lng ?? ''}">
  <div class="btn-row"><button class="btn btn-navy">${g ? 'Save changes' : 'List my garage'}</button>${g ? '<button type="button" class="btn btn-quiet" data-action="newGarage">Cancel</button>' : ''}</div><p class="hint form-msg" id="garageMsg" role="alert"></p></form></div></div></div>`;
  renderOwnerBookings();
  $('#rewardVerifyForm').onsubmit = async e => {
    e.preventDefault();
    const msg = $('#rewardVerifyMessage');
    const btn = $('#rewardVerifyForm button');
    msg.textContent = '';
    btn.disabled = true;
    try {
      const result = await api('/owner/rewards/verify', 'POST', {code: $('#rewardVoucherCode').value.trim().toUpperCase()});
      msg.textContent = `Valid voucher. Apply ${money(result.discount_amount)} off the customer’s service bill.`;
      $('#rewardVoucherCode').value = '';
      toast('Voucher verified successfully.');
    } catch (er) { msg.textContent = er.message || 'Could not verify this voucher.'; }
    finally { btn.disabled = false; }
  };
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
  $('#partnerBookings').innerHTML = list.length ? list.map(b => `<article class="booking-card"><div><h4>${esc(b.service)}</h4><p class="booking-ref">Booking ID: ${esc(b.booking_ref || ('#' + b.id))}</p><p><b>${esc(b.garage_name)}</b> · ${fmtDate(b.date)} at ${esc(b.time)}</p><p>Starting price: <b>${b.estimated_price ? money(b.estimated_price) : 'To be confirmed'}</b></p><p>${esc(b.vehicle_type || 'Vehicle')} · ${esc(b.vehicle)} · ${esc(b.mode)}</p><p>👤 ${esc(b.customer.name)} · ☎ <a href="tel:${esc(b.customer.phone)}">${esc(b.customer.phone || 'no phone')}</a></p>${b.notes ? `<p class="booking-note">Customer note: ${esc(b.notes)}</p>` : ''}${b.garage_note ? `<p class="booking-note">Your note: ${esc(b.garage_note)}</p>` : ''}${b.quote_amount ? `<p class="booking-note"><b>Quote: ${money(b.quote_amount)}</b> · ${esc(b.quote_status)}</p>` : ''}</div>
    <div class="booking-actions"><div class="booking-status-wrap">${statusPill(b.status)}</div>${b.status === 'Requested' ? `<button class="btn btn-navy" data-action="respond" data-status="Confirmed" data-id="${b.id}">Accept</button><button class="btn btn-outline" data-action="respond" data-status="Rejected" data-id="${b.id}">Decline</button>` : ''}${b.status === 'Confirmed' ? `<button class="btn btn-outline" data-action="quote" data-id="${b.id}">Send quotation / health report</button><button class="btn btn-navy" data-action="respond" data-status="Completed" data-id="${b.id}">Mark completed</button><button class="btn btn-outline" data-action="respond" data-status="Rejected" data-id="${b.id}">Cancel</button>` : ''}</div></article>`).join('') : '<p class="muted">Nothing here yet.</p>';
}
$('#quoteForm').onsubmit = async e => { e.preventDefault(); try { await api(`/bookings/${$('#quoteBookingId').value}/quote`, 'POST', {amount: $('#quoteAmount').value, note: $('#quoteNote').value, health_report: $('#quoteHealth').value}); closeModals(); toast('Quotation sent to customer for approval.'); renderGarageDash(); } catch (er) { fail(er); } };
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
