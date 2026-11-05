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
    <div class="muted small">${esc(store(i.retailer))} · #${esc(i.order_number)}${i.seller ? ` · sold by ${esc(i.seller)}` : ''}</div></div>
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
    <div class="muted small">${esc(store(i.retailer))} · to ${esc(i.destination ?? 'your payment method')}</div></div>${label}</div>
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

// ---------- pages ----------
async function renderHome() {
  const [d, status] = await Promise.all([api('/dashboard'), api('/status')]);
  const t = d.today;
  app.innerHTML = `
    <div class="row" style="margin-top:4px"><h1>Overview</h1>
      <button class="btn" id="sync" title="${esc(status.gmail.note)}">Sync emails</button></div>
    ${status.gmail.connected ? '' : `<div class="notice">Gmail isn't connected yet — real email import is built in Stage 2. ${d.hasSampleData ? 'Everything below is sample data.' : '<a href="#/settings">Load sample data</a> to try the app.'}</div>`}

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
  document.getElementById('sync').addEventListener('click', async () => {
    try { await api('/sync', {}); } catch (e) { toast(e.message); }
  });
  wireRefundActions(app, renderHome);
}

async function renderItems() {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const d = await api('/items?' + params.toString());
  app.innerHTML = `
    <h1>Items</h1>
    <form class="filters" id="filters">
      <input name="q" type="search" placeholder="Search item, store, order #" value="${esc(params.get('q') ?? '')}">
      <select name="store"><option value="">All stores</option>${d.stores.map((s) => `<option value="${esc(s)}" ${params.get('store') === s ? 'selected' : ''}>${esc(store(s))}</option>`).join('')}</select>
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
  const today = (await api('/status')).today;
  const returnFlow = ['need_to_return', 'return_started', 'dropped_off', 'return_received', 'refund_issued', 'refund_confirmed'].includes(i.stage);

  app.innerHTML = `
    <p><a href="#/items">← Items</a></p>
    <h1>${esc(i.name)}</h1>
    <div class="row wrap">${stageBadge(i)}${sampleBadge(i)}${i.quantity > 1 ? `<span class="badge">Qty ${i.quantity}</span>` : ''}${i.split_from_item_id ? '<span class="badge">Partial return line</span>' : ''}</div>

    <div class="card" style="margin-top:12px"><dl class="kv">
      <dt>Store</dt><dd>${esc(store(i.retailer))}${i.seller ? ` — sold by ${esc(i.seller)} (third-party)` : ''}</dd>
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
      ${policy ? `<p class="small">${esc(i.policy_explanation ?? '')}</p>
        <dl class="kv small">
          <dt>Eligible</dt><dd>${{ eligible: 'Yes', not_eligible: 'No', unknown: 'Unknown' }[i.eligibility] ?? '—'}</dd>
          <dt>Window</dt><dd>${policy.windowDays != null ? `${policy.windowDays} days from ${policy.startsFrom}` : 'Unknown'}</dd>
          <dt>Refund timing</dt><dd>${policy.refundTiming ? `${policy.refundTiming.minDays}–${policy.refundTiming.maxDays} ${policy.refundTiming.unit} days after ${policy.refundTiming.startEvent.replace('_', ' ')}` : 'Unknown'}</dd>
          <dt>Source</dt><dd>${i.policy_url ? `<a href="${esc(i.policy_url)}" target="_blank" rel="noopener">Policy page</a>` : i.policy_origin === 'sample' ? 'Sample — no real source' : '—'}</dd>
          <dt>Checked</dt><dd>${i.policy_checked_at ? niceDate(i.policy_checked_at) : '—'}</dd>
        </dl>` : '<p class="small muted">Not reviewed yet.</p>'}
      <p class="small muted">AI policy review arrives in Stage 3.</p>
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

  app.querySelector('#stage').addEventListener('change', (e) => post(`/items/${id}/stage`, { stage: e.target.value }, 'Stage updated'));
  app.querySelectorAll('[data-stage]').forEach((b) => b.addEventListener('click', () => post(`/items/${id}/stage`, { stage: b.dataset.stage }, 'Stage updated')));
  app.querySelector('#dropoff')?.addEventListener('submit', (e) => { e.preventDefault(); post(`/items/${id}/dropoff`, Object.fromEntries(new FormData(e.target)), 'Drop-off saved'); });
  app.querySelector('#deadlines')?.addEventListener('submit', (e) => { e.preventDefault(); post(`/items/${id}/deadlines`, Object.fromEntries(new FormData(e.target)), 'Deadline saved — it won\'t be overwritten automatically'); });
  app.querySelector('#expected')?.addEventListener('submit', (e) => { e.preventDefault(); post(`/items/${id}/expected-refund`, Object.fromEntries(new FormData(e.target)), 'Expected amount saved'); });
  app.querySelector('#resolve')?.addEventListener('submit', (e) => { e.preventDefault(); post(`/items/${id}/refund/resolve`, Object.fromEntries(new FormData(e.target)), 'Refund closed'); });
  app.querySelectorAll('[data-sugg]').forEach((b) => b.addEventListener('click', () => post(`/suggestions/${b.dataset.sid}/${b.dataset.sugg}`, {}, b.dataset.sugg === 'accept' ? 'Suggestion applied' : 'Kept your version')));
  wireRefundActions(app, reload);
}

