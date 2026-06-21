// =============================================================================
// gymboard — UI / render layer  (ui.js)   v2
// -----------------------------------------------------------------------------
// The ES-module entry point loaded by index.html (<script type="module">). It:
//   - imports the PURE, tested logic.js for EVERY date/missed/streak/trend/relative
//     computation (it never re-implements time math) and
//   - calls ONLY the data.js surface defined in the contract for all Firebase work
//     (it never imports firebase or touches Firestore directly).
//
// Boot order is load-bearing (DESIGN.md "How anonymous-auth + the token binding ..."):
//   initApp (App Check FIRST) -> authAndBind -> ensureUserDoc -> subscribeUsers.
//
// `now` is SERVER-ANCHORED. ui.js computes anchoredNow() = Date.now()+serverNowOffset()
// and passes THAT into currentBusinessDate()/missed()/computeStreak() so every viewer
// agrees through the rollover edge (DESIGN.md "Whose clock is now?").
//
// v2 scope (per SPEC-v2.md): two tabs GRID + ME (the old Today screen is GONE).
// The grid shows WORKOUT and NUTRITION per person per day (diagonal cells), plus
// per-person streak, weight+trend arrow, and last-active under each (vertical) name.
// Bottom bar = WORKOUT | MACROS, both tap-to-toggle. Day editor (tap own cell, any
// visible day = backfill) + read-only day detail (tap another person's cell). The
// LOUD reclaim modal, the offline outbox for WORKOUT, the optimistic overlay, and
// the autonomous missed->red repaint on a DST-safe next-rollover timer all remain.
// Scroll-back to past weeks is intentionally out of scope for this pass.
// =============================================================================

import {
  currentBusinessDate,
  prevBusinessDate,
  businessDate,
  missed,
  isRestDay,
  computeStreak,
  weightTrend,
  relativeTime,
  isDayKey,
} from './logic.js';

import * as data from './data.js';

// ---- defaults (the businessDate FUNCTION already takes tz+rollover params, so
//      per-user values from each subject's own doc ALWAYS win when present). ----
const DEFAULT_ROLLOVER_H = 4;
const DEFAULT_ROLLOVER_M = 0;
const DEFAULT_TZ =
  (typeof Intl !== 'undefined' &&
    Intl.DateTimeFormat().resolvedOptions &&
    Intl.DateTimeFormat().resolvedOptions().timeZone) ||
  'America/New_York';

const GRID_DAYS = 7; // one week (the current Mon..Sun-ish window, newest at top)
const WEIGHT_WINDOW_DAYS = 14; // weights window fetched per member for the trend
const HEARTBEAT_MS = 60 * 1000; // coarse belt-and-suspenders missed() re-eval

// =============================================================================
// DOM HANDLES
// =============================================================================
const $ = (id) => document.getElementById(id);
const elHdrReg = $('hdr-reg');
const elPipSync = $('pip-sync');
const elTabs = $('tabs');
const elScreens = { grid: $('screen-grid'), me: $('screen-me') };
const elGrid = $('grid');
const elGridRange = $('grid-range');
const elGridLegend = $('grid-legend');
const elWorkoutTile = $('workout-tile');
const elMacrosTile = $('macros-tile');
const elReclaim = $('reclaim');
const elReclaimBackdrop = $('reclaim-backdrop');
const elReclaimBtn = $('reclaim-btn');
const elReclaimStatus = $('reclaim-status');
const elBoot = $('boot');
const elToast = $('toast');

// ME page handles
const elMeWorkout = $('me-workout');
const elMeAte = $('me-ate');
const elMeKcal = $('me-kcal');
const elMeProtein = $('me-protein');
const elMeWeight = $('me-weight');
const elMeSaveLog = $('me-save-log');
const elMeRestdays = $('me-restdays');
const elMeGoal = $('me-goal');
const elMeName = $('me-name');
const elMeRollover = $('me-rollover');
const elMeHideWeight = $('me-hideweight');
const elMeSaveSettings = $('me-save-settings');

// Day editor / detail handles
const elDayEdit = $('dayedit');
const elDayEditBackdrop = $('dayedit-backdrop');
const elDayEditDate = $('dayedit-date');
const elDeWorkout = $('de-workout');
const elDeOff = $('de-off');
const elDeAte = $('de-ate');
const elDeKcal = $('de-kcal');
const elDeProtein = $('de-protein');
const elDeWeight = $('de-weight');
const elDeCancel = $('de-cancel');
const elDeSave = $('de-save');
const elDayDetail = $('daydetail');
const elDayDetailBackdrop = $('daydetail-backdrop');
const elDayDetailTitle = $('daydetail-title');
const elDayDetailSub = $('daydetail-sub');
const elDayDetailBody = $('daydetail-body');
const elDayDetailClose = $('daydetail-close');

// =============================================================================
// SESSION STATE (UI-side only; data.js owns Firebase truth)
// =============================================================================
let myUserId = null;
let members = []; // latest /users snapshot (archived==false), as data.js hands it over
let daysByUser = new Map(); // userId -> { [dateKey]: DayEntry }  (fetched window)
let weightsByUser = new Map(); // userId -> { [dateKey]: lb }  ({} == hidden)
let activeTab = 'grid';

// Optimistic overlay: while a WORKOUT write for (userId+businessDate) is in flight (or
// failed pre-rollback), we paint from THIS map, not the snapshot, and we never repaint
// that day red. Keyed userId -> { [dateKey]: {workout:bool} }.
const optimistic = new Map();
// Set of `${userId}|${dateKey}` with an unsynced (queued, not server-acked) write.
const unsynced = new Set();

let rolloverTimer = null;
let heartbeatTimer = null;
let booted = false;

// the (uid,dateKey) the day editor is currently open for.
let editTarget = null;

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // display order
const WEEKDAY_NUMS = [1, 2, 3, 4, 5, 6, 0]; // logic weekday for each label (0=Sun..6=Sat)
const GOALS = [
  { key: 'gain', label: 'Gain' },
  { key: 'lose', label: 'Lose' },
  { key: 'maintain', label: 'Maintain' },
];

// =============================================================================
// SMALL HELPERS
// =============================================================================
function anchoredNow() {
  // server-anchored now: Date.now() + (serverTime - Date.now()). data.serverNowOffset()
  // is sync and returns 0 until the round-trip lands, which is a safe approximation.
  let off = 0;
  try {
    off = data.serverNowOffset() || 0;
  } catch (e) {
    off = 0;
  }
  return Date.now() + off;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg) {
  if (!elToast) return;
  elToast.textContent = msg;
  elToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elToast.classList.remove('show'), 2200);
}

