# Heeben — vehicle-care marketplace MVP

Heeben helps vehicle owners discover independent garages and send booking requests. Garage partners can create listings, manage availability, accept/decline requests, send quotations and mark work complete.

## Run locally

Requirements: Python 3.9+ (standard library only; no `pip install` required).

```bash
python3 server.py
```

Open http://localhost:8000. By default, the app starts with an empty database and **does not create fake demo garages or demo accounts**. Create a customer account or a garage-owner account to test the real flow.

For a local-only demonstration with sample listings:

```bash
HEEBEN_DEMO=1 python3 server.py
```

Demo credentials: `owner@heeben.demo` / `heeben-demo-1`. Never enable demo mode on the public production site.

## Main functionality

- Customer registration/login, profile and saved vehicles.
- Search/filter garages by area, service, vehicle, rating, price and distance.
- Garage-owner registration, garage profile, services, starting prices and slot capacity.
- Booking requests with vehicle, date, time, visit/pickup preference and notes.
- Garage-side accept/decline/complete workflow and customer booking history.
- Quotations and optional vehicle health reports, with customer approval/decline.
- Customer reviews after completed bookings, saved garages and service reminders.
- Contact form with database storage.
- Optional email notifications for new booking requests, booking status changes, quotations and contact messages.
- Password hashing, session cookies, request validation, rate limits, security headers and SQLite persistence.

## Email notifications (recommended for a live marketplace)

The booking system works without email, but garage owners would otherwise need to log in to notice new requests. Configure the following environment variables on your hosting provider:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`
- `SMTP_STARTTLS=1` for STARTTLS (use port 465 for implicit TLS)
- `CONTACT_EMAIL` to receive website contact-form messages
- `SITE_URL` for links in notification emails

Example settings are in `.env.example`. For Gmail, use an App Password, not your normal account password. Keep credentials in Render Environment settings; never commit them to GitHub.

## Deploy on Render

1. Push the contents of this folder (not the ZIP itself) to a GitHub repository.
2. In Render choose **New → Blueprint** and select that repository. Render reads `render.yaml` and builds the Docker image.
3. Keep the persistent disk mounted at `/data`; the SQLite database is `/data/heeben.db`. The current Render configuration uses a paid Starter web service because persistent disks are not available on the free web-service tier.
4. Add the optional SMTP variables in Render → Environment. Set `SITE_URL` to the real public URL (or `https://heeben.com` after the custom domain is connected).
5. Deploy and check `https://YOUR-SERVICE.onrender.com/healthz` returns `ok`.
6. Add the custom domain in Render and copy the exact DNS records Render provides into your domain registrar. Wait for DNS/HTTPS to finish provisioning.
7. Test customer signup, owner signup, garage listing, booking request, owner acceptance, quotation and review before sharing the link publicly.

## Important launch notes

- `HEEBEN_DEMO=0` is required in production. The demo businesses and demo owner are illustrative only.
- New garage listings are self-published in this MVP. Contact and verify partners manually before treating them as trusted/verified; do not describe all listings as vetted.
- Heeben currently facilitates booking requests. It does not collect payments, guarantee service quality, dispatch roadside assistance, or guarantee pickup availability. Customers pay garages directly.
- Back up `/data/heeben.db` regularly. Do not use an ephemeral filesystem for the live SQLite database.
- Add a dedicated admin/verification workflow, password reset, transactional email provider, automated backups and privacy/legal review before scaling materially.

## New customer features (this upgrade)

- **Customer dashboard** (`/api/dashboard`): saved vehicles, active bookings, completed services, reminders and points summary.
- **Vehicle history / passport** (`/api/vehicle-history`): service records derived from bookings that use the same saved vehicle model or registration label. Older bookings that do not match a saved vehicle label will not automatically be assigned to it.
- **Heeben Rewards** (`/api/rewards`): a durable ledger awards 10 points once when a garage marks a booking Completed. Points are currently informational; redemption, cash value and partner-funded discounts are not enabled.
- **Heeben Vehicle Assistant** (`/api/assistant`): rule-based symptom guidance for common categories (starting/battery, noise/vibration, overheating, maintenance and urgent safety symptoms). It is not a generative AI model or a diagnostic tool. A qualified mechanic must confirm faults.
- **Garage dashboard**: existing booking, quote and completion workflow remains in place; completion now creates the customer reward entry.

The new tables are created automatically on startup. Keep `HEEBEN_DB` on persistent storage (for Render, the mounted `/data` disk and `/data/heeben.db`) before using real customer records. Back up the database regularly.

### Heeben Rewards redemption
Customers earn 10 points when a booking is marked completed. Available vouchers are 100 points = ₹50 off, 200 points = ₹120 off, and 500 points = ₹350 off. Customers redeem from My Dashboard → Heeben Rewards. The single-use voucher code is shown in their account. A garage owner can verify it using the authenticated `POST /api/owner/rewards/verify` endpoint with `{ "code": "HBCODE"`; a successful response returns the discount amount and marks the voucher as Used. The garage applies the discount manually to the service bill. The rewards redemption table is created automatically at server startup; existing points are preserved.
