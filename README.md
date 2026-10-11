# Visual Arc — REAL numbers server

This version of Visual Arc rents **real US phone numbers** and receives **real SMS**.

## Run

```bash
node server.js        # serves on http://localhost:5050
```

- No keys in `.env` → runs in **demo mode** (simulated numbers).
- Twilio or Telnyx keys in `.env` → **LIVE MODE**: real numbers, real SMS.

## Setup

1. Copy `.env.example` to `.env`
2. Paste your Twilio (easiest) or Telnyx keys
3. `node server.js`
4. The server tells the provider where to send incoming SMS (webhook) automatically.

## Files

| File | Purpose |
|---|---|
| `server.js` | API + webhooks + static hosting (zero dependencies) |
| `providers.js` | Twilio & Telnyx integration |
| `index.html` | The Visual Arc website (live mode + demo fallback) |
| `db.json` | Local storage of rentals & messages (auto-created) |

## API

| Endpoint | What it does |
|---|---|
| `GET /api/status` | `{real, provider}` |
| `POST /api/rent` | Rent a real US number |
| `GET /api/rentals/:id` | Poll for received messages |
| `POST /api/rentals/:id/release` | Release the number |
| `POST /webhooks/twilio` | Twilio delivers inbound SMS here |
| `POST /webhooks/telnyx` | Telnyx delivers inbound SMS here |
