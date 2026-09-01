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
  getFirestore, doc, getDoc, setDoc, updateDoc, collection, serverTimestamp,
  getDocs, query, where, writeBatch
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
  show($('lookupCard'), false);
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

const _app = initializeApp(cfg);

/* App Check, only when a site key is configured.
   
   This page is the one unauthenticated write path in the product, and since
   3.30.0 a booking request also reserves a slot -- so without it, a script can
   hold the clinic's entire week. App Check has Firebase reject writes that did
   not originate from a real browser running this page.
   
   Loaded dynamically so a clinic with no key set pays nothing: no reCAPTCHA
   script, no extra requests, and the page behaves exactly as it did before.
   That also means the CSP below has to permit google.com whether or not the key
   is set, which is the one cost of this -- see the note in book.html. */
if (String(cfg.appCheckSiteKey || '').trim()) {
  import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js')
    .then(function (m) {
      m.initializeAppCheck(_app, {
        provider: new m.ReCaptchaV3Provider(String(cfg.appCheckSiteKey).trim()),
        isTokenAutoRefreshEnabled: true
      });
    })
    .catch(function (e) {
      // Deliberately non-fatal. If App Check cannot start, bookings still reach
      // Firestore and are accepted or rejected by the rules as before; a clinic
      // that has switched enforcement on will see them refused, which is the
      // correct outcome and is visible in the console rather than silent here.
      console.error('App Check failed to start', e && e.message);
    });
}

const db = getFirestore(_app);
const publicConfigRef = doc(db, 'clinics', cfg.clinicId, 'publicConfig', 'booking');
const requestsCol = () => collection(db, 'clinics', cfg.clinicId, 'bookingRequests');

/* ---------- helpers ---------- */
function pad(n) { return String(n).padStart(2, '0'); }
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
/* The two schedules the clinic offers. Clinic visits use the top-level fields,
   unchanged, so a clinic that never enables online consultations sees exactly
   what it saw before. */
function modes() {
  const c = state.config || {};
  const out = [];
  if (c.active !== false) {
    out.push({ id:'clinic', label:'At the clinic',
      slotStart:c.slotStart, slotEnd:c.slotEnd, slotMinutes:c.slotMinutes, fee:c.fee });
  }
  if (c.online && c.online.active) {
    out.push({ id:'online', label:'Online consultation',
      slotStart:c.online.slotStart, slotEnd:c.online.slotEnd,
      slotMinutes:c.online.slotMinutes, fee:c.online.fee });
  }
  return out;
}

function currentMode() {
  const ms = modes();
  return ms.find(m => m.id === state.mode) || ms[0] || null;
}

/* What kind of appointment this booking is. Read from the booking document
   rather than from state.mode, because the status page is often opened days
   later from a saved link, when nothing on the page has been chosen. A booking
   made before 3.37.0 has no mode and is a clinic visit, which is what it was. */
function bookingMode(d) {
  return (d && d.mode === 'online') ? 'online' : 'clinic';
}

/* ---------- working hours as intervals ----------

   Availability is ONE operation: the hours you are open, minus the time you are
   away. Everything the clinic used to configure separately falls out of it:

     a break          the gap between two open intervals; not stored at all
     closed Sundays   Sunday having no intervals; nothing repeats
     a half day       a leave that does not cover the whole day
     Sat mornings     Saturday's intervals being shorter than Monday's

   The previous design applied hours, then closures, then breaks, in that order,
   and getting the order wrong silently dropped a slot: a half day of 10:30-13:00
   with a 13:00-14:00 lunch lost its last slot and the day still looked fine.
   Subtraction has no order to get wrong.

   Times are minutes from midnight throughout. Comparing "09:00" as a string
   works by luck of zero-padding and stops working the moment anything is
   arithmetic. */

