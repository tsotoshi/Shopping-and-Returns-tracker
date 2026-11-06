# Shopping & Returns Tracker

A personal, phone-friendly app that tracks purchases and returns, and follows every refund until **you** confirm the money reached your account.

> **Current status: all 4 stages built.** Read-only Gmail import for Amazon, AI return-policy review, refund follow-up, background sync, and reminders (in-app, phone push via ntfy, optional email). Sample data is still available and always labeled.

## Run it

You need [Node.js](https://nodejs.org) 22.13 or newer (the database is built into Node, so nothing needs compiling) (`node -v` to check).

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

## Reminders and notifications

The app creates reminders when a return deadline is near (default: 3 days before, plus the last day), a drop-off is due, a refund should have arrived, a refund is overdue, or Gmail needs reconnecting. Each reminder happens **once**. Snoozing a refund check ("Not yet") allows a new reminder on the new date.

- **In the app:** the **Alerts** tab.
- **Phone push (ntfy):** install the free *ntfy* app, then in Settings → Notifications, copy the generated topic, subscribe to it in ntfy, and tap **Turn on**. Item names are left out of push messages unless you turn that on, because anyone who knows the topic can read them.
- **Email (optional):** add your provider's SMTP settings to `.env` (see `.env.example`), then enable it in Settings. The app never sends through Gmail; that connection stays read-only.
- **Quiet hours** (default 9pm–8am): reminders wait until morning. Sample-data reminders stay in the app.

**Background checks** run every 15 minutes while the app is running: Gmail sync when due (default every 6 hours, adjustable or off), optional automatic AI reviews (off by default, since they cost money), then reminders. On a computer that's asleep, nothing runs until it wakes up.

## Other stores

Besides Amazon, sync looks for order emails from **any store**, using Gmail's own *Purchases* category plus order-related subject words, and skipping promotions. For each email:
- **Best case:** the store includes a standard machine-readable order summary (schema.org, the data Gmail uses for order "highlights"), which gives items, prices and status.
- **Otherwise:** general rules (subject wording, "Order #…", "Quantity:" lines). Emails with no order number are skipped, and listed in Settings → *Emails the app skipped*.
- **Not shopping:** rides, food delivery, banks, payment apps and subscriptions are ignored. Any store can be turned off with *Stop tracking* on one of its items.
- **Return policies:** the AI review reads each store's policy on that store's own website.

## Amazon order details (optional)

Amazon's emails often give only a category ("Household Supplies") and an order total. If you turn this on, the app uses the open-source [amazon-orders](https://github.com/alexdlaird/amazon-orders) tool to read your **Amazon order pages** during each sync and fill in real **product names, prices, sellers and Amazon's own return dates** (shown as *Confirmed*). Orders no email covered are added too. Emails remain the source for returns and refunds.

Setup (one time):
1. Install Python from **python.org**. That installer doesn't need Apple's developer tools.
2. In the app folder:
   ```bash
   python3 -m venv .venv
   .venv/bin/pip install "amazon-orders[browser]==5.2.1"
   .venv/bin/amazon-orders login --browser
   ```
   The last command opens a browser window to sign in to Amazon. Your password is never stored, only the session, on your computer.
3. Restart the app, then turn it on in Settings → *Amazon order details*.

What to know: it only reads your order history, but the saved session is a full Amazon sign-in kept on your computer (like staying logged in to a browser). Amazon doesn't officially support tools like this, so you may occasionally see extra security checks, and it can stop working until updated when Amazon changes its site. To revoke it: Amazon → *Your Account* → *Sign out of all devices*. When the session expires, the app shows an alert with the one command to run again.

How names are matched: by Amazon item ID or shared words first. If an order's items can't be told apart (category names with no shared words), real names are still filled in, with a note to swap with *Rename* if needed. This is never done for items with a return in progress. Your own renames are never overwritten.

## Use it from your phone

By default the app only accepts connections from the computer it runs on. To open it from your phone on the same Wi-Fi, set `APP_PASSWORD=something-long` in `.env` and restart. Then visit `http://<your-computer's-IP>:3000` and log in with any username and that password. Connect Gmail from the computer itself (Google only redirects back to `localhost`); after that, syncing works from the phone.

## Stages

| Stage | Contents | Status |
|---|---|---|
| 1 | Data model, the nine item stages, deadline and refund math, email-matching pipeline, dashboard, item page, tests | ✅ Done |
| 2 | Gmail OAuth (read-only), Amazon email parser, "Sync emails", optional app password | ✅ Done |
| 3 | AI return-policy review with verified quotes, policy links you supply, accept or reject suggestions | ✅ Done |
| 4 | Background sync, reminders, Alerts tab, phone push (ntfy), optional email, quiet hours | ✅ Done |

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
    index.js        registry: Gmail search + parser per store group
    amazon.js       Amazon email parser
    generic.js      every other store (schema.org markup, then general rules)
  integrations/amazonSite.js  optional Amazon order-page details (amazon-orders)
tools/amazon_orders_bridge.py  the small Python helper the app runs for that
  services/sync.js  "Sync emails": fetch → skip seen → parse → import
  ai/policyReview.js  what's sent to the AI, its rules, and quote verification
  services/policyReviews.js  batches items, saves verified results
  services/reminders.js  what deserves a reminder (each happens once)
  services/scheduler.js  background sync, optional reviews, reminders
  notify/channels.js  ntfy push + SMTP email, quiet hours, retries
  settings.js     every setting with its type, limits and default
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
- **App → ntfy (only if you turn on phone notifications):** reminder text. Item names are left out unless you opt in.
- **App → your email provider (only if you set up email):** reminder text, including item names.
- **App → Anthropic (when you tap a review button, or if you turn on automatic reviews):** the store name, each item's name and seller, its order, delivery and return dates, and any policy link you added. *Not* sent: prices, order numbers, payment methods, your email address or any email text.
