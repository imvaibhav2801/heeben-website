# Deploy Heeben for account and booking testing

1. Upload the contents of this project folder to the GitHub repository connected to Vercel.
2. Create a Render Web Service from the same repository. The included `render.yaml` uses the free plan.
3. Wait for deployment and confirm `/healthz` returns `ok`.
4. Copy the real Render service origin, e.g. `https://your-service.onrender.com`.
5. In Vercel → Settings → Environment Variables, create `HEEBEN_API_URL` with that exact origin (no trailing slash).
6. Redeploy Vercel after saving the variable.
7. Test `/api/me`, then create a new account on the live site.

The free Render plan is for initial testing only. Its local SQLite database is ephemeral; users/bookings can be lost after a restart or redeploy. Configure durable storage before public production use.
