# Putting Heeben on heeben.com

1. Create a free GitHub account and upload this `site` folder as a new repository.
2. Create a Render account (render.com) -> New -> Blueprint -> pick the repo. It reads `render.yaml` and builds the Dockerfile.
   (Fly.io or Railway also work: they need a volume mounted at /data so the SQLite database survives restarts.)
3. In Render: your service -> Settings -> Custom Domains -> add `heeben.com` and `www.heeben.com`.
   Render shows the DNS records to create.
4. At your domain registrar's DNS settings add exactly those records (usually an A record for heeben.com and a CNAME for www).
   HTTPS is issued automatically after DNS propagates (minutes to a few hours). GPS only works over HTTPS.
5. Open https://heeben.com, sign up as a garage owner, and list real garages. `HEEBEN_DEMO=0` means no demo account or sample garages are created.
6. Back up /data/heeben.db regularly.
