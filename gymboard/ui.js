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
// v3 scope (per SPEC-v3.md): two tabs GRID + ME. The grid shows WORKOUT (top band)
// and NUTRITION (bottom band) per person per day in a flat horizontal-split cell
// (no diagonal, no hatch), plus per-person streak (a quiet pip, no fire emoji),
// weight+trend arrow, and last-active under each inline horizontal name. Nutrition is
// AUTO-CHECKED via logic.nutritionStatus (calories+protein, direction-aware) — no
// binary toggle. Bottom bar = WORKOUT (optimistic toggle) | + FOOD (jump to ME +
// focus the meal input). ME is the primary daily app: a running food tracker (meal
// add/remove, progress bars), workout mark-done + 7-type picker, ad-hoc rest toggle,
// and a weight quick-log. Day editor (tap own cell, any visible day = backfill, now
// with a type picker) + read-only day detail (tap another person's cell, now with a
// Type line). The LOUD reclaim modal, the offline outbox for WORKOUT (carrying the
// workoutType), the optimistic overlay, and the autonomous missed->red repaint on a
// DST-safe next-rollover timer all remain. Nutrition NEVER uses red, anywhere.
// =============================================================================

import {
  currentBusinessDate,
  prevBusinessDate,
  nextDayKey,
  businessDate,
  missed,
  isRestDay,
  computeStreak,
  computeCompliance,
  weightTrend,
  relativeTime,
  nutritionStatus,
  emojiOf,
  EMOJI_SET,
  isDayKey,
  // v5 (#5): PLAYLIST — the pure song-input parser + cross-service deep-link builders.
  parseSongInput,
  playlistDedupeKey,
  spotifySearchUrl,
  // v5.1: rich-row display — a pasted Spotify link renders as an inline player.
  spotifyEmbed,
  // v5.2: two themed playlists per week (Mon–Wed 'a' / Thu–Sun 'b').
  businessWeekKey,
  playlistHalf,
  playlistSlotId,
  playlistSlotLabel,
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
// v4 (#3): widened to 90d so the weight-over-time chart (chart phase) shares this one
// fetch; weightTrend only looks ~7d back, so the wider window is harmless to the arrow.
const WEIGHT_WINDOW_DAYS = 90; // weights window fetched per member (trend + chart)
const HEARTBEAT_MS = 60 * 1000; // coarse belt-and-suspenders missed() re-eval
const COMPLIANCE_WINDOW_DAYS = 30; // v4 (#5): trailing window for the per-person % stat
const DAYPOP_AUTO_MS = 5000; // v4 (#13): the read-only popover self-dismisses after ~5s

// v4 (#3): weight-chart logical canvas (coords are computed against this fixed box; the
// <svg> stretches to the container via width/height:100%). Pad keeps lines + labels off
// the edges. The muted (non-me) line palette is gray/white tints ONLY — red is reserved
// for "me", and these are NOT status colors (no green/red status semantics in the chart).
const WCHART_VB_W = 300;
const WCHART_VB_H = 90;
const WCHART_PAD_L = 6;
const WCHART_PAD_R = 22; // extra right room for the end-labels
const WCHART_PAD_T = 8;
const WCHART_PAD_B = 8;
// v4.5: tokenized so the light theme can darken them (light grays vanish on white).
const WCHART_OTHER_COLORS = ['var(--wc-o1)', 'var(--wc-o2)', 'var(--wc-o3)', 'var(--wc-o4)', 'var(--wc-o5)'];
let wchartRange = 30; // selected window in days (30d default; 90d via the toggle)
// v4 (#1): weight-chart perf. _wchartSig is the signature of the LAST real rebuild; a
// repaint whose signature matches it skips the (expensive) SVG rebuild + innerHTML parse.
// Set _wchartSig = null to FORCE the next rebuild (e.g. the 30d/90d toggle).
let _wchartSig = null;
let _wchartGeom = null; // last-built chart geometry, for the tap/drag scrubber

// =============================================================================
// DOM HANDLES
// =============================================================================
const $ = (id) => document.getElementById(id);
const elHdrReg = $('hdr-reg');
const elPipSync = $('pip-sync');
const elTabs = $('tabs');
// v5 (#1): the tab/pane order is the LEFT-to-RIGHT slide order. setTab + wireSwipe both
// do index math over this one list, and each .screen's resting transform is computed off
// its index vs the active index (idx-activeIdx)*100% — robust for 3+ panes where the old
// declarative ±100% rules break (non-adjacent panes would slide from the wrong side).
const SCREENS = ['me', 'grid', 'month', 'playlist'];
const elScreens = {
  me: $('screen-me'),
  grid: $('screen-grid'),
  month: $('screen-month'), // v5 (#3): MONTH calendar tab (rendered in step 4)
  playlist: $('screen-playlist'), // v5 (#5): shared PLAYLIST tab (rendered in step 5)
};
const elGrid = $('grid');
const elGridTitle = $('grid-title'); // v5 (#2): THIS WEEK / LAST WEEK / N WEEKS AGO
const elGridRange = $('grid-range');
// v5 (#2): SOCIAL week-nav controls (older/newer arrows + a "today" reset pill).
const elWkOlder = $('wk-older');
const elWkNewer = $('wk-newer');
const elWkToday = $('wk-today');
// v5 (#4): MONTH tab — per-person calendar. The chip row picks the subject; ‹ › step months.
const elMonthHead = $('month-head');
const elMonthPrev = $('month-prev');
const elMonthNext = $('month-next');
const elMonthLabel = $('month-label');
const elMonthChips = $('month-chips');
const elMonthGrid = $('month-grid');
// v5 (#5): PLAYLIST tab — the shared song wall (add-bar, live list, footer open-buttons).
const elPlCount = $('pl-count');
const elPlInput = $('pl-input');
const elPlAddBtn = $('pl-add-btn');
const elPlAddHint = $('pl-add-hint');
const elPlList = $('pl-list');
const elPlOpenSpotify = $('pl-open-spotify');
const elPlCollab = $('pl-collab');
// v5.2: the two-themed-playlists chrome (half toggle + editable theme line).
const elPlHalfA = $('pl-half-a');
const elPlHalfB = $('pl-half-b');
const elPlThemeName = $('pl-theme-name');
const elPlThemeEdit = $('pl-theme-edit');
const elPlThemeInput = $('pl-theme-input');
const elGridLegend = $('grid-legend');
// v4 (#3): weight-over-time chart handles (the inline-SVG line chart on the SOCIAL board).
const elSocialChart = $('social-chart');
const elWchartSvg = $('wchart-svg');
const elWchartEmpty = $('wchart-empty');
const elWchartToggle = $('wchart-toggle');
const elWchartRangeLabel = $('wchart-range-label');
const elReclaim = $('reclaim');
const elReclaimBackdrop = $('reclaim-backdrop');
const elReclaimBtn = $('reclaim-btn');
const elReclaimStatus = $('reclaim-status');
const elBoot = $('boot');
const elToast = $('toast');

// ME page handles
const elMeTodayDate = $('me-today-date');
const elMeCalFig = $('me-cal-fig');
const elMeCalBar = $('me-cal-bar');
const elMeProFig = $('me-pro-fig');
const elMeProBar = $('me-pro-bar');
const elMeNutInd = $('me-nut-indicator');
const elMeNutHint = $('me-nut-hint'); // v4 (#6): the NUTRITION card hint (adapts per mode)
const elMeCalRow = $('me-cal-row'); // v4 (#6): wrapper around the CALORIES track row
const elMeProRow = $('me-pro-row'); // v4 (#6): wrapper around the PROTEIN track row
const elMeNutTracksSep = $('me-nut-tracks-sep'); // separator above the tracks (hidden in manual)
const elMeWeightLogged = $('me-weight-logged'); // v4.5: "already logged today" indicator
const elMeNutDone = $('me-nutdone'); // v3.1 "mark nutrition done" toggle (sets `ate`)
const elMeAddKcal = $('me-add-kcal');
const elMeAddProtein = $('me-add-protein');
const elMeAddMeal = $('me-add-meal');
const elMeSaveQuickMeal = $('me-save-quickmeal'); // v3.1 "+ save as quick meal"
const elMeQuickMeals = $('me-quickmeals'); // v3.1 quick-meal preset chips (TODAY)
const elMeMeals = $('me-meals');
const elMeWorkout = $('me-workout');
const elMeWType = $('me-wtype'); // workout-type picker (ME today card)
const elMeRestday = $('me-restday'); // "make today a rest day" toggle
const elMeWeight = $('me-weight');
const elMeLogWeight = $('me-log-weight');
const elMeRestdays = $('me-restdays');
const elMeGoal = $('me-goal');
const elMeKcalGoal = $('me-kcalgoal');
const elMeProteinGoal = $('me-proteingoal');
const elMeSaveGoals = $('me-save-goals');
const elMeName = $('me-name');
const elMeRollover = $('me-rollover');
const elMeHideWeight = $('me-hideweight');
const elMeSaveSettings = $('me-save-settings');
// v3.1 SETTINGS handles
const elMeSettings = $('me-settings'); // the collapsible SETTINGS wrapper
const elMeSettingsToggle = $('me-settings-toggle');
const elMeQmManage = $('me-qm-manage'); // quick-meal manager (add/remove presets)
const elMeQmKcal = $('me-qm-kcal');
const elMeQmProtein = $('me-qm-protein');
const elMeQmLabel = $('me-qm-label');
const elMeQmNote = $('me-qm-note'); // v4 (#7): optional free-text note for a quick-meal preset
const elMeQmAdd = $('me-qm-add');
const elMeQmName = $('me-qm-name'); // optional name for the TODAY "+ save as quick meal"
const elMeQmCancel = $('me-qm-cancel'); // cancel an in-progress SETTINGS quick-meal edit
let qmEditIdx = null; // index of the SETTINGS quick-meal being edited, or null
const elMeTypeChooser = $('me-typechooser'); // which workout types show in the picker
const elMeSaveTypes = $('me-save-types');
const elMeNutMode = $('me-nutmode'); // v4 (#6): nutrition-mode chooser (manual/protein/both)
const elMeNutModeHint = $('me-nutmode-hint'); // one-line hint under the chooser
const elMeEmoji = $('me-emoji'); // v4 (#14): personal-emoji picker

// v4 (#13): read-only MINI POPOVER handles (replaces the old bottom-sheet day detail).
const elDayPop = $('daypop');
const elDayPopTitle = $('daypop-title');
const elDayPopSub = $('daypop-sub');
const elDayPopBody = $('daypop-body');

// Error popup (app-chrome alert — used for the rest-day/workout mutual-exclusion block).
const elErrPop = $('errpop');
const elErrPopBackdrop = $('errpop-backdrop');
const elErrPopBody = $('errpop-body');
const elErrPopBtn = $('errpop-btn');

// =============================================================================
// SESSION STATE (UI-side only; data.js owns Firebase truth)
// =============================================================================
let myUserId = null;
let members = []; // latest /users snapshot (archived==false), as data.js hands it over
let daysByUser = new Map(); // userId -> { [dateKey]: DayEntry }  (fetched window)
let weightsByUser = new Map(); // userId -> { [dateKey]: lb }  ({} == hidden)
let activeTab = 'me'; // v3.1: ME is the default-active tab
// v5 (#2): how many WEEKS back the SOCIAL grid is scrolled (0 = current week, newest at
// top). Negative only — there's no future to browse. Shifts the grid's date anchor by
// weekOffset*GRID_DAYS days; the "today" highlight + weight chart stay pinned to the REAL
// current business-date so a past week shows no red today-row. Reset to 0 on tab switch.
let weekOffset = 0;

// v5 (#4): MONTH tab state. monthSubjectUid = whose calendar shows (the chip selection),
// reset to myUserId whenever we LEAVE the tab (see setTab). monthOffset = how many calendar
// months back from the viewer's current month (0 = this month; negative only — no future).
// _monthFetchSig is a `uid|monthAnchorKey` dirty-check: the on-demand fetch of an OTHER
// member's older month runs at most once per (subject, month) so re-renders don't refetch.
let monthSubjectUid = null; // set to myUserId on boot (myUserId isn't known at module load)
let monthOffset = 0;
let _monthFetchSig = null;

// v5 (#5): PLAYLIST tab state. `songs` is the latest /playlist snapshot (newest first), as
// data.subscribePlaylist hands it over. `plCollabUrl` is the Admin-seeded optional shared-
// playlist link (null = hide that footer button), fetched once on boot. The optimistic
// overlays make add/remove feel instant before the snapshot lands: `plOptimisticAdds` is a
// list of locally-added rows (keyed by the id addSong() returned) we render UNTIL the same id
// shows up in the snapshot, and `plOptimisticRemoves` is a set of ids we hide UNTIL the
// snapshot drops them. Reconciled in onSongs.
let songs = [];
let plCollabUrl = null;
let plOptimisticAdds = []; // [{ id, title, artist, url, source, slot, addedByUserId }]
const plOptimisticRemoves = new Set(); // song ids hidden pending the snapshot
// v5.2: two themed playlists per week. `plSlots` is the /playlistSlots snapshot
// (slotKey -> { theme?, spotifyPlaylistId?, spotifyUrl? }). `plViewHalf` is which
// half of THIS week is on screen ('a'|'b'); null means "default to the current
// half by today's date" (reset whenever the tab is opened).
let plSlots = {};
let plViewHalf = null;
let plThemeEditing = false; // true while the theme input is open (so render won't stomp it)

// Optimistic overlay: while a WORKOUT write for (userId+businessDate) is in flight (or
// failed pre-rollback), we paint from THIS map, not the snapshot, and we never repaint
// that day red. Keyed userId -> { [dateKey]: {workout:bool} }.
const optimistic = new Map();
// Set of `${userId}|${dateKey}` with an unsynced (queued, not server-acked) write.
const unsynced = new Set();

let rolloverTimer = null;
let heartbeatTimer = null;
let booted = false;

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; // display order
const WEEKDAY_NUMS = [1, 2, 3, 4, 5, 6, 0]; // logic weekday for each label (0=Sun..6=Sat)
const GOALS = [
  { key: 'gain', label: 'Gain' },
  { key: 'lose', label: 'Lose' },
  { key: 'maintain', label: 'Maintain' },
];

// v4 (#6): the three per-person nutrition modes (the ME SETTINGS chooser + the one-line hint).
const NUTRITION_MODES = [
  { key: 'manual', label: 'Manual', hint: 'Nutrition counts as done only when you mark it done.' },
  { key: 'protein', label: 'Protein', hint: 'Auto-done when you hit your protein goal (calories ignored).' },
  { key: 'both', label: 'Both', hint: 'Auto-done when both calories and protein are on target.' },
];
const NUTMODE_HINT = Object.fromEntries(NUTRITION_MODES.map((m) => [m.key, m.hint]));

// v3 workout types (lowercase stored). `label` = the picker button text; `tag` = the
// tiny 1-2 letter corner glyph painted on a done WORKOUT band in the grid.
const WORKOUT_TYPES = [
  { key: 'upper', label: 'Upper', tag: 'UP' },
  { key: 'lower', label: 'Lower', tag: 'LOW' },
  { key: 'push', label: 'Push', tag: 'PUSH' },
  { key: 'pull', label: 'Pull', tag: 'PULL' },
  { key: 'legs', label: 'Legs', tag: 'LEGS' },
  { key: 'full', label: 'Full', tag: 'FULL' },
  { key: 'cardio', label: 'Cardio', tag: 'CARD' },
];
const WTYPE_LABEL = Object.fromEntries(WORKOUT_TYPES.map((t) => [t.key, t.label]));
const WTYPE_TAG = Object.fromEntries(WORKOUT_TYPES.map((t) => [t.key, t.tag]));
const WTYPE_KEYS = WORKOUT_TYPES.map((t) => t.key); // canonical order/enum

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
    // v3: nutrition auto-check needs the goal direction + goal numbers, which live
    // on the public /users doc. Carried here so classifyDay's signature is unchanged.
    goal: member.goal || 'maintain',
    kcalGoal: Number.isFinite(member.kcalGoal) ? member.kcalGoal : null,
    proteinGoal: Number.isFinite(member.proteinGoal) ? member.proteinGoal : null,
    // v4 (#6): the per-person nutrition mode (default 'both' for back-compat / demo users).
    nutritionMode: nutritionModeOf(member),
  };
}

// v4 (#6): a member's nutrition mode, defaulting to 'both' (today's behavior) when absent
// or invalid — so seeded/demo docs with no nutritionMode keep working.
function nutritionModeOf(member) {
  const m = member && member.nutritionMode;
  return m === 'manual' || m === 'protein' || m === 'both' ? m : 'both';
}

function displayNameOf(member) {
  const n = member && member.profile && member.profile.displayName;
  return (typeof n === 'string' && n.trim()) ? n.trim() : 'Member';
}

