# Heeben — MVP

A working vehicle-care marketplace: customers find garages and request bookings; garage owners list their garage and accept/decline requests. Shared database, real accounts.

**No installs needed** — Python 3.9+ standard library only.

## Run
```
python3 server.py
```
Open http://localhost:8000. Data is stored in `data/heeben.db` (SQLite).

Demo data (6 sample garages + a demo owner) loads on first run:
`owner@heeben.demo` / `heeben-demo-1`. For production start with `HEEBEN_DEMO=0` so no demo account exists.

Env vars: `PORT`, `HOST`, `HEEBEN_DB`, `HEEBEN_DEMO`.

## Features
**Customers:** sign up / log in, search + filter + sort garages (service, vehicle, rating, price, GPS distance), garage detail with prices and reviews, save garages, real time-slot availability (no double-booking), booking requests with notes and phone, cancel, booking history, reviews after completed jobs, saved vehicles, service reminders, profile + password change.

**Garage owners:** garage-owner accounts, list/edit garages (services, per-service prices, vehicle types, slot capacity, location), hide/show listing, dashboard with stats, accept / decline / complete requests with a message to the customer.

**Platform:** salted PBKDF2 passwords, HttpOnly session cookies, login/signup rate limiting, input validation, XSS-safe rendering, security headers (CSP), contact form, terms/privacy page, hash routing (back button works), mobile friendly.

Ratings come only from completed bookings — sample garages show "New" until then.

## Deploying
Run behind HTTPS (Caddy/nginx/Render/Railway/Fly). Behind a proxy it reads `X-Forwarded-Proto` / `X-Forwarded-For`. Back up `data/heeben.db`.

## Not in the MVP yet (suggested next)
1. Email/SMS notifications and password reset (needs an email provider).
2. Admin panel for approving/verifying garages and moderating reviews.
3. Online payments (after the request→confirm flow is validated).
4. Photos for garages, opening hours / holidays per garage.
5. Move to Postgres + a framework (FastAPI) if traffic grows; the API shape in `server.py` maps over directly.
6. Have a lawyer review the starter terms/privacy page.