function toMin(hhmm){
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if(!m) return NaN;
  const v = (+m[1]) * 60 + (+m[2]);
  return (v >= 0 && v <= 1440) ? v : NaN;
}
function fromMin(v){
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

/* [a,b) minus a list of [c,d). Returns the pieces that survive, in order. */
function subtractIntervals(open, aways){
  let out = [open.slice()];
  (aways || []).forEach(function(a){
    const next = [];
    out.forEach(function(iv){
      // No overlap: the interval passes through untouched.
      if(a[1] <= iv[0] || a[0] >= iv[1]) { next.push(iv); return; }
      // A leave landing in the middle splits one interval into two, which is
      // the case a naive "trim the start or the end" implementation gets wrong.
      if(a[0] > iv[0]) next.push([iv[0], a[0]]);
      if(a[1] < iv[1]) next.push([a[1], iv[1]]);
    });
    out = next;
  });
  return out;
}

/* The old flat config, read as intervals. Deliberately a READ-time derivation
   rather than a migration that rewrites the document: a clinic that has not
   saved its settings since this release keeps working untouched, and there is
   no moment where a half-written conversion could leave a clinic with no hours.

   THE INVERSION THAT MATTERS: halfDays store the hours the clinic IS OPEN.
   Leaves store time it is CLOSED. A half day of 10:30-13:00 against 09:00-17:00
   is TWO leaves, 09:00-10:30 and 13:00-17:00 -- not one. Get this backwards and
   every half day becomes its own opposite, the clinic opening exactly when it
   used to be shut, with nothing to show for it until a patient books during
   lunch. */
function scheduleFor(modeId){
  const c = state.config || {};
  const sch = c.schedules && c.schedules[modeId];
  if(sch && sch.week) return sch;

  // Derived from the pre-interval shape.
  const src = modeId === 'online' ? (c.online || {}) : c;
  const a = toMin(src.slotStart), b = toMin(src.slotEnd);
  const lunchA = toMin(src.lunchStart), lunchB = toMin(src.lunchEnd);
  let day = (isFinite(a) && isFinite(b) && b > a) ? [[a, b]] : [];
  if(day.length && isFinite(lunchA) && isFinite(lunchB) && lunchB > lunchA){
    day = subtractIntervals(day[0], [[lunchA, lunchB]]);
  }
  /* closedDays holds the weekdays the clinic is shut every week, 0 = Sunday.
     A day listed here simply has no intervals, which is the whole mechanism --
     there is no recurring rule to evaluate and nothing to maintain.

     This is what a clinic closed on Sundays needed. Without it the only way to
     express it was to add a holiday every week forever, which nobody does, so
     Sundays stayed bookable and got declined by hand.

     Absent means open, deliberately: the old config had no way to say a day was
     closed, and inventing one here would shut a clinic that does work Sundays. */
  const closed = (c.closedDays || []).map(Number);
  const week = {};
  for(let d = 0; d < 7; d++){
    week[d] = closed.indexOf(d) !== -1 ? [] : day.map(function(iv){ return iv.slice(); });
  }
  return {
    active: modeId === 'online' ? !!(c.online && c.online.active) : c.active !== false,
    slotMinutes: Number(src.slotMinutes) > 0 ? Number(src.slotMinutes) : 30,
    fee: Number(src.fee) || 0,
    week: week
  };
}

/* Leaves for one date, in minutes, for one appointment type. */
function leavesFor(dateISO, modeId){
  const c = state.config || {};
  const out = [];
  const md = dateISO.slice(5); // MM-DD, for the yearly ones

  (c.leaves || []).forEach(function(L){
    if(!L) return;
    const scope = L.scope || 'both';
    if(scope !== 'both' && scope !== modeId) return;
    const from = String(L.from || ''), to = String(L.to || from);
    const inRange = L.yearly
      ? (md >= from.slice(5) && md <= (to || from).slice(5))
      : (dateISO >= from && dateISO <= (to || from));
    if(!inRange) return;
    const a = toMin(L.fromTime), b = toMin(L.toTime);
    // No times means the whole day. A leave with only a start time runs to the
    // end of the day, which is how "away from 1pm" is expressed.
    out.push([isFinite(a) ? a : 0, isFinite(b) ? b : 1440]);
  });

  // The pre-interval shape, still read so nothing has to be migrated first.
  (c.holidays || []).forEach(function(h){
    if(h && h.date === dateISO) out.push([0, 1440]);
  });
  (c.halfDays || []).forEach(function(h){
    if(!h || h.date !== dateISO) return;
    const openA = toMin(h.start), openB = toMin(h.end);
    if(!isFinite(openA) || !isFinite(openB) || openB <= openA){ out.push([0, 1440]); return; }
    // The inversion. Two leaves, not one.
    if(openA > 0) out.push([0, openA]);
    if(openB < 1440) out.push([openB, 1440]);
  });
  return out;
}

function leaveReasonFor(dateISO, modeId){
  const c = state.config || {};
  const md = dateISO.slice(5);
  let found = '';
  (c.leaves || []).forEach(function(L){
    if(!L || found) return;
    const scope = L.scope || 'both';
    if(scope !== 'both' && scope !== modeId) return;
    const from = String(L.from || ''), to = String(L.to || from);
    const inRange = L.yearly
      ? (md >= from.slice(5) && md <= (to || from).slice(5))
      : (dateISO >= from && dateISO <= (to || from));
    if(inRange && L.reason) found = L.reason;
  });
  if(found) return found;
  const h = (c.holidays || []).find(function(x){ return x && x.date === dateISO; });
  return (h && h.reason) || '';
}

function slotsFor(dateISO) {
  const modeId = (currentMode() || {}).id || 'clinic';
  const sch = scheduleFor(modeId);
  const step = Number(sch.slotMinutes) > 0 ? Number(sch.slotMinutes) : 30;

  let dow;
  try{ dow = new Date(dateISO + 'T00:00:00').getDay(); }catch(e){ dow = -1; }
  const open = (sch.week && sch.week[dow]) || [];
  const aways = leavesFor(dateISO, modeId);

  const free = [];
  open.forEach(function(iv){
    subtractIntervals(iv, aways).forEach(function(piece){ free.push(piece); });
  });

  const slots = [];
  free.forEach(function(iv){
    for(let t = iv[0]; t + step <= iv[1] && slots.length < 60; t += step) slots.push(fromMin(t));
  });

  if(!slots.length){
    return { closed: true, reason: leaveReasonFor(dateISO, modeId), slots: [] };
  }
  return { closed: false, slots: slots };
}

/* Only drawn when the clinic offers both. A one-option chooser is a decision
   the patient does not have and should not be asked to make. */
function renderModes() {
  const box = $('modeRow');
  if (!box) return;
  const ms = modes();
  if (ms.length < 2) { show(box, false); return; }
  if (!ms.find(m => m.id === state.mode)) state.mode = ms[0].id;
  box.textContent = '';
  ms.forEach(m => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mode' + (state.mode === m.id ? ' on' : '');
    b.setAttribute('aria-pressed', String(state.mode === m.id));
    b.innerHTML = '<span>' + esc(m.label) + '</span>' +
      (Number(m.fee) > 0 ? '<small>\u20B9' + Number(m.fee) + '</small>' : '');
    b.addEventListener('click', () => {
      if (state.mode === m.id) return;
      state.mode = m.id;
      // The chosen time belongs to the old schedule and almost certainly is not
      // a slot in the new one, so it is dropped rather than silently carried.
      state.slot = '';
      state.takenSlots = new Set();
      renderModes(); renderSlots(); renderPayment();
      if (state.date) loadTakenSlots(state.date).then(() => { renderSlots(); });
    });
    box.appendChild(b);
  });
  show(box, true);
}

