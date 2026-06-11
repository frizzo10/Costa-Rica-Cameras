# TheDeck AI — Setup Guide

Camera motion alert → email → CloudMailin → Netlify Function → Claude Vision →
Supabase log + WhatsApp. Works with **any camera brand that can send email
alerts** (Reolink, Ring, Wyze, Eufy, Hikvision, generic — basically all of them).

## 1. Supabase (5 min)
1. New project (or reuse an existing one).
2. SQL editor → run `supabase-schema.sql`.
3. Storage → New bucket → name `deck-snapshots` → **Public: ON**.
4. Note your project URL, **anon** key (for index.html), and **service_role**
   key (for Netlify env vars only).

## 2. Netlify (5 min)
1. Repo layout:
   ```
   index.html
   netlify/functions/alert-ingest.js
   ```
2. Deploy to the thedeckai site.
3. Site settings → Environment variables:
   - `ANTHROPIC_API_KEY`
   - `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
   - `TWILIO_WHATSAPP_FROM` (sandbox: `whatsapp:+14155238886`)
   - `ALERT_WHATSAPP_TO` (e.g. `whatsapp:+506XXXXXXXX`)
   - `INGEST_SECRET` (any random string)
4. Edit the two config lines at the top of `index.html` (URL + anon key).

Your ingest endpoint:
`https://thedeckai.netlify.app/.netlify/functions/alert-ingest?key=YOUR_INGEST_SECRET`

## 3. Twilio WhatsApp (10 min)
1. twilio.com → Messaging → Try WhatsApp (sandbox is free to start).
2. From your phone, send the join code to the sandbox number.
3. For production later: register a WhatsApp sender (or just use SMS —
   swap `whatsapp:` prefixes for plain numbers and it works as-is).

Note: sandbox sessions expire after 24h of inactivity — you re-send the join
code. Fine for testing; register a sender when you're happy with it.

## 4. CloudMailin (10 min)
1. cloudmailin.com → free tier gives you an inbound address.
2. Set the target to your ingest endpoint URL (with `?key=...`).
3. Format: **JSON (Normalized)**, attachments **embedded (base64)**.

## 5. Point the 9 cameras at it (the homework)
In each camera's app, enable **email alerts on motion, with snapshot
attached**, sending to your CloudMailin address.

Camera naming — two options:
- Put the camera name in the alert subject (most apps do this automatically), or
- Use plus-addressing per camera: `yourbox+frontgate@cloudmailin.net`,
  `yourbox+pool@...` — the function reads the name after the `+`.

## 6. Test
Send any email with a photo attached to the CloudMailin address. Within a few
seconds you should see: a row on the dashboard with Claude's verdict, and (if
threat ≥ 2) a WhatsApp message with the photo.

## Tuning
- `MIN_THREAT_TO_NOTIFY` env var: `1` = everything, `2` = default, `3` = urgent only.
- The classification prompt lives in `classify()` — tell Claude about your
  regulars ("a brown dog and workers in green Café Franco shirts are expected")
  to cut noise further.

## Costs (ballpark)
- Netlify functions + Supabase: free tier covers this easily.
- CloudMailin free tier: 200 emails/mo (paid ~$9 if the jungle is chatty).
- Claude Vision: fractions of a cent per snapshot.
- Twilio WhatsApp: ~$0.005–0.05 per message depending on country/type.

## What this does NOT do yet
Live video on the website. With cloud-only and mixed brands, live view depends
on what the cameras are — once you check which app(s) they live in, we can add
a camera grid (Reolink has web view, UniFi has an API, Ring/Wyze we'd deep-link
to their apps).
