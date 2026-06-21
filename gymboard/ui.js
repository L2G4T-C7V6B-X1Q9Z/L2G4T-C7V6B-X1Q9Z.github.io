// =============================================================================
// gymboard — UI / render layer  (ui.js)   PHASE 1
// -----------------------------------------------------------------------------
// The ES-module entry point loaded by index.html (<script type="module">). It:
//   - imports the PURE, tested logic.js for EVERY date/missed/streak computation
//     (it never re-implements time math) and
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
// Phase 1 scope ONLY: app shell + Today/Grid tabs; hero group % via groupConsistency;
// per-person today pills via missed()/currentBusinessDate() against EACH subject's own
// clock; a single full-width WORKOUT tile (optimistic green, unsynced dot, long-press
// undo); a one-tap week Grid (CSS grid, newest at top, color+shape cells); the LOUD
// reclaim modal; and the autonomous missed->red repaint on a DST-safe next-rollover
// timer + visibilitychange + ~60s heartbeat. MACROS, weigh-ins, month heatmap,
// reactions, profile, admin are all DEFERRED.
// =============================================================================

import {
  currentBusinessDate,
  prevBusinessDate,
  businessDate,
  businessWeekKey,
  missed,
  isRestDay,
  computeStreak,
  groupConsistency,
  isDayKey,
} from './logic.js';

import * as data from './data.js';

// ---- Phase-1 defaults (per the contract: everyone 04:00 + a single tz, but the
//      businessDate FUNCTION already takes tz+rollover params, so per-user values from
//      each subject's own doc ALWAYS win when present). ----------------------------
const DEFAULT_ROLLOVER_H = 4;
const DEFAULT_ROLLOVER_M = 0;
const DEFAULT_TZ =
  (typeof Intl !== 'undefined' &&
    Intl.DateTimeFormat().resolvedOptions &&
    Intl.DateTimeFormat().resolvedOptions().timeZone) ||
  'America/New_York';

const GRID_DAYS = 7; // Phase 1 = one week (fixed-flex week grid, newest at top)
const HEARTBEAT_MS = 60 * 1000; // coarse belt-and-suspenders missed() re-eval

// =============================================================================
// DOM HANDLES
// =============================================================================
const $ = (id) => document.getElementById(id);
const elHdrReg = $('hdr-reg');
const elPipSync = $('pip-sync');
const elTabs = $('tabs');
const elScreens = { today: $('screen-today'), grid: $('screen-grid') };
const elHeroPct = $('hero-pct');
const elHeroSub = $('hero-sub');
const elHeroBonus = $('hero-bonus');
const elTodayList = $('today-list');
const elGrid = $('grid');
const elGridRange = $('grid-range');
const elGridLegend = $('grid-legend');
const elAction = $('action');
const elWorkoutTile = $('workout-tile');
const elReclaim = $('reclaim');
const elReclaimBackdrop = $('reclaim-backdrop');
const elReclaimBtn = $('reclaim-btn');
const elReclaimStatus = $('reclaim-status');
const elBoot = $('boot');
const elToast = $('toast');

// =============================================================================
// SESSION STATE (UI-side only; data.js owns Firebase truth)
// =============================================================================
let myUserId = null;
let members = []; // latest /users snapshot (archived==false), as data.js hands it over
let daysByUser = new Map(); // userId -> { [dateKey]: DayEntry }  (fetched window)
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

// The authoritative day map for a subject, WITH the optimistic overlay applied. The
// overlay only ever sets workout:true locally (an in-flight tap), so missed() can't
// re-red a day the user just logged before the snapshot catches up.
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
// STATUS CLASSIFIER (the ONE shared function — color + shape for cell AND pill)
// Mirrors DESIGN.md "Status encoding" exactly. Returns a status key + small flags.
// =============================================================================
function classifyDay(subject, dateKey, now, day) {
  const joinDate = subject && subject.profile && subject.profile.joinDate;
  if (isDayKey(joinDate) && dateKey < joinDate) {
    return { status: 'prejoin', macros: false };
  }
  const rest = isRestDay(subject.restPattern, subject.perDateOverrides, dateKey);
  const trained = !!(day && day.workout === true);
  const off = !!(day && day.off === true);
  const macros = !!(day && day.macros === true);

  if (trained) {
    // trained on a scheduled rest day = bonus (derived live, never stored)
    return { status: rest ? 'bonus' : 'done', macros };
  }
  if (off) return { status: 'off', macros };
  if (rest) return { status: 'rest', macros };
  // not trained, not off, not rest. missed() is the SINGLE source of truth here — it
  // already encodes every conjunct (isPast against the subject's own clock, the joinDate
  // gate, and the brand-new-user fail-safe to NOT-missed). Trust it: anything it does not
  // call missed is pending. Do NOT add a `dateKey < cur` shortcut — that would re-red a
  // past blank day for an unconfigured (no-joinDate) subject, violating the design's
  // "fails safe to not-missed everywhere" rule.
  if (missed(subject, dateKey, now, day)) return { status: 'missed', macros };
  return { status: 'pending', macros };
}

