# Heeben backend MVP deployment

This repository contains two ways to serve the website:

- The root HTML/CSS/JS files are the existing static site (currently suitable for Vercel).
- `server.py` is the Python application server. It serves the matching customer/garage web app from `public/` and provides the `/api/*` endpoints used for accounts, garage listings and bookings.

## What works in this backend MVP

- Customer sign-up, login, logout and profile.
- Garage-owner sign-up, login and garage profile creation.
- Garage service and vehicle listings.
- Customer booking requests with date/time slots.
- Garage owners can view requests, accept/reject them, send quotations and mark jobs complete.
- Customers can track/cancel bookings and review completed jobs.
- SQLite database with password hashing, session cookies, validation and basic rate limiting.

Online payments, email/SMS notifications, password reset and an admin verification console are not implemented in this version. The customer pays the garage directly; do not advertise online payments until a payment provider has been integrated and tested.

## Deploy the full application on Render

The included `render.yaml` and `Dockerfile` are configured for Render:

1. Push/merge this branch into the repository's deployment branch.
2. In Render, create a **Blueprint** and select this GitHub repository.
3. Render reads `render.yaml`, builds the Docker image and starts `python3 server.py`.
4. Keep `HEEBEN_DEMO=0`. This prevents demo accounts and sample garages from being created.
5. The service uses `HEEBEN_DB=/data/heeben.db`. Keep the persistent disk mounted at `/data`; without persistent storage, customer accounts and bookings can disappear on redeploy/restart.
6. Wait for the service health check at `/` to pass. Test customer signup, garage-owner signup, garage creation and a booking before inviting real users.
7. For a custom domain, add it under the Render service's **Settings → Custom Domains**, then apply the DNS records Render gives you at your registrar.

The current frontend calls relative `/api/*` URLs and uses same-origin session cookies. Therefore, the simplest production setup is to serve the frontend and backend together from this Render service and point the production domain to Render. If you keep the current Vercel site as the production frontend, a separate cross-origin API configuration (CORS, cookie and frontend API URL changes) is required; do not simply point the frontend at the Render API without that work.

## Local testing

```bash
HEEBEN_DEMO=0 HEEBEN_DB=./data/heeben.db python3 server.py
```

Open `http://localhost:8000`. Use two separate browser sessions to test the customer and garage-owner journeys. Never commit the live database, credentials or provider secrets.
