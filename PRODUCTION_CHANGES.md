# Production-readiness changes

This update keeps the existing Heeben UI and marketplace workflows, while improving deployment safety and the real booking experience.

## Changed

- Demo data is now OFF by default. Public deployments will not accidentally display invented garages or expose the demo owner account. Set `HEEBEN_DEMO=1` only for local demos.
- Added `/healthz` for a reliable hosting health check; Render now checks this endpoint.
- Added optional asynchronous email alerts for new booking requests to garage owners, booking status updates and quotations to customers, and website contact messages to the support inbox.
- Added `.env.example` to document the SMTP and deployment configuration without storing secrets.
- Added security response headers, HTTPS HSTS when behind an HTTPS proxy, more careful static-file path validation, and better request-size/content-length handling.
- Added an automated end-to-end smoke test covering signup, garage listing, booking, owner acceptance, quotation, customer approval, completion and review.
- Rewrote deployment guidance to explain persistent SQLite storage, HTTPS/custom-domain setup, SMTP configuration and manual partner verification.

## Verified locally

`python3 tests/smoke_test.py` passes. `python3 -m py_compile server.py` and `node --check public/app.js` also pass.

## Still required before public launch

- Deploy this project from your GitHub repository to Render and connect your domain.
- Configure SMTP credentials if you want email alerts. Without SMTP, bookings still work, but users must check their dashboards for updates.
- Onboard and manually verify real garage partners. Sample data is intentionally disabled in production.
- Complete privacy/terms review and arrange database backups. Payments, password reset and an admin verification console are not included yet.