// v3.1: the workout types this member has enabled for their picker. An unset/empty list
// means "all 7" (back-compat); we also filter out any stale value not in the canonical
// enum so a corrupt doc can't render a junk button.
function enabledTypesOf(member) {
  const raw = member && Array.isArray(member.enabledWorkoutTypes) ? member.enabledWorkoutTypes : [];
  const filtered = raw.filter((k) => WTYPE_KEYS.includes(k));
  return filtered.length ? filtered : WTYPE_KEYS.slice();
}

// v3.1: this member's saved quick-meal presets (validated shape; defensive filter).
function savedMealsOf(member) {
  const raw = member && Array.isArray(member.savedMeals) ? member.savedMeals : [];
  return raw.filter((m) => m && Number.isFinite(m.kcal));
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

  // ---- NUTRITION side (v3: derived from goals + running totals) ----
  // nutritionStatus() encodes the full §2 contract: manual `ate`/`macros` override,
  // goals-unset fallback, the 0-kcal short-circuit, and the direction rule. It NEVER
  // returns red — 'hit'|'pending'|'none' map to green/quiet-fill/quiet-gray.
  const { h, m } = { h: subject.rolloverHour, m: subject.rolloverMinute };
  const cur = currentBusinessDate(now, subject.ianaTz, h, m);
  const nStatus = nutritionStatus(day, {
    nutritionMode: subject.nutritionMode, // v4 (#6): mode-aware auto-check
    kcalGoal: subject.kcalGoal,
    proteinGoal: subject.proteinGoal,
    goal: subject.goal || 'maintain',
    isPast: dateKey < cur,
  });

  return { wStatus, nStatus };
}

const CELL_LABEL = {
  done: 'done',
  missed: 'missed',
  rest: 'rest',
  off: 'rest', // v4 (#1): off renders + reads identically to rest
  pending: 'pending',
  prejoin: 'pre-join',
};

// =============================================================================
// RENDER: GRID  (people = COLUMNS, vertical bottom-to-top names, newest day on
// top, older rows fade. Diagonal cells: upper-left WORKOUT, lower-right NUTRITION.)
// =============================================================================
function gridDateKeys(now) {
  // v5 (#2): the body anchor is the viewer's current business-date shifted back
  // |weekOffset| WEEKS (weekOffset is <=0). Step prevBusinessDate weekOffset*GRID_DAYS
  // times so the trailing-7 body slides intact (fades/gutter/classifyDay follow). The
  // REAL today (unshifted) is returned separately so the today-highlight + range title
  // can be computed against it — a past week must paint NO red today-row.
  const today = viewerBusinessDate(now);
  let anchor = today;
  const back = -weekOffset * GRID_DAYS; // weekOffset<=0 => non-negative step count
  for (let i = 0; i < back; i++) anchor = prevBusinessDate(anchor);
  const keys = [anchor];
  for (let i = 1; i < GRID_DAYS; i++) keys.push(prevBusinessDate(keys[i - 1]));
  return { keys, anchor, today }; // newest (anchor) first; today = real current biz-date
}

function fmtDateGutter(dateKey) {
  // dateKey is 'YYYY-MM-DD' (a civil date string). Format DOW + M/D without constructing
  // a zoned instant (UTC noon avoids any local-offset day shift).
  const [y, mo, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const dow = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  return { dow: dow.toUpperCase(), md: `${mo}/${d}` };
}

// v5 (#2): a readable "Mon D" label for a dateKey (no zoned instant — UTC noon avoids a
// local-offset day shift, same trick as fmtDateGutter). Used for the SOCIAL range label.
function fmtDateShort(dateKey) {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const mon = dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mon} ${d}`;
}

// v5 (#2): the SOCIAL header title for the current weekOffset (0 = THIS WEEK, -1 = LAST
// WEEK, -N = N WEEKS AGO). weekOffset is never positive (no future to browse).
function weekTitleFor(offset) {
  if (offset >= 0) return 'THIS WEEK';
  if (offset === -1) return 'LAST WEEK';
  return `${-offset} WEEKS AGO`;
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

// Build the under-name header stack. v4 (#5): WORKOUT compliance % (30d) is the headline
// accountability number, with the streak folded in small beside it; then weight+arrow;
// then last-active. Nutrition % lives in the day popover (keeps the column uncluttered).
function headStackHtml(member, now, viewerBiz) {
  const uid = idOf(member);
  const subject = subjectOf(member);
  const parts = [];

  // (a) WORKOUT compliance % over a trailing 30d window (computeCompliance). null
  // (zero scheduled training days in-window) renders "—", never NaN/0. The streak is
  // folded in as a small secondary glyph on the same line.
  let comp = null;
  try {
    comp = computeCompliance(effectiveDays(uid), subject, now, { windowDays: COMPLIANCE_WINDOW_DAYS });
  } catch (e) {
    comp = null;
  }
  let streak = 0;
  try {
    streak = computeStreak(effectiveDays(uid), subject, now);
  } catch (e) {
    streak = 0;
  }
  const wPct = comp && comp.workout ? comp.workout.percent : null;
  const compNone = wPct == null;
  const pctText = compNone ? '—' : `${wPct}%`;
  const streakGlyph =
    streak > 0
      ? `<span class="gh-streak" aria-label="streak ${streak}"><span class="gh-streak-pip" aria-hidden="true"></span>${streak}</span>`
      : '';
  parts.push(
    `<span class="gh-compliance${compNone ? ' none' : ''}" aria-label="workout compliance ${compNone ? 'not enough data' : wPct + ' percent'} over 30 days">` +
      `${pctText}${streakGlyph}</span>`
  );

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
    // no cells to anchor to anymore — close any open popover before blanking the grid.
    if (daypopOpen) closeDayPopover();
    elGrid.innerHTML =
      '<div class="empty-note">No active members yet.<br>Soren seeds people with the admin script, then texts each person their link.</div>';
    elGridRange.textContent = '';
    return;
  }
  const { keys, anchor, today } = gridDateKeys(now);
  const cols = orderedMembers();

  // CSS grid template: a fixed date gutter + one CAPPED column per member. v4 (#15): the
  // cap (max 56px) stops 3 people from stretching full-width; #grid (width:max-content,
  // margin-inline:auto, justify-content:center) centers the block when narrow and lets
  // #grid-scroll scroll horizontally when many columns overflow.
  elGrid.style.gridTemplateColumns = `44px repeat(${cols.length}, minmax(40px, 56px))`;

  const cells = [];
  // header row: corner + member-name headers. v3.1: emit the stat stack FIRST and the
  // NAME LAST so the fixed-height flex-end .ghead pins every name to a common bottom
  // baseline (stats float above it). Names stay inline-horizontal.
  cells.push('<div class="gcell-corner"></div>');
  for (const m of cols) {
    const isMe = idOf(m) === myUserId;
    // v4 (#14): the per-person emoji sits ABOVE the name (between the stat stack and the
    // name span). emojiOf falls back to a deterministic id-hash for demo users with none.
    const emoji = emojiOf({ emoji: m.emoji, id: idOf(m) });
    cells.push(
      `<div class="ghead${isMe ? ' me' : ''}" title="${escapeHtml(displayNameOf(m))}">` +
        headStackHtml(m, now, today) +
        `<span class="ghead-emoji" aria-hidden="true">${escapeHtml(emoji)}</span>` +
        `<span class="ghead-v">${escapeHtml(displayNameOf(m))}</span>` +
        `</div>`
    );
  }

  // body: newest date at top; older rows fade out so the most recent reads clearest.
  for (let i = 0; i < keys.length; i++) {
    const dk = keys[i];
    const g = fmtDateGutter(dk);
    const isToday = dk === today; // real current biz-date, NOT the shifted anchor
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
      // v3 cell body: a TOP workout band + a BOTTOM nutrition band (V1 horizontal
      // split). A tiny dim corner tag on the workout band when a typed workout is done
      // (decoration only — never changes the done/missed color).
      let wtag = '';
      if (day && day.workout === true && day.workoutType && WTYPE_TAG[day.workoutType]) {
        wtag = `<span class="gcell-wtag" aria-hidden="true">${escapeHtml(WTYPE_TAG[day.workoutType])}</span>`;
      }
      cells.push(
        `<div class="gcell w-${wStatus} n-${nStatus}${isMe ? ' me' : ''}${prejoin ? ' prejoin' : ''}" ` +
          `style="opacity:${op}" data-uid="${escapeHtml(uid)}" data-date="${escapeHtml(dk)}" ` +
          `role="button" tabindex="0" aria-label="${escapeHtml(aria)}">` +
          `<div class="seg-w">${wtag}</div><div class="seg-n"></div></div>`
      );
    }
  }
  elGrid.innerHTML = cells.join('');

  // v4 (#4): the rebuild above replaced the cell the popover was anchored to. Instead of
  // force-closing it on every snapshot/heartbeat/rollover (which made reading a teammate's
  // day flicker away the moment anyone logged), RE-ANCHOR it to the freshly-built cell if
  // that uid+date is still on the grid; only close if the cell genuinely fell out of range.
  reanchorDayPopover();

  // v5 (#2): readable date range (oldest → newest of the shown week) + a dynamic title
  // that names how far back we're browsing. Title/range follow the shifted anchor; the
  // today-highlight + weight chart stay pinned to the real current business-date.
  const first = keys[keys.length - 1];
  elGridRange.textContent = `${fmtDateShort(first)} – ${fmtDateShort(anchor)}`;
  if (elGridTitle) elGridTitle.textContent = weekTitleFor(weekOffset);
  syncWeekNav();

  // Legend (v4 #11): at the TOP now, with a labeled mini-cell DIAGRAM (top=workout /
  // bottom=nutrition) plus the color key. Off is merged into rest (#1); nutrition is
  // NEVER red, and the "missed = workout only" note makes that explicit.
  if (!elGridLegend.dataset.built) {
    // v4.5: one clean row. A single example cell whose TOP half is the workout and BOTTOM
    // half is the nutrition (labeled right beside it), then a compact color key.
    elGridLegend.innerHTML =
      `<span class="lgex" aria-label="cell key: top half is workout, bottom half is nutrition">` +
        `<span class="leg-cell leg-cell-big w-done n-hit"><span class="seg-w"></span><span class="seg-n"></span></span>` +
        `<span class="lgex-labels"><span class="lgex-t">↖ workout</span><span class="lgex-b">↘ nutrition</span></span>` +
      `</span>` +
      `<span class="lgkey">` +
        `<span class="lgchip"><span class="lgsw lg-done"></span>done</span>` +
        `<span class="lgchip"><span class="lgsw lg-missed"></span>missed</span>` +
        `<span class="lgchip"><span class="lgsw lg-rest"></span>rest</span>` +
      `</span>`;
    elGridLegend.dataset.built = '1';
  }

  // v4 (#3): the weight-over-time chart shares this repaint (it lives below the grid on
  // the SOCIAL board). Re-rendered on every Social paint + on weights refetch + on toggle.
  renderWeightChart(now);
}

// =============================================================================
// RENDER: WEIGHT-OVER-TIME CHART (v4 #3) — pure inline SVG, no libraries.
//   x = business-date over the selected window (30d/90d), walked back DST-safely via
//   prevBusinessDate (never raw ms). y = weight, auto-fit with padding. One smoothed
//   polyline per VISIBLE member ("me" = red, others = muted gray tints) with a small
//   emoji/initial end-label. Faint hairline gridlines + a couple of y labels. Hidden
//   members (fetchWeights returned {}) and members with no in-range points are omitted.
// =============================================================================

// Catmull-Rom -> cubic-bezier smoothing over ordered {x,y} points. Returns an SVG path
// `d` string. 0 points => '', 1 point handled by the caller (a dot). The Catmull-Rom
// tension is the standard 1/6 control-point spacing, clamped to the segment endpoints so
// the curve never overshoots wildly on sparse, spiky weight data.
function smoothPath(points) {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return ''; // caller draws a dot for a single point
  if (n === 2) {
    return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)} L ${points[1].x.toFixed(2)} ${points[1].y.toFixed(2)}`;
  }
  let d = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    let c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    let c2y = p2.y - (p3.y - p1.y) / 6;
    // clamp control-point Y to this segment's endpoints so the curve can't overshoot the
    // chart bounds on sparse/spiky weight data (the comment above promised this).
    const segLo = Math.min(p1.y, p2.y), segHi = Math.max(p1.y, p2.y);
    c1y = c1y < segLo ? segLo : c1y > segHi ? segHi : c1y;
    c2y = c2y < segLo ? segLo : c2y > segHi ? segHi : c2y;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

// v4 (#1): the cheap signature of everything the chart draws from — the range, the
// container width, and per-VISIBLE-member (stable order) point summary. When this string
// is unchanged, the SVG is byte-identical, so we skip the rebuild. Walks the window once
// with plain map lookups (no string building), so it's cheap to run on every repaint.
function weightChartSig(now) {
  const cur = viewerBusinessDate(now);
  const rangeDays = wchartRange;
  // capture EVERY in-range point (key=lb) per visible member, PLUS the emoji label — i.e.
  // everything the chart actually draws. Editing any point (interior/first/last) or changing
  // an emoji changes the sig, so the dirty-check can never leave a stale chart. Cheap:
  // <=rangeDays lookups x members, string concat only.
  const keys = [cur];
  for (let i = 1; i < rangeDays; i++) keys.push(prevBusinessDate(keys[i - 1]));
  const width = (elWchartSvg && elWchartSvg.clientWidth) || (elSocialChart && elSocialChart.clientWidth) || 0;
  const parts = [`r${rangeDays}`, `w${width}`];
  for (const m of orderedMembers()) {
    const uid = idOf(m);
    if (uid !== myUserId && m.hideWeight === true) continue; // mirror the render's gate (#2)
    const wmap = weightsByUser.get(uid) || {};
    let pts = '';
    for (let i = keys.length - 1; i >= 0; i--) {
      const dk = keys[i];
      const lb = wmap[dk];
      if (Number.isFinite(lb)) pts += dk + '=' + lb + ',';
    }
    parts.push(uid + ':' + emojiOf(m) + ':' + pts);
  }
  return parts.join('|');
}