// Pull the logic.js "subject" view out of a public /users doc. Field names match the
// SHAPES block in the contract verbatim (ianaTz, rolloverHour/Minute, restPattern,
// perDateOverrides, profile.joinDate). Defaults applied so a thin doc still computes.
function subjectOf(member) {
  if (!member) return null;
  return {
    ianaTz: member.ianaTz || DEFAULT_TZ,
    rolloverHour: Number.isFinite(member.rolloverHour) ? member.rolloverHour : DEFAULT_ROLLOVER_H,
    rolloverMinute: Number.isFinite(member.rolloverMinute) ? member.rolloverMinute : DEFAULT_ROLLOVER_M,
    restPattern: Array.isArray(member.restPattern) ? member.restPattern : [],
    perDateOverrides: member.perDateOverrides || {},
    profile: member.profile || {},
  };
}

function displayNameOf(member) {
  const n = member && member.profile && member.profile.displayName;
  return (typeof n === 'string' && n.trim()) ? n.trim() : 'Member';
}

function memberById(userId) {
  return members.find((m) => (m.userId || m.id) === userId) || null;
}

function idOf(member) {
  return member.userId || member.id;
}

// The viewer's own current business-date (the grid + weight "as of" anchor). All
// members are still evaluated against THEIR own clock inside classifyDay/missed.
function viewerBusinessDate(now) {
  const me = memberById(myUserId);
  const s = subjectOf(me) || { ianaTz: DEFAULT_TZ, rolloverHour: DEFAULT_ROLLOVER_H, rolloverMinute: DEFAULT_ROLLOVER_M };
  return currentBusinessDate(now, s.ianaTz, s.rolloverHour, s.rolloverMinute);
}

// The authoritative day map for a subject, WITH the optimistic overlay applied. The
// overlay only ever sets workout:true/false locally (an in-flight tap), so missed()
// can't re-red a day the user just logged before the snapshot catches up.
function effectiveDays(userId) {
  const base = daysByUser.get(userId) || {};
  const ov = optimistic.get(userId);
  if (!ov) return base;
  const merged = { ...base };
  for (const dk of Object.keys(ov)) {
    merged[dk] = { ...(merged[dk] || {}), ...ov[dk] };
  }
  return merged;
}

// =============================================================================
// STATUS CLASSIFIER  (the ONE shared function — color + shape per cell)
// Returns { wStatus, nStatus } per SPEC-v2 "Each cell = diagonal split".
//   wStatus : 'done' | 'missed' | 'rest' | 'off' | 'pending' | 'prejoin'
//             (a workout on a rest day is PLAIN 'done', NO bonus state in v2).
//   nStatus : 'hit'  (ate/macros true) | 'pending' (today/future, undecided) |
//             'none' (past, not hit — NEVER red) | 'prejoin'.
// The prejoin MODIFIER is applied via the cell's extra `prejoin` class (see
// renderGrid); both wStatus and nStatus carry 'prejoin' so legend/aria stay sane.
// =============================================================================
function classifyDay(subject, dateKey, now, day) {
  const joinDate = subject && subject.profile && subject.profile.joinDate;
  if (isDayKey(joinDate) && dateKey < joinDate) {
    return { wStatus: 'prejoin', nStatus: 'prejoin' };
  }

  // ---- WORKOUT side (the existing v1 status logic, minus the bonus state) ----
  const rest = isRestDay(subject.restPattern, subject.perDateOverrides, dateKey);
  const trained = !!(day && day.workout === true);
  const off = !!(day && day.off === true);

  let wStatus;
  if (trained) {
    wStatus = 'done'; // workout on a rest day is still just 'done' (no bonus in v2)
  } else if (off) {
    wStatus = 'off';
  } else if (rest) {
    wStatus = 'rest';
  } else if (missed(subject, dateKey, now, day)) {
    // missed() is the SINGLE source of truth here — it encodes isPast against the
    // subject's own clock, the joinDate gate, and the brand-new-user fail-safe.
    wStatus = 'missed';
  } else {
    wStatus = 'pending';
  }

  // ---- NUTRITION side (new) ----
  // BACK-COMPAT read of the hit flag: prefer `ate`, fall back to legacy `macros`.
  const ateHit = !!(day && (day.ate === true || day.macros === true));
  let nStatus;
  if (ateHit) {
    nStatus = 'hit';
  } else {
    // today (the subject's current business-date) or any future day is undecided
    // => 'pending'; a past day with no hit is 'none' (gray, NEVER red).
    const { h, m } = { h: subject.rolloverHour, m: subject.rolloverMinute };
    const cur = currentBusinessDate(now, subject.ianaTz, h, m);
    nStatus = dateKey >= cur ? 'pending' : 'none';
  }

  return { wStatus, nStatus };
}

const CELL_LABEL = {
  done: 'done',
  missed: 'missed',
  rest: 'rest',
  off: 'day off',
  pending: 'pending',
  prejoin: 'pre-join',
};

// =============================================================================
// RENDER: GRID  (people = COLUMNS, vertical bottom-to-top names, newest day on
// top, older rows fade. Diagonal cells: upper-left WORKOUT, lower-right NUTRITION.)
// =============================================================================
function gridDateKeys(now) {
  // Anchor on the viewer's current business-date, walk back GRID_DAYS-1 by
  // CALENDAR-DAY decrement (logic.prevBusinessDate — DST-safe), newest first.
  const cur = viewerBusinessDate(now);
  const keys = [cur];
  for (let i = 1; i < GRID_DAYS; i++) keys.push(prevBusinessDate(keys[i - 1]));
  return { keys, cur }; // newest (cur) first
}

