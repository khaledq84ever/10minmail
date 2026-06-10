# 10MinMail

Disposable 10-minute temporary email web app. Each visitor instantly gets a real,
working throwaway address that receives real inbound mail — use it to register on any
site, read the message, then let it auto-expire.

**Live:** https://10minmail-production.up.railway.app

## How it works
- Frontend-only static app (`index.html` + `app.js`, Tailwind via CDN).
- Mail backend is the public **mail.tm** API — it owns the domain (`wshu.net`) and the
  real MX records, so addresses actually receive email. No mail server to run.
- Per-browser session stored in `localStorage`; survives refresh until the timer ends.

## Features
- Random address auto-generated on load, one-click copy.
- 10-minute countdown (green → amber under 2 min → red under 30 s).
- **Extend +10 min** (capped at 60 min total), **New address**, **Refresh**.
- Inbox auto-polls every 5 s; "new mail" toast; click to read.
- HTML emails rendered inside a sandboxed `<iframe>` (no script execution / breakout).
- On expiry the mailbox is deleted via the API and the inbox is wiped.

## Run locally
```bash
npm install
npm start      # serves on http://localhost:3000
```

## Deploy (Railway)
```bash
railway up --detach
railway domain      # prints the public URL
```
Static serving is done by `serve` (see `package.json` start script, binds `$PORT`).

## Notes / limits
- mail.tm is a shared free service with rate limits (~8 req/s) and its own retention —
  fine for throwaway signups, **never for sensitive accounts**.
- Want fully-owned addresses on your own domain instead of mail.tm? Swap the backend for
  Cloudflare Email Routing → Worker → webhook (see the build-prompt notes).