function renderSlots() {
  const box = $('slots');
  box.textContent = '';
  const note = $('dayNote');
  if (!state.date) { show(note, false); return; }
  const { closed, reason, half, slots } = slotsFor(state.date);
  if (closed) {
    // A closed day is exactly when someone most needs to reach the clinic, so
    // it offers the phone rather than leaving them at an empty grid wondering
    // whether the page is broken.
    const c2 = state.config || {};
    const msg = (c2.closedMessage || '').trim()
      || 'The clinic is closed on this day. For anything urgent, please call us.';
    note.className = 'note warn closed-day';
    note.innerHTML =
      '<div class="cd-k">Closed</div>' +
      (reason ? '<div class="cd-r">' + esc(reason) + '</div>' : '') +
      '<p>' + esc(msg) + '</p>' +
      (c2.phone
        ? '<a class="cd-call" href="tel:' + esc(String(c2.phone).replace(/[^\d+]/g, '')) + '">Call the clinic</a>'
        : '');
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

  // Slots the clinic has already given away. state.takenSlots is filled by
  // loadTakenSlots() from the slotLocks collection, which holds a date and a
  // time and no identifiers -- see the rules file. If that read failed the set
  // is empty and every slot stays offered, which is the pre-3.25.0 behaviour:
  // a request for a taken time still arrives Pending and a person declines it.
  // Failing open is right here. Failing closed would hide the clinic's whole
  // day because one read timed out.
  const taken = state.takenSlots || new Set();

  if (state.slot && taken.has(state.slot)) state.slot = '';

  bookable.forEach(t => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'slot' + (taken.has(t) ? ' taken' : '');
    b.textContent = t;
    if (taken.has(t)) {
      b.disabled = true;
      b.title = 'Already booked';
      b.setAttribute('aria-disabled', 'true');
    }
    b.setAttribute('aria-pressed', String(state.slot === t));
    b.addEventListener('click', () => {
      if (taken.has(t)) return;
      state.slot = t; renderSlots();
    });
    box.appendChild(b);
  });

  if (bookable.every(t => taken.has(t))) {
    note.className = 'note warn';
    note.textContent = 'Every time that day is already booked. Please choose another day.';
    show(note, true);
  }
}