function fmtDateGutter(dateKey) {
  // dateKey is 'YYYY-MM-DD' (a civil date string). Format DOW + M/D without constructing
  // a zoned instant (UTC noon avoids any local-offset day shift).
  const [y, mo, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const dow = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return { dow: dow.toUpperCase(), md: `${mo}/${d}` };
}

// Ordered columns: the current user first, then everyone else A-Z.
function orderedMembers() {
  return members.slice().sort((a, b) => {
    const am = idOf(a) === myUserId ? 0 : 1;
    const bm = idOf(b) === myUserId ? 0 : 1;
    if (am !== bm) return am - bm;
    return displayNameOf(a).localeCompare(displayNameOf(b));
  });
}

// Build the under-name header stack (flame+streak, weight+arrow, last-active).
function headStackHtml(member, now, viewerBiz) {
  const uid = idOf(member);
  const subject = subjectOf(member);
  const parts = [];

  // (a) flame + streak — hidden when streak === 0.
  let streak = 0;
  try {
    streak = computeStreak(effectiveDays(uid), subject, now);
  } catch (e) {
    streak = 0;
  }
  if (streak > 0) {
    parts.push(
      `<span class="gh-streak" aria-label="streak ${streak}"><span class="gh-flame" aria-hidden="true">🔥</span>${streak}</span>`
    );
  }

  // (b) weight + trend arrow (number neutral, arrow colored by goal/toward).
  const goal = (member && member.goal) || 'maintain';
  let trend = { latestLb: null, dir: 'flat', toward: null };
  try {
    trend = weightTrend(weightsByUser.get(uid) || {}, goal, viewerBiz);
  } catch (e) {
    trend = { latestLb: null, dir: 'flat', toward: null };
  }
  if (trend.latestLb != null) {
    const lb = Math.round(trend.latestLb);
    const arrow = trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '–';
    // arrow color: green toward, red away, neutral when undecided (toward === null).
    let arrowColor = 'var(--txt3)';
    if (trend.toward === true) arrowColor = 'var(--st-done)';
    else if (trend.toward === false) arrowColor = 'var(--red)';
    parts.push(
      `<span class="gh-wt" aria-label="weight ${lb} pounds">${lb}` +
        `<span class="gh-arrow" aria-hidden="true" style="color:${arrowColor}">${arrow}</span></span>`
    );
  }

  // (c) last-active text (dim when stale). lastActiveAt is a Firestore Timestamp.
  let lastMs = null;
  const la = member && member.lastActiveAt;
  if (la && typeof la.toMillis === 'function') {
    try {
      lastMs = la.toMillis();
    } catch (e) {
      lastMs = null;
    }
  }
  const rt = relativeTime(lastMs, now);
  if (rt.text) {
    parts.push(`<span class="gh-active${rt.stale ? ' stale' : ''}">${escapeHtml(rt.text)}</span>`);
  }

  return `<div class="gh-stack">${parts.join('')}</div>`;
}

function renderGrid(now) {
  if (!members.length) {
    elGrid.innerHTML =
      '<div class="empty-note">No active members yet.<br>Soren seeds people with the admin script, then texts each person their link.</div>';
    elGridRange.textContent = '';
    return;
  }
  const { keys, cur } = gridDateKeys(now);
  const cols = orderedMembers();

  // CSS grid template: a fixed date gutter + one (slightly wider) column per member.
  elGrid.style.gridTemplateColumns = `44px repeat(${cols.length}, minmax(40px, 1fr))`;

  const cells = [];
  // header row: corner + vertical member-name headers WITH the under-name stat stack.
  cells.push('<div class="gcell-corner"></div>');
  for (const m of cols) {
    const isMe = idOf(m) === myUserId;
    cells.push(
      `<div class="ghead${isMe ? ' me' : ''}" title="${escapeHtml(displayNameOf(m))}">` +
        `<span class="ghead-v">${escapeHtml(displayNameOf(m))}</span>` +
        headStackHtml(m, now, cur) +
        `</div>`
    );
  }

  // body: newest date at top; older rows fade out so the most recent reads clearest.
  for (let i = 0; i < keys.length; i++) {
    const dk = keys[i];
    const g = fmtDateGutter(dk);
    const isToday = dk === cur;
    const op = keys.length > 1 ? (1 - (i / (keys.length - 1)) * 0.55).toFixed(2) : '1';
    cells.push(
      `<div class="gdate${isToday ? ' today' : ''}" style="opacity:${op}"><span class="gdate-dow">${g.dow}</span><span>${g.md}</span></div>`
    );
    for (const m of cols) {
      const uid = idOf(m);
      const subject = subjectOf(m);
      const isMe = uid === myUserId;
      const day = effectiveDays(uid)[dk];
      const { wStatus, nStatus } = classifyDay(subject, dk, now, day);
      const prejoin = wStatus === 'prejoin';
      const aria = `${displayNameOf(m)} ${dk} — workout ${CELL_LABEL[wStatus] || wStatus}, nutrition ${nStatus}`;
      cells.push(
        `<div class="gcell w-${wStatus} n-${nStatus}${isMe ? ' me' : ''}${prejoin ? ' prejoin' : ''}" ` +
          `style="opacity:${op}" data-uid="${escapeHtml(uid)}" data-date="${escapeHtml(dk)}" ` +
          `role="button" tabindex="0" aria-label="${escapeHtml(aria)}">` +
          `<i class="pend-w"></i><i class="pend-n"></i></div>`
      );
    }
  }
  elGrid.innerHTML = cells.join('');

  const first = keys[keys.length - 1];
  elGridRange.textContent = `${fmtDateGutter(first).md} – ${fmtDateGutter(cur).md}`;

  // Legend: diagonal swatches mirroring the cell encoding (done/ate together).
  if (!elGridLegend.dataset.built) {
    const legCell = (w, n, label) =>
      `<span class="leg"><span class="leg-cell w-${w} n-${n}"><i class="pend-w"></i><i class="pend-n"></i></span>${label}</span>`;
    elGridLegend.innerHTML =
      legCell('done', 'hit', 'done / ate') +
      legCell('missed', 'none', 'missed') +
      legCell('rest', 'none', 'rest') +
      legCell('off', 'none', 'day off') +
      legCell('pending', 'pending', 'pending');
    elGridLegend.dataset.built = '1';
  }
}

// =============================================================================
// RENDER: BOTTOM BAR  (WORKOUT | MACROS — both tap-to-toggle today)
// =============================================================================
function renderBottomBar(now) {
  const me = memberById(myUserId);
  if (!myUserId || !me) {
    if (elWorkoutTile) {
      elWorkoutTile.disabled = true;
      const s = elWorkoutTile.querySelector('.wt-sub');
      if (s) s.textContent = '';
    }
    if (elMacrosTile) {
      elMacrosTile.disabled = true;
      const s = elMacrosTile.querySelector('.wt-sub');
      if (s) s.textContent = '';
    }
    return;
  }
  const subject = subjectOf(me);
  const cur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
  const days = effectiveDays(myUserId);
  const day = days[cur];

  // WORKOUT tile
  const done = !!(day && day.workout === true);
  const wkey = `${myUserId}|${cur}`;
  const wpending = unsynced.has(wkey);
  elWorkoutTile.dataset.bizdate = cur;
  elWorkoutTile.disabled = false;
  elWorkoutTile.classList.toggle('done', done);
  elWorkoutTile.classList.toggle('unsynced', wpending);
  const wsub = elWorkoutTile.querySelector('.wt-sub');
  if (wsub) {
    if (done) wsub.textContent = wpending ? 'logged · syncing…' : 'logged · tap to undo';
    else wsub.textContent = 'tap when you finish';
  }

  // MACROS tile (sets `ate`; back-compat read of legacy `macros`).
  if (elMacrosTile) {
    const ate = !!(day && (day.ate === true || day.macros === true));
    elMacrosTile.dataset.bizdate = cur;
    elMacrosTile.disabled = false;
    elMacrosTile.classList.toggle('done', ate);
    const msub = elMacrosTile.querySelector('.wt-sub');
    if (msub) msub.textContent = ate ? 'hit · tap to undo' : 'tap when you eat clean';
  }
}

// =============================================================================
// FULL REPAINT (called on snapshot, on tap, on rollover, on heartbeat)
// =============================================================================
function repaint() {
  const now = anchoredNow();
  if (activeTab === 'me') {
    renderMe(now);
  } else {
    renderGrid(now);
  }
  // the action bar (WORKOUT | MACROS) is present on both screens.
  renderBottomBar(now);
  updateSyncPip();
}

function updateSyncPip() {
  if (!elPipSync) return;
  elPipSync.classList.remove('ok', 'pending', 'fail');
  if (unsynced.size > 0) elPipSync.classList.add('pending');
  else if (booted) elPipSync.classList.add('ok');
}

// =============================================================================
// DST-SAFE NEXT-ROLLOVER SCHEDULER
//   Find the SMALLEST future instant whose business-date (in the current user's zone)
//   is strictly greater than today's, by Intl probing — NOT offset arithmetic (offset
//   math fires an hour early/late across a DST boundary). At that instant, pending days
//   become past -> some flip to red, and the bottom bar re-targets the new day.
// =============================================================================
function scheduleNextRollover() {
  clearTimeout(rolloverTimer);
  const me = memberById(myUserId);
  const s = subjectOf(me) || { ianaTz: DEFAULT_TZ, rolloverHour: DEFAULT_ROLLOVER_H, rolloverMinute: DEFAULT_ROLLOVER_M };
  const now = anchoredNow();
  const today = currentBusinessDate(now, s.ianaTz, s.rolloverHour, s.rolloverMinute);

  const STEP = 5 * 60 * 1000;
  const MAX_AHEAD = 26 * 60 * 60 * 1000; // a DST day is at most 25h; 26h is safe headroom
  let fireDelay = null;
  for (let t = STEP; t <= MAX_AHEAD; t += STEP) {
    const bd = businessDate(now + t, s.ianaTz, s.rolloverHour, s.rolloverMinute);
    if (bd > today) {
      fireDelay = t;
      break;
    }
  }
  if (fireDelay == null) fireDelay = 60 * 60 * 1000; // fallback: re-check in an hour

  rolloverTimer = setTimeout(() => {
    repaint(); // the new day is now "today"; yesterday's pendings flip per missed()
    scheduleNextRollover(); // arm the next boundary
    toast('new day');
  }, fireDelay + 1500); // +1.5s cushion so we're definitively across the cutoff
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState === 'visible') repaint();
  }, HEARTBEAT_MS);
}

