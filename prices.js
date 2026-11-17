'use strict';
/* Typical 2026 prices for cars in India (₹). Industry estimates — garages set their own prices.
   Items with `all` apply to every car size; otherwise h/s/u = hatchback / sedan / SUV. [low, high] */
const PRICE_GUIDE = [
  {service: 'Routine servicing', title: 'Servicing', icon: '◷', note: 'Multi-brand garage. Authorised centres cost about 1.5–2× more. Diesel adds roughly ₹700–1,300.', items: [
    {name: 'Periodic service', h: [2500, 4500], s: [3500, 6500], u: [5000, 9000]},
    {name: 'Major service (e.g. 40,000 km)', all: [8500, 18000]},
  ]},
  {service: 'Mechanical repairs', title: 'Repairs & parts', icon: '⌁', note: 'Parts and labour, typical for common cars. Premium and imported cars cost more.', items: [
    {name: 'Front brake pads (set)', all: [1500, 4500]},
    {name: 'Clutch plate set', all: [6500, 18000]},
    {name: 'Shock absorbers (pair)', all: [4500, 12000]},
    {name: 'Timing belt', all: [5500, 14000]},
    {name: 'AC gas refill', all: [1800, 3500]},
  ]},
  {service: 'Tyres & batteries', title: 'Tyres & battery', icon: '◉', note: 'Tyres are per tyre and depend on rim size and brand. Battery price is for the battery only.', items: [
    {name: 'Tyre (per tyre)', h: [3400, 6500], s: [4500, 11000], u: [7200, 16500]},
    {name: 'Tyre fitting & balancing (per tyre)', all: [300, 600]},
    {name: 'Wheel alignment', all: [400, 1500]},
    {name: 'Battery replacement', h: [5000, 7500], s: [7200, 9500], u: [9000, 17500]},
    {name: 'Battery fitting', all: [0, 1200], text: 'Free at battery shops, ₹500–1,200 at service centres'},
  ]},
  {service: 'Cleaning & detailing', title: 'Cleaning & detailing', icon: '✧', note: 'A plain exterior wash costs much less than these packages. Ranges below are for deep-clean and detailing work.', items: [
    {name: 'Interior deep clean', h: [1500, 2500], s: [2500, 4000], u: [4000, 8000]},
    {name: 'Machine polish', h: [2000, 3500], s: [3500, 5500], u: [5000, 8000]},
    {name: 'Full detailing', h: [3500, 6000], s: [5000, 8000], u: [8000, 15000], plus: true},
    {name: 'Ceramic coating', h: [12000, 15000], s: [18000, 25000], u: [25000, 40000]},
    {name: 'Paint protection film (PPF)', h: [61750, 80000], s: [80000, 120000], u: [120000, 280000]},
  ]},
];
const SERVICE_HINTS = {
  'Routine servicing': 'Periodic service ₹2,500–9,000',
  'Mechanical repairs': 'Brake pads from ₹1,500 · clutch ₹6,500–18,000',
  'Tyres & batteries': 'Tyres ₹3,400–16,500 each · battery ₹5,000–17,500',
  'Cleaning & detailing': 'Interior clean from ₹1,500 · full detail ₹3,500–15,000+',
  'Electrical & EV care': 'EV service about ₹3,500–7,000 · other work quoted after inspection',
};
const LAKH = n => n >= 100000 ? '₹' + (n / 100000).toFixed(n % 100000 ? 1 : 0).replace(/\.0$/, '') + ' lakh' : '₹' + n.toLocaleString('en-IN');