/* Reads the slot locks for one date. Public by design: the documents carry a
   date and a time and nothing else, so this exposes "10:00 is taken", which is
   what a patient would learn by trying to book it anyway. It deliberately does
   NOT read the appointments collection, which is staff-only and must stay
   that way -- that constraint is why slot locks exist as a separate thing. */
async function loadTakenSlots(dateISO) {
  state.takenSlots = new Set();
  if (!dateISO || !cfg.clinicId) return;
  try {
    const snap = await getDocs(query(
      collection(db, 'clinics', cfg.clinicId, 'slotLocks'),
      where('date', '==', dateISO)));
    const s = new Set();
    // Filtered by mode HERE rather than in the query: adding mode to the where
    // clause would need another composite index, and a day never holds enough
    // locks for the difference to matter. A lock with no mode is a clinic visit
    // booked before 3.37.0.
    const want = (currentMode() || {}).id || 'clinic';
    snap.forEach(d => {
      const v = d.data();
      if (v && v.slot && ((v.mode || 'clinic') === want)) s.add(v.slot);
    });
    state.takenSlots = s;
  } catch (e) {
    // Fail open, and say so in the console rather than silently.
    console.error('loadTakenSlots failed', e && e.code, e && e.message);
  }
}

/* The QR is drawn here, on the device, with the library the app already
   vendors. The previous booking site fetched it from api.qrserver.com, which
   sent the clinic's UPI id and the amount to a third party on every view and
   broke with no connection. */