const PILL_LABEL = {
  done: 'DONE',
  bonus: 'BONUS',
  rest: 'REST',
  missed: 'MISSED',
  off: 'OFF',
  pending: 'PENDING',
  prejoin: 'PRE-JOIN',
};

// =============================================================================
// RENDER: TODAY (hero + per-person list)
// =============================================================================
function renderHero(now) {
  // Hero = group weekly consistency %, recomputed on read from each member's /days docs
  // via logic.groupConsistency (NOT from the rollup). Bonuses excluded; clamp <=100;
  // "+N bonus" surfaced separately. Subjects evaluated each against their own clock.
  const weekKey = (() => {
    // Use a representative subject's current business-date to pick the Mon..Sun week.
    // Phase 1 keys to the current user's week (everyone shares a tz/rollover here, but
    // groupConsistency still evaluates each member against THEIR own clock internally).
    const me = memberById(myUserId);
    const s = subjectOf(me) || { ianaTz: DEFAULT_TZ, rolloverHour: DEFAULT_ROLLOVER_H, rolloverMinute: DEFAULT_ROLLOVER_M };
    const cur = currentBusinessDate(now, s.ianaTz, s.rolloverHour, s.rolloverMinute);
    return businessWeekKey(cur);
  })();

  const allMembersDays = members.map((m) => ({
    subject: subjectOf(m),
    days: effectiveDays(idOf(m)),
  }));

  let res;
  try {
    res = groupConsistency(allMembersDays, weekKey, now);
  } catch (e) {
    res = { expected: 0, completed: 0, percent: 0, bonus: 0 };
  }

  elHeroPct.innerHTML = `${res.percent}<span class="hero-sign">%</span>`;
  if (res.expected === 0) {
    elHeroSub.textContent = 'no sessions due yet this week';
  } else {
    elHeroSub.textContent = `${res.completed} / ${res.expected} sessions · this week`;
  }
  if (res.bonus > 0) {
    elHeroBonus.textContent = `+${res.bonus} bonus`;
    elHeroBonus.classList.remove('hidden');
  } else {
    elHeroBonus.classList.add('hidden');
  }
}

function renderTodayList(now) {
  if (!members.length) {
    elTodayList.innerHTML =
      '<div class="empty-note">No active members yet.<br>Soren seeds people with the admin script, then texts each person their link.</div>';
    return;
  }

  // Soren's own row pins to the top (visually tied to the action bar).
  const ordered = members.slice().sort((a, b) => {
    const am = idOf(a) === myUserId ? 0 : 1;
    const bm = idOf(b) === myUserId ? 0 : 1;
    if (am !== bm) return am - bm;
    return displayNameOf(a).localeCompare(displayNameOf(b));
  });

  const rows = ordered.map((m, i) => {
    const uid = idOf(m);
    const subject = subjectOf(m);
    const isMe = uid === myUserId;
    const cur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
    const days = effectiveDays(uid);
    const todayDay = days[cur];
    const cls = classifyDay(subject, cur, now, todayDay);

    // streak chip: read-recomputed (a viewer's recompute wins over any cached streak).
    let streak = 0;
    try {
      streak = computeStreak(days, subject, now);
    } catch (e) {
      streak = 0;
    }

    const macrodot = cls.macros ? '<span class="macrodot" aria-hidden="true"></span>' : '';
    const pill =
      `<span class="pill ${cls.status}" aria-label="${escapeHtml(PILL_LABEL[cls.status] || cls.status)}">` +
      `<span class="ptext">${escapeHtml(PILL_LABEL[cls.status] || '')}</span>${macrodot}</span>`;

    const streakChip =
      `<span class="pstreak${streak > 0 ? '' : ' zero'}" aria-label="streak ${streak}">` +
      `<span class="flame" aria-hidden="true">🔥</span>${streak}</span>`;

    return (
      `<div class="prow${isMe ? ' me' : ''}" style="animation-delay:${Math.min(i * 30, 180)}ms">` +
      `<span class="pname">${escapeHtml(displayNameOf(m))}</span>` +
      streakChip +
      pill +
      `</div>`
    );
  });

  elTodayList.innerHTML = rows.join('');
}

