# Heeben account creation and Vercel API connection fix

The frontend sends account requests to `/api/signup` and `/api/login`. The Vercel function proxies those requests to the Python backend.

## Important fix in this package

The Vercel proxy now disables automatic request-body parsing so signup/login JSON is forwarded to the Python backend intact. It also forwards the session cookie back to the browser, which is required to remain logged in after signup.

## Deploy steps

1. Deploy this repository as a Render web service using the included `render.yaml` (free tier for initial testing).
2. Wait for Render to finish deploying.
3. Open `https://YOUR-RENDER-SERVICE.onrender.com/healthz`. It must show `ok`.
4. In Vercel → Project → Settings → Environment Variables, add:
   - Name: `HEEBEN_API_URL`
   - Value: `https://YOUR-RENDER-SERVICE.onrender.com` (no trailing slash; use your real Render URL)
   - Environments: Production, Preview, Development as needed.
5. Save, then redeploy the Vercel project.
6. Test `https://YOUR-HEEBEN-DOMAIN/api/me`. When logged out it should return `{"user":null}`.
7. Create a new customer account, then create a garage-owner account with a different email address.

## Free-tier data warning

The included Render configuration uses the free plan and stores SQLite at `/tmp/heeben.db`. Account creation and login can be tested, but the database is temporary and can be erased when the free service restarts or redeploys. Do not use this setup for real customer bookings until durable database storage is configured.