function renderPayment() {
  const c = state.config || {};
  // The fee follows the chosen mode, not the clinic default -- charging the
  // in-clinic amount for an online consultation is a refund and a phone call.
  const fee = Number((currentMode() || {}).fee || 0);
  if (!c.upiId || !(fee > 0)) { show($('payCard'), false); return; }
  show($('payCard'), true);
  $('payLine').textContent = 'UPI / GPay · ₹' + fee;
  try {
    const link = 'upi://pay?pa=' + encodeURIComponent(c.upiId) +
      '&pn=' + encodeURIComponent(c.upiName || c.clinicName || 'Clinic') +
      '&am=' + encodeURIComponent(fee) + '&cu=INR&tn=Appointment';
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

/* Must derive EXACTLY the same id as slotLockId() in index.html, or the clinic
   and the public page would claim different documents for the same time and
   the whole mechanism would silently do nothing. Kept deliberately identical;
   a test asserts both files agree. */
function slotLockId(dateISO, slot, mode) {
  const d = String(dateISO || '').trim();
  const t = String(slot || '').trim().replace(/:/g, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{3,4}$/.test(t)) return '';
  // Must match slotLockId() in index.html exactly, including the fact that a
  // clinic visit gets NO suffix -- every lock held by a booking made before
  // 3.37.0 has that shape. A test asserts the two files agree.
  return d + '_' + t.padStart(4, '0') + (mode === 'online' ? '_o' : '');
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
    // The slot is claimed in the SAME batch as the request (3.30.0). The lock
    // is a create and `allow update: if false`, so if someone else claimed this
    // time between the page rendering and this tap, the batch fails and no
    // request is written -- rather than a request being accepted for a slot
    // that is already gone. Nothing half-lands.
    const lockId = slotLockId(state.date, state.slot, (currentMode()||{}).id);
    const batch = writeBatch(db);
    if (lockId) {
      batch.set(doc(collection(db, 'clinics', cfg.clinicId, 'slotLocks'), lockId), {
        date: state.date,
        slot: state.slot,
        mode: (currentMode()||{}).id || 'clinic',
        createdAt: new Date().toISOString()
        // No reference to this booking: the lock is publicly readable and a
        // booking's id is the token that opens it.
      });
    }
    batch.set(ref, {
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
      source: 'web',
      mode: (currentMode()||{}).id || 'clinic',
      // Records that THIS request claimed the slot. The lock itself carries no
      // identifier (it is public), so this is how the clinic later knows the
      // existing lock belongs to this booking rather than someone else's.
      slotLockHeld: !!lockId
    });
    await batch.commit();
    remember(ref.id);
    // The slip downloads itself once, here, at the only moment we know the
    // booking was just made. Doing it on every visit to the status page would
    // drop a file in the patient's downloads every time they checked.
    downloadBookingPdf(ref.id, {
      name: $('f_name').value.trim(),
      mobile: $('f_mobile').value.trim(),
      requestedDate: state.date, requestedSlot: state.slot,
      reason: $('f_reason').value.trim(), status: 'Pending'
    });
    location.hash = 'ref=' + ref.id;
    await openStatus(ref.id);
  } catch (e) {
    console.error('booking failed', e && e.code, e && e.message);
    // permission-denied here almost always means the slot went while the form
    // was open. Say that, and refresh the times so the taken one is struck out
    // -- telling someone to check their connection when the real answer is
    // "somebody just took 17:00" sends them to reboot their router.
    if (e && e.code === 'permission-denied') {
      box.textContent = 'Sorry — that time was just taken. Please choose another.';
      state.slot = '';
      await loadTakenSlots(state.date);
      renderSlots();
    } else {
      box.textContent = 'Could not send that — please check your connection and try again.';
    }
    show(box, true);
  } finally {
    state.busy = false;
    $('submitBtn').disabled = false;
    $('submitBtn').textContent = 'Request this appointment';
  }
}

/* ---------- the confirmation slip ---------- */

/* A one-page PDF built by hand, in about eighty lines, instead of pulling in
   jsPDF. jsPDF is 410 KB and the app already vendors it — but this is the
   PUBLIC page, loaded by a patient on mobile data who wants one screen and a
   reference number. Making every visitor fetch 410 KB so that some of them can
   download a slip is the wrong trade. A PDF containing nothing but text in a
   standard font is a few hundred bytes of well-documented syntax.

   Helvetica is used because it is one of the fourteen fonts every PDF reader is
   required to have built in, so nothing has to be embedded. That also means
   only WinAnsi characters survive: the rupee sign is not in it, so amounts are
   written as "Rs." rather than rendering as a wrong glyph in the patient's
   copy. */
function pdfEscape(t){
  return String(t == null ? '' : t)
    .replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    // Anything outside WinAnsi would render as the wrong glyph in a font we did
    // not embed, so it is dropped rather than shown wrongly.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '');
}

function buildBookingPdf(id, d){
  const c = state.config || {};
  const L = [];
  const line = (txt, size, font, dy) => L.push({ t: txt, s: size, f: font || 'F1', dy: dy || 0 });

  const online = bookingMode(d) === 'online';
  line(c.clinicName || 'Clinic', 17, 'F2', 0);
  // No street address on the slip for a video consultation: a printed address
  // is an instruction to go there.
  if(c.address && !online) line(c.address, 9.5, 'F1', 16);
  if(c.phone)   line(c.phone, 9.5, 'F1', 12);
  line('APPOINTMENT CONFIRMATION SLIP', 10, 'F2', 30);
  line('Reference: ' + id, 13, 'F2', 24);
  line('Show this reference at the clinic.', 9, 'F1', 14);
  line('Name: ' + (d.name || '-'), 11, 'F1', 24);
  if(d.mobile) line('Mobile: ' + d.mobile, 11, 'F1', 15);
  if(d.mode) line('Type: ' + (d.mode === 'online' ? 'Online consultation' : 'Visit at the clinic'), 11, 'F1', 15);
  line('Date: ' + (d.requestedDate || '-') + (d.requestedSlot ? '   Time: ' + d.requestedSlot : ''), 11, 'F1', 15);
  line('Status: ' + (d.status || 'Pending'), 11, 'F1', 15);
  const slipFee = Number((currentMode() || {}).fee || c.fee || 0);
  if(slipFee) line('Consultation fee: Rs. ' + slipFee, 11, 'F1', 15);
  if(d.reason) line('Reason: ' + String(d.reason).slice(0, 90), 10, 'F1', 15);
  line(online
    ? 'Online consultation. Joining details will be sent to you.'
    : 'Please arrive about ten minutes early.', 9, 'F1', 22);
  line('This is a request until the clinic confirms it.', 9, 'F1', 13);
  line('Check or cancel: ' + bookingLink(id), 8, 'F1', 13);

  // Text object. Start near the top of an A4 page and walk down.
  let y = 792, body = 'BT\n';
  L.forEach(function(o, i){
    y -= (i === 0 ? 0 : o.dy);
    body += '/' + o.f + ' ' + o.s + ' Tf\n1 0 0 1 56 ' + y + ' Tm\n(' + pdfEscape(o.t) + ') Tj\n';
  });
  body += 'ET';

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + body.length + ' >>\nstream\n' + body + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  ];

  // The cross-reference table needs each object's byte offset, so the file is
  // assembled while counting. Getting these wrong is the usual way a hand-made
  // PDF opens in one reader and not another.
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach(function(o, i){
    offsets.push(out.length);
    out += (i + 1) + ' 0 obj\n' + o + '\nendobj\n';
  });
  const xref = out.length;
  out += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(function(off){
    out += String(off).padStart(10, '0') + ' 00000 n \n';
  });
  out += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return out;
}

