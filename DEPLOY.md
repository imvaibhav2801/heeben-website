# Deploy Heeben so customers can access it

## Render + GitHub

1. Extract this project ZIP on your computer.
2. Upload the contents of the `site 20` folder to a GitHub repository. The repository root must contain `server.py`, `Dockerfile`, `render.yaml`, and the `public/` folder.
3. In Render, choose **New → Blueprint**, connect GitHub, and select the repository.
4. Review the service. The Blueprint uses a Starter web service and a persistent disk mounted at `/data`; this is intentional because the SQLite database must survive deploys/restarts.
5. Deploy. Open the generated `onrender.com` URL and check `/healthz` returns `ok`.
6. Test a customer account and a garage-owner account, add a real garage listing, and send a test booking request.
7. Add `heeben.com` and `www.heeben.com` under Render → Settings → Custom Domains. Add exactly the DNS records Render displays at Spaceship. Do not guess or add extra DNS records. Wait until Render reports the domain and TLS certificate are verified.
8. Set `SITE_URL` in Render to `https://heeben.com` once the custom domain works.

## Environment variables

The Blueprint sets `HEEBEN_DEMO=0` and `HEEBEN_DB=/data/heeben.db`. Keep both unchanged in production. Add SMTP settings from `.env.example` if you want automatic email alerts. Never commit SMTP credentials to GitHub.

## Before sharing publicly

- Confirm `/healthz` returns `ok`.
- Register a customer account and an owner account using different email addresses.
- Owner: create a garage listing with accurate location, phone, vehicles, services and prices.
- Customer: find that listing and request a future slot.
- Owner: accept/decline the request and test quotation workflow.
- Confirm email notifications if SMTP is configured.
- Confirm the site is on HTTPS and booking data survives a redeploy.

A successful deployment makes the website reachable. It does not automatically onboard real garages: partners must register or be added through the owner flow. Verify garage identity and contact details manually during this pilot.