async function renderSettings() {
  const [s, status, d] = await Promise.all([api('/settings'), api('/status'), api('/dashboard')]);
  app.innerHTML = `
    <h1>Settings</h1>

    <h2>Connections</h2>
    <div class="card"><dl class="kv">
      <dt>Gmail</dt><dd>${status.gmail.connected ? '<span class="badge ok">Connected</span>' : `<span class="badge">Not connected</span> <span class="small muted">${esc(status.gmail.note)}</span>`}</dd>
      <dt>AI review</dt><dd>${status.ai.configured ? '<span class="badge ok">Configured</span>' : `<span class="badge">Not set up</span> <span class="small muted">${esc(status.ai.note)}</span>`}</dd>
      <dt>Retailers</dt><dd>${status.retailers.map((r) => `${esc(r.name)} ${r.parserReady ? '' : '<span class="small muted">(email parser in Stage 2)</span>'}`).join(', ')}</dd>
    </dl></div>

    <h2>Sample data</h2>
    <div class="card">
      <p class="small">Sample data is a set of made-up orders so you can try every screen. It's always labeled "Sample" and is never mixed up with real imports.</p>
      <div class="row"><button class="btn primary grow" id="load">${d.hasSampleData ? 'Reset sample data' : 'Load sample data'}</button>
      <button class="btn grow" id="clear" ${d.hasSampleData ? '' : 'disabled'}>Remove sample data</button></div>
    </div>

    <h2>Reminders</h2>
    <form class="card" id="settings">
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
      <p style="margin-top:0">Everything is stored in a database file on the computer running this app. Right now, <strong>no data leaves the app</strong>.</p>
      <p>Later stages: Gmail is read with <em>read-only</em> permission (the app can't change, archive, or delete email). For AI policy review, only the store, item name, seller, dates, and the policy page text are sent to the AI provider — not your full emails or payment details.</p>
    </div>
  `;
  document.getElementById('load').onclick = async () => { await api('/sample/load', {}); toast('Sample data loaded'); renderSettings(); refreshBanner(); };
  document.getElementById('clear').onclick = async () => { await api('/sample/clear', {}); toast('Sample data removed'); renderSettings(); refreshBanner(); };
  document.getElementById('settings').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/settings', Object.fromEntries(new FormData(e.target))); toast('Settings saved'); } catch (err) { toast(err.message); }
  };
}

// ---------- router ----------
async function refreshBanner() {
  try {
    const d = await api('/dashboard');
    document.getElementById('sample-banner').hidden = !d.hasSampleData;
  } catch { /* ignore */ }
}

async function route() {
  const hash = location.hash || '#/';
  const tab = hash.startsWith('#/items') || hash.startsWith('#/item/') ? 'items' : hash.startsWith('#/settings') ? 'settings' : 'home';
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  try {
    const m = hash.match(/^#\/item\/(\d+)/);
    if (m) await renderItem(m[1]);
    else if (tab === 'items') await renderItems();
    else if (tab === 'settings') await renderSettings();
    else await renderHome();
  } catch (e) {
    app.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`;
  }
  refreshBanner();
}

window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });
route();
