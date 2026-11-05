# Putting Niinas Wash online

Two places:

- **A small Linux server (VPS)** runs the API and PostgreSQL in Docker. Ubuntu 24.04 is assumed. It only serves `/api`. HTTPS comes from a Caddy that is already running on the server (it owns ports 80 and 443 for all the apps there): our API joins its Docker network and gets one small site file in its `sites` folder.
- **Vercel** serves the app (the web pages) and forwards every `/api` request to the VPS. The browser only ever talks to the Vercel address, so the sign-in cookie stays on one site.

You need: a VPS with a public IP and Docker, a hostname that points at that IP (a real domain, or the free `13-140-136-228.sslip.io` style name made from the IP with dashes; Vercel forwards to it over HTTPS), and a Vercel project connected to the GitHub repository.

> The Docker files have not been run end to end yet (no Docker was available where they were written). Expect to fix a small thing on the first `docker compose up`, and check the first-deploy list below.

On a server with no Caddy of its own, add one: a `caddy:2` service on ports 80 and 443 whose Caddyfile is `deploy/niinas.caddy.template` with the two `__...__` values filled in, on the same network as `niinas-api`.

## 1. First time

**Server**

```bash
sudo apt update && sudo apt install -y git
curl -fsSL https://get.docker.com | sudo sh        # installs Docker and Docker Compose (skip if already installed)
sudo git clone https://github.com/Rigelis-Inc/ninas-wash.git /opt/niinas    # the repository is private: use a token or a deploy key
cd /opt/niinas
```