function renderWeightChart(now) {
  if (!elSocialChart || !elWchartSvg) return;

  // sync the range label + toggle button states to the current selection. Cheap + always
  // safe to run (idempotent), so it stays OUTSIDE the dirty-check / rAF coalescing.
  if (elWchartRangeLabel) elWchartRangeLabel.textContent = String(wchartRange);
  if (elWchartToggle) {
    for (const btn of elWchartToggle.querySelectorAll('.wc-range')) {
      const on = Number(btn.dataset.range) === wchartRange;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  // perf: skip the expensive innerHTML SVG rebuild when nothing the chart draws from has
  // changed (heartbeat / no-op snapshots / lastActiveAt bumps). weightChartSig is a cheap
  // map walk; buildWeightChart (the reparse) only runs on a real change — a logged weight,
  // a member-set change, or the range. The 30d/90d toggle sets _wchartSig=null to force it.
  const sig = weightChartSig(now);
  if (sig === _wchartSig) return;
  _wchartSig = sig;
  buildWeightChart(now);
}

// The actual SVG build (expensive: string assembly + innerHTML parse). Only ever reached
// from renderWeightChart after the dirty-check found a real change, coalesced via rAF.
function buildWeightChart(now) {
  if (!elSocialChart || !elWchartSvg) return;

  // ---- container geometry. Render at the host's REAL pixel aspect so the chart FILLS the
  // box (the old fixed 300x90 viewBox + "meet" letterboxed inside a taller box => a dead
  // empty strip at the bottom). vbH tracks the host; a bigger PAD_L holds the LEFT y-axis
  // labels (moved off the right edge, where they collided with the emoji end-labels).
  const hostW = elWchartSvg.clientWidth || 320;
  const hostH = elWchartSvg.clientHeight || 132;
  const vbW = 300;
  const vbH = Math.max(76, Math.min(220, Math.round(vbW * (hostH / Math.max(1, hostW)))));
  const PAD_L = 28, PAD_R = 16, PAD_T = 10, PAD_B = 12;

  // ---- X: the ordered window of business-dates, oldest..newest, DST-safe.
  const cur = viewerBusinessDate(now);
  const rangeDays = wchartRange;
  const keysNewestFirst = [cur];
  for (let i = 1; i < rangeDays; i++) keysNewestFirst.push(prevBusinessDate(keysNewestFirst[i - 1]));
  const keysOldestFirst = keysNewestFirst.slice().reverse();
  const dateIndex = new Map();
  keysOldestFirst.forEach((k, i) => dateIndex.set(k, i));

  const innerW = vbW - PAD_L - PAD_R;
  const innerH = vbH - PAD_T - PAD_B;
  const xOf = (idx) => PAD_L + (rangeDays <= 1 ? innerW : (idx / (rangeDays - 1)) * innerW);

  // ---- gather each visible member's in-range points. Hidden members (fetchWeights -> {})
  // and members with zero in-range points are omitted. "me" first so its red draws on top.
  const cols = orderedMembers();
  const series = [];
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const m of cols) {
    const uid = idOf(m);
    // v4 (#2): hiding weight hides it from the GROUP, not from yourself — so only skip
    // OTHERS here. Genuinely-hidden others come back with an empty weight map (the gate)
    // and fall out at the `!pts.length` check below anyway; this just keeps MY own line.
    if (uid !== myUserId && m.hideWeight === true) continue;
    const wmap = weightsByUser.get(uid) || {};
    const pts = [];
    for (const dk of keysOldestFirst) {
      const lb = wmap[dk];
      if (Number.isFinite(lb)) {
        pts.push({ dk, lb, idx: dateIndex.get(dk) });
        if (lb < yMin) yMin = lb;
        if (lb > yMax) yMax = lb;
      }
    }
    if (!pts.length) continue; // no in-range data -> no line (no flat zero, no NaN)
    series.push({ uid, member: m, isMe: uid === myUserId, pts });
  }

  // ---- empty: zero shared in-range points across everyone -> hide SVG, show the note.
  if (!series.length) {
    elWchartSvg.innerHTML = '';
    _wchartGeom = null;
    if (elWchartEmpty) elWchartEmpty.classList.remove('hidden');
    elSocialChart.classList.remove('hidden');
    return;
  }
  if (elWchartEmpty) elWchartEmpty.classList.add('hidden');
  elSocialChart.classList.remove('hidden');

  // ---- Y: auto-fit with padding. Single distinct value -> pad to [v-2, v+2].
  let lo = Math.floor(yMin - 1);
  let hi = Math.ceil(yMax + 1);
  if (lo === hi) { lo = yMin - 2; hi = yMax + 2; }
  const span = hi - lo || 1;
  const yOf = (lb) => PAD_T + (1 - (lb - lo) / span) * innerH;

  // ---- assign colors: "me" is red; others cycle the tokenized grays.
  let otherI = 0;
  for (const s of series) {
    if (s.isMe) {
      s.color = 'var(--red)';
      s.width = 2;
      s.opacity = 1;
    } else {
      s.color = WCHART_OTHER_COLORS[otherI % WCHART_OTHER_COLORS.length];
      s.width = 1.5;
      s.opacity = 0.85;
      otherI++;
    }
  }

  // ---- build the SVG.
  const parts = [];
  // gridlines at NICE round steps (1/2/5/10) so labels land on whole numbers and the
  // user's own weight line is always among them (fixes "146/148/149 but no 147 line").
  // Value labels sit on the LEFT, freeing the right edge for the emoji end-labels.
  const rng = hi - lo;
  const gstep = rng <= 6 ? 1 : rng <= 15 ? 2 : rng <= 40 ? 5 : 10;
  const gridVals = [];
  for (let g = Math.ceil(lo / gstep) * gstep; g <= hi + 0.001; g += gstep) gridVals.push(g);
  if (!gridVals.length) gridVals.push(lo, hi);
  for (const gv of gridVals) {
    const gy = yOf(gv).toFixed(2);
    parts.push(
      `<line x1="${PAD_L}" y1="${gy}" x2="${(vbW - PAD_R).toFixed(2)}" y2="${gy}" ` +
        `stroke="var(--hairline)" stroke-width="0.6" />`
    );
    parts.push(
      `<text x="${(PAD_L - 5).toFixed(2)}" y="${(yOf(gv) + 3).toFixed(2)}" ` +
        `font-size="9" fill="var(--txt3)" text-anchor="end">${Math.round(gv)}</text>`
    );
  }

  // one line (or dot) per member; collect the RIGHT-edge end-labels for a vertical-dodge.
  const labels = [];
  for (const s of series) {
    const coords = s.pts.map((p) => ({ x: xOf(p.idx), y: yOf(p.lb) }));
    const last = coords[coords.length - 1];
    if (coords.length === 1) {
      parts.push(`<circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="2.2" fill="${s.color}" opacity="${s.opacity}" />`);
    } else {
      const d = smoothPath(coords);
      parts.push(
        `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width}" ` +
          `stroke-linecap="round" stroke-linejoin="round" opacity="${s.opacity}" />`
      );
    }
    const emoji = emojiOf({ emoji: s.member.emoji, id: s.uid });
    labels.push({
      x: vbW - PAD_R + 2, anchor: 'start',
      idealY: last.y, y: last.y,
      fill: s.isMe ? 'var(--red)' : s.color,
      text: emoji || (displayNameOf(s.member).charAt(0) || '?'),
    });
  }
  // vertical-dodge the end-labels so emojis never overlap when weights are close.
  const LBL_GAP = 11;
  const lblTop = PAD_T + 4;
  const lblBot = vbH - PAD_B + 1;
  labels.sort((a, b) => a.idealY - b.idealY);
  for (let i = 0; i < labels.length; i++) {
    labels[i].y = i > 0 ? Math.max(labels[i].idealY, labels[i - 1].y + LBL_GAP) : labels[i].idealY;
  }
  const overflow = labels.length ? labels[labels.length - 1].y - lblBot : 0;
  if (overflow > 0) for (const L of labels) L.y -= overflow;
  for (const L of labels) {
    if (L.y < lblTop) L.y = lblTop;
    parts.push(
      `<text x="${L.x.toFixed(2)}" y="${(L.y + 3).toFixed(2)}" font-size="11" ` +
        `fill="${L.fill}" text-anchor="${L.anchor}">${escapeHtml(L.text)}</text>`
    );
  }

  elWchartSvg.innerHTML =
    `<svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="Weight over time, last ${rangeDays} days">${parts.join('')}</svg>`;

  // stash geometry for the tap/drag scrubber (wired separately).
  _wchartGeom = { vbW, vbH, PAD_L, PAD_R, PAD_T, PAD_B, innerW, rangeDays, keysOldestFirst, xOf, series };
}

// =============================================================================
// FULL REPAINT (called on snapshot, on tap, on rollover, on heartbeat)
// v3.1: no bottom bar — repaint just renders the active screen + the sync pip.
// =============================================================================
function repaint() {
  const now = anchoredNow();
  if (activeTab === 'me') {
    renderMe(now);
  } else if (activeTab === 'grid') {
    renderGrid(now);
  } else if (activeTab === 'month') {
    renderMonth(now); // v5 (#4): per-person calendar
  } else if (activeTab === 'playlist') {
    renderPlaylist(); // v5 (#5): shared song wall (live; not time-anchored, so no `now`)
  }
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
// OPTIMISTIC WORKOUT WRITE (commitWorkout) — the regression-critical path.
//   Triggered from the ME "mark workout done" button (and the type picker). Keeps
//   the optimistic paint + offline outbox + unsynced flag exactly as before; the
//   only change vs v3 is the trigger moved from the bottom WORKOUT tile to ME.
// `opts.workoutType` rides through to data.markWorkout so a typed mark-done persists
// the type; it's ignored on an undo (done===false) by data.js.
// =============================================================================
async function commitWorkout(bd, done, opts = {}) {
  if (!myUserId) return;
  const key = `${myUserId}|${bd}`;

  // optimistic paint immediately (workout bool only; type lands on the snapshot).
  setOptimistic(myUserId, bd, done);
  unsynced.add(key);
  repaint();

  try {
    await data.markWorkout(myUserId, bd, done, opts.workoutType ? { workoutType: opts.workoutType } : {});
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

// =============================================================================
// ERROR POPUP (app-chrome alert) — the reusable hard-block dialog. Used by the
// rest-day/workout mutual exclusion (#7). MAY use red (chrome, not a nutrition state).
// =============================================================================
function showError(msg) {
  if (!elErrPop || !elErrPopBackdrop) {
    toast(msg); // graceful fallback if the popup markup is somehow absent
    return;
  }
  if (elErrPopBody) elErrPopBody.textContent = msg;
  elErrPopBackdrop.classList.remove('hidden');
  elErrPop.classList.remove('hidden');
  if (elErrPopBtn) elErrPopBtn.focus();
}
function hideError() {
  if (elErrPopBackdrop) elErrPopBackdrop.classList.add('hidden');
  if (elErrPop) elErrPop.classList.add('hidden');
}
function wireError() {
  if (elErrPopBtn) elErrPopBtn.addEventListener('click', hideError);
  if (elErrPopBackdrop) elErrPopBackdrop.addEventListener('click', hideError);
}

// =============================================================================
// TABS  (ME | SOCIAL | MONTH | PLAYLIST — order = SCREENS = left-to-right slide order)
// =============================================================================
// v5 (#1): position every mounted screen off the active index. Each pane's resting
// transform is translateX((idx - activeIdx) * 100%): the active pane sits at 0, panes to
// its right slide off to the right (+100%, +200%, …), panes to its left off to the left.
// JS-computed per-index inline transforms beat the old declarative ±100% rules because a
// 4-pane strip also needs ±200%/±300%, and a jump from pane 0 to pane 2 must enter from the
// correct side. #stage (overflow:hidden) clips everything that isn't sitting at 0.
function applyScreenTransforms(activeIdx) {
  for (let i = 0; i < SCREENS.length; i++) {
    const el = elScreens[SCREENS[i]];
    if (el) el.style.transform = `translateX(${(i - activeIdx) * 100}%)`;
  }
}

function setTab(tab) {
  const idx = SCREENS.indexOf(tab);
  if (idx < 0) return; // not a known pane
  closeDayPopover(); // v4 (#13): don't leave a popover floating across a tab switch
  weekOffset = 0; // v5 (#2): never resume on a stale N-weeks-ago view after a tab switch
  // v5 (#4): reset the MONTH view to the viewer's own current month on every tab switch, so
  // we never resume on someone else's calendar or a stale month back. (Runs on leaving AND
  // re-entering — either way the tab opens fresh as "my current month".)
  monthSubjectUid = myUserId;
  monthOffset = 0;
  plViewHalf = null; // v5.2: PLAYLIST always opens on the current half (by today's date)
  activeTab = tab;
  for (const btn of elTabs.querySelectorAll('.tab')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  // v4.5: screens stay in the DOM and SLIDE via transform (see .screen in styles.css), so
  // we toggle is-active + aria-hidden instead of `hidden` (display:none would kill the
  // transition). v5 (#1): the actual translateX is set per-index in applyScreenTransforms
  // (the .is-active class is kept only as a styling hook + the pre-JS CSS resting state).
  // Loop over SCREENS so any number of panes stay in sync.
  for (let i = 0; i < SCREENS.length; i++) {
    const el = elScreens[SCREENS[i]];
    if (!el) continue;
    const on = SCREENS[i] === tab;
    // v5 (#3): the month/playlist sections ship with the boolean `hidden` attr (display:none)
    // so they never flash empty before first interaction. The moment the tab system runs we
    // clear it on EVERY pane — from here on, hiding is the transform slide + #stage clip, and
    // an off-screen pane must stay rendered (not display:none) so it can slide back in.
    el.hidden = false;
    el.classList.toggle('is-active', on);
    el.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
  applyScreenTransforms(idx);
  repaint();
}
function wireTabs() {
  elTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) setTab(btn.dataset.tab);
  });
}

// =============================================================================
// THEME  (light / dark toggle in the header; dark is the default, persisted)
// =============================================================================
const elHdrTheme = $('hdr-theme');
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function applyThemeIcon() {
  // show the icon of the mode you'll switch TO (sun => go light, moon => go dark).
  if (elHdrTheme) elHdrTheme.textContent = currentTheme() === 'light' ? '☾' : '☀';
}
function setTheme(theme) {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('gymboard.theme', theme); } catch (_) { /* private mode */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f4f5' : '#060606');
  applyThemeIcon();
}
function wireTheme() {
  applyThemeIcon();
  if (elHdrTheme) {
    elHdrTheme.addEventListener('click', () =>
      setTheme(currentTheme() === 'light' ? 'dark' : 'light')
    );
  }
}

// =============================================================================
// SWIPE  (left/right between adjacent panes on touch screens)
// v5 (#1): index math over SCREENS — a swipe moves ONE pane left or right, clamped to the
// ends (no wrap). Swipe LEFT advances to the next pane (idx+1), swipe RIGHT to the previous
// (idx-1). The same flick thresholds as before keep it from firing on scrolls/taps.
// =============================================================================
function wireSwipe() {
  const stage = $('stage');
  if (!stage) return;
  let x0 = null, y0 = null, t0 = 0;
  stage.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (x0 == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0, dt = Date.now() - t0;
    x0 = null;
    if (dt > 600) return;                          // too slow to read as a flick
    if (Math.abs(dx) < 55) return;                 // not a decisive horizontal move
    if (Math.abs(dx) < Math.abs(dy) * 1.6) return; // mostly-vertical => a scroll, ignore
    const cur = SCREENS.indexOf(activeTab);
    if (cur < 0) return;
    const next = cur + (dx < 0 ? 1 : -1);          // LEFT => next pane, RIGHT => previous
    if (next < 0 || next >= SCREENS.length) return; // clamp at the ends (no wrap)
    setTab(SCREENS[next]);
  }, { passive: true });
}

// =============================================================================
// WEEK NAVIGATION (v5 #2) — browse PAST weeks on SOCIAL via header arrows.
//   ‹ (older) decrements weekOffset (further back), › (newer) increments it toward 0,
//   and a "today" pill (shown only off-current-week) jumps straight back to 0. Browsing
//   within the already-cached ~120-day day-window is a PURE re-render; paging older than
//   the window lazy-fetches and MERGES the older days in (never replaces). The weight
//   chart + today-highlight stay pinned to the real current business-date (they do NOT
//   follow weekOffset — see gridDateKeys/renderWeightChart).
// =============================================================================
// The day-window the snapshot path already holds (matches the 120 in refetchAllDays /
// refetchDaysFor). _fetchedDaysBack tracks how deep we've ACTUALLY fetched, so paging
// further back only ever fetches the new slice once and grows the cache monotonically.
const DAY_WINDOW_DAYS = 120;
let _fetchedDaysBack = DAY_WINDOW_DAYS;

// How many days back the OLDEST cell of a given weekOffset reaches (weekOffset <= 0).
function oldestDaysBackFor(offset) {
  return -offset * GRID_DAYS + (GRID_DAYS - 1);
}

// Reflect weekOffset in the arrow/pill enabled+visible state. Idempotent + cheap, so it's
// safe to call on every grid paint. › is dead at offset>=0 (no future); the pill only
// shows once we've left the current week.
function syncWeekNav() {
  if (elWkNewer) {
    const atNow = weekOffset >= 0;
    elWkNewer.disabled = atNow;
    elWkNewer.setAttribute('aria-disabled', atNow ? 'true' : 'false');
  }
  if (elWkOlder) {
    elWkOlder.disabled = false; // no hard floor — we lazy-fetch older on demand
    elWkOlder.setAttribute('aria-disabled', 'false');
  }
  if (elWkToday) elWkToday.classList.toggle('hidden', weekOffset === 0);
}

// Lazy-fetch + MERGE older days for every member when the target week reaches past the
// cached window. Merges {...existing, ...older} (older-only slice) so nothing already
// loaded is dropped, then repaints. Within the window this is a no-op (pure re-render).
async function ensureDaysForOffset(offset, now) {
  const needBack = oldestDaysBackFor(offset);
  if (needBack < _fetchedDaysBack) return; // already cached this far — nothing to fetch
  const cur = viewerBusinessDate(now);
  // grow the window in week-sized headroom so we don't refetch on every single step.
  const targetBack = needBack + GRID_DAYS * 4;
  const newFrom = fromKeyFor(cur, targetBack);          // oldest key of the grown window
  const oldFrom = fromKeyFor(cur, _fetchedDaysBack);     // oldest key we already hold
  // fetch only the NEW older slice [newFrom .. dayBefore(oldFrom)] and merge it in.
  const sliceTo = prevBusinessDate(oldFrom);
  _fetchedDaysBack = targetBack;
  await Promise.all(members.map(async (m) => {
    const uid = idOf(m);
    try {
      const older = await data.fetchOlderDays(uid, newFrom, sliceTo);
      const existing = daysByUser.get(uid) || {};
      daysByUser.set(uid, { ...existing, ...(older || {}) }); // merge, never replace
    } catch (e) {
      /* keep prior; a per-member miss just leaves those older cells as pending blanks */
    }
  }));
}

// Step the grid by `delta` weeks (negative = older). Clamps the upper bound at 0 (no
// future), re-renders immediately for snappy feedback, then lazy-fetches older days if we
// paged past the window (a second repaint lands the merged data when it arrives).
function stepWeek(delta) {
  const next = Math.min(0, weekOffset + delta);
  if (next === weekOffset) return;
  weekOffset = next;
  const now = anchoredNow();
  renderGrid(now);
  if (oldestDaysBackFor(weekOffset) >= _fetchedDaysBack) {
    ensureDaysForOffset(weekOffset, now).then(() => {
      if (activeTab === 'grid') renderGrid(anchoredNow());
    });
  }
}

function wireWeekNav() {
  if (elWkOlder) elWkOlder.addEventListener('click', () => stepWeek(-1)); // ‹ older
  if (elWkNewer) elWkNewer.addEventListener('click', () => stepWeek(1));  // › newer
  if (elWkToday) elWkToday.addEventListener('click', () => {              // pill -> now
    if (weekOffset === 0) return;
    weekOffset = 0;
    renderGrid(anchoredNow());
  });
  syncWeekNav();
}

// =============================================================================
// RENDER: MONTH (v5 #4) — a per-person calendar. A chip row picks WHOSE month shows; ‹ ›
//   step the visible month. Each day cell REUSES the real .gcell + classifyDay so it shows
//   the exact same diagonal workout/nutrition split as the SOCIAL board (no new status
//   logic). The visible month is anchored on the VIEWER's current business-date (so nav is
//   stable regardless of subject), but every cell is classified against the SUBJECT's own
//   tz/rollover via subjectOf(member) — never the viewer's. Leading/trailing adjacent-month
//   pad cells are inert (dim number, no status, no tap). Tapping a real day reuses the day
//   popover. The viewer's recent months are already cached in daysByUser; an OTHER member's
//   (or an older) month outside the cached window is fetched on demand, guarded by a
//   uid|monthAnchor dirty-check so a re-render never refetches.
// =============================================================================
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
// Monday-start weekday header (matches GRID_DAYS' Mon..Sun framing + businessWeekKey math).
const MONTH_DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// The visible month's {y, m} (m is 1-based): the viewer's current-business-date month walked
// back `monthOffset` calendar months (monthOffset <= 0). Pure y/m arithmetic, no instant.
function monthAnchorParts(now) {
  const cur = viewerBusinessDate(now); // 'YYYY-MM-DD' in the viewer's own clock
  let y = +cur.slice(0, 4);
  let m = +cur.slice(5, 7) + monthOffset; // monthOffset is <= 0
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  return { y, m };
}

// The whole-month days-back of the 1st of {y,m} from the viewer's today — how deep we'd have
// to have fetched for this month's earliest day to be inside the cached window.
function monthFirstDaysBack(now, y, m) {
  const first = `${pad4(y)}-${pad2u(m)}-01`;
  let k = viewerBusinessDate(now);
  let back = 0;
  // walk back until we pass the 1st (cap the loop at a sane ceiling so a bad anchor can't spin).
  while (k > first && back < 4000) { k = prevBusinessDate(k); back++; }
  return back;
}

// tiny zero-pads (logic.js keeps its pad2 private; we need our own for key assembly here).
function pad2u(n) { return n < 10 ? '0' + n : '' + n; }
function pad4(n) { return ('000' + n).slice(-4); }

// Reset monthOffset toward 0 (never positive) + reflect the › disabled state. Cheap + safe
// to call on every month paint.
function syncMonthNav() {
  if (monthOffset > 0) monthOffset = 0;
  if (elMonthNext) {
    const atNow = monthOffset >= 0;
    elMonthNext.disabled = atNow;
    elMonthNext.setAttribute('aria-disabled', atNow ? 'true' : 'false');
  }
  if (elMonthPrev) {
    elMonthPrev.disabled = false; // no hard floor — older months fetch on demand
    elMonthPrev.setAttribute('aria-disabled', 'false');
  }
}

// Fetch + MERGE an out-of-window month's /days for `uid` (skip weights — day cells only need
// workout + nutrition). Guarded by a uid|monthAnchor dirty-check so a re-render never refetches
// the same (subject, month). Returns true if a fetch actually fired (so the caller repaints).
async function ensureMonthDays(uid, y, m, now) {
  const back = monthFirstDaysBack(now, y, m);
  // inside the already-cached day-window (the 120d board window / week-nav's grown depth) =>
  // nothing to do; the viewer's recent months + everyone's ~4-month board window land here.
  if (back < _fetchedDaysBack) return false;
  const sig = `${uid}|${pad4(y)}-${pad2u(m)}`;
  if (sig === _monthFetchSig) return false; // already fetched (or fetching) this exact month
  _monthFetchSig = sig;
  const fromKey = `${pad4(y)}-${pad2u(m)}-01`;
  // last day of the month: step to the 1st of next month, then back one day.
  let nm = m + 1, ny = y;
  if (nm > 12) { nm = 1; ny += 1; }
  const toKey = prevBusinessDate(`${pad4(ny)}-${pad2u(nm)}-01`);
  try {
    const older = await data.fetchDays(uid, fromKey, toKey);
    const existing = daysByUser.get(uid) || {};
    daysByUser.set(uid, { ...existing, ...(older || {}) }); // merge, never replace
  } catch (e) {
    /* a miss just leaves those days as pending blanks; don't blank the rest of the cache */
  }
  return true;
}

// The chip row: one tappable emoji chip per member (me first), the selected subject ringed
// in --red. Rebuilt only when the member set or selection changes (a cheap signature), so
// repaints don't thrash the DOM.
function renderMonthChips() {
  if (!elMonthChips) return;
  const cols = orderedMembers();
  const sig = cols.map((m) => idOf(m) + ':' + emojiOf({ emoji: m.emoji, id: idOf(m) })).join('|') + '#' + (monthSubjectUid || '');
  if (elMonthChips.dataset.sig !== sig) {
    elMonthChips.innerHTML = cols.map((m) => {
      const uid = idOf(m);
      const emoji = emojiOf({ emoji: m.emoji, id: uid });
      const on = uid === monthSubjectUid;
      return (
        `<button class="month-chip${on ? ' on' : ''}" type="button" data-uid="${escapeHtml(uid)}" ` +
        `aria-pressed="${on ? 'true' : 'false'}" title="${escapeHtml(displayNameOf(m))}" ` +
        `aria-label="show ${escapeHtml(displayNameOf(m))}'s month">` +
        `<span class="month-chip-emoji" aria-hidden="true">${escapeHtml(emoji)}</span></button>`
      );
    }).join('');
    elMonthChips.dataset.sig = sig;
  }
}

function renderMonth(now) {
  if (!elMonthGrid) return;
  // default / guard the subject (myUserId isn't known at module load; a removed member falls
  // back to me) and keep nav state legal.
  if (!monthSubjectUid || !memberById(monthSubjectUid)) monthSubjectUid = myUserId;
  syncMonthNav();

  if (!members.length) {
    elMonthChips.innerHTML = '';
    elMonthChips.dataset.sig = '';
    elMonthGrid.innerHTML = '<div class="empty-note">No active members yet.</div>';
    if (elMonthLabel) elMonthLabel.textContent = '';
    return;
  }

  renderMonthChips();

  const member = memberById(monthSubjectUid) || memberById(myUserId);
  if (!member) return;
  const uid = idOf(member);
  const subject = subjectOf(member);
  const { y, m } = monthAnchorParts(now);
  if (elMonthLabel) elMonthLabel.textContent = `${MONTH_NAMES[m - 1]} ${y}`;

  // classify every cell against the SUBJECT's OWN current business-date (their calendar's
  // "today"), not the viewer's — the highlighted/relative-day logic is the subject's.
  const subjCur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);

  const firstKey = `${pad4(y)}-${pad2u(m)}-01`;
  const monthPrefix = `${pad4(y)}-${pad2u(m)}`;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate(); // day 0 of next month = last day
  // leading Monday-start offset for the 1st (Mon->0 .. Sun->6), same math as businessWeekKey.
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun..6=Sat
  const lead = (firstDow + 6) % 7;
  // total visible cells = leading pad + the month, rounded UP to whole Mon..Sun weeks so the
  // grid is a clean 7-col rectangle (5 or 6 rows). Walk back `lead` days to the first cell,
  // then step forward one civil day per cell (nextDayKey) — pad cells fall outside monthPrefix.
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  let k = firstKey;
  for (let i = 0; i < lead; i++) k = prevBusinessDate(k);

  const cells = [];
  // weekday header row (Mon..Sun).
  for (const d of MONTH_DOW) cells.push(`<div class="month-dow" aria-hidden="true">${d}</div>`);

  for (let i = 0; i < total; i++) {
    const inMonth = k.slice(0, 7) === monthPrefix;
    const dayNum = +k.slice(8, 10);
    if (!inMonth) {
      // adjacent-month pad cell: inert — dim number, no status, no tap.
      cells.push(`<div class="month-cell pad" aria-hidden="true"><span class="month-num">${dayNum}</span></div>`);
    } else {
      const day = effectiveDays(uid)[k];
      const { wStatus, nStatus } = classifyDay(subject, k, now, day);
      const prejoin = wStatus === 'prejoin';
      const isToday = k === subjCur;
      const aria = `${displayNameOf(member)} ${k} — workout ${CELL_LABEL[wStatus] || wStatus}, nutrition ${nStatus}`;
      // reuse the exact .gcell + w-/n- classes so the diagonal split + colors match the board.
      // No workout corner-tag in this density (too small to read; color carries the signal).
      cells.push(
        `<div class="gcell month-cell w-${wStatus} n-${nStatus}${prejoin ? ' prejoin' : ''}${isToday ? ' col-today' : ''}" ` +
          `data-uid="${escapeHtml(uid)}" data-date="${escapeHtml(k)}" ` +
          `role="button" tabindex="0" aria-label="${escapeHtml(aria)}">` +
          `<div class="seg-w"></div><div class="seg-n"></div>` +
          `<span class="month-num">${dayNum}</span></div>`
      );
    }
    k = nextDayKey(k);
  }
  elMonthGrid.innerHTML = cells.join('');

  // on-demand fetch (skip weights): if this subject's month is outside the cached window,
  // ensureMonthDays merges it in and resolves true; we then repaint once (still on this tab +
  // subject). The dirty-check inside makes it fire at most once per subject+month, so this
  // never loops. Within the window it resolves false (a pure no-op).
  ensureMonthDays(uid, y, m, now).then((fetched) => {
    if (fetched && activeTab === 'month' && monthSubjectUid === uid) renderMonth(anchoredNow());
  });
}

// Tap/keyboard-activate a real month day cell -> the shared read-only day popover (pad cells
// have no data-date and are skipped). Reuses openDayPopover verbatim.
function onMonthCellActivate(target) {
  const cell = target.closest && target.closest('.month-cell');
  if (!cell || cell.classList.contains('pad')) return;
  const uid = cell.dataset.uid;
  const dateKey = cell.dataset.date;
  if (!uid || !isDayKey(dateKey)) return;
  const member = memberById(uid);
  if (member) openDayPopover(member, dateKey, cell);
}

// Step the visible month by `delta` (negative = older). Clamps the upper bound at 0 (no
// future) and repaints; renderMonth's own on-demand fetch lands older data when needed.
function stepMonth(delta) {
  const next = Math.min(0, monthOffset + delta);
  if (next === monthOffset) return;
  monthOffset = next;
  renderMonth(anchoredNow());
}

function wireMonth() {
  if (elMonthPrev) elMonthPrev.addEventListener('click', () => stepMonth(-1)); // ‹ older
  if (elMonthNext) elMonthNext.addEventListener('click', () => stepMonth(1));  // › newer
  if (elMonthChips)
    elMonthChips.addEventListener('click', (e) => {
      const chip = e.target.closest('.month-chip');
      if (!chip) return;
      const uid = chip.dataset.uid;
      if (!uid || uid === monthSubjectUid) return;
      monthSubjectUid = uid; // switch whose month shows (keep the current monthOffset)
      _monthFetchSig = null;  // a new subject may need its own out-of-window fetch
      renderMonth(anchoredNow());
    });
  if (elMonthGrid) {
    elMonthGrid.addEventListener('click', (e) => onMonthCellActivate(e.target));
    elMonthGrid.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onMonthCellActivate(e.target);
      }
    });
  }
}

