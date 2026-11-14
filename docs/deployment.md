# Deploying Adiutor

Status: written ahead of the launch; nothing here has been run against a production server. The board UI and the Telegram bot are on `main` (rows 7 and 8 of the [foundation plan](project-foundation.md)).

These notes are for the owner, who deploys production himself. Agents never deploy. Replace every example value (`adiutor.example.com`, `db.example.com`, `<...>`) with your own; keep the real values in `.env` on the server and in your private notes, never in the repository.

## What you deploy

- **Image:** `ghcr.io/shlomiporush/adiutor:<version>`, published by the Release workflow. Every release has an immutable version tag (`0.1.0`) and moves `latest`. Run a version tag, never `latest`: `docker-compose.yml` refuses to start without `VERSION`.
- **One container:** `docker-compose.yml` runs only `adiutor`. It keeps no files: all state is in your PostgreSQL database. It runs as `node` with no capabilities, no new privileges and a read-only root file system.
- **Migrations** run on every start, before the server listens. There is no separate migration step.
- **Backups** are yours: back up the Adiutor database with your own tools. Adiutor has no backup feature.

## 1. Create the database

1. Generate a password for the database role (hex, so it needs no escaping in a URL):

   ```bash
   openssl rand -hex 24
   ```

2. Adiutor needs PostgreSQL 16 or newer. On your PostgreSQL server, as a superuser, create a role and a database that only Adiutor uses:

   ```sql
   CREATE ROLE adiutor LOGIN PASSWORD '<database password>';
   CREATE DATABASE adiutor OWNER adiutor;
   REVOKE ALL ON DATABASE adiutor FROM PUBLIC;
   ```

   The role owns its database, so the migrations can create their tables. It needs no other rights.

3. In your server's `pg_hba.conf`, allow the role to connect to its database only from where `adiutor` connects (see "Reaching PostgreSQL" below):
   - **PostgreSQL on another host:** the Docker host's address.
   - **PostgreSQL in a container on the same Docker host:** the subnet of the Docker network the two containers share (`docker network inspect <network>`).

4. Write the connection URL for `.env`:

   ```text
   DATABASE_URL=postgres://adiutor:<database password>@db.example.com:5432/adiutor
   ```

   **Reaching PostgreSQL.** The shipped `docker-compose.yml` puts `adiutor` only on the `traefik` network:
   - **PostgreSQL on another host:** use that host's name in the URL and add `?sslmode=verify-full` (or `?sslmode=require` when the server's certificate cannot be verified). Its firewall and `pg_hba.conf` must let the Docker host in.
   - **PostgreSQL in a container on the same Docker host:** use its container name as the host. `adiutor` must share a Docker network with that container: in `docker-compose.yml`, add that network under the service's `networks:` and declare it at the end of the file as `external: true`, next to `traefik`. Allow that network's subnet in `pg_hba.conf` (item 3). Every container on that network can then reach `adiutor:8080` directly too (see section 3, "The client address and the rate limits").

## 2. Write `.env`

1. Copy `docker-compose.yml` and `.env.example` from the release's tag into a deploy directory on the server, and rename the copy to `.env`.
2. Restrict it: `chmod 600 .env`.
3. Generate the two keys. Run the command twice; the server refuses to start when a value is shorter than 32 bytes or the two are equal:

   ```bash
   openssl rand -hex 32   # ADIUTOR_AUTH_SECRETS, written as 1:<value>
   openssl rand -hex 32   # ADIUTOR_SETTINGS_KEYS, written as 1:<value>
   ```

   Generate both keys and the database password (step 1) new, on the server, with these `openssl rand` commands. Never reuse a value from the development stack's `stack.env` or `.env.dev` in production: the first launch starts with a new, empty database, so nothing needs the development keys.

