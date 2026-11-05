# Shopping & Returns Tracker

A personal, phone-friendly app that tracks purchases and returns, and follows every refund until **you** confirm the money reached your account.

> **Current status: Stage 3 of 4.** Real Gmail import (read-only) for Amazon and AI return-policy review work. Push/email notifications and background sync come in Stage 4. Sample data is still available and always labeled.

## Run it

You need [Node.js](https://nodejs.org) 22.9 or newer (`node -v` to check).

```bash
npm install          # download dependencies (first time only)
npm start            # http://localhost:3000
npm test             # run the automated tests
```

Then open Settings → **Load sample data** to explore, or connect Gmail (below).

## Connect Gmail

1. In Google Cloud, enable the Gmail API, set up the consent screen (External, Testing, yourself as a test user, scope `gmail.readonly`), and create a **Web application** OAuth client with redirect URI `http://localhost:3000/auth/google/callback`.
2. `cp .env.example .env` and fill in `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`. `.env` is git-ignored.
3. `npm start`, open **http://localhost:3000** on the same computer, go to Settings → **Connect Gmail**, approve, then tap **Sync emails**.

Things to know:
- **Read-only.** The app asks only for `gmail.readonly` and refuses to connect if Google grants anything broader.
- **Weekly reconnect.** While your Google app is in Testing mode, Google expires access after about 7 days. The app shows a **Reconnect** button when that happens.
- **First sync** looks back 180 days. Later syncs only look at recent mail, and emails already imported are never downloaded twice.
- **Spoof protection.** Only mail from real `amazon.com` addresses is used, and return label/QR links are only kept if they point to `amazon.com`.
- **Parser limits.** Amazon doesn't publish its email formats. Anything the parser can't read confidently goes to "Emails that need a look", with a link to open it in Gmail.

## Turn on AI policy review

1. Create an API key at **console.anthropic.com** (Settings → API keys) and add billing credit.
2. Add `ANTHROPIC_API_KEY=...` to `.env` and restart.
3. Tap **Review now** on the dashboard, or **Review policy with AI** on an item.

How it stays honest:
- The AI may only read pages on the retailer's own site (plus a policy link you add). The API's domain filter enforces this.
- Every rule must come with an exact quote, and the app checks each quote against the page the AI actually fetched. Rules that can't be verified are dropped and the item is flagged **Needs review**.
- The app, not the AI, computes the dates from the verified rules. Third-party sellers are never marked better than **Estimated**.
- If you've corrected an item's deadline, new AI results become suggestions you can accept or reject.
- Reviews only run when you tap a button, and each one uses a little of your Anthropic credit. Sample items are never sent.

## Use it from your phone

By default the app only accepts connections from the computer it runs on. To open it from your phone on the same Wi-Fi, set `APP_PASSWORD=something-long` in `.env` and restart. Then visit `http://<your-computer's-IP>:3000` and log in with any username and that password. Connect Gmail from the computer itself (Google only redirects back to `localhost`); after that, syncing works from the phone.

## Stages

| Stage | Contents | Status |
|---|---|---|
| 1 | Data model, the nine item stages, deadline and refund math, email-matching pipeline, dashboard, item page, tests | ✅ Done |
| 2 | Gmail OAuth (read-only), Amazon email parser, "Sync emails", optional app password | ✅ Done |
| 3 | AI return-policy review with verified quotes, policy links you supply, accept or reject suggestions | ✅ Done |
| 4 | Background sync, push or email notifications, more retailers | Next |

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
  gmail/
    oauth.js        Google sign-in (read-only scope, scope check)
    account.js      stores/refreshes the token in the local database
    client.js       read-only Gmail API calls + email decoding
  retailers/
    index.js        registry: Gmail search + parser per retailer
    amazon.js       Amazon email parser
  services/sync.js  "Sync emails": fetch → skip seen → parse → import
  ai/policyReview.js  what's sent to the AI, its rules, and quote verification
  services/policyReviews.js  batches items, saves verified results
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

Everything, including your Gmail token, lives in `data/tracker.sqlite` on the machine running the app. Nothing is stored in the browser or in git.

- **Gmail → app:** only emails matching the Amazon search. The app keeps the extracted details (order number, items, prices, dates, links) and the subject, not full email bodies.
- **App → Anthropic (only when you tap a review button):** the store name, each item's name and seller, its order, delivery and return dates, and any policy link you added. *Not* sent: prices, order numbers, payment methods, your email address or any email text.