function onVisibility() {
  if (document.visibilityState === 'visible') {
    // phones suspend timers; re-eval immediately and re-arm the boundary on return.
    repaint();
    scheduleNextRollover();
  }
}

// =============================================================================
// OPTIMISTIC OVERLAY HELPERS
// =============================================================================
function setOptimistic(userId, dateKey, workout) {
  let ov = optimistic.get(userId);
  if (!ov) {
    ov = {};
    optimistic.set(userId, ov);
  }
  ov[dateKey] = { ...(ov[dateKey] || {}), workout };
}
function clearOptimistic(userId, dateKey) {
  const ov = optimistic.get(userId);
  if (!ov) return;
  delete ov[dateKey];
  if (!Object.keys(ov).length) optimistic.delete(userId);
}

// =============================================================================
// BOTTOM-BAR WIRING
//   WORKOUT: optimistic + outbox + unsynced dot; TAP TOGGLES (second tap clears).
//   MACROS : await + toast on error (no outbox); TAP TOGGLES `ate`.
// =============================================================================
async function commitWorkout(bd, done) {
  if (!myUserId) return;
  const key = `${myUserId}|${bd}`;

  // optimistic paint immediately
  setOptimistic(myUserId, bd, done);
  unsynced.add(key);
  repaint();

  try {
    await data.markWorkout(myUserId, bd, done);
    // server acked: drop the unsynced flag. Keep the optimistic value until the
    // snapshot delivers the authoritative doc so there's no flash back to pending.
    unsynced.delete(key);
    repaint();
  } catch (err) {
    unsynced.delete(key);
    // Reclaim is handled by data.onReclaimNeeded (binding-uid mismatch). For any OTHER
    // hard reject, roll the optimistic paint back so we never lie about a saved state.
    const tag = err && (err.code || err.message || '');
    const isReclaim = /reclaim|binding|permission-denied/i.test(String(tag));
    if (!isReclaim) {
      clearOptimistic(myUserId, bd);
      toast('could not save — try again');
    }
    repaint();
  }
}

function onWorkoutTap() {
  if (!elWorkoutTile || elWorkoutTile.disabled) return;
  const bd = elWorkoutTile.dataset.bizdate;
  if (!isDayKey(bd)) return;
  const days = effectiveDays(myUserId);
  const isDone = !!(days[bd] && days[bd].workout === true);
  commitWorkout(bd, !isDone); // TAP TOGGLES
  if (isDone) toast('workout undone');
}

async function onMacrosTap() {
  if (!elMacrosTile || elMacrosTile.disabled) return;
  const bd = elMacrosTile.dataset.bizdate;
  if (!isDayKey(bd)) return;
  const days = effectiveDays(myUserId);
  const isAte = !!(days[bd] && (days[bd].ate === true || days[bd].macros === true));
  const next = !isAte;

  // optimistic-ish: flip the class immediately for snappy feedback, await the write,
  // and let the next snapshot/refetch confirm. No outbox for macros (per SPEC).
  elMacrosTile.classList.toggle('done', next);
  elMacrosTile.disabled = true;
  try {
    await data.setNutritionHit(bd, next);
    await refetchMyDays();
    toast(next ? 'nutrition logged' : 'nutrition undone');
  } catch (err) {
    const tag = String((err && (err.code || err.message)) || err);
    if (/reclaim/i.test(tag)) showReclaim();
    else toast('could not save — try again');
  } finally {
    elMacrosTile.disabled = false;
    repaint();
  }
}

function wireBottomBar() {
  if (elWorkoutTile) elWorkoutTile.addEventListener('click', onWorkoutTap);
  if (elMacrosTile) elMacrosTile.addEventListener('click', onMacrosTap);
}

