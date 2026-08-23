/* ============================================================
   Clinic Chart — public booking page.

   This is the only code in the project that runs for someone who is not
   signed in. It is deliberately small and deliberately separate from
   index.html: a bug here is reachable by anyone on the internet.

   Three things it must never do:
     - read clinics/{id}. That document holds the clinic's settings,
       including geminiApiKey. It reads clinics/{id}/publicConfig/booking,
       which exists solely so this page has somewhere safe to look.
     - list bookingRequests. It can create one, and get the single document
       whose 20-character id the patient was given. Listing would expose
       every requester's name, mobile and complaint.
     - trust anything it sends. The security rules re-check the shape, the
       status and the timestamp; the checks below are for the patient's
       benefit, not the clinic's protection.
   ============================================================ */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* SEC-05, again. frame-ancestors and X-Frame-Options are HTTP headers, and
   GitHub Pages sends neither; the directive is also ignored when delivered in
   a <meta> tag, which the console says out loud. So the same guard index.html
   uses is repeated here: a booking form is worth clickjacking precisely
   because it is the one page a stranger is expected to fill in. */
if (window.top !== window.self) {
  document.documentElement.textContent =
    'This page cannot be displayed inside another site.';
  throw new Error('framed');
}

const cfg = window.__CLINIC_CONFIG;
const $ = (id) => document.getElementById(id);
const show = (el, on) => { if (el) el.hidden = !on; };

const state = { config: null, date: '', slot: '', busy: false, ref: '' };

/* ---------- boot ---------- */
function fail(msg) {
  const b = $('boot');
  b.className = 'note bad';
  b.textContent = msg;
  show(b, true);
  show($('formView'), false);
  show($('statusView'), false);
}

if (!cfg || !cfg.apiKey || !cfg.projectId) {
  fail('This booking page is not set up yet — clinic-config.js is missing or incomplete.');
  throw new Error('clinic-config.js missing');
}
if (!cfg.clinicId) {
  // Deliberately not a silent no-op: an unconfigured clinicId would otherwise
  // read a document path of clinics//publicConfig/booking and fail obscurely.
  fail('Online booking is not switched on for this clinic.');
  throw new Error('clinicId not set in clinic-config.js');
}

const db = getFirestore(initializeApp(cfg));
const publicConfigRef = doc(db, 'clinics', cfg.clinicId, 'publicConfig', 'booking');
const requestsCol = () => collection(db, 'clinics', cfg.clinicId, 'bookingRequests');

/* ---------- helpers ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : NaN;
}
function fromMinutes(mins) { return pad(Math.floor(mins / 60)) + ':' + pad(mins % 60); }
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Slots are generated from the clinic's opening times, minus holidays and
   half-day overrides. They are NOT filtered by what is already booked: that
   would need reading the appointments collection, which is staff-only and
   must stay that way. A patient may therefore ask for a time the clinic has
   already given away — which is exactly why every request arrives Pending and
   a person confirms it. The page says so rather than implying a guarantee. */
function slotsFor(dateISO) {
  const c = state.config || {};
  const hol = (c.holidays || []).find(h => h && h.date === dateISO);
  if (hol) return { closed: true, reason: hol.reason || '', slots: [] };
  const half = (c.halfDays || []).find(h => h && h.date === dateISO);
  const start = toMinutes(half ? half.start : c.slotStart);
  const end = toMinutes(half ? half.end : c.slotEnd);
  const step = Number(c.slotMinutes) > 0 ? Number(c.slotMinutes) : 30;
  if (!isFinite(start) || !isFinite(end) || end <= start) {
    return { closed: true, reason: '', slots: [] };
  }
  const slots = [];
  for (let t = start; t + step <= end && slots.length < 60; t += step) slots.push(fromMinutes(t));
  return { closed: false, half: half || null, slots };
}

function renderSlots() {
  const box = $('slots');
  box.textContent = '';
  const note = $('dayNote');
  if (!state.date) { show(note, false); return; }
  const { closed, reason, half, slots } = slotsFor(state.date);
  if (closed) {
    note.className = 'note bad';
    note.textContent = reason ? ('The clinic is closed that day — ' + reason + '.')
                              : 'The clinic is closed that day.';
    show(note, true);
    return;
  }
  if (half) {
    note.className = 'note warn';
    note.textContent = 'Half day — ' + half.start + ' to ' + half.end +
      (half.reason ? ' (' + half.reason + ')' : '') + '. Fewer slots than usual.';
    show(note, true);
  } else show(note, false);

  // A slot that has already passed cannot be booked. The generator works from
  // the clinic's opening hours alone, so at 6pm it happily offered 17:00 —
  // the patient gets a confirmation for a time that is already gone, and the
  // clinic finds out when they don't arrive.
  //
  // The comparison is only applied to TODAY. Using a raw timestamp would also
  // rule out tomorrow morning, since 09:00 tomorrow is "before now" in no
  // sense a patient would recognise.
  const isToday = state.date === todayISO();
  const nowMins = (() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })();
  const toMins = t => { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); };
  const bookable = isToday ? slots.filter(t => toMins(t) > nowMins) : slots;

  if (!bookable.length) {
    note.className = 'note warn';
    note.textContent = isToday
      ? 'No times left today. Please choose another day.'
      : 'No times available that day.';
    show(note, true);
    // A stale selection from an earlier render must not survive: the slot is
    // gone from the screen but would still be submitted.
    state.slot = '';
    return;
  }
  if (state.slot && bookable.indexOf(state.slot) === -1) state.slot = '';

  bookable.forEach(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot';
    b.textContent = t;
    b.setAttribute('aria-pressed', String(state.slot === t));
    b.addEventListener('click', () => { state.slot = t; renderSlots(); });
    box.appendChild(b);
  });
}