// =============================================================================
// RENDER: PLAYLIST (v5 #5) — the shared in-app song WALL. One live onSnapshot list (newest
//   first) the group builds together: paste a Spotify / YT-Music link OR type "Song - Artist"
//   and tap ADD. Each row deep-LINKS out — it never fetches metadata — with a small Spotify +
//   YT-Music button apiece (OPEN the pasted link if it's that service, else SEARCH the
//   title+artist) and a ✕ on EVERY row since anyone can remove (shared-jukebox). Add/remove are
//   optimistic (plOptimisticAdds / plOptimisticRemoves) and reconciled against the snapshot.
//   The footer searches the whole list on each service + opens the optional Admin-stored
//   collaborative-playlist link; a live "· N SONGS" count sits in the header. All user text is
//   escaped; every outbound link is rel="noopener".
// =============================================================================

// the per-source row tag + a11y word. 'text' = a typed "Song - Artist" (no link); 'url' = a
// pasted link we don't recognize as Spotify/YT (still openable verbatim).
const SONG_SOURCE_TAG = { spotify: 'SPOTIFY', ytmusic: 'YT MUSIC', url: 'LINK', text: 'TYPED' };

// A text search query for a song: only meaningful for a TYPED row (title is a real song name);
// a pasted-link row's title IS the raw URL, so it has no good text query (returns '').
function songSearchText(song) {
  if (!song || song.source !== 'text') return '';
  const t = typeof song.title === 'string' ? song.title.trim() : '';
  const a = typeof song.artist === 'string' ? song.artist.trim() : '';
  return [t, a].filter(Boolean).join(' ');
}

// Per-row Spotify deep-link plan for the SP button. OPEN the song's own url when it's a Spotify
// link; else SEARCH the title+artist when we have a text query; else null (no usable target). A
// generic ('url') pasted link with no text query opens verbatim. Returns { sp:{href,mode} } with
// mode in 'open'|'search'|null. (v5.1: Spotify-only — the YT Music button was removed.)
function songLinks(song) {
  const url = typeof song.url === 'string' && song.url.trim() ? song.url.trim() : '';
  const q = songSearchText(song);
  const sp = { href: '', mode: null };
  if (song.source === 'spotify' && url) { sp.href = url; sp.mode = 'open'; }
  else if (q) { sp.href = spotifySearchUrl(q); sp.mode = 'search'; }
  // a generic ('url') pasted link with no text query: open it verbatim (better than a dead button).
  if (song.source === 'url' && url && !sp.mode) { sp.href = url; sp.mode = 'open'; }
  return { sp };
}

// One escaped row. `pending` (an optimistic, not-yet-acked add) dims it slightly + disables ✕
// until the snapshot confirms it (the id then matches a real doc and pending clears).
//
// v5.1 RICH DISPLAY: a pasted link's stored `title` is the raw URL (parseSongInput can't know
// the song name without a network call), so we DON'T show the title for links — instead we
// render the real thing: a Spotify link -> an inline player embed (cover art + title + artist +
// play), a YouTube link -> a clickable cover-art tile that opens the video. Typed "Song - Artist"
// rows (and any non-embeddable link) keep the plain text row + the SP/YT deep-link buttons.
function songRowHtml(song, pending) {
  const uid = song.addedByUserId || '';
  const member = memberById(uid);
  const emoji = emojiOf({ emoji: member && member.emoji, id: uid });
  const who = member ? displayNameOf(member) : 'Someone';
  const idAttr = escapeHtml(song.id || '');
  const emojiSpan =
    `<span class="pl-row-emoji" title="${escapeHtml(who)}" aria-label="added by ${escapeHtml(who)}">${escapeHtml(emoji)}</span>`;
  const xBtn =
    `<button class="pl-row-x" type="button" ${pending ? 'disabled' : ''} ` +
    `data-id="${idAttr}" aria-label="remove ${escapeHtml(song.title || 'song')}">✕</button>`;

  // --- RICH: a pasted Spotify link -> inline player (self-renders art/title/artist/play) ---
  const spe = song.source === 'spotify' ? spotifyEmbed(song.url) : null;
  if (spe) {
    return (
      `<div class="pl-row pl-row-embed${pending ? ' pending' : ''}" role="listitem" data-id="${idAttr}">` +
        emojiSpan +
        `<div class="pl-embed">` +
          // NOTE: no loading="lazy" — native lazy-loading is flaky on iframes inserted via
          // innerHTML (the intersection observer often never fires, leaving a blank player),
          // so we load eagerly. Fine for a friend-group list; revisit with a manual
          // IntersectionObserver mount only if the wall ever grows to dozens of embeds.
          `<iframe src="${escapeHtml(spe.src)}" frameborder="0" ` +
            `allow="encrypted-media; clipboard-write; picture-in-picture" ` +
            `title="Spotify player for added song"></iframe>` +
        `</div>` +
        xBtn +
      `</div>`
    );
  }

  // --- PLAIN: typed "Song - Artist" or a non-embeddable link -> text + a Spotify button ---
  const title = escapeHtml(song.title || '');
  const artist = song.artist ? escapeHtml(song.artist) : '';
  const tag = SONG_SOURCE_TAG[song.source] || 'TYPED';
  const { sp } = songLinks(song);

  const svcBtn = (svc, plan, label) => {
    if (!plan.mode) {
      return `<span class="pl-svc pl-svc-${svc} off" aria-hidden="true">${label}</span>`;
    }
    const verb = plan.mode === 'open' ? 'open' : 'search';
    return (
      `<a class="pl-svc pl-svc-${svc}" href="${escapeHtml(plan.href)}" target="_blank" rel="noopener" ` +
      `aria-label="${verb} ${escapeHtml(song.title || 'this song')} on Spotify">${label}</a>`
    );
  };

  return (
    `<div class="pl-row${pending ? ' pending' : ''}" role="listitem" data-id="${idAttr}">` +
      emojiSpan +
      `<div class="pl-row-main">` +
        `<div class="pl-row-title">${title}</div>` +
        `<div class="pl-row-meta">` +
          (artist ? `<span class="pl-row-artist">${artist}</span>` : '') +
          `<span class="pl-row-src mono">${tag}</span>` +
        `</div>` +
      `</div>` +
      `<div class="pl-row-svcs">${svcBtn('sp', sp, 'SP')}</div>` +
      xBtn +
    `</div>`
  );
}