// =============================================================================
// TABS  (GRID | ME)
// =============================================================================
function setTab(tab) {
  if (tab !== 'grid' && tab !== 'me') return;
  activeTab = tab;
  for (const btn of elTabs.querySelectorAll('.tab')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  if (elScreens.grid) {
    elScreens.grid.classList.toggle('is-active', tab === 'grid');
    elScreens.grid.hidden = tab !== 'grid';
  }
  if (elScreens.me) {
    elScreens.me.classList.toggle('is-active', tab === 'me');
    elScreens.me.hidden = tab !== 'me';
  }
  repaint();
}
function wireTabs() {
  elTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) setTab(btn.dataset.tab);
  });
}

// =============================================================================
// RENDER: ME PAGE  (logging on top, settings below; pre-filled from my user doc)
// =============================================================================
function renderMe(now) {
  const me = memberById(myUserId);
  if (!me) return;
  const subject = subjectOf(me);
  const cur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
  const days = effectiveDays(myUserId);
  const day = days[cur];

  // ---- TODAY card ----
  const done = !!(day && day.workout === true);
  if (elMeWorkout) {
    elMeWorkout.classList.toggle('on', done);
    elMeWorkout.textContent = done ? 'done ✓' : 'mark done';
  }
  const ate = !!(day && (day.ate === true || day.macros === true));
  if (elMeAte) {
    elMeAte.classList.toggle('on', ate);
    elMeAte.textContent = ate ? 'hit ✓' : 'hit it';
  }
  // numeric inputs: reflect current stored values (don't stomp a field being edited).
  if (elMeKcal && document.activeElement !== elMeKcal) {
    elMeKcal.value = day && Number.isFinite(day.kcal) ? String(day.kcal) : '';
  }
  if (elMeProtein && document.activeElement !== elMeProtein) {
    elMeProtein.value = day && Number.isFinite(day.protein) ? String(day.protein) : '';
  }
  if (elMeWeight && document.activeElement !== elMeWeight) {
    const w = (weightsByUser.get(myUserId) || {})[cur];
    elMeWeight.value = Number.isFinite(w) ? String(w) : '';
  }

  // ---- REST DAYS card ----
  renderRestDays(me);

  // ---- GOAL card ----
  renderGoal(me);

  // ---- PROFILE card ----
  if (elMeName && document.activeElement !== elMeName) {
    elMeName.value = (me.profile && me.profile.displayName) || '';
  }
  if (elMeRollover && document.activeElement !== elMeRollover) {
    elMeRollover.value = Number.isFinite(me.rolloverHour) ? String(me.rolloverHour) : String(DEFAULT_ROLLOVER_H);
  }
  if (elMeHideWeight) {
    const hidden = me.hideWeight === true;
    elMeHideWeight.classList.toggle('neutral-on', hidden);
    elMeHideWeight.textContent = hidden ? 'hidden' : 'shared';
  }
}

// resolve the currently-effective rest weekdays (the version with the largest
// effectiveFrom <= today) so the ME buttons reflect what's actually applying.
function currentRestWeekdays(member) {
  const rp = Array.isArray(member.restPattern) ? member.restPattern : [];
  if (!rp.length) return [];
  const today = viewerBusinessDate(anchoredNow());
  let chosen = null;
  for (const v of rp) {
    if (!v || !isDayKey(v.effectiveFrom)) continue;
    if (v.effectiveFrom <= today) {
      if (!chosen || v.effectiveFrom > chosen.effectiveFrom) chosen = v;
    }
  }
  // if no version is effective yet (all future-dated), fall back to the earliest.
  if (!chosen) {
    chosen = rp.reduce((a, b) => (a && a.effectiveFrom <= b.effectiveFrom ? a : b), null);
  }
  return chosen && Array.isArray(chosen.weekdays) ? chosen.weekdays.slice() : [];
}

function renderRestDays(member) {
  if (!elMeRestdays) return;
  const active = new Set(currentRestWeekdays(member));
  // rebuild once (static buttons), then just toggle the `rest` class.
  if (!elMeRestdays.dataset.built) {
    elMeRestdays.innerHTML = WEEKDAY_LABELS.map(
      (lbl, i) => `<button class="me-weekday" type="button" data-wd="${WEEKDAY_NUMS[i]}">${lbl}</button>`
    ).join('');
    elMeRestdays.dataset.built = '1';
  }
  for (const btn of elMeRestdays.querySelectorAll('.me-weekday')) {
    const wd = Number(btn.dataset.wd);
    btn.classList.toggle('rest', active.has(wd));
  }
}

function renderGoal(member) {
  if (!elMeGoal) return;
  const goal = (member && member.goal) || 'maintain';
  if (!elMeGoal.dataset.built) {
    elMeGoal.innerHTML = GOALS.map(
      (g) => `<button class="me-seg-btn" type="button" data-goal="${g.key}">${g.label}</button>`
    ).join('');
    elMeGoal.dataset.built = '1';
  }
  for (const btn of elMeGoal.querySelectorAll('.me-seg-btn')) {
    btn.classList.toggle('on', btn.dataset.goal === goal);
  }
}

// ---- ME wiring ----
function readNumInput(el) {
  if (!el) return null;
  const v = el.value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function meToggleWorkout() {
  const now = anchoredNow();
  const me = memberById(myUserId);
  if (!me) return;
  const subject = subjectOf(me);
  const cur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
  const days = effectiveDays(myUserId);
  const isDone = !!(days[cur] && days[cur].workout === true);
  // route through the optimistic+outbox path (same as the bottom bar) for parity.
  await commitWorkout(cur, !isDone);
  renderMe(now);
}

async function meToggleAte() {
  const now = anchoredNow();
  const me = memberById(myUserId);
  if (!me) return;
  const subject = subjectOf(me);
  const cur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
  const days = effectiveDays(myUserId);
  const isAte = !!(days[cur] && (days[cur].ate === true || days[cur].macros === true));
  try {
    await data.setNutritionHit(cur, !isAte);
    await refetchMyDays();
  } catch (err) {
    handleWriteError(err);
  }
  renderMe(anchoredNow());
  renderBottomBar(anchoredNow());
}

async function meSaveLog() {
  const now = anchoredNow();
  const me = memberById(myUserId);
  if (!me) return;
  const subject = subjectOf(me);
  const cur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);

  const kcal = readNumInput(elMeKcal);
  const protein = readNumInput(elMeProtein);
  const weight = readNumInput(elMeWeight);

  let didSomething = false;
  try {
    const macros = {};
    if (kcal != null) macros.kcal = kcal;
    if (protein != null) macros.protein = protein;
    if (Object.keys(macros).length) {
      await data.setMacros(cur, macros);
      didSomething = true;
    }
    if (weight != null) {
      await data.setWeight(cur, weight);
      didSomething = true;
    }
    if (!didSomething) {
      toast('nothing to save');
      return;
    }
    await refetchMyDays();
    await refetchWeights(myUserId);
    toast('saved');
  } catch (err) {
    handleWriteError(err);
  }
  renderMe(anchoredNow());
}

