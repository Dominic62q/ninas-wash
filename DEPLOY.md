# Putting Niinas Wash online

Two places:

- **A small Linux server (VPS)** runs PostgreSQL, the API (as a service) and nginx. Ubuntu 24.04 is assumed. It only serves `/api`.
- **Vercel** serves the app (the web pages) and forwards every `/api` request to the VPS. The browser only ever talks to the Vercel address, so the sign-in cookie stays on one site.

You need: a VPS with a public IP, a hostname for it that points at that IP (for example `api.example.com`, an `A` record; the address Vercel forwards to must be HTTPS), a Vercel project connected to the GitHub repository, and Node 22 or newer on the VPS (`node --version`).

## 1. First time

```bash
sudo apt update && sudo apt install -y nginx postgresql certbot python3-certbot-nginx git

# A user to run it, and the code
sudo adduser --system --group --home /opt/niinas niinas
sudo -u niinas git clone <your repository url> /opt/niinas
cd /opt/niinas && sudo -u niinas npm ci
```

**Database**

```bash
sudo -u postgres psql -c "CREATE USER niinas WITH PASSWORD 'a-long-random-password';"
sudo -u postgres psql -c "CREATE DATABASE niinas OWNER niinas;"
```

**Settings.** Create `/etc/niinas/api.env` (`sudo mkdir /etc/niinas`, then `chmod 600`, owner `niinas`):

```
DATABASE_URL=postgres://niinas:a-long-random-password@127.0.0.1:5432/niinas
WEB_ORIGIN=https://niinas-wash.vercel.app
PORT=3001
HOST=127.0.0.1
```

In production the API refuses to start if `DATABASE_URL` is missing or still the development one, or if `WEB_ORIGIN` is not an `https://` address. The message says which.

**Customer texts (optional).** Add these three lines from the Nalo account when you want texts to really go out:

```
SMS_API_URL=<the full send address from Nalo>
SMS_API_KEY=<the Nalo key>
SMS_SENDER_ID=NiinasWash
```

Without the first two, nothing breaks: every text is recorded as "not sent" and no credits are spent. The sender id (11 characters at most) must be approved by Nalo before it works. Restart the API after changing them.

**Tables, then the first owner**

```bash
cd /opt/niinas
sudo -u niinas bash -c 'set -a; . /etc/niinas/api.env; set +a; npm run db:migrate'
sudo -u niinas bash -c 'set -a; . /etc/niinas/api.env; set +a; npm run db:create-owner -- "Full Name" username'
```

That prints a one-time password (shown once). The owner chooses their own at first sign-in, then adds everyone else under Staff and users. Do **not** run `db:seed` or `db:seed-demo` on the real server: they make sample people.

**Run the API**

```bash
sudo cp deploy/niinas-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now niinas-api
curl -s http://127.0.0.1:3001/api/health      # {"ok":true}
```

**nginx and HTTPS (for the API)**

```bash
sudo cp deploy/nginx-api.conf.example /etc/nginx/sites-available/niinas-api   # edit api.example.com and the secret
sudo ln -s /etc/nginx/sites-available/niinas-api /etc/nginx/sites-enabled/
sudo certbot --nginx -d api.example.com
sudo nginx -t && sudo systemctl reload nginx
```

The secret in that file is a long random value only Vercel knows (`openssl rand -hex 32`). nginx refuses any `/api` request that does not carry it, so nobody can reach the API except through Vercel, and the visitor address Vercel passes on can be trusted for the sign-in limit.

**The web app on Vercel**

1. Import the GitHub repository as a new project. Leave the Root Directory as the repository root. `vercel.json` already sets the install and build commands and the output folder.
2. In `vercel.json`, change `https://api.example.com` to your API hostname, and commit.
3. Add one environment variable, `ORIGIN_SECRET`, with the same value as in the nginx file.
4. Deploy. Put the resulting address (for example `https://niinas-wash.vercel.app`, or your own domain) into `WEB_ORIGIN` in `/etc/niinas/api.env`, then `sudo systemctl restart niinas-api`.

Open the address on a phone and use "Add to Home Screen" to install it.

**Check on the first deploy** (a few things depend on how Vercel forwards requests, so confirm them once):