// v5.2: the playlist's current week (Monday key) + the half for "now", from the viewer's clock.
function currentPlaylistSlot() {
  const today = viewerBusinessDate(new Date());
  return { week: businessWeekKey(today), half: playlistHalf(today) };
}
// The slot being VIEWED: this week, the selected half (defaults to the current-by-day half until
// the user taps the other one). `nowHalf` = which half is the live one by today's date.
function viewedPlaylistSlot() {
  const { week, half } = currentPlaylistSlot();
  const h = plViewHalf || half;
  return { week, half: h, key: playlistSlotId(week, h), nowHalf: half };
}

// v5.2: the name the Worker gives the auto-created Spotify playlist for a slot — the half + its
// theme + the week, e.g. "gymboard MON–WED: Hype · Jun 22" (or without the theme until it's set).
const _PL_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function slotPlaylistName(slotKey) {
  const us = slotKey.indexOf('_');
  const weekKey = slotKey.slice(0, us);
  const label = playlistSlotLabel(slotKey.slice(us + 1)); // MON–WED / THU–SUN
  const theme = ((plSlots[slotKey] && plSlots[slotKey].theme) || '').trim();
  const p = weekKey.split('-');
  const wk = p.length === 3 ? `${_PL_MON[+p[1] - 1] || ''} ${+p[2]}` : weekKey;
  return `gymboard ${label}${theme ? ': ' + theme : ''} · ${wk}`;
}

// The render list for the VIEWED slot = its snapshot songs MINUS optimistic removes, PLUS its
// optimistic adds not yet in the snapshot. Both filtered to the viewed slot key (songs arrive
// newest-first from orderBy('createdAt','desc'), so order is preserved). Optimistic adds render
// at the TOP (newest).
function playlistRenderList() {
  const { key } = viewedPlaylistSlot();
  const inSlot = (s) => s.slot === key;
  const snapIds = new Set(songs.map((s) => s.id));
  const visibleSnap = songs.filter((s) => inSlot(s) && !plOptimisticRemoves.has(s.id));
  const pendingAdds = plOptimisticAdds.filter((s) => inSlot(s) && !snapIds.has(s.id));
  return { pendingAdds, visibleSnap };
}

function renderPlaylist() {
  if (!elPlList) return;
  const { pendingAdds, visibleSnap } = playlistRenderList();
  const total = pendingAdds.length + visibleSnap.length;

  // v5.2: half toggle (mark the viewed half active + tag which half is "now" by date) + the
  // editable theme line for the viewed slot.
  const { half, key, nowHalf } = viewedPlaylistSlot();
  if (elPlHalfA && elPlHalfB) {
    elPlHalfA.classList.toggle('active', half === 'a');
    elPlHalfB.classList.toggle('active', half === 'b');
    elPlHalfA.classList.toggle('now', nowHalf === 'a');
    elPlHalfB.classList.toggle('now', nowHalf === 'b');
    elPlHalfA.setAttribute('aria-selected', half === 'a' ? 'true' : 'false');
    elPlHalfB.setAttribute('aria-selected', half === 'b' ? 'true' : 'false');
  }
  if (elPlThemeName && !plThemeEditing) {
    const theme = plSlots[key] && typeof plSlots[key].theme === 'string' ? plSlots[key].theme.trim() : '';
    elPlThemeName.textContent = theme || 'name this week’s vibe';
    elPlThemeName.classList.toggle('unset', !theme);
  }

  // live "· N SONGS" count in the header (now scoped to the viewed themed slot).
  if (elPlCount) elPlCount.textContent = total ? ` · ${total} SONG${total === 1 ? '' : 'S'}` : '';

  if (!total) {
    elPlList.innerHTML = '<div class="empty-note">No songs in this playlist yet. Paste a Spotify link or type a song to start it.</div>';
  } else {
    const rows = [];
    for (const s of pendingAdds) rows.push(songRowHtml(s, true));
    for (const s of visibleSnap) rows.push(songRowHtml(s, false));
    elPlList.innerHTML = rows.join('');
  }

  // footer: whole-list search on each service is built from up to ~12 titles (a long query
  // helps neither engine); the shared-playlist link shows only when Admin-seeded.
  const wholeListQuery = visibleSnap
    .concat(pendingAdds)
    .map((s) => (s.source === 'text' ? [s.title, s.artist].filter(Boolean).join(' ') : ''))
    .filter(Boolean)
    .slice(0, 12)
    .join(' ');
  const spHref = wholeListQuery ? spotifySearchUrl(wholeListQuery) : 'https://open.spotify.com/search';
  if (elPlOpenSpotify) elPlOpenSpotify.dataset.href = spHref;
  if (elPlCollab) {
    if (plCollabUrl) {
      elPlCollab.href = plCollabUrl;
      elPlCollab.classList.remove('hidden');
    } else {
      elPlCollab.classList.add('hidden');
      elPlCollab.removeAttribute('href');
    }
  }
}

// snapshot handler: store + reconcile the optimistic overlays, then repaint if the tab is live.
function onSongs(songsArray) {
  songs = Array.isArray(songsArray) ? songsArray.slice() : [];
  const snapIds = new Set(songs.map((s) => s.id));
  // an optimistic ADD that now exists in the snapshot is no longer pending — drop it.
  plOptimisticAdds = plOptimisticAdds.filter((s) => !snapIds.has(s.id));
  // an optimistic REMOVE the server has honored (id gone from the snapshot) can be forgotten.
  for (const id of [...plOptimisticRemoves]) {
    if (!snapIds.has(id)) plOptimisticRemoves.delete(id);
  }
  if (activeTab === 'playlist') renderPlaylist();
}

// v5.2: /playlistSlots snapshot handler — store the theme/spotify map, repaint if live.
function onSlots(slotsMap) {
  plSlots = slotsMap && typeof slotsMap === 'object' ? slotsMap : {};
  if (activeTab === 'playlist') renderPlaylist();
}

// v5.2: theme editing — tap the name (or ✎) to swap in an inline input; Enter/blur saves,
// Esc cancels. The write is optimistic (reflect immediately, then persist via setPlaylistTheme).
function startThemeEdit() {
  if (!elPlThemeInput || !elPlThemeName) return;
  const { key } = viewedPlaylistSlot();
  plThemeEditing = true;
  elPlThemeInput.value = (plSlots[key] && plSlots[key].theme) || '';
  elPlThemeInput.classList.remove('hidden');
  elPlThemeName.classList.add('hidden');
  if (elPlThemeEdit) elPlThemeEdit.classList.add('hidden');
  elPlThemeInput.focus();
  elPlThemeInput.select();
}
function endThemeEdit() {
  plThemeEditing = false;
  if (elPlThemeInput) elPlThemeInput.classList.add('hidden');
  if (elPlThemeName) elPlThemeName.classList.remove('hidden');
  if (elPlThemeEdit) elPlThemeEdit.classList.remove('hidden');
}
async function commitThemeEdit() {
  if (!plThemeEditing) return; // already committed/cancelled (blur after Enter, etc.)
  const { key } = viewedPlaylistSlot();
  const val = (elPlThemeInput.value || '').trim().slice(0, 60);
  endThemeEdit();
  plSlots[key] = { ...(plSlots[key] || {}), theme: val }; // optimistic
  renderPlaylist();
  try {
    await data.setPlaylistTheme(key, val);
  } catch (err) {
    const code = String((err && (err.code || err.message)) || err);
    if (/reclaim/i.test(code)) plHint('Signed out elsewhere — tap to reclaim.', 'err');
    else plHint('Could not save the theme.', 'err');
  }
}

// A short red "already added" pulse on the add-bar hint (client-side dedupe feedback). Cleared
// on the next keystroke / successful add.
let _plPulseTimer = null;
function plHint(msg, kind) {
  if (!elPlAddHint) return;
  elPlAddHint.textContent = msg || '';
  elPlAddHint.classList.remove('dupe', 'err');
  if (kind) elPlAddHint.classList.add(kind);
  clearTimeout(_plPulseTimer);
  if (msg) {
    _plPulseTimer = setTimeout(() => {
      if (elPlAddHint) { elPlAddHint.textContent = ''; elPlAddHint.classList.remove('dupe', 'err'); }
    }, 2600);
  }
}

// Add the current input. parseSongInput → a {title,artist,url,source} payload; client-side
// dedupe via playlistDedupeKey against the CURRENT render list; optimistic insert + a real
// addSong() write reconciled by onSongs.
async function submitSong() {
  if (!elPlInput) return;
  const raw = elPlInput.value || '';
  const parsed = parseSongInput(raw);
  if (parsed.kind === 'empty') { plHint('Type a song or paste a link first.', 'err'); return; }

  // map parser kind -> stored source enum (the parser uses 'spotify'|'ytmusic'|'url'|'text').
  const source = ['spotify', 'ytmusic', 'url', 'text'].includes(parsed.kind) ? parsed.kind : 'text';
  // v5.2: the song lands in whichever themed half is on screen (both halves of THIS week are
  // addable — you can pre-load the upcoming one).
  const slot = viewedPlaylistSlot().key;
  const payload = {
    title: (parsed.title || '').trim(),
    artist: (parsed.artist || '').trim(),
    url: parsed.url || '',
    source,
    slot,
  };
  if (!payload.title) { plHint('Type a song or paste a link first.', 'err'); return; }

  // client-side dedupe (best-effort): same canonical key as an existing/visible row => pulse,
  // don't add. A same-second race can still slip a dup past this; harmless, anyone ✕'s one.
  const key = playlistDedupeKey(payload);
  if (key) {
    const { pendingAdds, visibleSnap } = playlistRenderList();
    const dup = pendingAdds.concat(visibleSnap).some((s) => playlistDedupeKey(s) === key);
    if (dup) {
      plHint('Already added.', 'dupe');
      elPlInput.select();
      return;
    }
  }

  // addSong generates the doc id and returns it, so the optimistic row and the server row share
  // ONE id — onSongs reconciles by id (no temp-id swap, no flash, no duplicate) the moment the
  // server row lands in the snapshot. We write FIRST (Firestore's offline cache acks the local
  // write fast, even offline) so a hard reject surfaces before we paint a row that can't exist.
  // v5.2: the Worker context — the slot's existing real playlist id (if any) so the Worker adds
  // to it, plus the name to use if it has to create one. No-op unless the Worker is configured.
  const workerCtx = {
    playlistId: (plSlots[slot] && plSlots[slot].spotifyPlaylistId) || '',
    playlistName: slotPlaylistName(slot),
  };
  let songId;
  try {
    songId = await data.addSong(payload, workerCtx); // stamps addedBy* + createdAt; returns the id
  } catch (err) {
    const code = String((err && (err.code || err.message)) || err);
    if (/reclaim/i.test(code)) { plHint('Signed out elsewhere — tap to reclaim.', 'err'); return; }
    plHint('Could not add that song.', 'err');
    return;
  }
  // success: clear the box + show the row optimistically until the snapshot confirms it. Guard
  // the unshift on the id NOT already being in the snapshot — with offline persistence the
  // onSnapshot echo can beat this await, in which case the row is already live and a stale
  // pendingAdd would just leak (it's filtered out of rendering, but never garbage-collected
  // since its own onSongs already passed). The guard keeps plOptimisticAdds tidy.
  elPlInput.value = '';
  plHint('');
  if (!songs.some((s) => s.id === songId)) {
    plOptimisticAdds.unshift({
      id: songId,
      title: payload.title,
      artist: payload.artist,
      url: payload.url,
      source: payload.source,
      slot: payload.slot,
      addedByUserId: myUserId,
    });
  }
  renderPlaylist();
}

// Remove a song (anyone can). Optimistic hide, then the real delete; on failure, un-hide.
async function removeSongRow(songId) {
  if (!songId) return;
  plOptimisticRemoves.add(songId);
  renderPlaylist();
  try {
    await data.removeSong(songId);
  } catch (err) {
    plOptimisticRemoves.delete(songId); // un-hide on failure
    renderPlaylist();
    const code = String((err && (err.code || err.message)) || err);
    if (/reclaim/i.test(code)) plHint('Signed out elsewhere — tap to reclaim.', 'err');
    else plHint('Could not remove that song.', 'err');
  }
}

