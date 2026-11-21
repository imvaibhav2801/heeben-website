# Heeben garage dashboard integration

The uploaded `heeben-garage-services-upgrade` archive contained a complete, older Heeben site (`site/` with `server.py` and `public/` assets), rather than a standalone `heeben_garage_dashboard.html` file.

The latest Heeben website already contains the garage-owner dashboard and its backend integration. This package keeps that latest version instead of replacing it with the older archive, which would remove newer features.

## Where the dashboard lives

- Frontend view: `public/index.html` (`#garage` / `garageBody`)
- Dashboard rendering and interactions: `public/app.js` (`renderGarageDash`, `renderOwnerBookings`)
- Garage account and listing APIs: `server.py` (`/api/signup`, `/api/garages`, `/api/owner/garages`, `/api/owner/bookings`)
- Booking actions: `server.py` (`/api/bookings/<id>/status`)
- Quotations and customer approval: `server.py` (`/api/bookings/<id>/quote`, `/api/bookings/<id>/quote-response`)
- Vercel API bridge: `api/[...path].js`

## How a garage owner opens it

1. Open the Heeben website and choose **For garages**.
2. Create an account and select **I run a garage**.
3. After successful registration/login, the app routes the garage owner to the dashboard (`#garage`).
4. The owner can create/edit a garage listing, set services and starting prices, manage capacity, view customer booking requests, accept/decline requests, send quotations/health reports, and mark jobs complete.

## Important deployment configuration

The frontend is hosted on Vercel and uses the same-origin `/api` proxy. Set `HEEBEN_API_URL` in Vercel to the deployed backend origin (no trailing slash and no `/api`). The backend must be deployed and reachable first.

Do not accept live bookings until persistent database storage is configured. See `README.md`, `DEPLOY.md`, and `VERCEL_BACKEND_FIX.md` for deployment requirements.