async function meToggleRestDay(wd) {
  const me = memberById(myUserId);
  if (!me) return;
  const today = viewerBusinessDate(anchoredNow());
  const current = new Set(currentRestWeekdays(me));
  if (current.has(wd)) current.delete(wd);
  else current.add(wd);
  const weekdays = [...current].sort((a, b) => a - b);

  // APPEND a new forward-only version effective from today (never rewrite history).
  const existing = Array.isArray(me.restPattern) ? me.restPattern.slice() : [];
  // collapse a same-day re-edit: if the latest version is already effectiveFrom==today,
  // replace it rather than stack duplicates (forward-only, one version per day).
  let next;
  const lastIdx = existing.length - 1;
  if (lastIdx >= 0 && existing[lastIdx] && existing[lastIdx].effectiveFrom === today) {
    next = existing.slice(0, lastIdx).concat([{ effectiveFrom: today, weekdays }]);
  } else {
    next = existing.concat([{ effectiveFrom: today, weekdays }]);
  }

  try {
    await data.setRestPattern(next);
    // reflect immediately in the local member doc so the UI is responsive pre-snapshot.
    me.restPattern = next;
    renderRestDays(me);
    renderGrid(anchoredNow());
  } catch (err) {
    handleWriteError(err);
    renderRestDays(me); // revert visual to truth
  }
}

async function meSetGoal(goal) {
  const me = memberById(myUserId);
  if (!me) return;
  try {
    await data.setGoal(goal);
    me.goal = goal;
    renderGoal(me);
    renderGrid(anchoredNow());
  } catch (err) {
    handleWriteError(err);
    renderGoal(me);
  }
}

async function meToggleHideWeight() {
  const me = memberById(myUserId);
  if (!me) return;
  const next = !(me.hideWeight === true);
  try {
    await data.setHideWeight(next);
    me.hideWeight = next;
    renderMe(anchoredNow());
    toast(next ? 'weight hidden from the group' : 'weight shared with the group');
  } catch (err) {
    handleWriteError(err);
    renderMe(anchoredNow());
  }
}

async function meSaveSettings() {
  const me = memberById(myUserId);
  if (!me) return;
  const name = elMeName ? elMeName.value.trim() : '';
  const rolloverH = readNumInput(elMeRollover);
  try {
    if (name && name !== ((me.profile && me.profile.displayName) || '')) {
      await data.setDisplayName(name);
      me.profile = { ...(me.profile || {}), displayName: name };
    }
    if (rolloverH != null) {
      await data.setRollover(rolloverH, 0);
      me.rolloverHour = Math.round(rolloverH);
      me.rolloverMinute = 0;
    }
    toast('settings saved');
  } catch (err) {
    handleWriteError(err);
  }
  renderMe(anchoredNow());
  scheduleNextRollover(); // rollover hour may have changed my clock anchor
}

function handleWriteError(err) {
  const tag = String((err && (err.code || err.message)) || err);
  if (/reclaim/i.test(tag)) {
    showReclaim();
  } else if (/bad-value|bad-date|bad-range/i.test(tag)) {
    toast('check the value and try again');
  } else {
    toast('could not save — try again');
  }
}

function wireMe() {
  if (elMeWorkout) elMeWorkout.addEventListener('click', meToggleWorkout);
  if (elMeAte) elMeAte.addEventListener('click', meToggleAte);
  if (elMeSaveLog) elMeSaveLog.addEventListener('click', meSaveLog);
  if (elMeRestdays)
    elMeRestdays.addEventListener('click', (e) => {
      const btn = e.target.closest('.me-weekday');
      if (btn) meToggleRestDay(Number(btn.dataset.wd));
    });
  if (elMeGoal)
    elMeGoal.addEventListener('click', (e) => {
      const btn = e.target.closest('.me-seg-btn');
      if (btn) meSetGoal(btn.dataset.goal);
    });
  if (elMeHideWeight) elMeHideWeight.addEventListener('click', meToggleHideWeight);
  if (elMeSaveSettings) elMeSaveSettings.addEventListener('click', meSaveSettings);
}

// =============================================================================
// DAY EDITOR (own cell) + DAY DETAIL (other person's cell)
// =============================================================================
function openSheet(sheet, backdrop) {
  if (backdrop) backdrop.classList.remove('hidden');
  if (sheet) sheet.classList.remove('hidden');
}
function closeSheet(sheet, backdrop) {
  if (backdrop) backdrop.classList.add('hidden');
  if (sheet) sheet.classList.add('hidden');
}

function openDayEditor(uid, dateKey) {
  editTarget = { uid, dateKey };
  const days = effectiveDays(uid);
  const day = days[dateKey] || {};
  const wt = (weightsByUser.get(uid) || {})[dateKey];

  if (elDayEditDate) {
    const g = fmtDateGutter(dateKey);
    elDayEditDate.textContent = `${g.dow} ${g.md}`;
  }
  const done = day.workout === true;
  const off = day.off === true;
  const ate = day.ate === true || day.macros === true;
  if (elDeWorkout) {
    elDeWorkout.classList.toggle('on', done);
    elDeWorkout.textContent = done ? 'done ✓' : 'done';
  }
  if (elDeOff) {
    elDeOff.classList.toggle('on', off);
    elDeOff.textContent = off ? 'off ✓' : 'off';
  }
  if (elDeAte) {
    elDeAte.classList.toggle('on', ate);
    elDeAte.textContent = ate ? 'hit ✓' : 'hit it';
  }
  if (elDeKcal) elDeKcal.value = Number.isFinite(day.kcal) ? String(day.kcal) : '';
  if (elDeProtein) elDeProtein.value = Number.isFinite(day.protein) ? String(day.protein) : '';
  if (elDeWeight) elDeWeight.value = Number.isFinite(wt) ? String(wt) : '';

  openSheet(elDayEdit, elDayEditBackdrop);
}

function closeDayEditor() {
  editTarget = null;
  closeSheet(elDayEdit, elDayEditBackdrop);
}