function wirePlaylist() {
  if (elPlAddBtn) elPlAddBtn.addEventListener('click', () => { submitSong(); });
  if (elPlInput) {
    elPlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitSong(); }
    });
    // clear a stale "already added" pulse as soon as they edit the box.
    elPlInput.addEventListener('input', () => {
      if (elPlAddHint && elPlAddHint.textContent) plHint('');
    });
  }
  // delegated remove (anyone-can-remove ✕ on every row).
  if (elPlList) {
    elPlList.addEventListener('click', (e) => {
      const x = e.target.closest('.pl-row-x');
      if (!x || x.disabled) return;
      removeSongRow(x.dataset.id);
    });
  }
  // footer open-buttons: open the whole-list search (href stashed on the dataset by render).
  const openStashed = (el) => {
    const href = el && el.dataset && el.dataset.href;
    if (href) window.open(href, '_blank', 'noopener');
  };
  if (elPlOpenSpotify) elPlOpenSpotify.addEventListener('click', () => openStashed(elPlOpenSpotify));
  // elPlCollab is a real <a href> (set in render) — no JS click needed.

  // v5.2: half toggle (Mon–Wed / Thu–Sun) — switch which themed playlist is on screen.
  if (elPlHalfA) elPlHalfA.addEventListener('click', () => { plViewHalf = 'a'; renderPlaylist(); });
  if (elPlHalfB) elPlHalfB.addEventListener('click', () => { plViewHalf = 'b'; renderPlaylist(); });
  // v5.2: inline theme edit (tap the name or ✎; Enter/blur saves, Esc cancels).
  if (elPlThemeName) elPlThemeName.addEventListener('click', startThemeEdit);
  if (elPlThemeEdit) elPlThemeEdit.addEventListener('click', startThemeEdit);
  if (elPlThemeInput) {
    elPlThemeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitThemeEdit(); }
      else if (e.key === 'Escape') { e.preventDefault(); endThemeEdit(); renderPlaylist(); }
    });
    elPlThemeInput.addEventListener('blur', () => { commitThemeEdit(); });
  }
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

  // ---- TODAY tracker ----
  if (elMeTodayDate) {
    const g = fmtDateGutter(cur);
    elMeTodayDate.textContent = ` · ${g.dow} ${g.md}`;
  }

  const kcal = day && Number.isFinite(day.kcal) ? day.kcal : 0;
  const protein = day && Number.isFinite(day.protein) ? day.protein : 0;
  const kcalGoal = Number.isFinite(me.kcalGoal) ? me.kcalGoal : null;
  const proteinGoal = Number.isFinite(me.proteinGoal) ? me.proteinGoal : null;
  const nutMode = nutritionModeOf(me); // v4 (#6)

  // calorie + protein figures and progress bars (NEVER red, even when over).
  renderTrackRow(elMeCalFig, elMeCalBar, kcal, kcalGoal, ''); // kcal unit blank
  renderTrackRow(elMeProFig, elMeProBar, protein, proteinGoal, 'g');

  // v4 (#6): the ME TODAY nutrition card ADAPTS to the person's mode so only what's
  // relevant shows. manual = just the mark-done toggle + meals (hide both tracks + the
  // indicator). protein = protein track only (hide calories). both = both tracks (v3.1).
  const showCal = nutMode === 'both';
  const showPro = nutMode === 'both' || nutMode === 'protein';
  const showTracks = showCal || showPro;
  if (elMeCalRow) elMeCalRow.style.display = showCal ? '' : 'none';
  if (elMeProRow) elMeProRow.style.display = showPro ? '' : 'none';
  if (elMeNutTracksSep) elMeNutTracksSep.style.display = showTracks ? '' : 'none';

  // nutrition status from nutritionStatus (today is never past => never 'none').
  const ns = nutritionStatus(day, {
    nutritionMode: nutMode, // v4 (#6)
    kcalGoal,
    proteinGoal,
    goal: me.goal || 'maintain',
    isPast: false, // this card is always today
  });
  if (elMeNutInd) {
    elMeNutInd.classList.remove('hit', 'pending', 'none');
    // manual mode has no auto-progress to show — hide the indicator entirely.
    if (nutMode === 'manual') {
      elMeNutInd.style.display = 'none';
    } else {
      elMeNutInd.style.display = '';
      if (ns === 'hit') {
        elMeNutInd.classList.add('hit');
        elMeNutInd.textContent = 'HIT ✓';
      } else {
        elMeNutInd.classList.add('pending');
        // a little nudge based on whether anything's logged yet (mode-relevant total).
        const logged = nutMode === 'protein' ? protein > 0 : kcal > 0;
        elMeNutInd.textContent = logged ? 'on track' : 'nothing logged yet';
      }
    }
  }
  // mode-relevant hint line at the top of the card.
  if (elMeNutHint) {
    elMeNutHint.textContent =
      nutMode === 'manual' ? 'Mark nutrition done when you\'ve eaten well.'
      : nutMode === 'protein' ? 'Log meals to auto-check on protein, or just mark it done.'
      : 'Log meals to auto-check, or just mark it done.';
  }

  // v3.1 "mark nutrition done" toggle — reflects the manual `ate` override OR an
  // auto-hit (so it reads as "done ✓" whenever nutrition is green for any reason).
  if (elMeNutDone) {
    const manualAte = !!(day && (day.ate === true || day.macros === true));
    const isHit = ns === 'hit';
    elMeNutDone.classList.toggle('on', isHit);
    elMeNutDone.textContent = isHit ? 'done ✓' : 'mark done';
    // remember just the manual flag so a tap toggles the override (not the auto-hit).
    elMeNutDone.dataset.ate = manualAte ? '1' : '';
  }

  // quick-meal preset chips (tap to log instantly).
  renderQuickMeals(me);

  // meals-today list (newest-first chips with tap-to-remove).
  renderMealsList(day);

  // workout mark-done + ENABLED-type picker (only the user's chosen types show).
  const done = !!(day && day.workout === true);
  if (elMeWorkout) {
    elMeWorkout.classList.toggle('on', done);
    elMeWorkout.textContent = done ? 'done ✓' : 'mark done';
  }
  renderTypePicker(elMeWType, day && day.workoutType, enabledTypesOf(me));

  // rest-day toggle.
  if (elMeRestday) {
    const off = !!(day && day.off === true);
    elMeRestday.classList.toggle('on', off);
    elMeRestday.textContent = off ? 'Today is a rest day ✓' : 'Make today a rest day';
  }

  // weight quick-log input (don't stomp a field being edited).
  if (elMeWeight && document.activeElement !== elMeWeight) {
    const w = (weightsByUser.get(myUserId) || {})[cur];
    elMeWeight.value = Number.isFinite(w) ? String(w) : '';
  }

  // v4.5: "already logged today" indicator — today's weight + ~how long ago (best-effort
  // from lastActiveAt; the per-weigh-in timestamp isn't loaded into the chart map).
  if (elMeWeightLogged) {
    const todayW = (weightsByUser.get(myUserId) || {})[cur];
    if (Number.isFinite(todayW)) {
      const la = me && me.lastActiveAt;
      const laMs = la && typeof la.toMillis === 'function' ? la.toMillis() : null;
      const rt = relativeTime(laMs, now);
      elMeWeightLogged.textContent =
        `✓ Logged today: ${todayW} lb` + (rt.text && rt.text !== 'now' ? ` · ${rt.text} ago` : '');
      elMeWeightLogged.classList.remove('hidden');
    } else {
      elMeWeightLogged.classList.add('hidden');
    }
  }

  // ======== SETTINGS zone (collapsible; rendered regardless of collapse state) ========

  // ---- REST DAYS card ----
  renderRestDays(me);

  // ---- GOAL card ----
  renderGoal(me);
  if (elMeKcalGoal && document.activeElement !== elMeKcalGoal) {
    elMeKcalGoal.value = Number.isFinite(me.kcalGoal) ? String(me.kcalGoal) : '';
  }
  if (elMeProteinGoal && document.activeElement !== elMeProteinGoal) {
    elMeProteinGoal.value = Number.isFinite(me.proteinGoal) ? String(me.proteinGoal) : '';
  }

  // ---- NUTRITION MODE chooser (v4 #6) ----
  renderNutMode(me);

  // ---- QUICK MEALS manager ----
  renderQuickMealManager(me);

  // ---- WORKOUT TYPES chooser ----
  renderTypeChooser(me);

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
  // ---- EMOJI picker (v4 #14) ----
  renderEmojiPicker(me);
}

// Render one CALORIES/PROTEIN row: the "total / goal" figure + a progress-bar fill.
// Bar fill is green when at/over a constructive amount, neutral otherwise; NEVER red
// (over-target just shows a full bar in a muted tone). Goals unset => just the total.
function renderTrackRow(figEl, barEl, total, goal, unit) {
  if (figEl) {
    if (Number.isFinite(goal)) {
      figEl.textContent = `${Math.round(total)}${unit} / ${Math.round(goal)}${unit}`;
    } else {
      figEl.textContent = `${Math.round(total)}${unit}`;
    }
  }
  if (barEl) {
    if (Number.isFinite(goal) && goal > 0) {
      const pct = Math.max(0, Math.min(100, (total / goal) * 100));
      barEl.style.width = `${pct}%`;
      barEl.classList.toggle('full', total >= goal);
    } else {
      // no goal: a thin neutral hint proportional to "something logged" (capped).
      barEl.style.width = total > 0 ? '12%' : '0%';
      barEl.classList.remove('full');
    }
  }
}

// v4 (#8): TODAY'S MEALS — an unambiguous, clearly-headed VERTICAL list. Each row reads
// "Meal N — NNN kcal / NNg" (or the preset's label if the meal was logged from one), with
// a remove control. A pre-array manual total still surfaces below as a migration note.
// Rows are newest-first but keep the ORIGINAL array index for removal.
function renderMealsList(day) {
  if (!elMeMeals) return;
  const meals = day && Array.isArray(day.meals) ? day.meals : [];
  const totalKcal = day && Number.isFinite(day.kcal) ? day.kcal : 0;

  if (!meals.length) {
    // no array yet: still surface a pre-array manual total if one exists (e.g. a v2 day).
    if (totalKcal > 0) {
      elMeMeals.innerHTML =
        `<div class="me-meals-head">TODAY'S MEALS</div>` +
        `<span class="me-meal-note">${Math.round(totalKcal)} kcal logged earlier</span>`;
    } else {
      elMeMeals.innerHTML = '';
    }
    return;
  }

  let mealsKcal = 0;
  for (const m of meals) if (m && Number.isFinite(m.kcal)) mealsKcal += m.kcal;

  const rows = [];
  for (let i = meals.length - 1; i >= 0; i--) {
    const m = meals[i] || {};
    const k = Number.isFinite(m.kcal) ? Math.round(m.kcal) : 0;
    const p = Number.isFinite(m.protein) ? Math.round(m.protein) : 0;
    // prefer a preset label written onto the element (v4 addMeal carries it); else "Meal N".
    const name = (typeof m.label === 'string' && m.label.trim()) ? m.label.trim() : `Meal ${i + 1}`;
    // v4 (#7): a meal logged from a quick-meal preset can carry a note — show it small
    // under the name (nutrition is NEVER red, so this stays in the muted text tones).
    const note = (typeof m.note === 'string' && m.note.trim()) ? m.note.trim() : '';
    const nameCell = note
      ? `<span class="me-meal-name has-note"><span class="me-meal-nametext">${escapeHtml(name)}</span>` +
          `<span class="me-meal-rownote">${escapeHtml(note)}</span></span>`
      : `<span class="me-meal-name">${escapeHtml(name)}</span>`;
    rows.push(
      `<div class="me-meal-row${note ? ' has-note' : ''}">` +
        nameCell +
        `<span class="me-meal-fig">${k} kcal / ${p}g</span>` +
        `<button class="me-meal-x" type="button" data-idx="${i}" aria-label="remove ${escapeHtml(name)}, ${k} kcal ${p} grams protein">⌫</button>` +
      `</div>`
    );
  }

  let html = `<div class="me-meals-head">TODAY'S MEALS</div>` + rows.join('');
  if (Math.round(mealsKcal) !== Math.round(totalKcal)) {
    const earlier = Math.round(totalKcal - mealsKcal);
    if (earlier > 0) html += `<span class="me-meal-note">+${earlier} kcal logged earlier</span>`;
  }
  elMeMeals.innerHTML = html;
}

// Render a workout-type picker into `container`, marking `selected` active. v3.1: an
// optional `enabledKeys` subset limits which of the 7 canonical types render (defaults to
// all). The set of rendered keys is cached on the container so we rebuild only when it
// actually changes (a settings edit), not on every paint.
function renderTypePicker(container, selected, enabledKeys) {
  if (!container) return;
  const keys = Array.isArray(enabledKeys) && enabledKeys.length ? enabledKeys : WTYPE_KEYS;
  // keep canonical order regardless of the order stored in enabledWorkoutTypes.
  const ordered = WTYPE_KEYS.filter((k) => keys.includes(k));
  const sig = ordered.join(',');
  if (container.dataset.sig !== sig) {
    container.innerHTML = ordered
      .map((k) => `<button class="me-type-btn" type="button" data-wtype="${k}">${WTYPE_LABEL[k]}</button>`)
      .join('');
    container.dataset.sig = sig;
  }
  for (const btn of container.querySelectorAll('.me-type-btn')) {
    btn.classList.toggle('on', btn.dataset.wtype === selected);
  }
}

// v3.1: TODAY quick-meal preset chips — tap one to log it via data.addMeal.
function renderQuickMeals(member) {
  if (!elMeQuickMeals) return;
  const presets = savedMealsOf(member);
  if (!presets.length) {
    elMeQuickMeals.innerHTML = '';
    return;
  }
  const chips = presets.map((m, i) => {
    const k = Math.round(m.kcal);
    const p = Number.isFinite(m.protein) ? Math.round(m.protein) : 0;
    const custom = (typeof m.label === 'string' && m.label.trim()) ? m.label.trim() : '';
    const note = (typeof m.note === 'string' && m.note.trim()) ? m.note.trim() : '';
    const fig = `${k} / ${p}g`;
    const inner = custom
      ? `<span class="qm-label">${escapeHtml(custom)}</span><span class="qm-fig">${fig}</span>`
      : `<span class="qm-fig solo">${escapeHtml(fig)}</span>`;
    // v4 (#7): the note rides on the title + aria-label (chip face stays compact).
    const titleAttr = note ? ` title="${escapeHtml(note)}"` : '';
    const ariaNote = note ? ` ${escapeHtml(note)}` : '';
    return (
      `<button class="me-qm-chip" type="button" data-qm="${i}"${titleAttr} ` +
      `aria-label="log ${escapeHtml(custom || (k + ' kcal'))} ${k} kcal ${p} grams protein${ariaNote}">` +
      `${inner}</button>`
    );
  });
  elMeQuickMeals.innerHTML = chips.join('');
}

// v3.1: SETTINGS quick-meal manager — list saved presets with a remove button each.
function renderQuickMealManager(member) {
  if (!elMeQmManage) return;
  const presets = savedMealsOf(member);
  if (!presets.length) {
    elMeQmManage.innerHTML = '';
    syncQmEditUI();
    return;
  }
  const rows = presets.map((m, i) => {
    const k = Math.round(m.kcal);
    const p = Number.isFinite(m.protein) ? Math.round(m.protein) : 0;
    const label = (typeof m.label === 'string' && m.label.trim()) ? m.label.trim() : `${k} kcal`;
    const note = (typeof m.note === 'string' && m.note.trim()) ? m.note.trim() : '';
    // v4 (#7): a note shows as a dim second line (the row wraps via .has-note).
    const noteHtml = note ? `<span class="qm-row-note">${escapeHtml(note)}</span>` : '';
    return (
      `<div class="me-qm-row${qmEditIdx === i ? ' editing' : ''}${note ? ' has-note' : ''}">` +
      `<span class="qm-row-label">${escapeHtml(label)}</span>` +
      `<span class="qm-row-fig">${k} / ${p}g</span>` +
      `<button class="qm-row-edit" type="button" data-qm-edit="${i}" aria-label="edit ${escapeHtml(label)}">edit</button>` +
      `<button class="qm-row-x" type="button" data-qm-rm="${i}" aria-label="remove ${escapeHtml(label)}">✕</button>` +
      noteHtml +
      `</div>`
    );
  });
  elMeQmManage.innerHTML = rows.join('');
  syncQmEditUI();
}