/* The QR is drawn here, on the device, with the library the app already
   vendors. The previous booking site fetched it from api.qrserver.com, which
   sent the clinic's UPI id and the amount to a third party on every view and
   broke with no connection. */
function renderPayment() {
  const c = state.config || {};
  if (!c.upiId || !(Number(c.fee) > 0)) { show($('payCard'), false); return; }
  show($('payCard'), true);
  $('payLine').textContent = 'UPI / GPay · ₹' + Number(c.fee);
  try {
    const link = 'upi://pay?pa=' + encodeURIComponent(c.upiId) +
      '&pn=' + encodeURIComponent(c.upiName || c.clinicName || 'Clinic') +
      '&am=' + encodeURIComponent(Number(c.fee)) + '&cu=INR&tn=Appointment';
    // Render straight into the visible node. Reading img.src immediately after
    // construction returned an empty string — qrcodejs fills it on a later
    // tick — which is how the page shipped a broken-image icon where the QR
    // should be. Appending the library's own node sidesteps the timing.
    const box = $('qr');
    box.textContent = '';
    new window.QRCode(box, { text: link, width: 180, height: 180 });
    show(box, true);
  } catch (e) {
    // A missing QR is a smaller problem than a broken page: the UPI id is
    // still shown above and payment at the clinic is always an option.
    console.error('QR render failed', e);
    show($('qr'), false);
  }
}

/* ---------- submit ---------- */
function validate() {
  const name = $('f_name').value.trim();
  const mobile = $('f_mobile').value.replace(/\D/g, '');
  if (name.length < 2) return 'Please enter the patient\u2019s name.';
  if (mobile.length < 8) return 'Please enter a valid mobile number.';
  if (!state.date) return 'Please choose a date.';
  if (!state.slot) return 'Please choose a time.';
  if (!$('f_consent').checked) return 'Please tick the box to continue.';
  const age = $('f_age').value.trim();
  if (age !== '' && (!/^\d{1,3}$/.test(age) || +age > 130)) return 'Please check the age.';
  return '';
}

async function submit() {
  if (state.busy) return;                       // double-submit guard
  const err = validate();
  const box = $('formErr');
  if (err) { box.textContent = err; show(box, true); return; }
  show(box, false);

  state.busy = true;
  $('submitBtn').disabled = true;
  $('submitBtn').textContent = 'Sending…';
  try {
    const ref = doc(requestsCol());
    const ageRaw = $('f_age').value.trim();
    await setDoc(ref, {
      name: $('f_name').value.trim().slice(0, 80),
      mobile: $('f_mobile').value.trim().slice(0, 20),
      age: ageRaw === '' ? 0 : parseInt(ageRaw, 10),
      gender: $('f_gender').value,
      reason: $('f_reason').value.trim().slice(0, 300),
      requestedDate: state.date,
      requestedSlot: state.slot,
      paymentMethod: (state.config && state.config.upiId) ? 'UPI' : 'At clinic',
      paymentClaimed: false,
      status: 'Pending',
      createdAt: serverTimestamp(),
      source: 'web'
    });
    remember(ref.id);
    location.hash = 'ref=' + ref.id;
    await openStatus(ref.id);
  } catch (e) {
    console.error('booking failed', e && e.code);
    box.textContent = 'Could not send that — please check your connection and try again.';
    show(box, true);
  } finally {
    state.busy = false;
    $('submitBtn').disabled = false;
    $('submitBtn').textContent = 'Request this appointment';
  }
}

/* The reference is kept so a returning patient sees their booking without
   digging out a link. localStorage is not treated as the record — the URL
   fragment wins — because a shared phone would otherwise show one family
   member the other's booking. */
function remember(id) { try { localStorage.setItem('cc_booking_ref', id); } catch (e) {} }
function recall() { try { return localStorage.getItem('cc_booking_ref') || ''; } catch (e) { return ''; } }