async function saveDayEditor() {
  if (!editTarget) return;
  const { dateKey } = editTarget; // always MY column (only own cells open the editor)
  const days = effectiveDays(myUserId);
  const day = days[dateKey] || {};
  const wtNow = (weightsByUser.get(myUserId) || {})[dateKey];

  const wantWorkout = elDeWorkout ? elDeWorkout.classList.contains('on') : day.workout === true;
  const wantOff = elDeOff ? elDeOff.classList.contains('on') : day.off === true;
  const wantAte = elDeAte ? elDeAte.classList.contains('on') : (day.ate === true || day.macros === true);
  const kcal = readNumInput(elDeKcal);
  const protein = readNumInput(elDeProtein);
  const weight = readNumInput(elDeWeight);

  const wasWorkout = day.workout === true;
  const wasOff = day.off === true;
  const wasAte = day.ate === true || day.macros === true;

  if (elDeSave) elDeSave.disabled = true;
  try {
    // only write the fields that actually changed (keeps it merge-minimal + rule-safe).
    if (wantWorkout !== wasWorkout) {
      await data.markWorkout(myUserId, dateKey, wantWorkout);
    }
    if (wantOff !== wasOff) {
      await data.setDayOff(dateKey, wantOff);
    }
    if (wantAte !== wasAte) {
      await data.setNutritionHit(dateKey, wantAte);
    }
    const macros = {};
    if (kcal != null && kcal !== day.kcal) macros.kcal = kcal;
    if (protein != null && protein !== day.protein) macros.protein = protein;
    if (Object.keys(macros).length) {
      await data.setMacros(dateKey, macros);
    }
    if (weight != null && weight !== wtNow) {
      await data.setWeight(dateKey, weight);
    }
    await refetchMyDays();
    await refetchWeights(myUserId);
    toast('saved');
    closeDayEditor();
  } catch (err) {
    handleWriteError(err);
  } finally {
    if (elDeSave) elDeSave.disabled = false;
    repaint();
  }
}

function openDayDetail(member, dateKey) {
  const uid = idOf(member);
  const days = effectiveDays(uid);
  const day = days[dateKey] || {};
  const wt = (weightsByUser.get(uid) || {})[dateKey];

  if (elDayDetailTitle) elDayDetailTitle.textContent = displayNameOf(member);
  if (elDayDetailSub) {
    const g = fmtDateGutter(dateKey);
    elDayDetailSub.textContent = `${g.dow} ${g.md}`;
  }
  if (elDayDetailBody) {
    elDayDetailBody.classList.add('daydetail-body'); // pull in the .dd-line styling
    const lines = [];
    const workoutVal = day.workout === true ? 'yes' : day.off === true ? 'off' : 'no';
    lines.push(line('Workout', workoutVal));
    lines.push(line('Nutrition', day.ate === true || day.macros === true ? 'hit' : '—'));
    if (Number.isFinite(day.kcal)) lines.push(line('Calories', `${day.kcal}`));
    if (Number.isFinite(day.protein)) lines.push(line('Protein', `${day.protein}g`));
    if (Number.isFinite(wt)) lines.push(line('Weight', `${wt} lb`)); // omit if hidden/absent
    elDayDetailBody.innerHTML = lines.join('');
  }
  openSheet(elDayDetail, elDayDetailBackdrop);

  function line(k, v) {
    return `<div class="dd-line"><span class="dd-k">${escapeHtml(k)}</span><span class="dd-v">${escapeHtml(v)}</span></div>`;
  }
}

function closeDayDetail() {
  closeSheet(elDayDetail, elDayDetailBackdrop);
}

function onGridCellActivate(target) {
  const cell = target.closest && target.closest('.gcell');
  if (!cell) return;
  const uid = cell.dataset.uid;
  const dateKey = cell.dataset.date;
  if (!uid || !isDayKey(dateKey)) return;
  if (uid === myUserId) {
    openDayEditor(uid, dateKey);
  } else {
    const member = memberById(uid);
    if (member) openDayDetail(member, dateKey);
  }
}

function wireGridTaps() {
  elGrid.addEventListener('click', (e) => onGridCellActivate(e.target));
  elGrid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onGridCellActivate(e.target);
    }
  });
  // editor wiring
  if (elDeCancel) elDeCancel.addEventListener('click', closeDayEditor);
  if (elDayEditBackdrop) elDayEditBackdrop.addEventListener('click', closeDayEditor);
  if (elDeSave) elDeSave.addEventListener('click', saveDayEditor);
  // editor toggle buttons flip their own `on` class; save reads the class state.
  for (const btn of [elDeWorkout, elDeOff, elDeAte]) {
    if (btn) btn.addEventListener('click', () => btn.classList.toggle('on'));
  }
  // detail wiring
  if (elDayDetailClose) elDayDetailClose.addEventListener('click', closeDayDetail);
  if (elDayDetailBackdrop) elDayDetailBackdrop.addEventListener('click', closeDayDetail);
}

// =============================================================================
// RECLAIM MODAL (LOUD) — wired to data.onReclaimNeeded
// =============================================================================
function showReclaim() {
  elReclaimBackdrop.classList.remove('hidden');
  elReclaim.classList.remove('hidden');
  elReclaimStatus.textContent = '';
  elReclaimStatus.classList.remove('err');
  elReclaimBtn.disabled = false;
}
function hideReclaim() {
  elReclaimBackdrop.classList.add('hidden');
  elReclaim.classList.add('hidden');
}
function wireReclaim() {
  elReclaimBtn.addEventListener('click', async () => {
    elReclaimBtn.disabled = true;
    elReclaimStatus.classList.remove('err');
    elReclaimStatus.textContent = 'reclaiming…';
    try {
      const res = await data.reclaim(); // re-runs the bind from the stored capability URL
      myUserId = (res && res.userId) || data.currentUserId() || myUserId;
      hideReclaim();
      toast('reclaimed — this device is active again');
      // re-fetch this user's window so the grid/streak reflect truth post-rebind.
      await refetchMyDays();
      await refetchWeights(myUserId);
      repaint();
    } catch (err) {
      elReclaimStatus.classList.add('err');
      elReclaimStatus.textContent = 'could not reclaim — reopen your link';
      elReclaimBtn.disabled = false;
    }
  });
}

// =============================================================================
// DATA FETCH (the /days + /weights windows for everyone shown)
// =============================================================================
function fromKeyFor(cur, daysBack) {
  let from = cur;
  for (let i = 0; i < daysBack; i++) from = prevBusinessDate(from);
  return from;
}

async function refetchAllDays(now) {
  const cur = viewerBusinessDate(now);
  // fetch a window wide enough for the grid AND the streak walk's recent run. The
  // streak can be long; computeStreak stops at the first missed day, and a deep
  // streak beyond the window is a rare display-only truncation.
  const from = fromKeyFor(cur, 120);
  const tasks = members.map(async (m) => {
    const uid = idOf(m);
    try {
      const map = await data.fetchDays(uid, from, cur);
      daysByUser.set(uid, map || {});
    } catch (e) {
      // a per-member read failure shouldn't blank the whole board; keep any prior data.
      if (!daysByUser.has(uid)) daysByUser.set(uid, {});
    }
  });
  await Promise.all(tasks);
}