**Settings.** Copy the example and fill it in (`API_DOMAIN`, `WEB_ORIGIN`, `EDGE_NETWORK` if the Caddy's network has another name, and two random values made with `openssl rand -hex 32`):

```bash
cp deploy/.env.example .env && chmod 600 .env && nano .env
```

`ORIGIN_SECRET` must be the same value you put in Vercel (below). The API refuses to start in production if the database password is still the development one or `WEB_ORIGIN` is not an `https://` address. The message says which.

**Customer texts (optional).** Fill in `SMS_API_URL`, `SMS_API_KEY` and `SMS_SENDER_ID` in `.env` from the Nalo account when you want texts to really go out. Without the first two, nothing breaks: every text is recorded as "not sent" and no credits are spent. The sender id (11 characters at most) must be approved by Nalo before it works. Run `docker compose up -d` again after changing them.

**Start it, make the tables, then the first owner**

```bash
docker compose up -d --build
docker compose run --rm niinas-api npm run db:migrate
docker compose run --rm niinas-api npm run db:create-owner -- "Full Name" username
```

The last command prints a one-time password (shown once). The owner chooses their own at first sign-in, then adds everyone else under Staff and users. Do **not** run `db:seed` or `db:seed-demo` on the real server: they make sample people.

Check the API is up (it should say `{"ok":true}`):

```bash
docker compose ps
docker compose exec niinas-api node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>r.text()).then(console.log)"
```

**Put it on the internet.** Add the site to the server's Caddy (it checks the whole Caddy config first and puts things back if that fails, so the other sites are not touched):

```bash
sudo ./deploy/install-caddy-site.sh
```

The script reads `API_DOMAIN` and `ORIGIN_SECRET` from `.env`, writes `niinas.caddy` into the Caddy's `sites` folder (readable by root only, since it holds the secret), validates and reloads. Defaults are `CADDY_CONTAINER=rigel-medsgh-caddy` and `SITES_DIR=/home/medsgh/rigel-medsgh/caddy/sites`; set them in the environment if the server differs. The certificate arrives on its own once `API_DOMAIN` points at the server. If it does not, `docker logs <the caddy container>` says why. Run the script again after changing `API_DOMAIN` or `ORIGIN_SECRET`.

**The web app on Vercel**

1. Import the GitHub repository as a new project. Leave the Root Directory as the repository root. `vercel.json` already sets the install and build commands and the output folder.
2. In `vercel.json`, the `/api` forward points at `https://api.niinaswash.com`. Change it if your API hostname differs, and commit.
3. Add one environment variable, `ORIGIN_SECRET`, with the same value as in `.env` on the server.
4. Deploy. Put the resulting address (for example `https://niinas-wash.vercel.app`, or your own domain) into `WEB_ORIGIN` in `.env` on the server, then `docker compose up -d`.

Open the address on a phone and use "Add to Home Screen" to install it.

**Check on the first deploy** (a few things depend on how Vercel forwards requests, so confirm them once):

- Sign in works and stays signed in after a refresh (the cookie passes through).
- Opening a deep link such as `/jobs` or a receipt link `/r/<token>` directly shows the app, not a 404.
- Adding a receipt photo works.
- Three wrong passwords from your phone do not lock out a second phone (the visitor address is passed on correctly).
- From your own computer, `curl -s -o /dev/null -w "%{http_code}" https://api.niinaswash.com/api/health` gives 403 (no secret), and the same path through the Vercel address gives 200.

**Backups**

```bash
sudo mkdir -p /var/backups/niinas
sudo crontab -e      # add: 15 2 * * *  /opt/niinas/deploy/backup.sh >> /var/log/niinas-backup.log 2>&1
```

Copy `/var/backups/niinas` off the server regularly too. **Test a restore once** so you know it works before you need it: create an empty database in a scratch container and run `pg_restore --dbname=<it> file.dump`. The data itself lives in the `pgdata` Docker volume, so never run `docker compose down -v`: the `-v` deletes it.

**Good to know before the first customer test**

- **Receipt photos live in the database**, not in a folder. There is no uploads directory to create, back up or lose; the nightly `backup.sh` already includes them. The database grows a little with every photo (a phone-shrunk receipt is a few hundred KB).
- **Uploads need to allow 3 MB.** The Niinas Wash site file does (`max_size 3MB`). Anything smaller makes adding a receipt photo fail with "too large" even though the app allows 2.5 MB.
- **A customer can open a receipt without signing in.** "Share receipt" on a finished job makes a link like `https://<your Vercel address>/r/<long random token>`. It shows the bill only: no phone number, no payment method. On a phone the button sends the receipt as a PDF through the share sheet; on a computer it opens the print dialog. The PDF is made by the API (`/api/receipts/<token>/pdf`, using the app font that is installed in the image, so no extra setup). The link is a normal screen of the app, so the catch-all rewrite to `/index.html` in `vercel.json` must stay, or the link gives a 404.
- **Migrations 0008 to 0012** (payment methods, expense categories and photos, quantity on a service, receipt links, attendant logins) run with `docker compose run --rm niinas-api npm run db:migrate`. They only add things and keep existing rows. Back up first, as in section 2.
- **Roles are data.** Only Owner is fixed (it can do everything). Manager, Cashier, Attendant and any role you add are edited under Settings, "Roles and access". An attendant who needs a login is given one from Staff, "Give a login", which uses the **Attendant** role and shows them only their own washes and earnings.

## 2. Every update

The web app: push to GitHub and Vercel builds and publishes it by itself.

The API, on the server:

```bash
cd /opt/niinas && git pull
./deploy/backup.sh                                  # a safety copy first
docker compose up -d --build
docker compose run --rm niinas-api npm run db:migrate
```

People who have the app open see **"A new version is ready"** within half an hour (or straight away when they switch back to it) and tap **Refresh now**. Nothing reloads by itself, so nobody loses a half-filled payment. "Later" hides it for half an hour.

For this to work, `sw.js` and `index.html` must not be cached. `vercel.json` already says so. If you ever put another CDN in front, keep that rule.

## 3. When something is wrong

| Symptom | Look at |
|---|---|
| Sign-in page says it cannot reach the server | `docker compose ps`, `docker compose logs --tail 100 niinas-api`, and the server's Caddy log |
| API will not start | The log says which production setting is missing or wrong |
| "Unknown site" on every save | `WEB_ORIGIN` does not match the address in the browser exactly (https, no trailing slash). It is the Vercel address, not the API one |
| Everyone gets "Too many attempts" | The visitor address is not reaching the API, so everybody looks like one visitor. Check `trusted_proxies` in `deploy/niinas.caddy.template`, then run `install-caddy-site.sh` again |
| Every request fails with 403 or the app says it cannot reach the server | `ORIGIN_SECRET` in Vercel and in `.env` differ, or `vercel.json` points at the wrong hostname. After changing `ORIGIN_SECRET` in `.env`, run `install-caddy-site.sh` again |
| Deep links such as `/jobs` or a receipt link show 404 | The rewrite to `/index.html` in `vercel.json` is not applying. Check the Vercel deployment's routes |
| Old screens after an update | `sw.js` or `index.html` is being cached somewhere |