// =============================================================================
// RENDER: WORKOUT TILE (the current user's single action)
// =============================================================================
function renderWorkoutTile(now) {
  const me = memberById(myUserId);
  if (!myUserId || !me) {
    elWorkoutTile.disabled = true;
    elWorkoutTile.querySelector('.wt-sub').textContent = '';
    return;
  }
  const subject = subjectOf(me);
  const cur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
  const days = effectiveDays(myUserId);
  const day = days[cur];
  const done = !!(day && day.workout === true);
  const key = `${myUserId}|${cur}`;
  const pending = unsynced.has(key);

  elWorkoutTile.dataset.bizdate = cur;
  elWorkoutTile.disabled = false;
  elWorkoutTile.classList.toggle('done', done);
  elWorkoutTile.classList.toggle('unsynced', pending);

  const sub = elWorkoutTile.querySelector('.wt-sub');
  if (done) {
    sub.textContent = pending ? 'logged · syncing…' : 'logged · long-press to undo';
  } else {
    sub.textContent = 'tap when you finish';
  }
}

// =============================================================================
// RENDER: GRID (one tap off Today; CSS grid, newest date at top, color+shape cells)
// =============================================================================
function gridDateKeys(now) {
  // Anchor on the current user's current business-date, walk back GRID_DAYS-1 by
  // CALENDAR-DAY decrement (logic.prevBusinessDate — DST-safe), newest first.
  const me = memberById(myUserId);
  const s = subjectOf(me) || { ianaTz: DEFAULT_TZ, rolloverHour: DEFAULT_ROLLOVER_H, rolloverMinute: DEFAULT_ROLLOVER_M };
  const cur = currentBusinessDate(now, s.ianaTz, s.rolloverHour, s.rolloverMinute);
  const keys = [cur];
  for (let i = 1; i < GRID_DAYS; i++) keys.push(prevBusinessDate(keys[i - 1]));
  return { keys, cur }; // newest (cur) first
}

function shortName(member) {
  const n = displayNameOf(member);
  // initials-ish header token: first word, capped to keep columns fixed-width.
  return n.split(/\s+/)[0].slice(0, 5).toUpperCase();
}