// v3.1: SETTINGS workout-type chooser — all 7 canonical types, the enabled ones marked
// active. Tapping toggles a pending selection on the container's dataset; "save types"
// persists it. Built once (the full 7 never change).
function renderTypeChooser(member) {
  if (!elMeTypeChooser) return;
  if (!elMeTypeChooser.dataset.built) {
    elMeTypeChooser.innerHTML = WORKOUT_TYPES.map(
      (t) => `<button class="me-type-btn" type="button" data-wtype="${t.key}">${t.label}</button>`
    ).join('');
    elMeTypeChooser.dataset.built = '1';
  }
  // don't stomp an in-progress selection the user is editing (only reset from the doc
  // when the chooser hasn't been touched since the last save).
  if (!elMeTypeChooser.dataset.dirty) {
    elMeTypeChooser.dataset.pending = enabledTypesOf(member).join(',');
  }
  const pending = new Set((elMeTypeChooser.dataset.pending || '').split(',').filter(Boolean));
  for (const btn of elMeTypeChooser.querySelectorAll('.me-type-btn')) {
    btn.classList.toggle('on', pending.has(btn.dataset.wtype));
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

// v4 (#6): the NUTRITION MODE 3-segment chooser (manual / protein / both) + one-line hint.
function renderNutMode(member) {
  if (!elMeNutMode) return;
  const mode = nutritionModeOf(member);
  if (!elMeNutMode.dataset.built) {
    elMeNutMode.innerHTML = NUTRITION_MODES.map(
      (m) => `<button class="me-seg-btn" type="button" data-nutmode="${m.key}">${m.label}</button>`
    ).join('');
    elMeNutMode.dataset.built = '1';
  }
  for (const btn of elMeNutMode.querySelectorAll('.me-seg-btn')) {
    btn.classList.toggle('on', btn.dataset.nutmode === mode);
  }
  if (elMeNutModeHint) elMeNutModeHint.textContent = NUTMODE_HINT[mode] || '';
}

// v4 (#14): the personal-emoji picker — the curated set as tap targets, current marked.
function renderEmojiPicker(member) {
  if (!elMeEmoji) return;
  if (!elMeEmoji.dataset.built) {
    elMeEmoji.innerHTML = EMOJI_SET.map(
      (e) => `<button class="me-emoji-btn" type="button" data-emoji="${escapeHtml(e)}" aria-label="set symbol ${escapeHtml(e)}">${escapeHtml(e)}</button>`
    ).join('');
    elMeEmoji.dataset.built = '1';
  }
  // the member's CURRENT symbol (chosen, or the deterministic id fallback) is marked.
  const current = emojiOf({ emoji: member.emoji, id: idOf(member) });
  for (const btn of elMeEmoji.querySelectorAll('.me-emoji-btn')) {
    btn.classList.toggle('on', btn.dataset.emoji === current);
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
  // v3.1 (#7): rest-day and worked-out are mutually exclusive. If today is a rest day and
  // the user tries to MARK a workout done, block with an error popup and do NOT write.
  // (Un-marking a workout is always allowed — it can't create the both-true conflict.)
  if (!isDone && !!(days[cur] && days[cur].off === true)) {
    showError('You marked today as a rest day. Clear the rest day first to log a workout.');
    return;
  }
  // route through the optimistic+outbox path for parity.
  await commitWorkout(cur, !isDone);
  renderMe(now);
}

// v3.1 "mark nutrition done" toggle — sets the manual `ate` override (greens nutrition
// regardless of numbers). Tapping again clears the manual flag. This is the simple path
// alongside meal logging.
async function meToggleNutritionDone() {
  const cur = myCurrentBiz();
  if (!cur) return;
  const wasManual = elMeNutDone && elMeNutDone.dataset.ate === '1';
  try {
    await data.setNutritionHit(cur, !wasManual);
    await refetchMyDays();
    toast(!wasManual ? 'nutrition marked done' : 'nutrition cleared');
  } catch (err) {
    handleWriteError(err);
  }
  renderMe(anchoredNow());
}

// Today's business-date for the ME card (the owner's own clock).
function myCurrentBiz() {
  const now = anchoredNow();
  const me = memberById(myUserId);
  if (!me) return null;
  const s = subjectOf(me);
  return currentBusinessDate(now, s.ianaTz, s.rolloverHour, s.rolloverMinute);
}

// Add a meal: kcal (required) + protein (optional) -> data.addMeal, clear, repaint.
async function meAddMeal() {
  const me = memberById(myUserId);
  if (!me) return;
  const cur = myCurrentBiz();
  if (!cur) return;
  const kcal = readNumInput(elMeAddKcal);
  const protein = readNumInput(elMeAddProtein);
  if (kcal == null && protein == null) {
    toast('enter a meal');
    return;
  }
  if (kcal == null || !(kcal > 0)) {
    toast('enter the calories');
    return;
  }
  if (elMeAddMeal) elMeAddMeal.disabled = true;
  try {
    await data.addMeal(cur, { kcal, protein: protein != null ? protein : 0 });
    if (elMeAddKcal) elMeAddKcal.value = '';
    if (elMeAddProtein) elMeAddProtein.value = '';
    await refetchMyDays();
    toast('meal logged');
  } catch (err) {
    handleWriteError(err);
  } finally {
    if (elMeAddMeal) elMeAddMeal.disabled = false;
    renderMe(anchoredNow());
  }
}

// Remove a meal by its array index -> data.removeMeal, refetch, repaint.
async function meRemoveMeal(idx) {
  const cur = myCurrentBiz();
  if (!cur) return;
  try {
    await data.removeMeal(cur, idx);
    await refetchMyDays();
    toast('meal removed');
  } catch (err) {
    handleWriteError(err);
  }
  renderMe(anchoredNow());
}

// Tap a workout type: mark done AND set the type in one optimistic write.
// v3.1 (#7): blocked if today is a rest day (setting a type implies a workout).
async function meSetType(wtype) {
  const cur = myCurrentBiz();
  if (!cur) return;
  const days = effectiveDays(myUserId);
  if (!!(days[cur] && days[cur].off === true)) {
    showError('You marked today as a rest day. Clear the rest day first to log a workout.');
    return;
  }
  await commitWorkout(cur, true, { workoutType: wtype });
  renderMe(anchoredNow());
}

// Tap a quick-meal preset -> log it via data.addMeal (reuses the meal-add path).
async function meLogQuickMeal(presetIdx) {
  const me = memberById(myUserId);
  if (!me) return;
  const cur = myCurrentBiz();
  if (!cur) return;
  const presets = savedMealsOf(me);
  const m = presets[presetIdx];
  if (!m) return;
  try {
    // v4 (#8): carry the preset's label onto the meal element so TODAY'S MEALS names it.
    const mealArg = { kcal: m.kcal, protein: Number.isFinite(m.protein) ? m.protein : 0 };
    if (typeof m.label === 'string' && m.label.trim()) mealArg.label = m.label.trim();
    // v4 (#7): also forward the preset's note so it rides through to the logged meal.
    if (m.note) mealArg.note = m.note;
    await data.addMeal(cur, mealArg);
    await refetchMyDays();
    toast('meal logged');
  } catch (err) {
    handleWriteError(err);
  }
  renderMe(anchoredNow());
}

// Toggle "make today a rest day" -> data.setDayOff (neutral; never green/red).
// v3.1 (#7): blocked if a workout is already logged today (mutual exclusion).
async function meToggleRestToday() {
  const cur = myCurrentBiz();
  if (!cur) return;
  const days = effectiveDays(myUserId);
  const isOff = !!(days[cur] && days[cur].off === true);
  if (!isOff && !!(days[cur] && days[cur].workout === true)) {
    showError('You already logged a workout today. Undo the workout first to mark a rest day.');
    return;
  }
  try {
    await data.setDayOff(cur, !isOff);
    await refetchMyDays();
    toast(!isOff ? "today won't go red" : 'rest day cleared');
  } catch (err) {
    handleWriteError(err);
  }
  renderMe(anchoredNow());
}

// Weight quick-log: lb input + LOG -> data.setWeight, refetch, repaint.
async function meLogWeight() {
  const cur = myCurrentBiz();
  if (!cur) return;
  const weight = readNumInput(elMeWeight);
  if (weight == null) {
    toast('enter a weight');
    return;
  }
  if (elMeLogWeight) elMeLogWeight.disabled = true;
  try {
    await data.setWeight(cur, weight);
    await refetchWeights(myUserId);
    toast('weight logged');
  } catch (err) {
    handleWriteError(err);
  } finally {
    if (elMeLogWeight) elMeLogWeight.disabled = false;
    renderMe(anchoredNow());
  }
}

// Save the calorie + protein goals (one combined write). SETTING, no lastActive bump.
async function meSaveGoals() {
  const me = memberById(myUserId);
  if (!me) return;
  const kcalGoal = readNumInput(elMeKcalGoal);
  const proteinGoal = readNumInput(elMeProteinGoal);
  if (kcalGoal == null && proteinGoal == null) {
    toast('enter a goal');
    return;
  }
  try {
    const goals = {};
    if (kcalGoal != null) goals.kcalGoal = kcalGoal;
    if (proteinGoal != null) goals.proteinGoal = proteinGoal;
    await data.setNutritionGoals(goals);
    if (kcalGoal != null) me.kcalGoal = Math.round(kcalGoal);
    if (proteinGoal != null) me.proteinGoal = Math.round(proteinGoal);
    renderGrid(anchoredNow()); // goals drive the nutrition auto-check on the board
    toast('goals saved');
  } catch (err) {
    handleWriteError(err);
  }
  renderMe(anchoredNow());
}

// v3.1: save a quick-meal preset. From the TODAY "+ save as quick meal" affordance it
// reads the just-entered kcal/protein in the add-meal form; called from SETTINGS it reads
// the manager's own kcal/protein/label inputs. `fromSettings` picks the input set.
async function meSaveQuickMeal(fromSettings) {
  const me = memberById(myUserId);
  if (!me) return;
  const kEl = fromSettings ? elMeQmKcal : elMeAddKcal;
  const pEl = fromSettings ? elMeQmProtein : elMeAddProtein;
  const kcal = readNumInput(kEl);
  const protein = readNumInput(pEl);
  if (kcal == null || !(kcal > 0)) {
    toast('enter the calories first');
    return;
  }
  const preset = { kcal, protein: protein != null ? protein : 0 };
  const nameEl = fromSettings ? elMeQmLabel : elMeQmName;
  if (nameEl) {
    const label = nameEl.value.trim();
    if (label) preset.label = label;
  }
  // v4 (#7): the optional note only exists in the SETTINGS registry form.
  if (fromSettings && elMeQmNote) {
    const note = elMeQmNote.value.trim();
    if (note) preset.note = note;
  }
  const current = savedMealsOf(me);
  const editing = fromSettings && qmEditIdx != null && qmEditIdx >= 0 && qmEditIdx < current.length;
  if (!editing && current.length >= 20) {
    toast('quick-meal limit reached (20)');
    return;
  }
  try {
    let next;
    if (editing) {
      next = current.slice();
      next[qmEditIdx] = preset;
      await data.setSavedMeals(next);
    } else {
      next = current.concat([preset]);
      await data.addSavedMeal(current, preset);
    }
    me.savedMeals = next; // reflect locally pre-snapshot
    if (fromSettings) {
      if (elMeQmKcal) elMeQmKcal.value = '';
      if (elMeQmProtein) elMeQmProtein.value = '';
      if (elMeQmLabel) elMeQmLabel.value = '';
      if (elMeQmNote) elMeQmNote.value = '';
      qmEditIdx = null;
    } else if (elMeQmName) {
      elMeQmName.value = '';
    }
    renderMe(anchoredNow());
    toast(editing ? 'quick meal updated' : 'quick meal saved');
  } catch (err) {
    handleWriteError(err);
  }
}

// v3.1: remove a saved quick-meal preset by index.
async function meRemoveQuickMeal(idx) {
  const me = memberById(myUserId);
  if (!me) return;
  const current = savedMealsOf(me);
  if (idx < 0 || idx >= current.length) return;
  try {
    await data.removeSavedMeal(current, idx);
    me.savedMeals = current.slice(0, idx).concat(current.slice(idx + 1));
    if (qmEditIdx != null) meCancelQmEdit(); // a remove invalidates any in-progress edit index
    renderMe(anchoredNow());
    toast('quick meal removed');
  } catch (err) {
    handleWriteError(err);
  }
}

// v3.1: reflect the SETTINGS quick-meal edit state on the SAVE/cancel controls.
function syncQmEditUI() {
  if (elMeQmAdd) elMeQmAdd.textContent = qmEditIdx != null ? 'UPDATE' : 'SAVE';
  if (elMeQmCancel) elMeQmCancel.classList.toggle('hidden', qmEditIdx == null);
}

// v3.1: load a saved preset into the SETTINGS manager form to edit it (name/kcal/protein).
function meEditQuickMeal(idx) {
  const me = memberById(myUserId);
  if (!me) return;
  const m = savedMealsOf(me)[idx];
  if (!m) return;
  qmEditIdx = idx;
  if (elMeQmKcal) elMeQmKcal.value = Number.isFinite(m.kcal) ? String(Math.round(m.kcal)) : '';
  if (elMeQmProtein) elMeQmProtein.value = Number.isFinite(m.protein) ? String(Math.round(m.protein)) : '';
  if (elMeQmLabel) elMeQmLabel.value = (typeof m.label === 'string') ? m.label : '';
  if (elMeQmNote) elMeQmNote.value = (typeof m.note === 'string') ? m.note : ''; // v4 (#7)
  renderQuickMealManager(me); // highlight the editing row + flip SAVE->UPDATE
  if (elMeQmKcal) elMeQmKcal.focus();
}

// v3.1: abandon an in-progress quick-meal edit (clear the form, drop the edit index).
function meCancelQmEdit() {
  qmEditIdx = null;
  if (elMeQmKcal) elMeQmKcal.value = '';
  if (elMeQmProtein) elMeQmProtein.value = '';
  if (elMeQmLabel) elMeQmLabel.value = '';
  if (elMeQmNote) elMeQmNote.value = ''; // v4 (#7)
  const me = memberById(myUserId);
  if (me) renderQuickMealManager(me);
  else syncQmEditUI();
}

// v3.1: toggle a type in the SETTINGS chooser's PENDING selection (persisted on save).
function meToggleTypeChoice(wtype) {
  if (!elMeTypeChooser || !WTYPE_KEYS.includes(wtype)) return;
  const cur = new Set((elMeTypeChooser.dataset.pending || '').split(',').filter(Boolean));
  if (cur.has(wtype)) cur.delete(wtype);
  else cur.add(wtype);
  // keep canonical order in the stored signature.
  elMeTypeChooser.dataset.pending = WTYPE_KEYS.filter((k) => cur.has(k)).join(',');
  elMeTypeChooser.dataset.dirty = '1';
  const me = memberById(myUserId);
  if (me) renderTypeChooser(me);
}

// v3.1: persist the enabled workout types from the chooser's pending selection.
async function meSaveTypes() {
  const me = memberById(myUserId);
  if (!me || !elMeTypeChooser) return;
  const pending = (elMeTypeChooser.dataset.pending || '').split(',').filter(Boolean);
  if (!pending.length) {
    toast('keep at least one type');
    return;
  }
  try {
    await data.setEnabledWorkoutTypes(pending);
    me.enabledWorkoutTypes = pending.slice();
    elMeTypeChooser.dataset.dirty = ''; // accept the doc value again on next paint
    renderMe(anchoredNow()); // the TODAY picker now reflects the new enabled set
    toast('workout types saved');
  } catch (err) {
    handleWriteError(err);
  }
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

// v4 (#6): set the nutrition mode (SETTING). Reflects locally + repaints the board (the
// mode changes the nutrition auto-check everywhere) and the ME card (tracks show/hide).
async function meSetNutMode(mode) {
  const me = memberById(myUserId);
  if (!me) return;
  try {
    await data.setNutritionMode(mode);
    me.nutritionMode = mode;
    renderMe(anchoredNow());
    renderGrid(anchoredNow());
    toast('nutrition mode saved');
  } catch (err) {
    handleWriteError(err);
    renderNutMode(me); // revert visual to truth
  }
}

// v4 (#14): set the personal emoji (SETTING). Reflects locally + repaints the board header.
async function meSetEmoji(emoji) {
  const me = memberById(myUserId);
  if (!me) return;
  try {
    await data.setEmoji(emoji);
    me.emoji = emoji;
    renderEmojiPicker(me);
    renderGrid(anchoredNow());
    toast('symbol saved');
  } catch (err) {
    handleWriteError(err);
    renderEmojiPicker(me);
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
  // ---- TODAY: NUTRITION ----
  if (elMeNutDone) elMeNutDone.addEventListener('click', meToggleNutritionDone);
  if (elMeAddMeal) elMeAddMeal.addEventListener('click', meAddMeal);
  if (elMeAddKcal)
    elMeAddKcal.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); meAddMeal(); }
    });
  if (elMeAddProtein)
    elMeAddProtein.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); meAddMeal(); }
    });
  if (elMeSaveQuickMeal) elMeSaveQuickMeal.addEventListener('click', () => meSaveQuickMeal(false));
  if (elMeQuickMeals)
    elMeQuickMeals.addEventListener('click', (e) => {
      const chip = e.target.closest('.me-qm-chip');
      if (chip) meLogQuickMeal(Number(chip.dataset.qm));
    });
  if (elMeMeals)
    elMeMeals.addEventListener('click', (e) => {
      const x = e.target.closest('.me-meal-x');
      if (x) meRemoveMeal(Number(x.dataset.idx));
    });
  // ---- TODAY: WORKOUT ----
  if (elMeWorkout) elMeWorkout.addEventListener('click', meToggleWorkout);
  if (elMeWType)
    elMeWType.addEventListener('click', (e) => {
      const btn = e.target.closest('.me-type-btn');
      if (btn) meSetType(btn.dataset.wtype);
    });
  if (elMeRestday) elMeRestday.addEventListener('click', meToggleRestToday);
  // ---- TODAY: WEIGHT ----
  if (elMeLogWeight) elMeLogWeight.addEventListener('click', meLogWeight);

  // ---- SETTINGS: collapse/expand ----
  if (elMeSettingsToggle) elMeSettingsToggle.addEventListener('click', toggleSettings);
  // ---- SETTINGS: REST DAYS ----
  if (elMeRestdays)
    elMeRestdays.addEventListener('click', (e) => {
      const btn = e.target.closest('.me-weekday');
      if (btn) meToggleRestDay(Number(btn.dataset.wd));
    });
  // ---- SETTINGS: GOAL ----
  if (elMeGoal)
    elMeGoal.addEventListener('click', (e) => {
      const btn = e.target.closest('.me-seg-btn');
      if (btn) meSetGoal(btn.dataset.goal);
    });
  if (elMeSaveGoals) elMeSaveGoals.addEventListener('click', meSaveGoals);
  // ---- SETTINGS: NUTRITION MODE (v4 #6) ----
  if (elMeNutMode)
    elMeNutMode.addEventListener('click', (e) => {
      const btn = e.target.closest('.me-seg-btn');
      if (btn) meSetNutMode(btn.dataset.nutmode);
    });
  // ---- SETTINGS: QUICK MEALS manager ----
  if (elMeQmAdd) elMeQmAdd.addEventListener('click', () => meSaveQuickMeal(true));
  if (elMeQmCancel) elMeQmCancel.addEventListener('click', meCancelQmEdit);
  if (elMeQmManage)
    elMeQmManage.addEventListener('click', (e) => {
      const ed = e.target.closest('.qm-row-edit');
      if (ed) { meEditQuickMeal(Number(ed.dataset.qmEdit)); return; }
      const x = e.target.closest('.qm-row-x');
      if (x) meRemoveQuickMeal(Number(x.dataset.qmRm));
    });
  // ---- SETTINGS: WORKOUT TYPES chooser ----
  if (elMeTypeChooser)
    elMeTypeChooser.addEventListener('click', (e) => {
      const btn = e.target.closest('.me-type-btn');
      if (btn) meToggleTypeChoice(btn.dataset.wtype);
    });
  if (elMeSaveTypes) elMeSaveTypes.addEventListener('click', meSaveTypes);
  // ---- SETTINGS: PROFILE ----
  if (elMeHideWeight) elMeHideWeight.addEventListener('click', meToggleHideWeight);
  if (elMeEmoji)
    elMeEmoji.addEventListener('click', (e) => {
      const btn = e.target.closest('.me-emoji-btn');
      if (btn) meSetEmoji(btn.dataset.emoji);
    });
  if (elMeSaveSettings) elMeSaveSettings.addEventListener('click', meSaveSettings);
}