4. Fill in every value; `.env.example` explains each one:
   - `VERSION`: the release to run, for example `0.1.0`.
   - `DOMAIN`: the host name you open, for example `adiutor.example.com`.
   - `DATABASE_URL`: from step 1.
   - `ADIUTOR_PUBLIC_URL`: exactly the origin the browser's address bar shows: `https://` and `DOMAIN`, plus `:<port>` when the proxy's entry point is not on 443. Any difference makes every browser change fail with 403 (invalid origin), sign-in included. Telegram links use it, and the same value goes into every `--url` of `adiutor connect` (section 6). Write the full value, for example `https://adiutor.example.com`, instead of the example's `https://${DOMAIN}`, and check that the server gets it resolved: `docker compose config` shows the environment the container receives.
   - `ADIUTOR_AUTH_SECRETS`: `1:<value>` from step 3. Better Auth signs the sign-in cookies and encrypts the TOTP secret and the backup codes with it. To rotate, put a new version first and keep the old one (`2:<new>,1:<old>`): every browser signs in again, and the stored TOTP secret stays readable while the old version is listed.
   - `ADIUTOR_SETTINGS_KEYS`: `1:<value>` from step 3. It encrypts the secrets you store in Settings (the Telegram bot token), and must differ from the auth secret. Rotate it the same way; a stored value whose version is no longer listed must be entered again in Settings.
   - `ADIUTOR_TRUSTED_PROXIES`: the address (or CIDR range) Traefik uses to reach `adiutor` on the `traefik` network, for example the network's subnet from `docker network inspect traefik`. Better Auth then reads the client address from `X-Forwarded-For` (step 3). Prefer Traefik's own fixed address when you can give it one: the whole subnet trusts every container on that network, and any of them can reach `adiutor:8080` directly and forge `X-Forwarded-For`. That weakens only the per-address rate limits; sign-in and agent keys are still required.
   - Keep backups of `.env` with the database backup: with other keys every browser is signed out, the TOTP secret cannot be read, and the stored bot token must be entered again.

   Everything else you manage in Adiutor itself, in Settings: the Telegram bot token and chat id, sending sign-in codes to Telegram, the private domains of the secret check, the connected agents and how long a browser stays signed in. `ADIUTOR_TELEGRAM_BOT_TOKEN`, `ADIUTOR_TELEGRAM_CHAT_ID` and `ADIUTOR_PRIVATE_DOMAINS` may still be set here: each then overrides its field, and Settings shows that field locked. Leave `TELEGRAM_API_URL` empty. Never set a `BETTER_AUTH_*` variable: the server refuses to start with one, because Better Auth would read it on its own. It refuses `ADIUTOR_AUTH_SECRET` too, even empty: that variable is no longer used, and `ADIUTOR_AUTH_SECRETS` holds the auth keys.

## 3. Fit the network

Adiutor must be reachable only over your NetBird network. The shipped `docker-compose.yml` puts it behind Traefik on the external Docker network `traefik`, publishes no port, and asks Traefik for one router:

| Label                                              | Shipped value  | Change it to                                                                           |
| -------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------- |
| `traefik.docker.network` and the `networks:` entry | `traefik`      | The Docker network your reverse proxy uses                                             |
| `traefik.http.routers.adiutor.entrypoints`         | `https`        | Your proxy's entry point that only NetBird can reach                                   |
| `traefik.http.routers.adiutor.middlewares`         | `default@file` | Your middleware chain (headers, and an allow list of NetBird addresses if you use one) |
| `traefik.http.routers.adiutor.tls`                 | `true`         | Add `traefik.http.routers.adiutor.tls.certresolver=<resolver>` if your proxy needs it  |