function fmtDateGutter(dateKey) {
  // dateKey is 'YYYY-MM-DD' (a civil date string). Format DOW + M/D without constructing
  // a zoned instant (UTC noon avoids any local-offset day shift).
  const [y, mo, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const dow = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return { dow: dow.toUpperCase(), md: `${mo}/${d}` };
}

function renderGrid(now) {
  if (!members.length) {
    elGrid.innerHTML = '';
    elGridRange.textContent = '';
    return;
  }
  const { keys, cur } = gridDateKeys(now);

  // People are COLUMNS with VERTICAL name headers, so many people fit across without
  // truncating. Days are ROWS, newest at the top. The current user is the first column.
  const cols = members.slice().sort((a, b) => {
    const am = idOf(a) === myUserId ? 0 : 1;
    const bm = idOf(b) === myUserId ? 0 : 1;
    if (am !== bm) return am - bm;
    return displayNameOf(a).localeCompare(displayNameOf(b));
  });

  // CSS grid template: a fixed date gutter + one narrow column per member.
  elGrid.style.gridTemplateColumns = `44px repeat(${cols.length}, minmax(28px, 1fr))`;

  const cells = [];
  // header row: corner + vertical member-name headers
  cells.push('<div class="gcell-corner"></div>');
  for (const m of cols) {
    const isMe = idOf(m) === myUserId;
    cells.push(`<div class="ghead${isMe ? ' me' : ''}" title="${escapeHtml(displayNameOf(m))}"><span class="ghead-v">${escapeHtml(displayNameOf(m))}</span></div>`);
  }

  // body: newest date at top
  for (const dk of keys) {
    const g = fmtDateGutter(dk);
    const isToday = dk === cur;
    cells.push(
      `<div class="gdate${isToday ? ' today' : ''}"><span class="gdate-dow">${g.dow}</span><span>${g.md}</span></div>`
    );
    for (const m of cols) {
      const uid = idOf(m);
      const subject = subjectOf(m);
      const isMe = uid === myUserId;
      const day = effectiveDays(uid)[dk];
      const cls = classifyDay(subject, dk, now, day);
      cells.push(
        `<div class="gcell ${cls.status}${isMe ? ' me' : ''}" aria-label="${escapeHtml(displayNameOf(m))} ${dk} ${cls.status}"></div>`
      );
    }
  }
  elGrid.innerHTML = cells.join('');

  const first = keys[keys.length - 1];
  elGridRange.textContent = `${fmtDateGutter(first).md} – ${fmtDateGutter(cur).md}`;

  if (!elGridLegend.dataset.built) {
    elGridLegend.innerHTML =
      '<span class="leg"><span class="swatch done"></span>done</span>' +
      '<span class="leg"><span class="swatch rest"></span>rest</span>' +
      '<span class="leg"><span class="swatch missed"></span>missed</span>' +
      '<span class="leg"><span class="swatch off"></span>off</span>' +
      '<span class="leg"><span class="swatch pending"></span>pending</span>';
    elGridLegend.dataset.built = '1';
  }
}

// =============================================================================
// FULL REPAINT (called on snapshot, on tap, on rollover, on heartbeat)
// =============================================================================
function repaint() {
  const now = anchoredNow();
  if (activeTab === 'today') {
    renderHero(now);
    renderTodayList(now);
  } else {
    renderGrid(now);
  }
  // the action bar (WORKOUT tile) is present on both screens
  renderWorkoutTile(now);
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
//   become past -> some flip to red, and the WORKOUT tile re-targets the new day.
// =============================================================================
function scheduleNextRollover() {
  clearTimeout(rolloverTimer);
  const me = memberById(myUserId);
  const s = subjectOf(me) || { ianaTz: DEFAULT_TZ, rolloverHour: DEFAULT_ROLLOVER_H, rolloverMinute: DEFAULT_ROLLOVER_M };
  const now = anchoredNow();
  const today = currentBusinessDate(now, s.ianaTz, s.rolloverHour, s.rolloverMinute);

  // Coarse-step forward in 5-min increments to bracket the boundary (cheap: <=300 probes
  // for a 25h day), then we don't need to bisect — 5-min granularity on a re-render timer
  // is well inside the ~1-min heartbeat's tolerance, and the heartbeat backstops it.
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

  // setTimeout caps near ~24.8 days; our delays are always < 26h so this is safe.
  rolloverTimer = setTimeout(() => {
    repaint(); // the new day is now "today"; yesterday's pendings flip per missed()
    scheduleNextRollover(); // arm the next boundary
    toast('new day');
  }, fireDelay + 1500); // +1.5s cushion so we're definitively across the cutoff
}

function startHeartbeat() {
  clearInterval(heartbeatTimer);
  // ~once per visible minute: a cheap pure missed() recompute so a single mis-scheduled
  // timer lags by at most ~1 minute (DESIGN.md belt-and-suspenders).
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
// WORKOUT TILE WIRING — tap = optimistic done; long-press = undo
//   markWorkout is the 2-write atomic batch in data.js; ui.js only paints optimistically
//   and rolls back on a HARD reject. businessDate is recomputed at tap time from the
//   current user's own clock (never device-local Date directly).
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

async function commitWorkout(done) {
  if (!myUserId) return;
  const me = memberById(myUserId);
  const subject = subjectOf(me);
  const now = anchoredNow();
  const bd = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
  const key = `${myUserId}|${bd}`;

  // optimistic paint immediately
  setOptimistic(myUserId, bd, done);
  unsynced.add(key);
  repaint();

  try {
    await data.markWorkout(myUserId, bd, done);
    // server acked: drop the unsynced flag. Keep the optimistic value until the snapshot
    // delivers the authoritative doc (onSnapshot of /users carries the rollup; the days
    // doc lands via the same write), so there's no flash back to pending.
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

// long-press-to-undo state machine (no second-tap undo; matches DESIGN.md + gym-timer)
let pressTimer = null;
let pressFired = false;
function tilePressStart() {
  if (elWorkoutTile.disabled) return;
  const bd = elWorkoutTile.dataset.bizdate;
  const days = effectiveDays(myUserId);
  const isDone = !!(days[bd] && days[bd].workout === true);
  if (!isDone) return; // long-press only undoes a DONE day; plain tap handles marking
  pressFired = false;
  elWorkoutTile.classList.add('holding');
  pressTimer = setTimeout(() => {
    pressFired = true;
    elWorkoutTile.classList.remove('holding');
    commitWorkout(false); // undo
    toast('workout undone');
  }, 520);
}
function tilePressCancel() {
  clearTimeout(pressTimer);
  elWorkoutTile.classList.remove('holding');
}
function tileTap() {
  if (pressFired) {
    pressFired = false;
    return; // the long-press already handled it; swallow the trailing click
  }
  if (elWorkoutTile.disabled) return;
  const bd = elWorkoutTile.dataset.bizdate;
  const days = effectiveDays(myUserId);
  const isDone = !!(days[bd] && days[bd].workout === true);
  if (isDone) {
    // tapping a done tile is a no-op (idempotent); the undo path is long-press.
    toast('already logged — long-press to undo');
    return;
  }
  commitWorkout(true);
}

function wireWorkoutTile() {
  // pointer events cover touch + mouse; we guard the trailing click via pressFired.
  elWorkoutTile.addEventListener('pointerdown', tilePressStart);
  elWorkoutTile.addEventListener('pointerup', tilePressCancel);
  elWorkoutTile.addEventListener('pointerleave', tilePressCancel);
  elWorkoutTile.addEventListener('pointercancel', tilePressCancel);
  elWorkoutTile.addEventListener('click', tileTap);
}

// =============================================================================
// TABS
// =============================================================================
function setTab(tab) {
  if (tab !== 'today' && tab !== 'grid') return;
  activeTab = tab;
  for (const btn of elTabs.querySelectorAll('.tab')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  elScreens.today.classList.toggle('is-active', tab === 'today');
  elScreens.grid.classList.toggle('is-active', tab === 'grid');
  elScreens.today.hidden = tab !== 'today';
  elScreens.grid.hidden = tab !== 'grid';
  repaint();
}
function wireTabs() {
  elTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) setTab(btn.dataset.tab);
  });
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
      repaint();
    } catch (err) {
      elReclaimStatus.classList.add('err');
      elReclaimStatus.textContent = 'could not reclaim — reopen your link';
      elReclaimBtn.disabled = false;
    }
  });
}

