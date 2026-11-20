'use strict';
/* Used only when the Heeben API server can't be reached (e.g. the site is opened as static files).
   Lets garage browsing + GPS "near me" keep working with the sample garages. Booking/login still need the server. */
const FALLBACK_META = {services: ['General service', 'Basic service', 'Comprehensive service', 'Engine oil & filter change', 'Air filter replacement', 'Coolant replacement', 'Periodic inspection', 'Engine diagnostics & repair', 'Clutch repair', 'Gearbox / transmission repair', 'Suspension & steering repair', 'Brake repair', 'Brake pad / shoe replacement', 'Radiator & cooling system repair', 'Exhaust system repair', 'AC inspection & service', 'AC gas refill', 'AC repair', 'Tyre replacement', 'Puncture repair', 'Wheel alignment & balancing', 'Battery check & replacement', 'Electrical diagnostics', 'Wiring & lighting repair', 'EV diagnostics & battery health check', 'EV charger inspection', 'Exterior wash', 'Interior deep cleaning', 'Full car/bike detailing', 'Machine polishing', 'Ceramic coating', 'Chain cleaning & lubrication', 'Chain / sprocket replacement', 'Bike brake service', 'Scooter belt / CVT service', 'Bike clutch & cable repair', 'Cleaning & detailing', 'Routine servicing', 'Mechanical repairs', 'Tyres & batteries', 'Electrical & EV care'],
  vehicles: ['Car', 'Two-wheeler', 'Electric vehicle', 'Commercial vehicle'], slots: ['09:00 AM', '11:00 AM', '02:00 PM', '04:00 PM'], modes: ['Visit garage', 'Pickup requested (subject to availability)']};
const FALLBACK_GARAGES = [
  [1, 'Northside Auto Care', 'Indiranagar, Bengaluru', 12.9784, 77.6408, 'Car,Two-wheeler', {'Routine servicing': 2800, 'Mechanical repairs': 1500, 'Tyres & batteries': 3400}, 'Friendly neighbourhood workshop for scheduled servicing and repairs.'],
  [2, 'The Detail Studio', 'Koramangala, Bengaluru', 12.9352, 77.6245, 'Car,Two-wheeler', {'Cleaning & detailing': 1500}, 'Interior and exterior detailing, polishing and ceramic coating.'],
  [3, 'Volt Vehicle Works', 'HSR Layout, Bengaluru', 12.9116, 77.6389, 'Electric vehicle,Car', {'Electrical & EV care': 799, 'Routine servicing': 3500}, 'EV diagnostics, battery health checks and charging support.'],
  [4, 'City Bike Clinic', 'Jayanagar, Bengaluru', 12.9250, 77.5838, 'Two-wheeler', {'Mechanical repairs': 299, 'Routine servicing': 349, 'Tyres & batteries': 399}, 'Two-wheeler specialists. Quick turnaround on routine jobs.'],
  [5, 'Prime Motor Hub', 'Whitefield, Bengaluru', 12.9698, 77.7500, 'Car,Commercial vehicle', {'Routine servicing': 3200, 'Mechanical repairs': 1500, 'Cleaning & detailing': 1500}, 'Multi-brand service centre for cars and light commercial vehicles.'],
  [6, 'Green Route EV Care', 'Bellandur, Bengaluru', 12.9304, 77.6784, 'Electric vehicle,Two-wheeler', {'Electrical & EV care': 599, 'Tyres & batteries': 699}, 'Electric scooter and car care, with battery and charger checks.'],
].map(([id, name, area, lat, lng, v, sv, description]) => ({id, name, area, phone: '+91 80000 00000', description, lat, lng, vehicles: v.split(','), capacity: 2, is_sample: true,
  services: Object.entries(sv).map(([service, price]) => ({service, price})).sort((a, b) => a.price - b.price), rating: null, review_count: 0, min_price: Math.min(...Object.values(sv)), saved: false}));
function fallbackGarages({q = '', service = '', vehicle = '', sort = 'recommended', lat, lng, radius}) {
  const km = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 12742 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x)); };
  const has = lat != null && lng != null; q = q.toLowerCase();
  let out = FALLBACK_GARAGES.filter(g => (!q || (g.name + ' ' + g.area + ' ' + g.description).toLowerCase().includes(q)) && (!vehicle || g.vehicles.includes(vehicle)) && (!service || g.services.some(s => s.service === service)))
    .map(g => ({...g, distance_km: has ? Math.round(km(lat, lng, g.lat, g.lng) * 10) / 10 : null}));
  if (has && radius) out = out.filter(g => g.distance_km <= radius);
  if (sort === 'price') out.sort((a, b) => a.min_price - b.min_price);
  else if (sort === 'distance' || (sort === 'recommended' && has)) out.sort((a, b) => (a.distance_km ?? 1e6) - (b.distance_km ?? 1e6));
  return out;
}