1. Put a NetBird private service in front of the proxy: a NetBird network resource (or route) for the proxy host, with an access policy that allows only your own peers.
2. Make `DOMAIN` resolve only inside NetBird, for example with a NetBird DNS zone or a private DNS record that points at the proxy's NetBird address.
3. Bind the proxy's entry point for Adiutor to the NetBird interface, or firewall it so that only the NetBird interface reaches it. Never publish the `adiutor` container's port on a public interface.
4. Serve HTTPS with a certificate the browsers trust; for a private name, a DNS challenge or your own CA works. With an `https://` public URL the sign-in cookies are `Secure`, so plain HTTP does not work in production.
5. With a reverse proxy other than Traefik: remove the `labels:`, attach `adiutor` to the proxy's Docker network and proxy `https://adiutor.example.com` to `http://adiutor:8080`. Pass the `Origin` header through unchanged.

**The client address and the rate limits.** Better Auth limits sign-up, sign-in, the two-factor codes and the password change to 5 attempts per 5 minutes per client address. Behind Traefik it takes that address from `X-Forwarded-For`, skipping the proxies in `ADIUTOR_TRUSTED_PROXIES`. That is safe only under two conditions, which the shipped setup meets; keep them:

- Adiutor is reachable only through Traefik: the Compose file publishes no port, and `adiutor` is only on the `traefik` network. A database network added in step 1 lets that network's containers reach `adiutor` directly as well.
- Traefik replaces the forwarding headers clients send: do not set `forwardedHeaders.insecure` or `forwardedHeaders.trustedIPs` on the entry point Adiutor uses.

Without `ADIUTOR_TRUSTED_PROXIES`, every request shares one bucket, which fails safe for one owner. Two-factor also locks sign-in for 15 minutes after 10 wrong codes. Adiutor's own limit of 10 failed agent keys a minute counts per client address too: `X-Forwarded-For` counts only when the connection comes from a proxy in `ADIUTOR_TRUSTED_PROXIES`, and otherwise the connection's address does. Without the setting, every agent and the sync behind Traefik share one count, so ten wrong keys from any of them make the others wait a minute; the owner's browser is never limited by failed keys.

## 4. Start and check

1. The image is public, like the repository: the Release workflow links the `adiutor` package on GHCR to this repository, and the server pulls it without logging in. If the first `docker compose pull` answers `denied` or `unauthorized`, the package was created private: set it to Public once, in the package's settings on GitHub (Package settings, Change visibility), and pull again.

2. In the deploy directory:

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps          # adiutor: running (healthy) after up to 30 seconds
   docker compose logs adiutor  # Adiutor <version> listening, with the port
   ```

   The migrations run before that line, which is the only one the server logs at start; there is no line of their own. A failed migration logs `Database migration failed` and the server exits instead of listening.

   Create your account (section 5) right after the container is healthy: until then, anyone on the private network who opens the address could create the owner account.

3. From a device on NetBird:

   ```bash
   curl -fsS https://adiutor.example.com/healthz
   # {"status":"ok","database":"ok"}
   ```

4. From a device outside NetBird (a phone on mobile data with NetBird off), check that the same URL does not answer.

`/healthz` answers 503 with `"database":"down"` when PostgreSQL does not answer; Docker then marks the container unhealthy.

## 5. Create your account and sign in

The browser signs in with a username, a password and a code from an authenticator app (TOTP). There is one account, yours.

1. Open `https://adiutor.example.com` on the desktop. On a new database it shows the setup: choose a username (3 to 30 letters, digits, underscores or dots; a dot cannot be first, last or next to another dot) and a password of at least 12 characters.
2. Set up two-factor authentication right away; it is required. Scan the QR code with an authenticator app such as 1Password, Aegis or Google Authenticator, or type the key shown under it, then enter the code the app shows.
3. Save the 10 backup codes the setup shows next (Copy or Download), somewhere apart from this device. They are shown only once. Each signs in once without the authenticator; the Account page (the account menu, Account) makes new ones.
4. On the phone, with NetBird connected, open the same URL and sign in with the username, the password and a code.
5. A browser stays signed in while you open Adiutor there at least once every 30 days. Settings, General changes that length (1 to 90 days); a shorter value does not shorten browsers signed in already, so choose "Sign out everywhere" after shortening it. The Account page (the account menu, Account) lists the signed-in browsers, changes the password, signs this browser out, signs the others out, signs out everywhere, makes new backup codes, and sets up a new authenticator.
6. Telegram links open the item after you sign in, when the browser is not signed in.
7. Before you enter the real bot token in production, stop the development stack (`scripts/local.sh down` in the Adiutor checkout in WSL) and make sure its Settings, Telegram hold no real bot token. Two stacks with one bot take each other's updates, and both send the morning message.
8. Settings, Telegram: enter the bot token from BotFather and your chat id (the number of your own chat with the bot), then save. The bot and the morning message start at once, without a restart. "Send sign-in codes to Telegram" is off by default; turned on, it makes your Telegram chat another way in.

