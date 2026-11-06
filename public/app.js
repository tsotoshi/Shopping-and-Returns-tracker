// Frontend: a tiny single-page app with hash routes (#/, #/items, #/item/5,
// #/settings). It only talks to our own server's /api — no API keys or Gmail
// tokens ever reach the browser.

const app = document.getElementById('app');

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);
const dollars = (c) => (c == null ? '' : (c / 100).toFixed(2));
const RETAILERS = { amazon: 'Amazon' };
const store = (r) => RETAILERS[r] ?? r;
const storeName = (i) => i.merchant_name || store(i.retailer);

function niceDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function relDays(iso, today) {
  if (!iso) return '';
  const n = Math.round((Date.parse(iso.slice(0, 10)) - Date.parse(today)) / 86400000);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

async function api(path, body) {
  const res = await fetch('/api' + path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

const STATUS_BADGE = {
  confirmed: '<span class="badge ok" title="Based on a source and actual dates">Confirmed</span>',
  estimated: '<span class="badge warn" title="Some inputs were assumed">Estimated</span>',
  needs_review: '<span class="badge bad" title="Could not be determined reliably">Needs review</span>',
};
const statusBadge = (s) => STATUS_BADGE[s] ?? '';
const sampleBadge = (x) => (x?.is_sample ? ' <span class="badge sample">Sample</span>' : '');

function stageBadge(item) {
  const cls = { refund_confirmed: 'ok', need_to_return: 'warn', return_started: 'warn', refund_issued: 'info', keeping: '' }[item.stage] ?? 'info';
  return `<span class="badge ${cls}">${esc(item.stage_label)}</span>`;
}

function itemCard(i, extra = '') {
  return `<a class="card link" href="#/item/${i.id}">
    <div class="row"><div class="grow"><div class="title">${esc(i.name)}${i.quantity > 1 ? ` <span class="muted">×${i.quantity}</span>` : ''}</div>
    <div class="muted small">${esc(storeName(i))} · #${esc(i.order_number)}${i.seller ? ` · sold by ${esc(i.seller)}` : ''}</div></div>
    ${stageBadge(i)}</div>${extra ? `<div class="small" style="margin-top:6px">${extra}</div>` : ''}${i.is_sample ? '<div style="margin-top:6px"><span class="badge sample">Sample</span></div>' : ''}
  </a>`;
}

const section = (title, list, render, empty) =>
  `<h2>${title}</h2>${list.length ? list.map(render).join('') : `<div class="empty">${empty}</div>`}`;

// ---------- refund check card (the three actions) ----------
function refundCheckCard(i, today) {
  const label = { overdue: '<span class="badge bad">Overdue</span>', problem: '<span class="badge bad">Problem reported</span>', check: '<span class="badge warn">Time to check</span>' }[i.bucket] ?? '';
  return `<div class="card">
    <div class="row"><div class="grow"><a href="#/item/${i.id}" class="title">${esc(i.name)}</a>
    <div class="muted small">${esc(storeName(i))} · to ${esc(i.destination ?? 'your payment method')}</div></div>${label}</div>
    <div class="small" style="margin-top:6px">Expected ${money(i.expected_cents)} · issued by retailer ${money(i.issued_cents)} · you've confirmed ${money(i.confirmed_cents)}
    ${i.window_end ? `<br>Expected to post by ${niceDate(i.window_end)} (${relDays(i.window_end, today)})` : ''}</div>
    <p class="small muted" style="margin:6px 0 0">Please check your payment account. A "refund issued" email doesn't mean the money has arrived.</p>
    ${refundActions(i.id, i)}
    ${i.is_sample ? '<div style="margin-top:6px"><span class="badge sample">Sample</span></div>' : ''}
  </div>`;
}

function refundActions(itemId, r) {
  const issuedLeft = Math.max(0, (r.issued_cents ?? 0) - (r.confirmed_cents ?? 0));
  const suggested = issuedLeft || Math.max(0, (r.expected_cents ?? 0) - (r.confirmed_cents ?? 0));
  return `<div class="actions three">
      <button class="btn primary" data-act="received" data-id="${itemId}" data-suggest="${dollars(suggested)}">Refund received</button>
      <button class="btn" data-act="not-yet" data-id="${itemId}">Not yet — remind me again</button>
      <button class="btn danger" data-act="problem" data-id="${itemId}">Problem / wrong amount</button>
    </div><div class="act-form" data-for="${itemId}"></div>`;
}

function wireRefundActions(root, reload) {
  root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.id;
    const holder = root.querySelector(`.act-form[data-for="${id}"]`);
    try {
      if (b.dataset.act === 'not-yet') {
        const d = await api(`/items/${id}/refund/not-yet`, {});
        toast(`OK — we'll remind you again on ${niceDate(d.refund.next_check_at)}.`);
        return reload();
      }
      if (b.dataset.act === 'received') {
        holder.innerHTML = `<form class="card" style="margin-top:8px">
          <label>Amount that reached your account ($)</label><input name="amount" inputmode="decimal" value="${esc(b.dataset.suggest)}" required>
          <label>Date you saw it</label><input name="date" type="date" value="${new Date().toLocaleDateString('en-CA')}">
          <div class="actions"><button class="btn primary">Confirm</button></div></form>`;
      } else {
        holder.innerHTML = `<form class="card" style="margin-top:8px">
          <label>What's wrong?</label><textarea name="note" rows="2" placeholder="e.g. only $40 posted, expected $60" required></textarea>
          <label>Amount you did receive, if any ($)</label><input name="received" inputmode="decimal" placeholder="0.00">
          <div class="actions"><button class="btn primary">Save problem</button></div></form>`;
      }
      holder.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.target));
        try {
          if (b.dataset.act === 'received') {
            const d = await api(`/items/${id}/refund/received`, f);
            toast(d.refund.status === 'confirmed' ? 'Refund complete 🎉' : `Saved. ${money(d.refund.expected_cents - d.refund.confirmed_cents)} still outstanding — kept open.`);
          } else {
            await api(`/items/${id}/refund/problem`, f);
            toast('Problem saved. The refund stays open.');
          }
          reload();
        } catch (err) { toast(err.message); }
      });
    } catch (err) { toast(err.message); }
  }));
}

// ---------- Gmail ----------
function syncSummary(r) {
  const parts = [`${r.imported} new`, `${r.already_had} already imported`];
  if (r.ignored) parts.push(`${r.ignored} not order-related`);
  if (r.needs_review) parts.push(`${r.needs_review} need a look`);
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.ai_read) parts.push(`${r.ai_read} read by AI`);
  if (r.ai_paused) parts.push(`${r.ai_paused} waiting (AI monthly limit reached)`);
  if (r.amazonSite) parts.push(r.amazonSite.ok ? `Amazon details: ${r.amazonSite.named + r.amazonSite.created} item${r.amazonSite.named + r.amazonSite.created === 1 ? '' : 's'} updated` : `Amazon details: ${amazonError(r.amazonSite.error)}`);
  return parts.join(' · ');
}

function gmailNotice(g, hasSample) {
  if (!g.configured) return `<div class="notice">Gmail isn't set up yet — see <a href="#/settings">Settings</a>. ${hasSample ? 'Items marked "Sample" are made-up data.' : ''}</div>`;
  if (g.needsReconnect) return '<div class="notice warn">Gmail access expired — <a href="#/settings">reconnect in Settings</a>. (Google requires this about weekly while the app is in Testing mode.)</div>';
  if (!g.connected) return '<div class="notice"><a href="#/settings">Connect Gmail</a> to import your Amazon orders automatically.</div>';
  const last = g.lastRun;
  return `<p class="small muted">Gmail: ${esc(g.email)} · ${last ? `last synced ${new Date(last.finished_at || last.started_at).toLocaleString()}${last.status === 'error' ? ' (failed)' : ''}` : 'not synced yet — tap Sync emails'}</p>`;
}

