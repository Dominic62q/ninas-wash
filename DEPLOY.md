# Putting Niinas Wash on a VPS

One small Linux server (Ubuntu 24.04 is assumed). It runs PostgreSQL, the API (as a service) and nginx, which serves the app over HTTPS and passes `/api` to the API.

You need: a server with a public IP, a domain name pointing at it (an `A` record), and Node 22 or newer (`node --version`).

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
WEB_ORIGIN=https://wash.example.com
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

**Build the app and publish it**

```bash
cd /opt/niinas && npm run build -w @niinas/web
sudo mkdir -p /var/www/niinas && sudo rsync -a --delete apps/web/dist/ /var/www/niinas/
```

**Run the API**

```bash
sudo cp deploy/niinas-api.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now niinas-api
curl -s http://127.0.0.1:3001/api/health      # {"ok":true}
```

**nginx and HTTPS**

```bash
sudo cp deploy/niinas-headers.conf /etc/nginx/snippets/niinas-headers.conf
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/niinas   # edit wash.example.com
sudo ln -s /etc/nginx/sites-available/niinas /etc/nginx/sites-enabled/
sudo certbot --nginx -d wash.example.com
sudo nginx -t && sudo systemctl reload nginx
```

Open the address on a phone and use "Add to Home Screen" to install it.

**Firewall and backups**

```bash
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
sudo mkdir -p /var/backups/niinas && sudo chown niinas /var/backups/niinas
sudo -u niinas crontab -e      # add: 15 2 * * *  /opt/niinas/deploy/backup.sh >> /tmp/niinas-backup.log 2>&1
```

Copy `/var/backups/niinas` off the server regularly too. **Test a restore once** (`pg_restore --dbname=<an empty database> file.dump`) so you know it works before you need it.

**Good to know before the first customer test**

- **Receipt photos live in the database**, not in a folder. There is no uploads directory to create, back up or lose; the nightly `backup.sh` already includes them. The database grows a little with every photo (a phone-shrunk receipt is a few hundred KB).
- **`client_max_body_size` must be at least 3m** in the nginx `server` block (the example has it). With the default 1m, adding a receipt photo fails with "too large" even though the app allows 2.5 MB.
- **A customer can open a receipt without signing in.** "Share receipt" on a finished job makes a link like `https://wash.example.com/r/<long random token>`. It shows the bill only: no phone number, no payment method. The link is a normal screen of the app, so the nginx rule `try_files $uri /index.html` (already in the example) must stay, or the link gives a 404.
- **Migrations 0008 to 0012** (payment methods, expense categories and photos, quantity on a service, receipt links, attendant logins) run with `npm run db:migrate`. They only add things and keep existing rows. Back up first, as in section 2.
- **Roles are data.** Only Owner is fixed (it can do everything). Manager, Cashier, Attendant and any role you add are edited under Settings, "Roles and access". An attendant who needs a login is given one from Staff, "Give a login", which uses the **Attendant** role and shows them only their own washes and earnings.

## 2. Every update

```bash
cd /opt/niinas && sudo -u niinas git pull && sudo -u niinas npm ci
sudo -u niinas ./deploy/backup.sh                 # a safety copy first
sudo -u niinas bash -c 'set -a; . /etc/niinas/api.env; set +a; npm run db:migrate'
npm run build -w @niinas/web && sudo rsync -a --delete apps/web/dist/ /var/www/niinas/
sudo systemctl restart niinas-api
```

People who have the app open see **"A new version is ready"** within half an hour (or straight away when they switch back to it) and tap **Refresh now**. Nothing reloads by itself, so nobody loses a half-filled payment. "Later" hides it for half an hour.

For this to work, `sw.js` and `index.html` must not be cached. The nginx example already says so. If you ever put a CDN in front, keep that rule.

## 3. When something is wrong

| Symptom | Look at |
|---|---|
| Sign-in page says it cannot reach the server | `systemctl status niinas-api`, `journalctl -u niinas-api -n 100` |
| API will not start | The log says which production setting is missing or wrong |
| "Unknown site" on every save | `WEB_ORIGIN` does not match the address in the browser exactly (https, no trailing slash) |
| Everyone gets "Too many attempts" | nginx is not sending `X-Forwarded-For`, so everybody looks like one visitor. Check the `/api/` block |
| Old screens after an update | `sw.js` or `index.html` is being cached somewhere |
