# Deploying MarketingBrain (Phase 8)

One Fly.io machine in Toronto plus a Neon Postgres database in Canada.
Roughly CAD 10–15 a month before LLM usage. No staging: this is an
internal single-user tool, and the safety nets are mock mode, PAUSED
creation, the policy gates and the platforms' own spend caps.

What is in the repo already:

| File | Role |
|---|---|
| `Dockerfile` | Builds the web bundle, ships API + web + scheduler in one image |
| `fly.toml` | One machine, never stopped, `/health` check, volume at `/app/data`, migrations as the release command |
| `.github/workflows/deploy.yml` | Push to `main` → `flyctl deploy --remote-only`, 10-minute cap |

Everything below is run by you, once. Commands are for PowerShell 5.1.
Placeholders are in capitals with `PASTE_` in front; replace every one
before pressing Enter.

## 1. Accounts

- **Fly.io**: sign up at fly.io, add a payment method (required even on
  the pay-as-you-go plan).
- **Neon**: sign up at neon.tech. Create a project named `marketingbrain`,
  Postgres 16. Neon has no Canadian region; **US East (Ohio)** was chosen
  on 2026-10-08 because this is a personal tool holding ad metrics and
  org-level ids, never people. Copy the
  **direct** connection string, not the pooled one: the host must **not**
  contain `-pooler`. The job scheduler needs a session-level connection
  (advisory locks and LISTEN/NOTIFY), which Neon's pooler does not give.
  Keep the `sslmode=require` that Neon includes.

## 2. Install flyctl and sign in

```powershell
winget install --id Fly.Flyctl -e
```

Open a new PowerShell window afterwards so `fly` is on the PATH, then:

```powershell
fly auth login
```

A browser opens; sign in. You should see *successfully logged in as …*.

## 3. Create the app and its volume

From the repo folder. `--no-deploy` creates the app without deploying;
`--copy-config` keeps the committed `fly.toml`. Say **no** to Postgres and
Redis if it offers them.

```powershell
fly launch --no-deploy --copy-config --name vibemarketingbrain --region yyz
```

If the name is taken, pick another and change the `app = "…"` line in
`fly.toml` to match, then commit that change.

```powershell
fly volumes create data --region yyz --size 1 --yes
```

## 4. Google sign-in

In Google Cloud Console → APIs & Services → Credentials → Create
credentials → OAuth client ID → Web application:

- Authorized redirect URI: `https://vibemarketingbrain.fly.dev/auth/google/callback`
  (use your app name if different)

Copy the client ID and client secret.

## 5. Secrets

Secrets go in through a file, never on the command line, so nothing lands
in your PowerShell history. The file name `.env.fly` is already ignored
by git. Create it in the repo folder with Notepad:

```powershell
notepad .env.fly
```

Paste these lines and replace every placeholder. The TryoutBrain token
must be the **rotated** one, never the one that was pasted into chat.

```
DATABASE_URL=PASTE_NEON_POOLED_CONNECTION_STRING
APP_SECRET=PASTE_48_RANDOM_HEX_CHARACTERS
ALLOWED_EMAILS=evan@elitesultimate.com
PUBLIC_BASE_URL=https://vibemarketingbrain.fly.dev
GOOGLE_CLIENT_ID=PASTE_GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET=PASTE_GOOGLE_CLIENT_SECRET
```

To make the random value for the second line:

```powershell
-join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
```

Optional lines, each turning a mock into the real thing (Google Ads tokens
are Phase 5; leave them out until then):

```
ANTHROPIC_API_KEY=PASTE_ANTHROPIC_KEY
TRYOUTBRAIN_EXPORT_URL=https://tryoutbrain.com/api/internal/marketing/events
TRYOUTBRAIN_EXPORT_TOKEN=PASTE_ROTATED_TRYOUTBRAIN_TOKEN
META_ACCESS_TOKEN=PASTE_META_SYSTEM_USER_TOKEN
META_AD_ACCOUNT_ID=act_1082877204521539
META_PAGE_ID=1361698740353589
```

The Meta ad account id and Page id are identifiers, not secrets; the token
is. After the Meta lines are set, re-run the seed (step 7): it records the
account row with the currency and timezone Meta reports and mirrors the
account's structure. Reads only until Phase 12.

Save, close Notepad, then load the file into Fly and delete it:

```powershell
Get-Content .env.fly | fly secrets import
```

```powershell
Remove-Item .env.fly
```

You should see the secret names listed (never the values) and
*Secrets are staged for the first deployment*.

## 6. First deploy

```powershell
fly deploy --remote-only
```

The release command applies the migrations, then the machine starts. You
should see *1 desired, 1 placed, 1 healthy*. Then:

```powershell
fly status
```

Open `https://vibemarketingbrain.fly.dev`. Google sign-in should take you
to Today with no brand yet.

## 7. Seed the brand

Creates the TryoutBrain brand, its facts and policy:

```powershell
fly ssh console -C "node_modules/.bin/tsx scripts/seed.ts"
```

Until real ad accounts exist, add the mock ad account too (every screen
labels its numbers as mock; it is one `channel_accounts` row you can delete
later):

```powershell
fly ssh console -C "env SEED_MOCK_ACCOUNT=true node_modules/.bin/tsx scripts/seed.ts"
```

Reload Today. From here the morning job runs at 06:00 (machine time is
UTC; the brand's timezone is used for windows).

## 8. Deploys from GitHub

Create a deploy token and store it as a repository secret named
`FLY_API_TOKEN` (GitHub → repo → Settings → Secrets and variables →
Actions):

```powershell
fly tokens create deploy -x 999999h
```

Every push to `main` then deploys. Tests still run locally before each
push, and on pull requests in CI, never on push (Actions minutes).

## Day-to-day

| Need | Command |
|---|---|
| Logs | `fly logs` |
| A shell | `fly ssh console` |
| Change a secret | Put the line in `.env.fly` again and repeat the import (restarts the machine) |
| Roll back | `fly releases` then `fly deploy --image PASTE_IMAGE_REF_FROM_LIST` |
| Pause the scheduler | `fly secrets set JOBS_ENABLED=false` (not a secret, so the command line is fine) |

## Cost

| Item | Estimate |
|---|---|
| Fly shared-cpu-1x, 1 GB, always on | about USD 6 / month |
| Fly volume, 1 GB | about USD 0.15 / month |
| Neon free tier (0.5 GB) | USD 0 (Launch plan USD 19 if it outgrows) |
| LLM usage | capped by `monthlyAiBudgetMicros` in the brand policy (CAD 100) |

## What the deploy does not change

- The AI still only proposes; the executor still creates everything PAUSED.
- Secrets live in Fly's secret store, never in the image, the database or logs.
- The app runs in Toronto; the database is in Neon US East (Ohio), a deliberate exception to the Canada rule for this personal tool.