async function runSync(btn, after) {
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const r = await api('/sync', {});
    toast(`Sync done: ${syncSummary(r)}`);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync emails';
    after();
  }
}

// ---------- Amazon order pages ----------
function amazonError(code) {
  return { signin_required: 'Amazon needs you to sign in again (see Settings)', not_installed: 'helper not installed (see Settings)', amazon_error: 'Amazon returned an error — try again later', bridge_failed: "the helper couldn't run (see Settings)", unexpected: 'something unexpected went wrong' }[code] ?? code;
}

function amazonSiteCard(a, s) {
  const last = a.last;
  const steps = `<ol class="small steps">
      <li>Install Python from <strong>python.org</strong> (Downloads → macOS). It doesn't need Apple's developer tools.</li>
      <li>In Terminal, in the app's folder, run these one at a time:
        <pre class="cmd">python3 -m venv .venv
.venv/bin/pip install "amazon-orders[browser]==5.2.1"
.venv/bin/amazon-orders login --browser</pre>
        The last one opens a browser window: sign in to Amazon there. Your password isn't saved — only the sign-in session, on this computer.</li>
      <li>Restart the app (<code>Ctrl + C</code>, then <code>npm start</code>) and come back here.</li>
    </ol>`;
  if (!a.available) {
    return `<p class="small">Amazon's emails often leave out product names and prices. With your permission, the app can read your <strong>Amazon order pages</strong> during each sync to fill in real names, prices, sellers, and Amazon's own return dates.</p>
      <details><summary class="small">Set it up (about 5 minutes, one time)</summary>${steps}
      <p class="small muted">What to know: this uses the open-source amazon-orders tool. It only reads your order history. Amazon doesn't officially support tools like this, so you may occasionally see extra Amazon security checks, and it can stop working until updated when Amazon changes its site.</p></details>`;
  }
  return `<form class="settings-form">
      <label class="check"><input type="checkbox" name="amazonSiteEnabled" ${s.amazonSiteEnabled ? 'checked' : ''}> <span>Get Amazon purchases from my Amazon order pages (real names, prices, return dates). Amazon emails are then only used for returns and refunds.</span></label>
      <div class="actions"><button class="btn primary">Save</button>${s.amazonSiteEnabled ? '<button class="btn" type="button" id="amazon-now">Check Amazon now</button>' : ''}</div>
    </form>
    ${last ? `<p class="small ${last.ok ? 'muted' : ''}">Last check: ${new Date(last.at).toLocaleString()} — ${last.ok ? `${last.summary.orders} orders read · ${last.summary.named + last.summary.created} names · ${last.summary.priced ?? 0} prices · ${last.summary.returnDates} return dates added` : esc(amazonError(last.error))}</p>` : ''}
    ${last && !last.ok && last.error === 'signin_required' ? '<div class="notice warn">Sign in again: in Terminal, in the app folder, run <code>.venv/bin/amazon-orders login --browser</code>, then tap Check Amazon now.</div>' : ''}
    <details><summary class="small">Setup steps (for reference)</summary>${steps}</details>`;
}

// ---------- AI email reading ----------
function aiEmailCard(ai, s) {
  const spent = ai.emailMonth ?? { cents: 0, emails: 0 };
  const intro = '<p class="small">Every store writes order emails differently. When the built-in rules can\'t read an email that looks like a purchase, <strong>Claude Haiku 5.5</strong> reads it instead. About $0.50 per 1,000 emails.</p>';
  const privacy = '<p class="small muted">Sent to Anthropic: the email\'s subject and text, with email addresses, phone numbers, card numbers and street-address lines removed. Every order number, item name and price the AI returns must appear in the email, or it\'s left out.</p>';
  if (!ai.configured) {
    return `${intro}<p class="small">To turn it on: create an API key at <strong>console.anthropic.com</strong> (Settings → API keys), add a little credit under Billing, put <code>ANTHROPIC_API_KEY=your-key</code> in the <code>.env</code> file, and restart the app.</p>${privacy}`;
  }
  return `${intro}
    <form class="settings-form">
      <label class="check"><input type="checkbox" name="aiEmailEnabled" ${s.aiEmailEnabled ? 'checked' : ''}> <span>Use AI for emails the rules can't read</span></label>
      <label>Monthly limit ($)</label>
      <input name="aiMonthlyCapDollars" type="number" min="0.10" max="50" step="0.10" value="${(s.aiMonthlyCapCents / 100).toFixed(2)}">
      <p class="small muted">When the limit is reached, AI reading pauses until next month; those emails are tried again then.</p>
      <div class="actions"><button class="btn primary">Save</button></div>
    </form>
    <p class="small">This month: <strong>$${(spent.cents / 100).toFixed(3)}</strong> for ${spent.emails} email${spent.emails === 1 ? '' : 's'} (limit $${(s.aiMonthlyCapCents / 100).toFixed(2)}).</p>
    ${privacy}`;
}

// ---------- AI policy review ----------
function reviewSummary(r) {
  if (!r.reviewed) return 'Nothing needed a review.';
  const parts = [];
  if (r.confirmed) parts.push(`${r.confirmed} confirmed`);
  if (r.estimated) parts.push(`${r.estimated} estimated`);
  if (r.needsReview) parts.push(`${r.needsReview} need your review`);
  if (r.suggestions) parts.push(`${r.suggestions} saved as suggestions (you'd corrected them)`);
  return `Policy review done: ${parts.join(' · ')}`;
}

async function runReview(btn, itemIds, after) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reviewing… (can take a minute)';
  try { toast(reviewSummary(await api('/policy/review', itemIds ? { itemIds } : {}))); } catch (e) { toast(e.message); }
  btn.disabled = false;
  btn.textContent = label;
  after();
}