function downloadBookingPdf(id, d){
  try{
    const pdf = buildBookingPdf(id, d);
    // Latin-1: every byte written above is already in that range, and using
    // UTF-8 here would silently shift every offset in the xref table.
    const bytes = new Uint8Array(pdf.length);
    for(let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xFF;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'appointment-' + id + '.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 4000);
    return true;
  }catch(e){
    console.error('building the booking pdf failed', e && e.message);
    return false;
  }
}

/* ---------- keeping hold of the booking ---------- */

/* The full URL that reopens this booking. The reference lives in the FRAGMENT,
   which browsers do not send in the Referer header, so sharing this link does
   not leak the booking id to any third party the page happens to load. */
function bookingLink(id) {
  return location.origin + location.pathname + '#ref=' + id;
}

function bookingSummaryText(id, d) {
  const c = state.config || {};
  const when = d && d.requestedDate
    ? (' on ' + d.requestedDate + (d.requestedSlot ? ' at ' + d.requestedSlot : ''))
    : '';
  const kind = bookingMode(d) === 'online' ? ' online consultation' : ' appointment';
  return (c.clinicName || 'Clinic') + kind + when +
         '. Reference ' + id + '. Check or cancel it here: ' + bookingLink(id);
}

/* An .ics file built here, on the device. No calendar API, no third party, and
   it works with whatever calendar the patient actually uses. */
function downloadIcs(id, d) {
  const c = state.config || {};
  const date = (d && d.requestedDate || '').replace(/-/g, '');
  const time = (d && d.requestedSlot || '09:00').replace(':', '') + '00';
  if (!/^\d{8}$/.test(date)) { return false; }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  // No timezone conversion: a floating local time is what the patient reads on
  // the clinic's board, and guessing an offset here would move the appointment.
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Clinic Chart//EN',
    'BEGIN:VEVENT',
    'UID:' + id + '@clinic-chart',
    'DTSTAMP:' + stamp,
    'DTSTART:' + date + 'T' + time,
    'SUMMARY:' + (c.clinicName || 'Clinic') +
      (bookingMode(d) === 'online' ? ' online consultation' : ' appointment'),
    'DESCRIPTION:Reference ' + id + '. ' + bookingLink(id),
    (bookingMode(d) !== 'online' && c.address)
      ? 'LOCATION:' + String(c.address).replace(/[\r\n,]/g, ' ') : '',
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  try {
    const blob = new Blob([ics], { type: 'text/calendar' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'appointment.ics';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return true;
  } catch (e) { console.error('ics failed', e && e.message); return false; }
}

function wireSaveButtons(id, d) {
  const link = bookingLink(id);
  const text = bookingSummaryText(id, d);
  const wa = $('waBtn'), sms = $('smsBtn'), copy = $('copyBtn'), ics = $('icsBtn');
  if (wa) wa.onclick = () => {
    // wa.me opens WhatsApp with the message ready to send to whoever the
    // patient picks -- usually themselves. No number is needed and nothing
    // leaves the device until they choose a recipient.
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  };
  if (sms) sms.onclick = () => { location.href = 'sms:?&body=' + encodeURIComponent(text); };
  if (copy) copy.onclick = async () => {
    try {
      // navigator.share first: on a phone it offers every app the patient
      // already keeps things in. Clipboard is the fallback, and a manual
      // select-and-copy is the fallback to that.
      if (navigator.share) { await navigator.share({ text: text }); return; }
      await navigator.clipboard.writeText(link);
      copy.textContent = 'Link copied';
      setTimeout(() => { copy.textContent = 'Copy link'; }, 2500);
    } catch (e) {
      const r = $('refText');
      if (r) { r.textContent = link; }
      copy.textContent = 'Select and copy above';
    }
  };
  if (ics) ics.onclick = () => {
    if (!downloadIcs(id, d)) { ics.textContent = 'No date to add'; }
  };
  const pdf = $('pdfBtn');
  if (pdf) pdf.onclick = () => {
    if (!downloadBookingPdf(id, d)) { pdf.textContent = 'Could not build the slip'; }
  };
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
  show($('lookupCard'), false);
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
  // Wire the save buttons with the booking's real date and time, so the
  // WhatsApp text and the calendar entry say when the appointment is rather
  // than just handing over a bare reference.
  wireSaveButtons(id, d);
  const c = state.config || {};
  const when = esc(d.requestedDate || '') + (d.requestedSlot ? ', ' + esc(d.requestedSlot) : '');

  if (d.status === 'Confirmed') {
    const online = bookingMode(d) === 'online';
    box.className = 'status confirmed';
    // An online consultation has nothing to arrive at and no address to go to.
    // Telling a patient to turn up ten minutes early at a street address for a
    // video call is how someone ends up outside a locked clinic.
    box.innerHTML = '<div class="tag">Confirmed</div>' +
      '<div class="kind">' + (online ? 'Online consultation' : 'Visit at the clinic') + '</div>' +
      '<h2>' + when + '</h2><p>' +
      (online
        ? 'The clinic will send you the joining details before your appointment.'
        : 'Please arrive about ten minutes early.') + '</p>';
    detail.innerHTML = '<div class="note good"><b>' + esc(c.clinicName || 'The clinic') + '</b>' +
      // The address is directions for a visit; for a video call it is noise at
      // best and misleading at worst. The phone number stays either way.
      (!online && c.address ? '<br>' + esc(c.address) : '') +
      (online && c.phone ? '<br>' + esc(c.phone) : '') + '</div>' +
      '<div class="note warn">Need to change or cancel this appointment? ' +
      'Please phone the clinic' + (c.phone ? ' on ' + esc(c.phone) : '') + '.</div>';
    // The cancel button is deliberately NOT shown once a booking is Confirmed.
    // The security rules permit exactly one patient-side transition, Pending ->
    // Cancelled, so on a confirmed booking this button was guaranteed to fail
    // with permission-denied and then tell the patient to phone the clinic --
    // after making them press a button that never had a chance of working.
    // Offering an action the server forbids is worse than not offering it.
    show($('cancelBtn'), false);
  } else if (d.status === 'Pending') {
    box.className = 'status pending';
    box.innerHTML = '<div class="tag">Pending</div><h2>Waiting for the clinic</h2>' +
      // Was "Nothing is held until the clinic confirms", which stopped being
      // true in 3.30.0: the slot IS reserved the moment the form is submitted.
      // Leaving it would have told patients their time was up for grabs while
      // the clinic's calendar said otherwise.
      '<div class="kind">' +
      (bookingMode(d) === 'online' ? 'Online consultation' : 'Visit at the clinic') +
      '</div>' +
      '<p>You asked for <b>' + when + '</b>. This time is held for you. ' +
      'The clinic will confirm it shortly.</p>';
    show($('cancelBtn'), true);
  } else if (d.status === 'Cancelled') {
    show($('waBtn') && $('waBtn').parentNode, false);
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
    // The slot lock is NOT deleted here, and cannot be: the public may not
    // delete locks, because a lock carries no identifier and the rules could
    // not tell whether this caller owns the one being freed. The clinic app
    // releases it (reconcileCancelledSlots) the next time it is opened. The
    // status message below says "shortly" rather than "now" for that reason --
    // it is a real delay, not a hedge.
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

  const c0 = state.config;
  renderModes();
  $('clinicName').textContent = c0.clinicName || 'Book an appointment';
  $('clinicAddr').textContent = c0.address || '';
  if(c0.phone){
    $('clinicPhone').textContent = c0.phone;
    show($('clinicPhone'), true);
  }
  // Only a data: URL is accepted. This value arrives from the database, and an
  // http(s) src here would let anyone who could write publicConfig point the
  // clinic's own booking page at a third-party server and watch who loads it.
  const logo = String(c0.logoDataUrl || '');
  if(/^data:image\//.test(logo)){
    const img = $('clinicLogo');
    img.src = logo;
    img.alt = (c0.clinicName || 'Clinic') + ' logo';
    show(img, true);
  }
  document.title = (state.config.clinicName || 'Clinic') + ' — book an appointment';

  // Listeners are attached BEFORE the status-view early return below. They
  // used to be at the end of this function, so a visitor arriving with a saved
  // reference got the status view and returned before any button was wired:
  // Cancel and Book-another rendered perfectly and did nothing at all.
  $('submitBtn').addEventListener('click', submit);
  $('cancelBtn').addEventListener('click', cancelBooking);
  const lookupBtn = $('lookupBtn');
  if (lookupBtn) lookupBtn.addEventListener('click', async () => {
    const raw = ($('f_lookup').value || '').trim();
    const err = $('lookupErr');
    show(err, false);
    // Accept a whole pasted link as well as a bare reference: someone who
    // still has the link is far more likely to paste all of it.
    const m = /([A-Za-z0-9_-]{6,64})\s*$/.exec(raw.replace(/^.*#ref=/, ''));
    if (!m) {
      err.textContent = 'That does not look like a booking reference.';
      show(err, true);
      return;
    }
    location.hash = 'ref=' + m[1];
    await openStatus(m[1]);
  });

  $('againBtn').addEventListener('click', () => {
    try { localStorage.removeItem('cc_booking_ref'); } catch (e) {}
    location.hash = '';
    location.reload();
  });

  const existing = refFromHash() || recall();
  if (existing) { await openStatus(existing); return; }

  show($('boot'), false);
  show($('formView'), true);
  show($('lookupCard'), true);

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
    state.date = dateEl.value; state.slot = '';
    state.takenSlots = new Set();
    renderSlots();
    // Re-render once the locks land. Rendering first keeps the day's slots
    // visible immediately instead of blanking them behind a network round trip.
    loadTakenSlots(state.date).then(renderSlots);
  });
  renderPayment();

}

window.addEventListener('hashchange', () => {
  const r = refFromHash();
  if (r && r !== state.ref) openStatus(r);
});

start();
