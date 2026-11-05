# Shopping & Returns Tracker

A personal, phone-friendly app that tracks purchases and returns, and follows every refund until **you** confirm the money reached your account.

> **Current status: Stage 1 of 4.** The interface and all the core logic work, but only with clearly labeled **sample data**. Gmail import, AI policy review, and notifications haven't been built yet, and the app says so wherever they'd appear.

## Run it

You need [Node.js](https://nodejs.org) 22.9 or newer (`node -v` to check).

```bash
npm install          # download dependencies (first time only)
npm start            # http://localhost:3000
npm test             # run the automated tests
```

Then open Settings → **Load sample data**. To use it on your phone, have the phone on the same Wi-Fi and visit `http://<your-computer's-IP>:3000`.

Optional: `cp .env.example .env` to change the port or database location. `.env` is git-ignored.

## Stages

| Stage | Contents | Status |
|---|---|---|
| 1 | Data model, the nine item stages, deadline and refund math, email-matching pipeline, dashboard, item page, tests | ✅ Done (sample data) |
| 2 | Gmail OAuth (read-only), Amazon email parser, "Sync emails" | Next |
| 3 | AI return-policy review, policy links you supply, accept or reject suggestions | Planned |
| 4 | Background sync, push or email notifications, more retailers | Planned |

## How it's organized

```
src/
  lib/            Pure logic, no database (easy to test)
    dates.js        calendar & business-day math, US bank holidays
    stages.js       the 9 stages; email evidence only moves forward
    deadlines.js    return & drop-off deadlines + confirmed/estimated/needs_review
    refunds.js      posting windows, partial refunds, confirm/snooze/problem
    matching.js     matching email item names to known items
  services/
    ingest.js       ONE parsed email → orders/items/events (duplicate-safe)
    items.js        every user action & email effect on items/refunds/policies
    queries.js      dashboard, list, detail
  retailers/        retailer registry (parsers plug in here in Stage 2)
  sample/           labeled sample data, imported through the real pipeline
  db.js           SQLite schema
  app.js          JSON API + serves public/
public/           the phone UI (plain HTML/CSS/JS, no build step)
test/             node:test tests
```

## Key rules built in

- **No duplicates.** Each Gmail message is imported at most once. Orders are unique by retailer and order number. Items are matched by product ID, then exact name, then truncated name, then similar name. If a match is ambiguous, the email is flagged for you to look at; the app never guesses.
- **Partial returns** split a multi-quantity line, so each part has its own stage (for example, return 1 of 3 phone cases).
- **Partial refunds** add up. A refund stays open until what you've confirmed covers the expected amount, or until you close it with a reason (for example, a restocking fee).
- **Only you close a refund.** A "refund issued" email moves the item to stage 8, never stage 9.
- **Your corrections stick.** If you edit a deadline, later automatic results are saved as suggestions you can accept or reject.
- **Honest deadlines.** Each one is marked *confirmed*, *estimated*, or *needs review*, with a plain-English explanation. Business days skip weekends and US Federal Reserve holidays, and the app tells you so.

## Your data

Everything lives in `data/tracker.sqlite` on the machine running the app. In Stage 1, **no data leaves the app**. What later stages will send, and to whom, is documented in Settings → Your data and will be expanded when those stages are built.