// ---------- pages ----------
async function renderHome() {
  const [d, status] = await Promise.all([api('/dashboard'), api('/status')]);
  const t = d.today;
  app.innerHTML = `
    <div class="row" style="margin-top:4px"><h1>Overview</h1>
      <button class="btn" id="sync">${status.gmail.syncing ? 'Syncing…' : 'Sync emails'}</button></div>
    ${gmailNotice(status.gmail, d.hasSampleData)}
    ${status.ai.configured && status.ai.pending ? `<div class="card"><div class="title">${status.ai.pending === 1 ? '1 item needs' : `${status.ai.pending} items need`} a return-policy review</div>
      <p class="small muted" style="margin:4px 0 0">The AI reads the retailer's official policy and finds the deadlines. Each review uses a little of your Anthropic credit.</p>
      <div class="actions"><button class="btn primary" id="review-all">Review now</button></div></div>` : ''}

    <div class="card stat"><div class="muted small">Total outstanding expected refunds</div>
      <div class="num">${money(d.totalOutstandingCents)}</div>
      <div class="muted small">Money you're owed that you haven't confirmed in your account</div></div>

    ${section('Refunds to check', d.needsCheck, (i) => refundCheckCard(i, t), 'Nothing to check right now.')}
    ${section('Return deadlines approaching', d.deadlines, (i) => itemCard(i,
      `${i.overdue ? '<span class="badge bad">Deadline passed</span>' : '⏰'} Return by <strong>${niceDate(i.return_deadline)}</strong> (${relDays(i.return_deadline, t)}) ${statusBadge(i.return_deadline_status)}`),
      'No deadlines in the next two weeks.')}
    ${section('Items to drop off', d.toDropOff, (i) => itemCard(i,
      i.dropoff_deadline ? `📦 Drop off by <strong>${niceDate(i.dropoff_deadline)}</strong> (${relDays(i.dropoff_deadline, t)}) ${statusBadge(i.dropoff_deadline_status)}` : '📦 Drop-off deadline unknown'),
      'Nothing to drop off.')}
    ${section('Returns in transit', d.inTransit, (i) => itemCard(i,
      i.stage === 'return_received' ? `Received by retailer ${niceDate(i.return_received_at)}` : `Dropped off ${niceDate(i.dropped_off_at)}`),
      'No returns in transit.')}
    ${section('Refunds awaiting posting', d.awaitingPosting, (i) => itemCard(i,
      `Issued ${money(i.issued_cents)} on ${niceDate(i.issued_at)} · expected in your account by ${niceDate(i.window_end)}`),
      'No refunds waiting to post.')}
    ${d.deadlinesUnknown.length ? section('Deadline needs review', d.deadlinesUnknown, (i) => itemCard(i, `${statusBadge(i.return_deadline_status)} We couldn't determine the return deadline.`), '') : ''}
    ${d.emailsNeedingReview.length ? section('Emails that need a look', d.emailsNeedingReview, (e) => `<div class="card"><div class="title">${esc(e.subject)}${sampleBadge(e)}</div><div class="small muted">${esc(e.review_reason)}</div>${e.web_link ? `<a class="small" href="${esc(e.web_link)}" target="_blank" rel="noopener">Open in Gmail</a>` : ''}</div>`, '') : ''}
  `;
  document.getElementById('sync').addEventListener('click', (e) => runSync(e.target, renderHome));
  document.getElementById('review-all')?.addEventListener('click', (e) => runReview(e.target, null, renderHome));
  wireRefundActions(app, renderHome);
}

async function renderItems() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const d = await api('/items?' + params.toString());
  app.innerHTML = `
    <h1>Items</h1>
    <form class="filters" id="filters">
      <input name="q" type="search" placeholder="Search item, store, order #" value="${esc(params.get('q') ?? '')}">
      <select name="store"><option value="">All stores</option>${d.stores.map((s) => `<option value="${esc(s.retailer)}" ${params.get('store') === s.retailer ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <select name="stage"><option value="">All statuses</option>${d.stages.map((s) => `<option value="${s.key}" ${params.get('stage') === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
    </form>
    <p class="muted small">${d.items.length} item${d.items.length === 1 ? '' : 's'}</p>
    ${d.items.map((i) => itemCard(i, i.return_deadline && ['purchased', 'delivered', 'need_to_return'].includes(i.stage) ? `Return by ${niceDate(i.return_deadline)} ${statusBadge(i.return_deadline_status)}` : '')).join('') || '<div class="empty">No items match.</div>'}
  `;
  const form = document.getElementById('filters');
  let timer;
  const apply = () => {
    const p = new URLSearchParams([...new FormData(form)].filter(([, v]) => v));
    history.replaceState(null, '', '#/items' + (p.toString() ? '?' + p : ''));
    renderItems().then(() => {
      const q = app.querySelector('input[name=q]');
      q.focus(); q.setSelectionRange(q.value.length, q.value.length);
    });
  };
  form.addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(apply, e.target.name === 'q' ? 300 : 0); });
  form.addEventListener('submit', (e) => { e.preventDefault(); apply(); });
}

const EVENT_ICON = { email: '✉️', manual: '✋', system: '⚙️' };
const SOURCE_LABEL = { email: 'From email', manual: 'Your update', system: 'Automatic' };

async function renderItem(id) {
  const d = await api(`/items/${id}`);
  const { item: i, refund: r, policy } = d;
  const status = await api('/status');
  const today = status.today;
  const returnFlow = ['need_to_return', 'return_started', 'dropped_off', 'return_received', 'refund_issued', 'refund_confirmed'].includes(i.stage);

  app.innerHTML = `
    <p><a href="#/">← Purchases</a></p>
    <h1>${esc(i.name)}</h1>
    ${i.email_name && i.email_name !== i.name ? `<p class="small muted" style="margin:0 0 6px">Amazon calls it: ${esc(i.email_name)}</p>` : ''}
    <details class="small"><summary>Rename</summary>
      <form id="rename" class="row"><input name="name" value="${esc(i.name)}" class="grow" aria-label="Item name" required><button class="btn">Save</button></form>
    </details>
    ${i.notes ? `<div class="notice">${esc(i.notes)}</div>` : ''}
    ${i.name_source === 'amazon_site' ? '<p class="small muted" style="margin:4px 0">Name and details from your Amazon order page.</p>' : ''}
    ${i.retailer !== 'amazon' && !i.is_sample ? `<details class="small"><summary>Not a store you want tracked?</summary>
      <p class="muted">Future emails from ${esc(storeName(i))} (${esc(i.retailer)}) will be skipped. Items already here stay unless you remove them.</p>
      <button class="btn danger" id="ignore-store" type="button">Stop tracking ${esc(storeName(i))}</button></details>` : ''}
    <div class="row wrap">${stageBadge(i)}${sampleBadge(i)}${i.quantity > 1 ? `<span class="badge">Qty ${i.quantity}</span>` : ''}${i.split_from_item_id ? '<span class="badge">Partial return line</span>' : ''}</div>

    <div class="card" style="margin-top:12px"><dl class="kv">
      <dt>Store</dt><dd>${esc(storeName(i))}${i.seller ? ` — sold by ${esc(i.seller)} (third-party)` : ''}</dd>
      <dt>Order</dt><dd>#${esc(i.order_number)}</dd>
      <dt>Price</dt><dd>${money(i.unit_price_cents)}${i.quantity > 1 ? ` each` : ''}</dd>
      <dt>Ordered</dt><dd>${niceDate(i.order_date)}</dd>
      <dt>Delivered</dt><dd>${i.delivered_date ? niceDate(i.delivered_date) : i.estimated_delivery_date ? `Expected ${niceDate(i.estimated_delivery_date)}` : '—'}</dd>
      <dt>Paid with</dt><dd>${esc(i.payment_method ?? '—')}</dd>
    </dl>
    ${d.siblings.length ? `<p class="small muted" style="margin:10px 0 0">Also in this order: ${d.siblings.map((s) => `<a href="#/item/${s.id}">${esc(s.name)}${s.quantity > 1 ? ` ×${s.quantity}` : ''}</a> (${esc(s.stage_label)})`).join(', ')}</p>` : ''}
    </div>

    <h2>Status</h2>
    <div class="card">
      <label for="stage">Stage (change it if the app got it wrong)</label>
      <select id="stage">${d.stages.map((s) => `<option value="${s.key}" ${s.key === i.stage ? 'selected' : ''}>${s.rank}. ${esc(s.label)}</option>`).join('')}</select>
      <div class="actions">
        ${i.stage === 'delivered' || i.stage === 'purchased' ? `<div class="row"><button class="btn grow" data-stage="keeping">I'm keeping it</button><button class="btn grow" data-stage="need_to_return">I need to return it</button></div>` : ''}
        ${['need_to_return', 'return_started'].includes(i.stage) || (i.stage === 'dropped_off' && i.dropoff_source === 'manual') ? `
          <form id="dropoff" class="row"><input type="date" name="date" value="${esc(i.dropped_off_at ?? today)}" class="grow" aria-label="Drop-off date">
          <button class="btn primary">${i.dropped_off_at ? 'Update drop-off date' : 'I dropped it off'}</button></form>` : ''}
      </div>
      ${i.dropped_off_at ? `<p class="small muted">Dropped off ${niceDate(i.dropped_off_at)} (${i.dropoff_source === 'manual' ? 'entered by you' : 'from receipt email'})</p>` : ''}
    </div>

    <h2>Return deadlines</h2>
    <div class="card">
      <div class="row"><div><div class="muted small">Return by</div><div class="title">${i.eligibility === 'not_eligible' ? 'Not returnable' : niceDate(i.return_deadline)}${i.return_deadline ? ` <span class="muted small">(${i.return_started_at ? 'return already started' : relDays(i.return_deadline, today)})</span>` : ''}</div></div>${statusBadge(i.return_deadline_status)}</div>
      <p class="small muted">${esc(i.return_deadline_basis ?? '')}</p>
      ${i.return_started_at ? `<div class="row"><div><div class="muted small">Ship / drop off by</div><div class="title">${niceDate(i.dropoff_deadline)}</div></div>${statusBadge(i.dropoff_deadline_status)}</div>
      <p class="small muted">${esc(i.dropoff_deadline_basis ?? '')}</p>` : ''}
      ${i.deadline_locked_by_user ? '<div class="notice">You corrected these deadlines. Automatic updates won\'t overwrite them — new results appear as suggestions below.</div>' : ''}
      <details><summary>Correct a deadline</summary>
        <form id="deadlines">
          <label>Return by</label><input type="date" name="returnDeadline" value="${esc(i.return_deadline ?? '')}">
          ${i.return_started_at ? `<label>Drop off by</label><input type="date" name="dropoffDeadline" value="${esc(i.dropoff_deadline ?? '')}">` : ''}
          <label>Note (optional)</label><input name="note" placeholder="e.g. holiday policy, confirmed with support">
          <div class="actions"><button class="btn primary">Save correction</button></div>
        </form></details>
    </div>
    ${d.suggestions.map((s) => `<div class="card"><div class="title">Suggested update (${esc(s.origin)})</div>
      <p class="small">${esc(s.result.explanation ?? '')}</p>
      <div class="row"><button class="btn primary grow" data-sugg="accept" data-sid="${s.id}">Accept</button><button class="btn grow" data-sugg="reject" data-sid="${s.id}">Keep mine</button></div></div>`).join('')}

    <h2>Return policy</h2>
    <div class="card">
      ${policy ? `<div class="row wrap" style="margin-bottom:6px">${{ ai: '<span class="badge info">AI-reviewed</span>', user: '<span class="badge">Set by you</span>', sample: '<span class="badge sample">Sample</span>' }[i.policy_origin] ?? ''} ${statusBadge(policy.confidence)}</div>
        <p class="small">${esc(i.policy_explanation ?? '')}</p>
        <dl class="kv small">
          <dt>Returnable</dt><dd>${{ eligible: 'Yes', not_eligible: 'No — excluded by policy', unknown: policy.windowDays != null ? 'Not stated (no exclusion quoted)' : 'Unknown' }[i.eligibility] ?? '—'}</dd>
          <dt>Window</dt><dd>${policy.windowDays != null ? `${policy.windowDays} days from ${policy.startsFrom}` : 'Unknown'}</dd>
          ${policy.dropoffDays != null ? `<dt>Drop off within</dt><dd>${policy.dropoffDays} days of starting the return</dd>` : ''}
          ${policy.holidayExtension ? `<dt>Holiday rule</dt><dd>Bought ${niceDate(policy.holidayExtension.purchasedFrom)}–${niceDate(policy.holidayExtension.purchasedTo)}: return by ${niceDate(policy.holidayExtension.returnBy)}</dd>` : ''}
          <dt>Refund timing</dt><dd>${policy.refundTiming ? `${policy.refundTiming.minDays}–${policy.refundTiming.maxDays} ${policy.refundTiming.unit} days after ${policy.refundTiming.startEvent.replace('_', ' ')}` : 'Unknown'}</dd>
          <dt>Source</dt><dd>${i.policy_url ? `<a href="${esc(i.policy_url)}" target="_blank" rel="noopener">Policy page</a>` : i.policy_origin === 'sample' ? 'Sample — no real source' : '—'}</dd>
          <dt>Checked</dt><dd>${i.policy_checked_at ? niceDate(i.policy_checked_at) : '—'}</dd>
        </dl>
        ${policy.evidence && Object.keys(policy.evidence).length ? `<details><summary class="small">What the policy page says</summary>${Object.values(policy.evidence).map((q) => `<blockquote class="small quote">“${esc(q)}”</blockquote>`).join('')}<p class="small muted">Each quote was checked against the page the AI read.</p></details>` : ''}` : '<p class="small muted">Not reviewed yet.</p>'}
      ${i.is_sample ? '<p class="small muted">Sample items are never sent to the AI.</p>' : status.ai.configured ? `
        <div class="actions"><button class="btn" id="review">${policy && i.policy_origin !== 'sample' ? 'Re-check with AI' : 'Review policy with AI'}</button></div>
        <details><summary class="small">Use a specific policy link</summary>
          <form id="policy-link"><p class="small muted">Paste the retailer's official return-policy page if the AI couldn't find or read the right one. It will re-check using that page.</p>
          <input name="url" type="url" inputmode="url" placeholder="https://…" value="${esc(i.policy_user_url ?? '')}" required>
          <div class="actions"><button class="btn primary">Save link and re-check</button></div></form>
        </details>` : '<p class="small muted">AI review isn\'t set up — see Settings.</p>'}
      ${i.policy_user_url ? `<p class="small muted">Your policy link: <a href="${esc(i.policy_user_url)}" target="_blank" rel="noopener">${esc(new URL(i.policy_user_url).hostname)}</a></p>` : ''}
    </div>

    ${i.return_instructions || i.label_url || i.qr_url ? `<h2>Return instructions</h2><div class="card">
      ${i.return_instructions ? `<p class="small">${esc(i.return_instructions)}</p>` : ''}
      <div class="row wrap">${i.label_url ? `<a class="btn" href="${esc(i.label_url)}" target="_blank" rel="noopener">Shipping label</a>` : ''}${i.qr_url ? `<a class="btn" href="${esc(i.qr_url)}" target="_blank" rel="noopener">QR code</a>` : ''}</div>
      ${i.is_sample ? '<p class="small muted">Sample links go nowhere.</p>' : ''}</div>` : ''}

    ${r ? `<h2>Refund</h2><div class="card">
      <dl class="kv">
        <dt>Expected</dt><dd>${money(r.expected_cents)}</dd>
        <dt>Issued by retailer</dt><dd>${money(r.issued_cents)}${r.issued_at ? ` on ${niceDate(r.issued_at)}` : ''}</dd>
        <dt>You confirmed</dt><dd>${money(r.confirmed_cents)}${r.confirmed_at ? ` on ${niceDate(r.confirmed_at)}` : ''}</dd>
        <dt>Outstanding</dt><dd><strong>${['confirmed', 'resolved'].includes(r.status) ? '$0.00' : money(Math.max(0, (r.expected_cents ?? r.issued_cents) - r.confirmed_cents))}</strong></dd>
        <dt>Goes to</dt><dd>${esc(r.destination ?? '—')}</dd>
        <dt>Status</dt><dd>${esc({ pending: 'Not issued yet', issued: 'Issued — awaiting posting', partial: 'Partly received', problem: 'Problem reported', confirmed: 'Received — closed', resolved: 'Closed by you' }[r.status])}</dd>
        ${r.window_end ? `<dt>Expected by</dt><dd>${niceDate(r.window_end)} ${r.window_kind === 'default_interval' ? '<span class="badge warn">Your default reminder</span>' : '<span class="badge info">Retailer timing</span>'}</dd>` : ''}
        ${r.next_check_at ? `<dt>Next check</dt><dd>${niceDate(r.next_check_at)}</dd>` : ''}
      </dl>
      ${r.window_basis ? `<p class="small muted">${esc(r.window_basis)}${r.window_assumption ? ` ${esc(r.window_assumption)}` : ''}</p>` : ''}
      ${r.problem_note ? `<div class="notice warn">Problem: ${esc(r.problem_note)}</div>` : ''}
      ${r.resolution_note ? `<p class="small">Closed note: ${esc(r.resolution_note)}</p>` : ''}
      ${['pending', 'issued', 'partial', 'problem'].includes(r.status) ? `
        <p class="small muted">Only you can close a refund — a "refund issued" email doesn't prove the money arrived.</p>
        ${refundActions(i.id, r)}
        <details><summary>Edit expected amount</summary><form id="expected" class="row"><input name="amount" inputmode="decimal" value="${dollars(r.expected_cents)}" class="grow"><button class="btn">Save</button></form></details>
        ${r.confirmed_cents > 0 || r.status === 'problem' ? `<details><summary>Close with a shortfall</summary><form id="resolve"><p class="small muted">Use this if the difference is expected (e.g. a restocking fee). This closes the refund.</p><input name="note" placeholder="Reason" required><div class="actions"><button class="btn">Close refund</button></div></form></details>` : ''}
      ` : ''}
    </div>` : returnFlow ? '' : ''}

    <h2>Timeline</h2>
    <div class="card"><p class="small muted" style="margin-top:0">✉️ from email · ✋ your update · ⚙️ automatic</p><ul class="timeline">
      ${d.events.map((e) => `<li><span class="icon" title="${SOURCE_LABEL[e.source]}">${EVENT_ICON[e.source] ?? '•'}</span><div>
        <div>${esc(e.detail ?? e.kind)}</div>
        <div class="small muted">${niceDate(e.occurred_at)} · ${SOURCE_LABEL[e.source]}${e.email_link ? ` · <a href="${esc(e.email_link)}" target="_blank" rel="noopener">view email</a>` : ''}</div></div></li>`).join('')}
    </ul></div>

    <h2>Supporting emails</h2>
    ${d.emails.length ? d.emails.map((m) => `<div class="card"><div class="title small">${esc(m.subject ?? m.kind)}${sampleBadge(m)}</div>
      <div class="small muted">${niceDate(m.received_at)} · ${esc(m.kind.replace('_', ' '))}</div>
      ${m.web_link ? `<a class="small" href="${esc(m.web_link)}" target="_blank" rel="noopener">Open in Gmail</a>` : `<span class="small muted">${m.is_sample ? 'Sample email — not in your Gmail' : 'No link available'}</span>`}</div>`).join('') : '<div class="empty">No emails linked.</div>'}
  `;

  const reload = () => renderItem(id);
  const post = async (path, body, msg) => { try { await api(path, body); if (msg) toast(msg); reload(); } catch (e) { toast(e.message); } };

  app.querySelector('#ignore-store')?.addEventListener('click', () => post('/stores/ignore', { domain: i.retailer, name: storeName(i) }, `Stopped tracking ${storeName(i)}`));
  app.querySelector('#rename')?.addEventListener('submit', (e) => { e.preventDefault(); post(`/items/${id}/rename`, Object.fromEntries(new FormData(e.target)), 'Renamed'); });
  app.querySelector('#stage').addEventListener('change', (e) => post(`/items/${id}/stage`, { stage: e.target.value }, 'Stage updated'));
  app.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', () => post(`/items/${id}/stage`, { stage: b.dataset.stage }, 'Stage updated')));
  app.querySelector('#dropoff')?.addEventListener('submit', (e) => { e.preventDefault(); post(`/items/${id}/dropoff`, Object.fromEntries(new FormData(e.target)), 'Drop-off saved'); });
  app.querySelector('#deadlines')?.addEventListener('submit', (e) => { e.preventDefault(); post(`/items/${id}/deadlines`, Object.fromEntries(new FormData(e.target)), 'Deadline saved — it won\'t be overwritten automatically'); });
  app.querySelector('#expected')?.addEventListener('submit', (e) => { e.preventDefault(); post(`/items/${id}/expected-refund`, Object.fromEntries(new FormData(e.target)), 'Expected amount saved'); });
  app.querySelector('#resolve')?.addEventListener('submit', (e) => { e.preventDefault(); post(`/items/${id}/refund/resolve`, Object.fromEntries(new FormData(e.target)), 'Refund closed'); });
  const reviewBtn = app.querySelector('#review');
  reviewBtn?.addEventListener('click', () => runReview(reviewBtn, [Number(id)], reload));
  app.querySelector('#policy-link')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true; btn.textContent = 'Checking…';
    try { toast(reviewSummary(await api(`/items/${id}/policy-link`, Object.fromEntries(new FormData(e.target))))); } catch (err) { toast(err.message); }
    reload();
  });
  app.querySelectorAll('[data-sugg]').forEach((b) => b.addEventListener('click', () => post(`/suggestions/${b.dataset.sid}/${b.dataset.sugg}`, {}, b.dataset.sugg === 'accept' ? 'Suggestion applied' : 'Kept your version')));
  wireRefundActions(app, reload);
}

function gmailCard(g) {
  const onThisComputer = ['localhost', '127.0.0.1'].includes(location.hostname);
  const connectBtn = (label) => onThisComputer
    ? `<a class="btn primary block" href="/auth/google/start" style="display:block;text-align:center;text-decoration:none">${label}</a>`
    : '<div class="notice">Connect Gmail from the computer running the app (Google only allows sign-in to return to localhost). After that, syncing works from your phone too.</div>';
  if (!g.configured) {
    return `<p class="small">Gmail isn't set up yet. Add <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and <code>GOOGLE_REDIRECT_URI</code> to the <code>.env</code> file, then restart the app.</p>`;
  }
  if (!g.email) {
    return `<p class="small">The app will ask Google for <strong>read-only</strong> access. It can't send, change, archive, or delete email, and it only looks at Amazon order, shipping, return, and refund emails.</p>${connectBtn('Connect Gmail')}`;
  }
  const r = g.lastRun;
  return `<dl class="kv">
      <dt>Account</dt><dd>${esc(g.email)} ${g.needsReconnect ? '<span class="badge warn">Needs reconnect</span>' : '<span class="badge ok">Connected · read-only</span>'}</dd>
      <dt>Last sync</dt><dd>${r ? `${new Date(r.finished_at || r.started_at).toLocaleString()} — ${r.status === 'ok' ? esc(syncSummary(r)) : r.status === 'running' ? 'running…' : `failed: ${esc(r.message)}`}` : 'Never'}</dd>
    </dl>
    ${g.needsReconnect ? `<div style="margin-top:10px">${connectBtn('Reconnect Gmail')}</div>` : `<div class="actions"><button class="btn primary" id="sync-now">Sync emails now</button></div>`}
    <div class="actions"><button class="btn danger" id="disconnect">Disconnect Gmail</button></div>
    <p class="small muted">Disconnecting deletes the app's Gmail token and asks Google to cancel access. Imported purchases stay.</p>`;
}

async function renderSettings() {
  const [s, status, d] = await Promise.all([api('/settings'), api('/status'), api('/dashboard')]);
  const gmailMsg = new URLSearchParams(location.hash.split('?')[1] ?? '').get('gmail');
  const skipped = status.gmail.email ? (await api('/gmail/skipped')).skipped : [];
  const ignored = (await api('/stores/ignored')).stores;
  app.innerHTML = `
    <h1>Settings</h1>

    ${gmailMsg ? `<div class="notice ${gmailMsg === 'connected' ? '' : 'warn'}">${gmailMsg === 'connected' ? 'Gmail connected (read-only). Tap Sync emails to import.' : esc(gmailMsg)}</div>` : ''}
    <h2>Gmail</h2>
    <div class="card">${gmailCard(status.gmail)}</div>
    ${skipped.length ? `<details class="card"><summary>Emails the app skipped (${skipped.length})</summary>
      <p class="small muted">Amazon emails the app looked at but didn't import, and why. If a real order is in this list, tell me its subject so the parser can learn it.</p>
      ${skipped.map((m) => `<div class="skip"><div class="small title">${esc(m.subject || '(no subject)')}</div>
        <div class="small muted">${esc(m.reason)}${m.received_at ? ` · ${new Date(m.received_at).toLocaleDateString()}` : ''} · <a href="${esc(m.web_link)}" target="_blank" rel="noopener">Open in Gmail</a></div></div>`).join('')}
    </details>` : ''}

    <h2>Connections</h2>
    <div class="card"><dl class="kv">
      <dt>AI review</dt><dd>${status.ai.configured ? `<span class="badge ok">Set up</span> <span class="small muted">${status.ai.pending} item${status.ai.pending === 1 ? '' : 's'} waiting for review</span>` : '<span class="badge">Not set up</span> <span class="small muted">Add <code>ANTHROPIC_API_KEY</code> to <code>.env</code> and restart.</span>'}</dd>
      <dt>Stores</dt><dd>Amazon (from your order pages when Amazon order details is on), plus order emails from any store found by searching all your mail</dd>
    </dl></div>

    <h2>Sample data</h2>
    <div class="card">
      <p class="small">Sample data is a set of made-up orders so you can try every screen. It's always labeled "Sample" and is never mixed up with real imports.</p>
      <div class="row"><button class="btn primary grow" id="load">${d.hasSampleData ? 'Reset sample data' : 'Load sample data'}</button>
      <button class="btn grow" id="clear" ${d.hasSampleData ? '' : 'disabled'}>Remove sample data</button></div>
    </div>

    <h2>Background checks</h2>
    <form class="card settings-form">
      <label>Check Gmail for new emails automatically</label>
      <select name="autoSyncHours">${[0, 1, 3, 6, 12, 24].map((h) => `<option value="${h}" ${s.autoSyncHours === h ? 'selected' : ''}>${h === 0 ? 'Off — only when I tap Sync' : `Every ${h} hour${h === 1 ? '' : 's'}`}</option>`).join('')}</select>
      <label class="check"><input type="checkbox" name="autoReview" ${s.autoReview ? 'checked' : ''}> <span>Automatically review return policies for new items <span class="muted">(uses Anthropic credit)</span></span></label>
      <p class="small muted">Background checks only run while the app is running on your computer. ${status.background?.lastRunAt ? `Last run: ${new Date(status.background.lastRunAt).toLocaleString()}${status.background.last?.errors?.length ? ` — ${esc(status.background.last.errors[0])}` : ''}.` : ''}</p>
      <div class="actions"><button class="btn primary">Save</button><button class="btn" type="button" id="run-now">Run checks now</button></div>
    </form>

    <h2>AI email reading</h2>
    <div class="card">${aiEmailCard(status.ai, s)}</div>

    <h2>Amazon order details</h2>
    <div class="card">${amazonSiteCard(status.amazonSite, s)}</div>
    ${ignored.length ? `<h2>Stores you stopped tracking</h2><div class="card">${ignored.map((st) => `<div class="row skip"><span class="small grow">${esc(st.name)} <span class="muted">(${esc(st.domain)})</span></span><button class="btn" type="button" data-unignore="${esc(st.domain)}">Track again</button></div>`).join('')}</div>` : ''}

    <h2>Notifications</h2>
    <div class="card">
      <h3>Phone notifications (ntfy)</h3>
      ${s.ntfyTopic ? `<p class="small"><span class="badge ok">On</span> Sending to topic <code>${esc(s.ntfyTopic)}</code>.</p>` : '<p class="small">Get reminders on your phone with the free <strong>ntfy</strong> app.</p>'}
      <details ${s.ntfyTopic ? '' : 'open'}><summary class="small">${s.ntfyTopic ? 'Setup steps' : 'Set it up (2 minutes)'}</summary>
        <ol class="small steps">
          <li>Install <strong>ntfy</strong> from the App Store.</li>
          <li>In ntfy, tap <strong>+</strong>, then subscribe to this topic name:</li>
        </ol>
        <div class="row"><code class="grow topic" id="topic">${esc(s.ntfyTopic || newTopic())}</code><button class="btn" type="button" id="copy-topic">Copy</button></div>
        <p class="small muted">Treat the topic like a password: anyone who knows it can read these notifications. ${s.ntfyTopic ? '' : 'This one was generated randomly for you.'}</p>
        <div class="actions"><button class="btn primary" type="button" id="save-topic">${s.ntfyTopic ? 'Save topic' : 'Turn on phone notifications'}</button>${s.ntfyTopic ? '<button class="btn danger" type="button" id="clear-topic">Turn off</button>' : ''}</div>
      </details>
      <h3 style="margin-top:16px">Email</h3>
      ${status.notify.emailConfigured
        ? `<form class="settings-form"><label class="check"><input type="checkbox" name="emailEnabled" ${s.emailEnabled ? 'checked' : ''}> <span>Email reminders to ${esc(status.notify.emailTo)}</span></label><div class="actions"><button class="btn">Save</button></div></form>`
        : '<p class="small muted">Optional. Add your email provider\'s SMTP settings to <code>.env</code> (see README) to get reminders by email.</p>'}
      <form class="settings-form">
        <h3 style="margin-top:16px">What and when</h3>
        <label class="check"><input type="checkbox" name="pushIncludeNames" ${s.pushIncludeNames ? 'checked' : ''}> <span>Include item names in phone notifications</span></label>
        <p class="small muted">Off: "An item's return deadline is tomorrow." On: "Desk Lamp: return by tomorrow." Emails always include names.</p>
        <label>Remind me this many days before a return deadline</label>
        <input name="remindBeforeDays" type="number" min="1" max="30" value="${s.remindBeforeDays}">
        <label>Quiet hours (no notifications)</label>
        <div class="row"><select name="quietStart" aria-label="Quiet hours start">${hourOptions(s.quietStart)}</select><span>to</span><select name="quietEnd" aria-label="Quiet hours end">${hourOptions(s.quietEnd)}</select></div>
        <p class="small muted">Set both to the same time to turn quiet hours off. Reminders during quiet hours are sent when they end.</p>
        <div class="actions"><button class="btn primary">Save</button><button class="btn" type="button" id="test-notify" ${s.ntfyTopic || (status.notify.emailConfigured && s.emailEnabled) ? '' : 'disabled'}>Send test notification</button></div>
      </form>
    </div>

    <h2>Reminders</h2>
    <form class="card settings-form">
      <label>Default refund reminder (calendar days) — used when the retailer's refund timing is unknown</label>
      <input name="refundReminderDays" type="number" min="1" max="365" value="${s.refundReminderDays}">
      <label>"Not yet — remind me again" waits (days)</label>
      <input name="snoozeDays" type="number" min="1" max="365" value="${s.snoozeDays}">
      <label>Mark a refund overdue this many days after its expected window</label>
      <input name="overdueGraceDays" type="number" min="1" max="365" value="${s.overdueGraceDays}">
      <label>Show return deadlines this many days ahead</label>
      <input name="deadlineWarningDays" type="number" min="1" max="365" value="${s.deadlineWarningDays}">
      <div class="actions"><button class="btn primary">Save</button></div>
    </form>

    <h2>Your data</h2>
    <div class="card small">
      <p style="margin-top:0">Everything is stored in a database file on the computer running this app. Your Gmail token is stored there too — never in the browser or in git.</p>
      <p><strong>Gmail → app:</strong> the app downloads only emails matching Amazon order/shipping/return/refund searches, keeps just the extracted details (order number, items, prices, dates, links) plus the subject, and does not save full email bodies.</p>
      <p><strong>App → Anthropic (AI email reading, only if you turn it on):</strong> purchase-looking emails the rules couldn't read — subject and text, with email addresses, phone numbers, card numbers and street-address lines removed. Capped by your monthly limit.</p>
      <p><strong>App → Anthropic (AI policy review, only when you tap a review button):</strong> the store name, each item's name, its seller, and its order, delivery, and return dates, plus any policy link you added. <em>Not</em> sent: prices, order numbers, payment methods, your email address, or any email text. The AI reads policy pages only on the retailer's own website (and links you add).</p>
      <p>Sample items are never sent to the AI.</p>
    </div>
  `;
  document.getElementById('sync-now')?.addEventListener('click', (e) => runSync(e.target, renderSettings));
  document.getElementById('amazon-now')?.addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Checking Amazon… (up to a minute)';
    try {
      const r = await api('/amazon-site/run', {});
      toast(r.ok ? `Amazon: ${r.orders} orders read · ${r.named + r.created} names · ${r.priced ?? 0} prices · ${r.returnDates} return dates added` : amazonError(r.error));
    } catch (err) { toast(err.message); }
    renderSettings();
  });
  app.querySelectorAll('[data-unignore]').forEach((b) => b.addEventListener('click', async () => { await api('/stores/unignore', { domain: b.dataset.unignore }); toast('Tracking again'); renderSettings(); }));
  document.getElementById('disconnect')?.addEventListener('click', async () => {
    if (!confirm('Disconnect Gmail? Your imported purchases will stay.')) return;
    await api('/gmail/disconnect', {});
    toast('Gmail disconnected');
    history.replaceState(null, '', '#/settings');
    renderSettings();
  });
  document.getElementById('load').onclick = async () => { await api('/sample/load', {}); toast('Sample data loaded'); renderSettings(); refreshBanner(); };
  document.getElementById('clear').onclick = async () => { await api('/sample/clear', {}); toast('Sample data removed'); renderSettings(); refreshBanner(); };
  // Every settings form saves only its own fields (checkboxes send true/false).
  app.querySelectorAll('.settings-form').forEach((form) => form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
    if (body.aiMonthlyCapDollars != null) { body.aiMonthlyCapCents = Math.round(Number(body.aiMonthlyCapDollars) * 100); delete body.aiMonthlyCapDollars; }
    try { await api('/settings', body); toast('Settings saved'); renderSettings(); } catch (err) { toast(err.message); }
  }));
  const topic = () => document.getElementById('topic').textContent.trim();
  document.getElementById('copy-topic').onclick = async () => {
    try { await navigator.clipboard.writeText(topic()); toast('Topic copied — paste it in the ntfy app'); } catch { toast('Copy failed — select the text and copy it manually'); }
  };
  document.getElementById('save-topic').onclick = async () => {
    try { await api('/settings', { ntfyTopic: topic() }); toast('Phone notifications on. Tap "Send test notification" to check.'); renderSettings(); } catch (err) { toast(err.message); }
  };
  document.getElementById('clear-topic')?.addEventListener('click', async () => { await api('/settings', { ntfyTopic: '' }); toast('Phone notifications off'); renderSettings(); });
  document.getElementById('test-notify').onclick = async () => {
    try {
      const r = await api('/notifications/test', {});
      toast(r.results.map((x) => `${x.channel}: ${x.ok ? 'sent ✓' : `failed (${x.error})`}`).join(' · '));
    } catch (err) { toast(err.message); }
  };
  document.getElementById('run-now').onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = 'Running…';
    try {
      const r = await api('/background/run', {});
      toast(r.errors?.length ? `Done with problems: ${r.errors[0]}` : `Done. ${r.sync ? `Sync: ${r.sync.imported} new. ` : ''}${r.remindersCreated} new reminder${r.remindersCreated === 1 ? '' : 's'}.`);
    } catch (err) { toast(err.message); }
    renderSettings();
  };
}