## 6. Connect the agents and the reconciler

Every agent and the reconciler get their own key through `adiutor connect`, a command of the sync bundle (build it as [sync.md](sync.md) says). You approve each one in the browser on `/connect/device`, signed in with two-factor; Settings, Agent access shows the commands with your address, lists every connected agent with its end date and last request, and disconnects one or all at once. A key keeps working after you sign out.

- **Reconciler:** in the Adiutor checkout on your PC, `node dist/sync/adiutor-sync.js connect --url https://adiutor.example.com --name sync --for sync`. It writes `ADIUTOR_URL` and `ADIUTOR_AGENT_TOKEN` into `%LOCALAPPDATA%\adiutor\sync.env`, restricted to your Windows user. The T3 scheduled task in [prompts/reconcile.md](../prompts/reconcile.md) runs the sync with that file. After its first run, `GET /api/v1/sync/runs` shows the run's outcome.
- **Claude Code:** `... connect --url https://adiutor.example.com --name claude --for claude` runs `claude mcp add` itself; Claude Code keeps the key in its own user configuration. Start a new Claude Code session to use it.
- **Codex:** `... connect --url https://adiutor.example.com --name codex --for codex` sets `ADIUTOR_AGENT_KEY` for your Windows user with `setx`, then runs `codex mcp add`, so Codex's `config.toml` names the variable and never holds the key. Restart Codex from a new terminal.
- Only when a step fails does `connect` print that step's command or lines, with the key; clear them from your shell history if others can read it. [sync.md](sync.md), "Connecting an agent or the sync", has the details.
- Always pass `--url` with the value of `ADIUTOR_PUBLIC_URL`. Without it, `connect` falls back to `ADIUTOR_URL` from the environment or an existing env file, which may still point at the development stack.
- `--days` sets how long a key works (1 to 365, default 90). When it ends, run the command again. [agent-instruction.md](agent-instruction.md) has the instruction text for the agents.
- Adiutor never logs a key. Claude Code keeps its key in its configuration, and Windows keeps Codex's `ADIUTOR_AGENT_KEY` in your user environment.
- If `connect` reports that it could not end its temporary session, end the session "adiutor connect (agent approval)" on the Account page.

## 7. Move from the dry run to production (once)