/* ---------- status ---------- */
async function openStatus(id) {
  state.ref = id;
  show($('boot'), false);
  show($('formView'), false);
  show($('statusView'), true);
  $('refText').textContent = id;
  const box = $('statusBox'), detail = $('statusDetail'), errBox = $('statusErr');
  show(errBox, false);
  box.className = 'status pending';
  box.innerHTML = '<h2>Checking…</h2>';
  detail.textContent = '';
  show($('cancelBtn'), false);

  let snap;
  try {
    snap = await getDoc(doc(requestsCol(), id));
  } catch (e) {
    console.error('status lookup failed', e && e.code);
    box.className = 'status cancelled';
    box.innerHTML = '<h2>Could not check</h2><p>Please try again in a moment.</p>';
    return;
  }
  if (!snap.exists()) {
    box.className = 'status cancelled';
    box.innerHTML = '<h2>Not found</h2><p>That reference doesn\u2019t match a booking.</p>';
    return;
  }
  const d = snap.data();
  const c = state.config || {};
  const when = esc(d.requestedDate || '') + (d.requestedSlot ? ', ' + esc(d.requestedSlot) : '');

  if (d.status === 'Confirmed') {
    box.className = 'status confirmed';
    box.innerHTML = '<div class="tag">Confirmed</div><h2>' + when +
      '</h2><p>Please arrive about ten minutes early.</p>';
    detail.innerHTML = '<div class="note good"><b>' + esc(c.clinicName || 'The clinic') + '</b>' +
      (c.address ? '<br>' + esc(c.address) : '') + '</div>';
    show($('cancelBtn'), true);
  } else if (d.status === 'Pending') {
    box.className = 'status pending';
    box.innerHTML = '<div class="tag">Pending</div><h2>Waiting for the clinic</h2>' +
      '<p>You asked for <b>' + when + '</b>. Nothing is held until the clinic confirms.</p>';
    show($('cancelBtn'), true);
  } else if (d.status === 'Cancelled') {
    box.className = 'status cancelled';
    box.innerHTML = '<div class="tag">Cancelled</div><h2>This booking was cancelled</h2>' +
      '<p>Request another time whenever you like.</p>';
  } else {
    box.className = 'status cancelled';
    box.innerHTML = '<div class="tag">Not available</div><h2>That slot has gone</h2><p>' +
      (d.declineReason ? esc(d.declineReason) : 'Please request another time.') + '</p>';
  }
}

async function cancelBooking() {
  if (state.busy || !state.ref) return;
  state.busy = true;
  $('cancelBtn').disabled = true;
  try {
    // The rules permit exactly this transition and nothing else.
    await updateDoc(doc(requestsCol(), state.ref),
      { status: 'Cancelled', cancelledAt: serverTimestamp() });
    await openStatus(state.ref);
  } catch (e) {
    console.error('cancel failed', e && e.code);
    $('statusErr').textContent = 'Could not cancel — please phone the clinic.';
    show($('statusErr'), true);
  } finally {
    state.busy = false;
    $('cancelBtn').disabled = false;
  }
}

/* ---------- start ---------- */
function refFromHash() {
  // The fragment, never the query string: a ?ref= is sent in the Referer
  // header to every third party the page loads. A fragment is not transmitted.
  const m = /(?:^|[#&])ref=([A-Za-z0-9_-]{6,64})/.exec(location.hash || '');
  return m ? m[1] : '';
}

async function start() {
  let cSnap;
  try {
    cSnap = await getDoc(publicConfigRef);
  } catch (e) {
    console.error('publicConfig read failed', e && e.code);
    fail('Could not reach the clinic right now. Please try again shortly.');
    return;
  }
  if (!cSnap.exists()) { fail('Online booking is not switched on for this clinic.'); return; }
  state.config = cSnap.data() || {};

  $('clinicName').textContent = state.config.clinicName || 'Book an appointment';
  $('clinicAddr').textContent = state.config.address || '';
  document.title = (state.config.clinicName || 'Clinic') + ' — book an appointment';

  // Listeners are attached BEFORE the status-view early return below. They
  // used to be at the end of this function, so a visitor arriving with a saved
  // reference got the status view and returned before any button was wired:
  // Cancel and Book-another rendered perfectly and did nothing at all.
  $('submitBtn').addEventListener('click', submit);
  $('cancelBtn').addEventListener('click', cancelBooking);
  $('againBtn').addEventListener('click', () => {
    try { localStorage.removeItem('cc_booking_ref'); } catch (e) {}
    location.hash = '';
    location.reload();
  });

  const existing = refFromHash() || recall();
  if (existing) { await openStatus(existing); return; }

  show($('boot'), false);
  show($('formView'), true);

  if (state.config.active === false) {
    const n = $('closedNote');
    n.textContent = state.config.closedMessage ||
      'Online booking is paused at the moment. Please phone the clinic.';
    show(n, true);
    $('submitBtn').disabled = true;
  }

  const dateEl = $('f_date');
  dateEl.min = todayISO();
  dateEl.addEventListener('change', () => {
    state.date = dateEl.value; state.slot = ''; renderSlots();
  });
  renderPayment();

}

window.addEventListener('hashchange', () => {
  const r = refFromHash();
  if (r && r !== state.ref) openStatus(r);
});

start();