function newTopic() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return 'returns-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function hourOptions(selected) {
  return Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${h === selected ? 'selected' : ''}>${new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</option>`).join('');
}

const ALERT_ICON = { return_deadline: '⏰', dropoff: '📦', refund_check: '💳', refund_overdue: '⚠️', gmail_reconnect: '🔌' };

async function renderAlerts() {
  const d = await api('/notifications');
  app.innerHTML = `
    <div class="row" style="margin-top:4px"><h1>Alerts</h1>${d.unread ? '<button class="btn" id="read-all">Mark all read</button>' : ''}</div>
    <p class="small muted">Reminders about deadlines and refunds. Turn on phone notifications in <a href="#/settings">Settings</a> to get these on your lock screen.</p>
    ${d.notifications.length ? d.notifications.map((n) => `
      <a class="card link ${n.read_at ? 'read' : 'unread'}" href="${n.item_id ? `#/item/${n.item_id}` : '#/settings'}" data-nid="${n.id}">
        <div class="row"><div class="grow"><div class="title">${ALERT_ICON[n.kind] ?? '🔔'} ${esc(n.title)}</div>
        <div class="small">${esc(n.body)}</div>
        <div class="small muted">${new Date(n.created_at.replace(' ', 'T') + 'Z').toLocaleString()}${n.delivery_note ? ` · ${esc(n.delivery_note)}` : ''}</div></div>
        ${n.read_at ? '' : '<span class="dot" aria-label="Unread"></span>'}</div>
        ${n.is_sample ? '<div style="margin-top:6px"><span class="badge sample">Sample</span></div>' : ''}
      </a>`).join('') : '<div class="empty">No alerts yet. Reminders appear here when a deadline is near or a refund needs checking.</div>'}
  `;
  app.querySelectorAll('[data-nid]').forEach((a) => a.addEventListener('click', () => api(`/notifications/${a.dataset.nid}/read`, {}).catch(() => {})));
  document.getElementById('read-all')?.addEventListener('click', async () => { await api('/notifications/all/read', {}); renderAlerts(); refreshBanner(); });
}

// ---------- Purchases (simple list for checking the data) ----------
const purchaseView = { sort: 'date', dir: 'desc', q: '', merchant: '' };
const SORTS = {
  date: (r) => r.order_date ?? '',
  merchant: (r) => (r.merchant ?? '').toLowerCase(),
  item: (r) => (r.name ?? '').toLowerCase(),
  amount: (r) => r.amount_cents ?? -1,
  total: (r) => r.order_total_cents ?? -1,
};

function sortedPurchases(rows) {
  const { sort, dir, q, merchant } = purchaseView;
  const needle = q.trim().toLowerCase();
  const out = rows.filter((r) => (!merchant || r.merchant === merchant)
    && (!needle || `${r.name} ${r.email_name ?? ''} ${r.merchant} ${r.order_number}`.toLowerCase().includes(needle)));
  const key = SORTS[sort];
  out.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = x < y ? -1 : x > y ? 1 : (b.order_date ?? '').localeCompare(a.order_date ?? '');
    return dir === 'asc' ? c : -c;
  });
  return out;
}