- Sign in works and stays signed in after a refresh (the cookie passes through).
- Opening a deep link such as `/jobs` or a receipt link `/r/<token>` directly shows the app, not a 404.
- Adding a receipt photo works.
- Three wrong passwords from your phone do not lock out a second phone (the visitor address is passed on correctly).
- On the server, `curl -s -o /dev/null -w "%{http_code}" https://api.example.com/api/health` gives 403 (no secret), and the same through the Vercel address gives 200.

**Firewall and backups**

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
sudo mkdir -p /var/backups/niinas && sudo chown niinas /var/backups/niinas
sudo -u niinas crontab -e      # add: 15 2 * * *  /opt/niinas/deploy/backup.sh >> /tmp/niinas-backup.log 2>&1
```

Copy `/var/backups/niinas` off the server regularly too. **Test a restore once** (`pg_restore --dbname=<an empty database> file.dump`) so you know it works before you need it.

**Good to know before the first customer test**

- **Receipt photos live in the database**, not in a folder. There is no uploads directory to create, back up or lose; the nightly `backup.sh` already includes them. The database grows a little with every photo (a phone-shrunk receipt is a few hundred KB).
- **`client_max_body_size` must be at least 3m** in the nginx `server` block (`nginx-api.conf.example` has it). With the default 1m, adding a receipt photo fails with "too large" even though the app allows 2.5 MB.
- **A customer can open a receipt without signing in.** "Share receipt" on a finished job makes a link like `https://<your Vercel address>/r/<long random token>`. It shows the bill only: no phone number, no payment method. On a phone the button sends the receipt as a PDF through the share sheet; on a computer it opens the print dialog. The PDF is made by the API (`/api/receipts/<token>/pdf`, using the app font from `node_modules`, so no extra setup). The link is a normal screen of the app, so the catch-all rewrite to `/index.html` in `vercel.json` must stay, or the link gives a 404.
- **Migrations 0008 to 0012** (payment methods, expense categories and photos, quantity on a service, receipt links, attendant logins) run with `npm run db:migrate`. They only add things and keep existing rows. Back up first, as in section 2.
- **Roles are data.** Only Owner is fixed (it can do everything). Manager, Cashier, Attendant and any role you add are edited under Settings, "Roles and access". An attendant who needs a login is given one from Staff, "Give a login", which uses the **Attendant** role and shows them only their own washes and earnings.

## 2. Every update

The web app: push to GitHub and Vercel builds and publishes it by itself.

The API, on the server:

```bash
cd /opt/niinas && sudo -u niinas git pull && sudo -u niinas npm ci
sudo -u niinas ./deploy/backup.sh                 # a safety copy first
sudo -u niinas bash -c 'set -a; . /etc/niinas/api.env; set +a; npm run db:migrate'
sudo systemctl restart niinas-api
```

People who have the app open see **"A new version is ready"** within half an hour (or straight away when they switch back to it) and tap **Refresh now**. Nothing reloads by itself, so nobody loses a half-filled payment. "Later" hides it for half an hour.

For this to work, `sw.js` and `index.html` must not be cached. `vercel.json` already says so. If you ever put another CDN in front, keep that rule.

## 3. When something is wrong

| Symptom | Look at |
|---|---|
| Sign-in page says it cannot reach the server | `systemctl status niinas-api`, `journalctl -u niinas-api -n 100` |
| API will not start | The log says which production setting is missing or wrong |
| "Unknown site" on every save | `WEB_ORIGIN` does not match the address in the browser exactly (https, no trailing slash). It is the Vercel address, not the API one |
| Everyone gets "Too many attempts" | The visitor address is not reaching the API, so everybody looks like one visitor. Check the `X-Forwarded-For` line in the nginx `/api/` block |
| Every request fails with 403 or the app says it cannot reach the server | `ORIGIN_SECRET` in Vercel and the secret in the nginx file differ, or `vercel.json` still points at `api.example.com` |
| Deep links such as `/jobs` or a receipt link show 404 | The rewrite to `/index.html` in `vercel.json` is not applying. Check the Vercel deployment's routes |
| Old screens after an update | `sw.js` or `index.html` is being cached somewhere |