// v3.1: SETTINGS collapse/expand. Collapsed by default (the `.collapsed` class is on the
// wrapper in the markup). Toggles the class + the aria-expanded state.
function toggleSettings() {
  if (!elMeSettings || !elMeSettingsToggle) return;
  const nowCollapsed = elMeSettings.classList.toggle('collapsed');
  elMeSettingsToggle.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
}

// =============================================================================
// DAY POPOVER (v4 #13) — tap ANY cell -> a small read-only popover anchored beside the
// cell (left/right via getBoundingClientRect, clamped inside the app column). Read-only;
// dismisses on outside tap AND a ~5s auto-timeout. Replaces the old bottom-sheet.
// =============================================================================
let daypopTimer = null; // the ~5s auto-dismiss timer
let daypopOutsideHandler = null; // the document outside-tap listener (removed on close)
let daypopOpen = false;
let daypopAnchor = null; // v4 (#4): {uid, date} the open popover is anchored to, so a
                         // repaint can RE-ANCHOR it to the rebuilt cell instead of closing.

function buildDayPopBody(member, dateKey) {
  const uid = idOf(member);
  const subject = subjectOf(member);
  const days = effectiveDays(uid);
  const day = days[dateKey] || {};
  const wt = (weightsByUser.get(uid) || {})[dateKey];

  const line = (k, v, cls) =>
    `<div class="dd-line${cls ? ' ' + cls : ''}"><span class="dd-k">${escapeHtml(k)}</span><span class="dd-v">${escapeHtml(v)}</span></div>`;

  const lines = [];
  // v4 (#1): off reads as "rest" (off and rest converge).
  const workoutVal = day.workout === true ? 'yes' : (day.off === true || isRestDay(subject.restPattern, subject.perDateOverrides, dateKey)) ? 'rest' : 'no';
  lines.push(line('Workout', workoutVal));
  if (day.workout === true && day.workoutType && WTYPE_LABEL[day.workoutType]) {
    lines.push(line('Type', WTYPE_LABEL[day.workoutType]));
  }
  // nutrition status for THIS day, mode-aware (read-only; never red).
  const now = anchoredNow();
  const cur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
  const ns = nutritionStatus(day, {
    nutritionMode: subject.nutritionMode,
    kcalGoal: subject.kcalGoal,
    proteinGoal: subject.proteinGoal,
    goal: subject.goal || 'maintain',
    isPast: dateKey < cur,
  });
  lines.push(line('Nutrition', ns === 'hit' ? 'hit' : '—'));
  if (Number.isFinite(day.kcal)) lines.push(line('Calories', `${day.kcal}`));
  if (Number.isFinite(day.protein)) lines.push(line('Protein', `${day.protein}g`));
  if (Number.isFinite(wt)) lines.push(line('Weight', `${wt} lb`)); // omit if hidden/absent

  // v4 (#5): nutrition compliance % footer (30d). null => "—".
  let nPct = null;
  try {
    const comp = computeCompliance(days, subject, now, { windowDays: COMPLIANCE_WINDOW_DAYS });
    nPct = comp && comp.nutrition ? comp.nutrition.percent : null;
  } catch (e) {
    nPct = null;
  }
  lines.push(line('Nutrition 30d', nPct == null ? '—' : `${nPct}%`, 'dd-foot'));

  return lines.join('');
}

// v4 (#4): after a grid rebuild, keep an open popover pinned to its (uid+date) cell. If
// that cell is still present, just RE-POSITION against the fresh node (the body content is
// left as-is — read-only — and the original auto-dismiss timer + outside-tap listener keep
// running, so nothing is duplicated or leaked). If the cell fell out of the window, close.
function reanchorDayPopover() {
  if (!daypopOpen || !daypopAnchor || !elDayPop || !elGrid) return;
  const sel = `.gcell[data-uid="${cssAttrEscape(daypopAnchor.uid)}"][data-date="${cssAttrEscape(daypopAnchor.date)}"]`;
  const cell = elGrid.querySelector(sel);
  if (cell) {
    positionDayPop(cell); // re-pin to the rebuilt node; don't touch the timer/listener
  } else {
    closeDayPopover(); // the anchored day is no longer on the grid
  }
}

// Escape a string for safe use inside a CSS attribute-selector "...". Prefer the native
// CSS.escape when available; the fallback backslash-escapes the quote + backslash, which
// is all our uid/date keys can contain that would break the selector.
function cssAttrEscape(s) {
  const str = String(s == null ? '' : s);
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(str);
  return str.replace(/["\\]/g, '\\$&');
}

function openDayPopover(member, dateKey, cellEl) {
  if (!elDayPop) return;
  const emoji = emojiOf({ emoji: member.emoji, id: idOf(member) });
  if (elDayPopTitle) elDayPopTitle.innerHTML =
    `<span aria-hidden="true">${escapeHtml(emoji)}</span><span>${escapeHtml(displayNameOf(member))}</span>`;
  if (elDayPopSub) {
    const g = fmtDateGutter(dateKey);
    elDayPopSub.textContent = `${g.dow} ${g.md}`;
  }
  if (elDayPopBody) elDayPopBody.innerHTML = buildDayPopBody(member, dateKey);

  // show first (so we can measure), then position beside the cell, clamped to #app.
  elDayPop.classList.remove('hidden');
  positionDayPop(cellEl);
  daypopOpen = true;
  daypopAnchor = { uid: idOf(member), date: dateKey }; // v4 (#4): remember what it points at

  // auto-dismiss after ~5s.
  clearTimeout(daypopTimer);
  daypopTimer = setTimeout(closeDayPopover, DAYPOP_AUTO_MS);

  // dismiss on the NEXT outside tap (defer attach so the opening click doesn't close it).
  removeDayPopOutside();
  daypopOutsideHandler = (e) => {
    if (elDayPop.contains(e.target)) return; // taps inside stay open
    closeDayPopover();
  };
  setTimeout(() => {
    if (daypopOpen) document.addEventListener('click', daypopOutsideHandler, true);
  }, 0);
}

// Place the popover to the RIGHT of the cell if it fits, else LEFT, else clamp; vertically
// align to the cell top, clamped within the app column. position:fixed (viewport coords).
function positionDayPop(cellEl) {
  if (!elDayPop || !cellEl || typeof cellEl.getBoundingClientRect !== 'function') return;
  const appEl = document.getElementById('app');
  const r = cellEl.getBoundingClientRect();
  const appR = appEl ? appEl.getBoundingClientRect() : { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
  const gap = 6;
  const popW = elDayPop.offsetWidth || 150;
  const popH = elDayPop.offsetHeight || 120;

  // horizontal: prefer right, else left, else clamp inside the app column.
  let left;
  if (r.right + gap + popW <= appR.right) {
    left = r.right + gap;
  } else if (r.left - gap - popW >= appR.left) {
    left = r.left - gap - popW;
  } else {
    left = Math.max(appR.left + 4, Math.min(r.left, appR.right - popW - 4));
  }
  // vertical: align to the cell top, clamp within the app column.
  let top = r.top;
  const maxTop = appR.bottom - popH - 4;
  const minTop = appR.top + 4;
  top = Math.max(minTop, Math.min(top, maxTop));

  // #app has transform:translateX(-50%) on wide viewports (>=500px), which makes it the
  // containing block for #daypop's position:fixed. getBoundingClientRect gives VIEWPORT
  // coords, so subtract the containing block's viewport origin to get correct local coords.
  // On phones #app has no transform, so this subtraction is a no-op (appR.left/top ~= 0).
  const isContained = appEl && getComputedStyle(appEl).transform !== 'none';
  const ox = isContained ? appR.left : 0;
  const oy = isContained ? appR.top : 0;

  elDayPop.style.left = `${Math.round(left - ox)}px`;
  elDayPop.style.top = `${Math.round(top - oy)}px`;
}

function removeDayPopOutside() {
  if (daypopOutsideHandler) {
    document.removeEventListener('click', daypopOutsideHandler, true);
    daypopOutsideHandler = null;
  }
}

function closeDayPopover() {
  if (elDayPop) elDayPop.classList.add('hidden');
  daypopOpen = false;
  daypopAnchor = null; // v4 (#4)
  clearTimeout(daypopTimer);
  daypopTimer = null;
  removeDayPopOutside();
}

// v4: the grid is READ-ONLY. Tapping ANY cell opens the read-only mini popover beside it.
function onGridCellActivate(target) {
  const cell = target.closest && target.closest('.gcell');
  if (!cell) return;
  const uid = cell.dataset.uid;
  const dateKey = cell.dataset.date;
  if (!uid || !isDayKey(dateKey)) return;
  const member = memberById(uid);
  if (member) openDayPopover(member, dateKey, cell);
}

function wireGridTaps() {
  elGrid.addEventListener('click', (e) => onGridCellActivate(e.target));
  elGrid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onGridCellActivate(e.target);
    }
  });
}

// v4.5: collapsible weight chart. Tapping the title bar collapses the body to just the
// header; the state is persisted. Re-fitting (the dynamic viewBox needs the real height)
// is forced on EXPAND because the chart wasn't laid out while collapsed.
function wireChartCollapse() {
  const btn = $('wchart-collapse');
  if (!btn || !elSocialChart) return;
  try { if (localStorage.getItem('gymboard.chartCollapsed') === '1') elSocialChart.classList.add('collapsed'); } catch (_) {}
  const sync = () => btn.setAttribute('aria-expanded', elSocialChart.classList.contains('collapsed') ? 'false' : 'true');
  sync();
  btn.addEventListener('click', () => {
    const collapsed = elSocialChart.classList.toggle('collapsed');
    try { localStorage.setItem('gymboard.chartCollapsed', collapsed ? '1' : '0'); } catch (_) {}
    sync();
    if (!collapsed) { _wchartSig = null; renderWeightChart(anchoredNow()); }
  });
}

// v4 (#3): the 30d/90d range toggle is a PURE re-render — the 90-day weights window is
// already fetched (WEIGHT_WINDOW_DAYS=90), so switching never refetches.
function wireWeightChart() {
  if (!elWchartToggle) return;
  elWchartToggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.wc-range');
    if (!btn) return;
    const r = Number(btn.dataset.range);
    if (r !== 30 && r !== 90) return;
    if (r === wchartRange) return;
    wchartRange = r;
    _wchartSig = null; // v4 (#1c): force a rebuild — the range changed, the dirty-check must not skip it
    renderWeightChart(anchoredNow());
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

// Selective refetch: only the named members' day / weight windows (used by the diffed
// snapshot path so one person's tap doesn't fan out into a read for everyone).
async function refetchDaysFor(uids, now) {
  const cur = viewerBusinessDate(now);
  const from = fromKeyFor(cur, 120);
  await Promise.all(uids.map(async (uid) => {
    try { daysByUser.set(uid, (await data.fetchDays(uid, from, cur)) || {}); }
    catch (e) { if (!daysByUser.has(uid)) daysByUser.set(uid, {}); }
  }));
}
async function refetchWeightsFor(uids, now) {
  const cur = viewerBusinessDate(now);
  const from = fromKeyFor(cur, WEIGHT_WINDOW_DAYS);
  await Promise.all(uids.map(async (uid) => {
    try { weightsByUser.set(uid, (await data.fetchWeights(uid, from, cur)) || {}); }
    catch (e) { if (!weightsByUser.has(uid)) weightsByUser.set(uid, {}); }
  }));
}

// A signature of the fields that, when they move, mean a member's day/weight window
// may have changed (so we should refetch THAT member — and only that member).
function memberSig(m) {
  const la = (m && m.lastActiveAt && typeof m.lastActiveAt.toMillis === 'function') ? m.lastActiveAt.toMillis() : 0;
  return {
    la,
    hw: !!(m && m.hideWeight === true),
    rollup: JSON.stringify((m && m.rollup) || {}),
    rp: JSON.stringify((m && m.restPattern) || []),
    joinDate: (m && m.profile && m.profile.joinDate) || '',
  };
}

// Drop an optimistic workout overlay once the authoritative snapshot agrees AND the
// write is no longer in flight — restoring snapshot authority + the missed->red path
// (without this the overlay pins a stale DONE on this device forever).
function reconcileOptimistic() {
  for (const [uid, ov] of optimistic) {
    for (const dk of Object.keys(ov)) {
      if (unsynced.has(uid + '|' + dk)) continue; // still pending
      const srv = (daysByUser.get(uid) || {})[dk];
      if (!!(srv && srv.workout === true) === !!ov[dk].workout) clearOptimistic(uid, dk);
    }
  }
}

// onSnapshot callback: a /users doc changed (someone joined/archived, or a log bumped
// rollup/lastActiveAt). We DIFF against the previous snapshot and refetch ONLY the
// members who materially changed: a moved lastActiveAt/rollup => that member logged
// (refetch their /days); a hideWeight flip or a weigh-in (la moves) => refetch their
// /weights. A user's OWN tap bumps only their own doc, so this collapses the old
// per-tap 2N-read fan-out (the renderer stall) down to ~2 reads for the one changed
// member, while still propagating everyone else's logs.
let snapshotSeq = 0;
let _prevSig = new Map();
function onMembers(usersArray) {
  members = Array.isArray(usersArray) ? usersArray.slice() : [];
  const mySeq = ++snapshotSeq;
  const now = anchoredNow();

  const curSig = new Map(members.map((m) => [idOf(m), memberSig(m)]));
  const daysUids = [];
  const weightUids = [];
  for (const [uid, s] of curSig) {
    const p = _prevSig.get(uid);
    if (!p) { daysUids.push(uid); weightUids.push(uid); continue; } // new member
    if (p.la !== s.la || p.rollup !== s.rollup || p.rp !== s.rp || p.joinDate !== s.joinDate) daysUids.push(uid);
    if (p.hw !== s.hw || p.la !== s.la) weightUids.push(uid);
  }
  _prevSig = curSig;

  if (daysUids.length || weightUids.length) {
    Promise.all([refetchDaysFor(daysUids, now), refetchWeightsFor(weightUids, now)]).then(() => {
      if (mySeq !== snapshotSeq) return; // a newer snapshot superseded this fetch
      reconcileOptimistic();
      repaint();
      scheduleNextRollover(); // member set can change my clock anchor; re-arm
    });
  } else {
    scheduleNextRollover();
  }
  // paint immediately from the rollup-bearing /users docs so the board isn't blank.
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
  let cfg, siteKey, debugToken, spotifyWorker;
  try {
    const conf = await import('./firebase-config.js');
    cfg = conf.firebaseConfig;
    siteKey = conf.recaptchaSiteKey;
    debugToken = conf.appCheckDebugToken;
    spotifyWorker = conf.spotifyWorker; // v5.1: optional { url, secret } for real Spotify sync
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
    await data.initApp(cfg, siteKey, { appCheckDebugToken: debugToken, spotifyWorker });
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

  // v4.5: the header "live" text + sync pip were removed (replaced by the theme
  // toggle). booted still gates the sync-pip class updates (harmless no-ops now).
  booted = true;

  // 4. live board: onSnapshot on /users where archived==false.
  try {
    data.subscribeUsers(onMembers); // sync return = the unsub handle (kept by data.teardown)
  } catch (err) {
    fatal('LIVE READ FAILED', 'Could not subscribe to the group. ' + escapeHtml(String((err && err.message) || err)));
    return;
  }

  // 4b. v5 (#5): live PLAYLIST wall (onSnapshot on /playlist, newest first). Non-fatal — a
  // playlist subscribe hiccup must not blank the board; the tab just stays empty. The unsub is
  // tracked inside data.subscribePlaylist (detached by data.teardown).
  try {
    data.subscribePlaylist(onSongs);
    data.subscribePlaylistSlots(onSlots); // v5.2: themed-slot names (+ spotify ids in phase 2)
  } catch (e) {
    /* non-fatal: the playlist tab degrades to empty */
  }
  // one-shot read of the optional Admin-seeded collaborative-playlist link (footer button).
  data.fetchPlaylistMeta().then((meta) => {
    plCollabUrl = (meta && meta.collabUrl) || null;
    if (activeTab === 'playlist') renderPlaylist();
  });

  // wire interactions + timers
  wireTabs();
  wireTheme();
  wireSwipe();
  wireMe();
  wireGridTaps();
  wireWeekNav();
  wireMonth(); // v5 (#4): MONTH tab — chip selector + month nav + day taps
  wirePlaylist(); // v5 (#5): PLAYLIST tab — add-bar, delegated remove, footer open-buttons
  wireWeightChart();
  wireChartCollapse();
  wireReclaim();
  wireError();
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