function purchaseFlags(r) {
  const f = [];
  if (r.name_source === 'email_category') f.push('<span class="badge warn" title="The email only gave a category, not the product name">category only</span>');
  if (r.amount_cents == null) f.push('<span class="badge" title="No price found">no price</span>');
  else if (r.price_is_total) f.push('<span class="badge warn" title="This is the order\'s grand total, including tax">= order total</span>');
  return f.join(' ');
}

function toCsv(rows) {
  const cols = [
    ['Order date', (r) => r.order_date], ['Merchant', (r) => r.merchant], ['Item', (r) => r.name], ['Name in email', (r) => r.email_name],
    ['Qty', (r) => r.quantity], ['Amount', (r) => dollars(r.amount_cents)], ['Price is order total', (r) => (r.price_is_total ? 'yes' : '')],
    ['Order total', (r) => dollars(r.order_total_cents)], ['Order #', (r) => r.order_number], ['Data source', (r) => r.source],
    ['Payment', (r) => r.payment_method], ['Delivered', (r) => r.delivered_date],
    ['Expected delivery', (r) => r.estimated_delivery_date], ['Return by', (r) => r.return_deadline], ['Status', (r) => r.stage_label], ['Email link', (r) => r.email_link],
  ];
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => cell(c[1](r))).join(','))].join('\n');
}