**Not needed for the first launch.** The first launch starts production with a new, empty database (requirements section 9, owner's decision of 2026-11-12), so skip the numbered move below; it stays for moving a development database to production later. The notes on the development stack apply either way.

**Not into PostgreSQL 16.** The development database is PostgreSQL 18, and a PostgreSQL 18 dump is not downward compatible: its restore starts with `SET transaction_timeout`, which PostgreSQL 16 refuses. The move below works only into a production server of PostgreSQL 18 or newer. On PostgreSQL 16 the supported first launch is a new, empty database.

The dry run runs on the development stack on your PC with real data. Move its data once, after you approved the dry run (requirements section 9). Production must not run before step 5: the migrations would create empty tables that the restore cannot overwrite.

**Keys of the development stack.** `scripts/local.sh up` or `start` generates the database password and the keys once into `stack.env` in the stack's data directory (default `~/.local/share/adiutor-dev/stack.env`, mode 0600), before PostgreSQL first starts, and never rewrites it. Keep that file with the database: without it the stack refuses to start, because new keys would not open the database. `nuke` deletes both. Keys that an older `.env.dev` already sets keep winning over `stack.env`; leave them there, or move them by hand as whole values with every version listed. Interrupted on its very first start (before any data), a stack can be started over with `nuke` and `start`.

**Optional overrides in `.env.dev`.** `docker/dev.env.example` lists them. Without a `.env.dev` at the root of the Adiutor checkout in WSL, copy the example there (git ignores it) and restrict it (`chmod 600 .env.dev`). When `.env.dev` exists, never copy over it: add only the lines you need, because keys it holds may be the ones your data is encrypted with. Then enter the Telegram bot token and chat id in Settings, Telegram, and connect the agents with `adiutor connect` (section 6).

**A reverse proxy in front of the development stack.** The stack publishes its port (`ADIUTOR_PORT`, default 8090) on every interface. Set `ADIUTOR_PUBLIC_URL` in `.env.dev` to the URL the browser opens through the proxy; the access restrictions live in the proxy. Set `ADIUTOR_TRUSTED_PROXIES` only when the proxy replaces the `X-Forwarded-For` header clients send (section 3).

A `docker-compose-dev.yml` copied before these changes is refused: copy `docker/docker-compose-dev.example.yml` again, then `scripts/local.sh start`. `scripts/verify.sh` and `scripts/try-pr.sh` never read `.env.dev`. To check the bot without waiting for 08:00, use Settings, "Send a test morning message": it sends today's message now and does not change the 08:00 send.

1. Pause the reconciler's T3 scheduled task.
2. Stop the local application, and keep its database running. The local stack is the only consumer of the Telegram bot; two consumers would take each other's updates. In the Adiutor checkout in WSL:

   ```bash
   source scripts/lib/common.sh
   dev_compose stop adiutor
   ```

3. Dump the development database to a file outside every repository. It holds your real data: keep it private.

   ```bash
   mkdir -p ~/adiutor-move && chmod 700 ~/adiutor-move
   dev_compose exec -T postgres pg_dump -U adiutor -d adiutor -Fc >~/adiutor-move/adiutor.dump
   ```

4. Create the production database (step 1) and write `.env` (step 2) if you have not yet. The database must be empty: if production already started once, drop and create it again.
5. Restore the dump into it from a machine that reaches the production PostgreSQL. Use `pg_restore` from PostgreSQL 18 or newer, because the development database is PostgreSQL 18. The production server must be PostgreSQL 18 or newer too (see above): check its version first.

   ```bash
   read -rs PGPASSWORD && export PGPASSWORD   # the production role's password; stays out of the history
   docker run --rm -i -e PGPASSWORD postgres:18-bookworm \
     pg_restore --no-owner --no-privileges --exit-on-error --single-transaction \
     -h db.example.com -U adiutor -d adiutor <~/adiutor-move/adiutor.dump
   unset PGPASSWORD
   ```

   The dump carries everything, including the applied migrations, `job_runs` (so today's morning message is not sent twice) and `telegram_updates` (so no Telegram update is handled twice).

6. Start production and check it (step 4).
7. Sign in with your dry-run account and sign out everywhere (step 8, "After any restore"). Sign-in cookies belong to a host, so the browsers signed in on the PC are not signed in on the production host anyway. Use the dry run's `ADIUTOR_AUTH_SECRETS` and `ADIUTOR_SETTINGS_KEYS` in production's `.env` (or list them after new versions): otherwise the stored TOTP secret, the backup codes and the bot token cannot be read. The backup codes are encrypted with the same key, so they do not help then; see "Lost an auth secret" in step 8.
8. Point the reconciler's env file at production: `ADIUTOR_URL=https://adiutor.example.com`, with its agent key (the keys moved with the database). Resume its scheduled task and check its first run.
9. Point the agents' MCP configuration at production (step 6).
10. Keep the local stack off: `scripts/local.sh down`. Before you ever start it again, remove the bot token in its Settings (or reset its database), so it never polls the real bot.
11. Delete the dump: `rm -r ~/adiutor-move`.

## 8. Recovery and after any restore

**Forgot the password:** on the server, in the deploy directory, run

```bash
docker compose exec adiutor node dist/server/cli.js reset-password
```

It runs Better Auth's own password reset: it prints the username and a new random password once, signs out every browser, and records the reset in the activity log (actor "system", source "server command"). Two-factor stays: sign in with the new password and the authenticator, or a saved backup code, then change the password on the Account page. A sign-in that someone started before the reset with your old password and a current code can still finish within 3 minutes (G3); check the browsers list afterwards.

**Lost the authenticator:** sign in with the password and a saved backup code ("Use a backup code"), then the Account page, "Set up a new authenticator". With the password lost too, run the command above first. Finish the setup right away: until the new authenticator is verified, two-factor is off and the password alone signs in, from any browser, and leads to the setup (G-C in the foundation plan).

**Lost the authenticator and every backup code,** with no browser still signed in and sign-in codes to Telegram off: there is no supported way back; only editing the database by hand (G4 in the foundation plan). Keep the backup codes safe, and make new ones when they run low.

**Lost an auth secret.** Better Auth encrypts the TOTP secret and the backup codes with `ADIUTOR_AUTH_SECRETS`. A backup code is therefore no way back when the key that encrypted it is gone: both it and the TOTP secret can be read only with that key. When sign-in codes to Telegram are on and reach you, and the settings key that encrypts the bot token was kept (`ADIUTOR_SETTINGS_KEYS`), there is another way: sign in with the password and a code sent to Telegram ("Send a code to Telegram instead"), then the Account page, "Set up a new authenticator": it turns two-factor off with the password and enrols a new authenticator, with new backup codes; finish it right away, as above. Only when no such sign-in path is available is the way back to put the old key back: list it again in `ADIUTOR_AUTH_SECRETS` under its old version (after a newer one, if you rotated, for example `2:<new>,1:<old>`), and run `docker compose up -d`. So keep every auth secret you ever used with the backup of `.env`, and remove an old version only after you set up the authenticator and made new backup codes under the new one. Without the old key the stored factor cannot be read; Adiutor has no recovery for that beyond editing the database by hand (G4). The same holds for `ADIUTOR_SETTINGS_KEYS` and the stored bot token, which you can simply enter again in Settings.

**After any restore**, whether a dry-run move or a backup: a restored database can hold sign-ins that you ended after the backup was taken, and agent keys you revoked since. So:

1. Sign in and choose the Account page, "Sign out everywhere", then sign in again. When you cannot sign in, the recovery command above also signs out every browser.
2. Open Settings, Agent access and disconnect every agent you do not recognise or had disconnected.
3. If `.env` or the backup may have leaked, put a new version first in `ADIUTOR_AUTH_SECRETS` (keep the old one listed so the TOTP secret stays readable) and run `docker compose up -d`: every browser is signed out. Replace the agent keys, and the Telegram bot token with BotFather.

## 9. Upgrade

1. Read the release notes of the new version on the repository's Releases page.
2. Back up the Adiutor database with your own tools. Migrations only move forward; the backup is the way back.
3. Set `VERSION` in `.env` to the new version.
4. Run the commands below.

   ```bash
   docker compose pull
   docker compose up -d
   docker compose ps   # healthy again
   ```

5. Check `/healthz` (step 4) and open the board.

To go back to an earlier version, restore the backup from step 2, set the earlier `VERSION`, start it, and follow "Recovery and after any restore" (step 8).