async function refetchAllWeights(now) {
  const cur = viewerBusinessDate(now);
  const from = fromKeyFor(cur, WEIGHT_WINDOW_DAYS);
  const tasks = members.map(async (m) => {
    const uid = idOf(m);
    try {
      // {} result == hidden (data.js maps a permission-deny to {}); weightTrend then
      // returns latestLb:null -> blank under the name. Per-member try/catch so one
      // member's failure never breaks the render.
      const map = await data.fetchWeights(uid, from, cur);
      weightsByUser.set(uid, map || {});
    } catch (e) {
      if (!weightsByUser.has(uid)) weightsByUser.set(uid, {});
    }
  });
  await Promise.all(tasks);
}

async function refetchWeights(userId) {
  if (!userId) return;
  const now = anchoredNow();
  const cur = viewerBusinessDate(now);
  const from = fromKeyFor(cur, WEIGHT_WINDOW_DAYS);
  try {
    const map = await data.fetchWeights(userId, from, cur);
    weightsByUser.set(userId, map || {});
  } catch (e) {
    /* keep prior */
  }
}

async function refetchMyDays() {
  if (!myUserId) return;
  const now = anchoredNow();
  const cur = viewerBusinessDate(now);
  const from = fromKeyFor(cur, 120);
  try {
    const map = await data.fetchDays(myUserId, from, cur);
    daysByUser.set(myUserId, map || {});
  } catch (e) {
    /* keep prior */
  }
}

// onSnapshot callback: members changed (someone joined/archived, or a rollup/days write
// landed). Re-fetch the day + weight windows for the current member set, then repaint.
// Weights are re-fetched on EVERY snapshot so a hideWeight toggle reflects for viewers.
let snapshotSeq = 0;
function onMembers(usersArray) {
  members = Array.isArray(usersArray) ? usersArray.slice() : [];
  const mySeq = ++snapshotSeq;
  const now = anchoredNow();
  Promise.all([refetchAllDays(now), refetchAllWeights(now)]).then(() => {
    if (mySeq !== snapshotSeq) return; // a newer snapshot superseded this fetch
    repaint();
    scheduleNextRollover(); // member set can change my clock anchor; re-arm
  });
  // paint immediately from the rollup-bearing /users docs so the board isn't blank while
  // the windows load. effectiveDays falls back to {} -> cells render as pending.
  repaint();
}

// =============================================================================
// FATAL BANNER
// =============================================================================
function fatal(title, bodyHtml) {
  elBoot.innerHTML =
    `<div class="boot-title">${escapeHtml(title)}</div><div class="boot-body">${bodyHtml}</div>`;
  elBoot.classList.remove('hidden');
}

// =============================================================================
// BOOT SEQUENCE (order is load-bearing)
// =============================================================================
async function boot() {
  // pull the PUBLIC firebase web config + App Check site key from the gitignored
  // firebase-config.js. It's a DYNAMIC import so a missing file (first run, before the
  // user copies the example) is caught here as a friendly banner rather than crashing the
  // whole module graph with an opaque resolver error.
  let cfg, siteKey, debugToken;
  try {
    const conf = await import('./firebase-config.js');
    cfg = conf.firebaseConfig;
    siteKey = conf.recaptchaSiteKey;
    debugToken = conf.appCheckDebugToken;
  } catch (e) {
    fatal(
      'CONFIG MISSING',
      'Copy <code>firebase-config.example.js</code> to <code>firebase-config.js</code> and fill in the Firebase web config + App Check reCAPTCHA site key. See <code>SETUP.md</code>.'
    );
    return;
  }
  if (!cfg) {
    fatal(
      'CONFIG INCOMPLETE',
      'Fill in the real Firebase web config in <code>firebase-config.js</code>. See <code>SETUP.md</code>.'
    );
    return;
  }
  // App Check is optional: an empty key (or a leftover TODO_ placeholder) means
  // "skip App Check". Normalize to '' so data.initApp() skips it cleanly.
  if (siteKey && /^TODO_/.test(String(siteKey))) siteKey = '';

  try {
    // 1. App Check FIRST (before Auth + any Firestore call), then offline persistence.
    await data.initApp(cfg, siteKey, { appCheckDebugToken: debugToken });
  } catch (err) {
    fatal('STARTUP FAILED', 'App Check / Firebase init did not complete. Check the App Check site key and that this origin is an authorized domain. ' + escapeHtml(String((err && err.message) || err)));
    return;
  }

  // register the reclaim handler BEFORE any read/write can trigger a binding mismatch.
  try {
    data.onReclaimNeeded(() => showReclaim());
  } catch (e) {
    /* non-fatal */
  }

  try {
    // 2. anon sign-in + token-gated binding (parses #u/#t, or falls back to stored URL).
    const bound = await data.authAndBind();
    myUserId = (bound && bound.userId) || data.currentUserId();
  } catch (err) {
    const msg = String((err && (err.code || err.message)) || err);
    if (/fragment|token|link|missing|malformed/i.test(msg)) {
      fatal(
        'NO ACCESS LINK',
        'Open gymboard from your personal capability link (the one Soren texted you). It looks like <code>…/gymboard/#u=…&t=…</code>. Saving that link to your home screen is your login.'
      );
    } else {
      fatal('SIGN-IN FAILED', escapeHtml(msg));
    }
    return;
  }

  try {
    // 3. self-create the minimal first-run /users doc if absent (joinDate + rest anchor).
    await data.ensureUserDoc(myUserId);
  } catch (e) {
    // non-fatal: the doc may already exist (seeded by admin). Proceed to subscribe.
  }

  // refresh the header register with a short, non-identifying session tag.
  if (elHdrReg) elHdrReg.textContent = '● live';
  booted = true;

  // 4. live board: onSnapshot on /users where archived==false.
  try {
    data.subscribeUsers(onMembers); // sync return = the unsub handle (kept by data.teardown)
  } catch (err) {
    fatal('LIVE READ FAILED', 'Could not subscribe to the group. ' + escapeHtml(String((err && err.message) || err)));
    return;
  }

  // wire interactions + timers
  wireTabs();
  wireBottomBar();
  wireMe();
  wireGridTaps();
  wireReclaim();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onVisibility);
  startHeartbeat();
  scheduleNextRollover();
  updateSyncPip();
}

// teardown on tab close / pagehide (detach listeners + timers via data.teardown).
function teardown() {
  try {
    data.teardown();
  } catch (e) {
    /* ignore */
  }
  clearTimeout(rolloverTimer);
  clearInterval(heartbeatTimer);
}
window.addEventListener('pagehide', teardown);
window.addEventListener('beforeunload', teardown);

// kick off once the DOM is parsed (module scripts are deferred, so DOM is ready here).
boot();