async function renderPurchases() {
  const { purchases } = await api('/purchases');
  const status = await api('/status');
  const merchants = [...new Set(purchases.map((r) => r.merchant))].sort((a, b) => a.localeCompare(b));

  const draw = () => {
    const rows = sortedPurchases(purchases);
    const orders = new Set(rows.map((r) => `${r.retailer}|${r.order_number}`));
    const totalCents = [...orders].reduce((sum, key) => {
      const r = rows.find((x) => `${x.retailer}|${x.order_number}` === key);
      return sum + (r.order_total_cents ?? 0);
    }, 0);
    const noPrice = rows.filter((r) => r.amount_cents == null).length;
    const categoryOnly = rows.filter((r) => r.name_source === 'email_category').length;
    const th = (key, label, cls = '') => `<th class="${cls}"><button class="sort ${purchaseView.sort === key ? 'on' : ''}" data-sort="${key}">${label}${purchaseView.sort === key ? (purchaseView.dir === 'asc' ? ' ▲' : ' ▼') : ''}</button></th>`;

    app.innerHTML = `
      <div class="row" style="margin-top:4px"><h1>Purchases</h1><button class="btn" id="sync">${status.gmail.syncing ? 'Syncing…' : 'Sync'}</button></div>
      ${status.gmail.connected ? '' : '<div class="notice">Gmail isn\'t connected — <a href="#/settings">connect it in Settings</a> to import purchases.</div>'}
      <div class="filters">
        <input id="pq" type="search" placeholder="Search item, merchant, order #" value="${esc(purchaseView.q)}">
        <select id="pm"><option value="">All merchants</option>${merchants.map((m) => `<option ${purchaseView.merchant === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>
        <select id="ps" class="mobile-only" aria-label="Sort">
          ${[['date', 'Order date'], ['merchant', 'Merchant'], ['amount', 'Amount'], ['item', 'Item'], ['total', 'Order total']].map(([k, l]) => ['desc', 'asc'].map((d) => `<option value="${k}:${d}" ${purchaseView.sort === k && purchaseView.dir === d ? 'selected' : ''}>Sort: ${l} ${d === 'asc' ? (k === 'date' ? '(oldest)' : k === 'amount' || k === 'total' ? '(low → high)' : '(A → Z)') : (k === 'date' ? '(newest)' : k === 'amount' || k === 'total' ? '(high → low)' : '(Z → A)')}</option>`).join('')).join('')}
        </select>
      </div>
      <p class="small muted">${rows.length} item${rows.length === 1 ? '' : 's'} in ${orders.size} order${orders.size === 1 ? '' : 's'} · order totals ${money(totalCents)}
        ${noPrice || categoryOnly ? `<br>Data checks: ${noPrice ? `${noPrice} without a price` : ''}${noPrice && categoryOnly ? ' · ' : ''}${categoryOnly ? `${categoryOnly} with category-only names` : ''}` : ''}</p>
      ${rows.length ? `<table class="ptable">
        <thead><tr>${th('date', 'Order date')}${th('merchant', 'Merchant')}${th('item', 'Item')}<th class="num">Qty</th>${th('amount', 'Amount', 'num')}${th('total', 'Order total', 'num')}<th>Order #</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr data-id="${r.id}">
            <td data-label="Order date">${niceDate(r.order_date)}</td>
            <td data-label="Merchant">${esc(r.merchant)}</td>
            <td data-label="Item" class="item"><a href="#/item/${r.id}">${esc(r.name)}</a>
              <div class="small muted mobile-only">${esc(r.merchant)} · ${niceDate(r.order_date)}${(r.quantity ?? 1) > 1 ? ` · Qty ${r.quantity}` : ''}${r.order_total_cents != null ? ` · order ${money(r.order_total_cents)}` : ''}</div>
              <div class="small muted">${esc(r.source)}${r.email_link ? ` · <a class="elink" href="${esc(r.email_link)}" target="_blank" rel="noopener">email</a>` : ''}</div>
              ${purchaseFlags(r) ? `<div class="flags">${purchaseFlags(r)}</div>` : ''}</td>
            <td data-label="Qty" class="num">${r.quantity ?? 1}</td>
            <td data-label="Amount" class="num">${money(r.amount_cents)}</td>
            <td data-label="Order total" class="num">${money(r.order_total_cents)}</td>
            <td data-label="Order #" class="small">${esc(r.order_number)}</td>
          </tr>`).join('')}</tbody>
      </table>` : `<div class="empty">No purchases yet. ${status.gmail.connected ? 'Tap Sync to import from Gmail.' : ''}</div>`}
      <div class="actions"><button class="btn" id="csv" ${rows.length ? '' : 'disabled'}>Download CSV (opens in Numbers or Excel)</button></div>
      <p class="small muted" style="margin-top:16px"><a href="#/overview">Returns &amp; refunds dashboard</a> · <a href="#/alerts">Alerts</a></p>
    `;

    app.querySelectorAll('[data-sort]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.sort;
      if (purchaseView.sort === k) purchaseView.dir = purchaseView.dir === 'asc' ? 'desc' : 'asc';
      else { purchaseView.sort = k; purchaseView.dir = k === 'merchant' || k === 'item' ? 'asc' : 'desc'; }
      draw();
    }));
    const pq = app.querySelector('#pq');
    pq.addEventListener('input', () => {
      purchaseView.q = pq.value;
      draw();
      const again = app.querySelector('#pq');
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    });
    app.querySelector('#pm').addEventListener('change', (e) => { purchaseView.merchant = e.target.value; draw(); });
    app.querySelector('#ps').addEventListener('change', (e) => { [purchaseView.sort, purchaseView.dir] = e.target.value.split(':'); draw(); });
    app.querySelector('#sync').addEventListener('click', (e) => runSync(e.target, renderPurchases));
    app.querySelector('#csv').addEventListener('click', () => {
      const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `purchases-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
  };
  draw();
}

// ---------- router ----------
async function refreshBanner() {
  try {
    const d = await api('/dashboard');
    document.getElementById('sample-banner').hidden = !d.hasSampleData;
    const badge = document.getElementById('alert-count');
    if (badge) {
      const n = await api('/notifications');
      badge.textContent = n.unread > 9 ? '9+' : String(n.unread);
      badge.hidden = !n.unread;
    }
  } catch { /* ignore */ }
}

async function route() {
  const hash = location.hash || '#/';
  // Simple mode for now: Purchases is the main screen; the returns dashboard lives at #/overview.
  const tab = hash.startsWith('#/items') ? 'items' : hash.startsWith('#/item/') ? 'purchases' : hash.startsWith('#/settings') ? 'settings'
    : hash.startsWith('#/alerts') ? 'alerts' : hash.startsWith('#/overview') ? 'home' : 'purchases';
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  try {
    const m = hash.match(/^#\/item\/(\d+)/);
    if (m) await renderItem(m[1]);
    else if (tab === 'items') await renderItems();
    else if (tab === 'settings') await renderSettings();
    else if (tab === 'alerts') await renderAlerts();
    else if (tab === 'home') await renderHome();
    else await renderPurchases();
  } catch (e) {
    app.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`;
  }
  refreshBanner();
}

window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
route();