// =============================================================================
// DATA FETCH (the /days window for everyone shown)
// =============================================================================
async function refetchAllDays(now) {
  const me = memberById(myUserId);
  const s = subjectOf(me) || { ianaTz: DEFAULT_TZ, rolloverHour: DEFAULT_ROLLOVER_H, rolloverMinute: DEFAULT_ROLLOVER_M };
  const cur = currentBusinessDate(now, s.ianaTz, s.rolloverHour, s.rolloverMinute);
  // fetch a window wide enough for the grid AND the streak walk's recent run. The streak
  // can be long, but for the chip we fetch a generous recent window; computeStreak stops
  // at the first missed day, and a deep streak beyond the window is a rare display-only
  // truncation (the hero % only needs the current week, well inside this window).
  let from = cur;
  for (let i = 0; i < 120; i++) from = prevBusinessDate(from);
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

async function refetchMyDays() {
  if (!myUserId) return;
  const now = anchoredNow();
  const me = memberById(myUserId);
  const s = subjectOf(me) || { ianaTz: DEFAULT_TZ, rolloverHour: DEFAULT_ROLLOVER_H, rolloverMinute: DEFAULT_ROLLOVER_M };
  const cur = currentBusinessDate(now, s.ianaTz, s.rolloverHour, s.rolloverMinute);
  let from = cur;
  for (let i = 0; i < 120; i++) from = prevBusinessDate(from);
  try {
    const map = await data.fetchDays(myUserId, from, cur);
    daysByUser.set(myUserId, map || {});
  } catch (e) {
    /* keep prior */
  }
}

// onSnapshot callback: members changed (someone joined/archived, or a rollup/days write
// landed). Re-fetch the day window for the current member set, then repaint.
let snapshotSeq = 0;
function onMembers(usersArray) {
  members = Array.isArray(usersArray) ? usersArray.slice() : [];
  const mySeq = ++snapshotSeq;
  const now = anchoredNow();
  refetchAllDays(now).then(() => {
    if (mySeq !== snapshotSeq) return; // a newer snapshot superseded this fetch
    repaint();
    scheduleNextRollover(); // member set can change my clock anchor; re-arm
  });
  // paint immediately from the rollup-bearing /users docs so the board isn't blank while
  // the /days window loads. effectiveDays falls back to {} -> pills render as pending.
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
  // whole module graph with an opaque resolver error. The example file exports
  // `firebaseConfig`, `recaptchaSiteKey`, and an optional `appCheckDebugToken`.
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
    //    appCheckDebugToken (dev-only) rides in via the optional opts arg data.js supports.
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
  wireWorkoutTile();
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
