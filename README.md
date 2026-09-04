# BrainWash Castricum Booker

Deployable Node/Playwright dashboard for the booking preferences configured in this chat:

- Salon: **BrainWash Castricum**
- Treatment: **Wassen, knippen, drogen Heer** (the current Aimy label for the requested men's wash-and-cut service)
- Stylist: **no preference**
- Preferred times: **Tuesday–Friday from 17:00**, **any time Saturday**
- Default cadence: **monthly**
- Default mode: **approval before booking**

## What is live

`Check live availability` launches Chromium on the server, opens the official BrainWash Castricum booking route, selects **Heren**, confirms the category, chooses **Wassen, knippen, drogen Heer**, continues by date with **Geen voorkeur**, expands each relevant day's complete time list, and extracts matching appointment times.

The app keeps a connector diagnostic (current URL, visible controls and a text excerpt). This is intentional: Aimy does not expose a documented public customer-booking API, so the DOM automation can require a selector adjustment after their UI changes.

## Safety gate for real booking

Real final submission is controlled by the environment variable:

```text
BOOKING_ENABLED=false
```

Keep it `false` for the first live availability test. When a candidate is approved, the connector will re-open the flow and try to reach/fill the final form, but will stop before submission. After you have verified the diagnostic and the correct treatment/date/time, set:

```text
BOOKING_ENABLED=true
```

Then redeploy/restart. Approval mode still requires a click in the dashboard. Auto mode can also be selected after this gate is enabled.

## Run locally

Requirements: Node.js 22+.

```bash
npm install
npx playwright install chromium
npm start
```

Open http://localhost:3000

## Docker

```bash
docker build -t brainwash-booker .
docker run --rm -p 3000:3000 \
  -e BOOKING_ENABLED=false \
  -v brainwash-data:/app/data \
  brainwash-booker
```

## Deploy online (Railway / Render / Fly.io / VPS)

Use the included Dockerfile. Configure:

- `PORT=3000` (most hosts override this automatically)
- `TZ=Europe/Amsterdam`
- `DATA_DIR=/app/data`
- `HEADLESS=true`
- `BOOKING_ENABLED=false` initially

Attach a persistent volume mounted at `/app/data`; otherwise profile/settings/history can disappear on redeploy.

### Railway outline

1. Create a new project from this folder/repository.
2. Railway detects the Dockerfile.
3. Add a persistent Volume mounted at `/app/data`.
4. Add the environment variables above.
5. Generate a public domain.
6. Open the dashboard, enter your contact details, and run **Check live availability**.
7. Review the Aimy diagnostic. Only then enable `BOOKING_ENABLED=true`.

## Scheduler

The server contains two schedulers, both using `Europe/Amsterdam`:

- monthly: 09:00 on the first day of every month;
- every 4 weeks: a daily 09:05 trigger that only runs when at least 28 days have elapsed since the last check.

In approval mode, a scheduled run saves matching candidates for you to approve later. In auto mode, the earliest matching candidate is submitted only when `BOOKING_ENABLED=true` and the saved contact profile is complete.

## Important operational note

Browser automation against a third-party booking website is inherently less stable than an API integration. If Aimy changes the booking flow, the dashboard will preserve diagnostics instead of guessing. Re-test after any UI change before enabling automatic booking again.
