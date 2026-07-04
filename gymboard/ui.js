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
  layoutChartEndLabels,
  abbrevName,
  nutritionStatus,
  nutritionProgress,
  nutritionGoalOpts,
  emojiOf,
  EMOJI_SET,
  isDayKey,
  memberInactiveByKeys,
  // v5 (#5): PLAYLIST — the pure song-input parser + cross-service deep-link builders.
  parseSongInput,
  playlistDedupeKey,
  spotifySearchUrl,
  playlistLinkUrl,
  // v5.1: rich-row display — a pasted Spotify link renders as an inline player.
  spotifyEmbed,
  // v5.2: two themed playlists per week (Mon–Wed 'a' / Thu–Sun 'b').
  businessWeekKey,
  playlistHalf,
  playlistSlotId,
  playlistSlotLabel,
  playlistNextResetDayKey,
  formatResetCountdown,
  // v7: sync-merge display + MXT naming + history + theme submission.
  mergeRows,
  historySlots,
  mxtPlaylistName,
  nextPeriodKey,
  normalizeTrackTitle,
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
// v9.2 (Soren 7/4): chart mode. 'rel' (default) = Robinhood re-based deltas (everyone starts
// at 0, y = +/- lbs change); 'abs' = absolute weight (y = real lbs, no re-basing).
let wchartMode = 'rel';
// v4 (#1): weight-chart perf. _wchartSig is the signature of the LAST real rebuild; a
// repaint whose signature matches it skips the (expensive) SVG rebuild + innerHTML parse.
// Set _wchartSig = null to FORCE the next rebuild (e.g. the 30d/90d toggle).
let _wchartSig = null;
let _wchartGeom = null; // last-built chart geometry, for the tap/drag scrubber
// v7.2: weight-chart interactions (scrubber + zoom/pan). _wzoom is the visible window when
// zoomed (fractional date-index bounds i0..i1 + weight bounds lo..hi); null = the default
// auto-fit full view, in which case buildWeightChart's output is byte-identical to before.
let _wzoom = null;
let _wscrubIdx = null;   // currently-scrubbed integer date index into keysOldestFirst; null = hidden
// v7.3: the last pointer CLIENT position driving the scrub. Stored (not just the viewBox y) so
// renderScrub can re-map it to the CURRENT geometry after a zoom/pan/range rebuild and re-pick the
// nearest line. null = no pointer yet.
let _wscrubClientX = null, _wscrubClientY = null;
let _wscrubWired = false;
let _wscrubOverlay = null, _wscrubBox = null, _wscrubResetBtn = null;
let _wscrubDots = [];

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
// v9.2 (Soren 7/4): PLAYLIST is PARKED — flag off so none of it loads (no tab, no pane,
// no /playlist + /playlistSlots subscriptions, no Worker fetches, no reset-badge timer).
// To bring it back: set true AND restore the #screen-playlist section + PLAYLIST tab
// button in index.html (removed same day; see git history at Pages ae0a8ff).
const PLAYLIST_ENABLED = false;
const SCREENS = PLAYLIST_ENABLED ? ['me', 'grid', 'month', 'playlist'] : ['me', 'grid', 'month'];
// v7 (#B): the ONE desktop-vs-mobile decision. matchMedia('(min-width:1024px) and
// (pointer:fine)') is true ONLY on a wide screen whose PRIMARY pointer is fine (a mouse /
// trackpad). A phone/tablet reports pointer:coarse, so it returns false even at 1300px
// landscape -> a touch device ALWAYS gets the mobile tabbed layout. Every desktop branch in
// the code below is gated on this, and every guard fails SAFE toward mobile (if the query
// can't be evaluated for any reason, .matches is false => mobile). One shared MQL object is
// reused so the change-listener and the live checks read the same source.
const DESKTOP_MQ = window.matchMedia('(min-width:1024px) and (pointer:fine)');
function isDesktop() { return DESKTOP_MQ.matches; }
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
// v7: REFRESH (re-sync from Spotify) + HISTORY (past playlists) + the theme line (repurposed: submit
// an idea for the NEXT period, with live-naming the CURRENT period as the zero-submission fallback).
const elPlRefresh = $('pl-refresh');
const elPlHistory = $('pl-history');
const elPlThemeName = $('pl-theme-name');
const elPlThemeEdit = $('pl-theme-edit');
const elPlThemeInput = $('pl-theme-input');
const elPlThemeIdeas = $('pl-theme-ideas'); // live count of ideas submitted for the next period
const elPlThemeBy = $('pl-theme-by'); // v7.5 #A: "submitted by X" attribution for the resolved theme
const elPlReset = $('pl-reset'); // countdown to the next half-week reset
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

// v5/v7 PLAYLIST tab state. `songs` is the latest /playlist snapshot — under v7 this is the
// ATTRIBUTION source (spotifyTrackId -> addedBy), not the display source. `plCollabUrl` is the
// Admin-seeded optional shared-playlist link (null = hide that footer button), fetched once on boot.
// `plOptimisticAdds` makes an add feel instant before it lands in the real playlist (reconciled by
// track id / title in pendingMatchesReal). No optimistic-REMOVE overlay anymore (#6 dropped remove).
let songs = [];
let plCollabUrl = null;
// v7: optimistic adds — rows we render immediately on add and keep UNTIL the same track appears in
// the real playlist (plRealTracks). Each: { id, title, artist, url, source, slot, addedByUserId,
// trackId, addedAt }. trackId is parsed from a pasted Spotify link right away, or stamped later from
// the Worker /add response for a typed song (P0 #2). Reconciled by track id (links) / normalized
// title (typed). No optimistic REMOVE set anymore (#6 dropped the remove path).
let plOptimisticAdds = [];
// v5.2: /playlistSlots snapshot (slotKey -> { theme?, mxtNumber?, spotifyPlaylistId?, spotifyUrl? }).
let plSlots = {};
let plThemeEditing = false; // true while the theme input is open (so render won't stomp it)
// v7 #1 SYNC-MERGE: the REAL Spotify playlist's tracks (Worker /list) are the DISPLAY source; the
// Firestore /playlist snapshot is demoted to attribution-only. plRealForSlot tags which slot the
// tracks belong to; plRealFetchedAt drives the 20s client cache guard (Spotify's rolling-30s window).
let plRealTracks = [];
let plRealFetchedAt = 0;
let plRealForSlot = '';
let _plRealSyncing = false; // re-entrancy guard so overlapping focus/visibility events don't double-fetch
// v7 #4 THEME SUBMISSION: live count of ideas submitted for the NEXT period, + the subscription.
let plNextIdeasCount = 0;
let _plNextIdeasPeriod = '';
let plNextIdeasUnsub = null;
// v7.5 #A: live submissions for the VIEWED period — used to attribute the resolved theme ("submitted
// by X"). resolveThemeForPeriod doesn't record WHICH submission it picked, so we match the live theme
// text back to its submission here.
let plViewedSubs = [];
let _plViewedSubsPeriod = '';
let plViewedSubsUnsub = null;
// periods we've already lazily resolved the theme for (resolveThemeForPeriod runs once per period).
const _plResolvedPeriods = new Set();
// v7.3: signature of the LAST playlist render. renderPlaylist no-ops when nothing it draws has
// changed, so the heartbeat / no-op /users snapshots (which fire ~every few seconds via repaint())
// stop needlessly rebuilding the pane. null = force the first render.
let _plRenderSig = null;

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
  { key: 'upper', label: 'Upper', tag: 'Upper' },
  { key: 'lower', label: 'Lower', tag: 'Lower' },
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
  // v9: evaluate each day against the goal that was IN EFFECT THEN, not the live one.
  // A day snapshots its own kcalGoal/proteinGoal/goalDir when it's logged, so changing
  // your goal later never rewrites past days' hit/dither. nutritionGoalOpts (logic.js)
  // is the ONE snapshot-else-live precedence rule, shared with the day popover and
  // computeCompliance so no two views of the same day can disagree.
  const goalOpts = nutritionGoalOpts(day, subject);

  const nStatus = nutritionStatus(day, { ...goalOpts, isPast: dateKey < cur });

  // v8: the fraction of the calorie (or protein) goal logged -> drives the
  // dithered partial-fill on the nutrition triangle. null when there's no
  // measurable goal (manual mode / goal unset) -> cell stays the flat binary.
  const nProgress = nutritionProgress(day, goalOpts);

  return { wStatus, nStatus, nProgress };
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
  // duration vs true-UTC serverTimestamp: use raw Date.now(), not the (possibly stale)
  // server-offset anchoredNow(); see weigh-in indicator note for the 6h-skew rationale.
  const rt = relativeTime(lastMs, Date.now());
  if (rt.text) {
    parts.push(`<span class="gh-active${rt.stale ? ' stale' : ''}">${escapeHtml(rt.text)}</span>`);
  }

  return `<div class="gh-stack">${parts.join('')}</div>`;
}

// v7.6 (Soren 6/28): a member is INACTIVE when their last activity OR, if they never logged,
// their join is >=3 civil days before `today` — gray out their whole board column + show an
// "(inactive)" tag. Joined-long-ago-never-logged members (Lars/Olivia) now show inactive too;
// a genuinely-new joiner (<3d, no logs) is still spared by the grace window. DST-safe: the
// pure tested memberInactiveByKeys (logic.js) does the day diff on civil dateKeys — no raw ms.
function memberInactive(m, today) {
  if (!m) return false;
  let laKey = null;
  const la = m.lastActiveAt;
  if (la && typeof la.toMillis === 'function') {
    let ms = null;
    try { ms = la.toMillis(); } catch (e) { ms = null; }
    if (ms != null) {
      const vs = subjectOf(memberById(myUserId)) || { ianaTz: DEFAULT_TZ, rolloverHour: DEFAULT_ROLLOVER_H, rolloverMinute: DEFAULT_ROLLOVER_M };
      laKey = businessDate(ms, vs.ianaTz, vs.rolloverHour, vs.rolloverMinute);
    }
  }
  const joinKey = m.profile && m.profile.joinDate;
  return memberInactiveByKeys(laKey, joinKey, today);
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
  // v7.3 (Soren 6/25): inactive members (no activity >=3d) sink to the FAR RIGHT of the board,
  // while ME stays leftmost and everyone else keeps their existing relative order. filter() is a
  // stable partition (preserves order within each group), so concatenating active+inactive is a
  // clean stable sort by inactivity. Only reorders the grid columns — chart order is untouched.
  const baseCols = orderedMembers();
  const cols = baseCols.filter((m) => !memberInactive(m, today)).concat(baseCols.filter((m) => memberInactive(m, today)));

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
    // v9.2 (Soren 7/4): emoji removed — the name IS the identity everywhere now.
    const inactive = memberInactive(m, today);
    cells.push(
      `<div class="ghead${isMe ? ' me' : ''}${inactive ? ' inactive' : ''}" title="${escapeHtml(displayNameOf(m))}">` +
        (inactive ? `<span class="ghead-inactive">inactive</span>` : '') +
        headStackHtml(m, now, today) +
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
      const { wStatus, nStatus, nProgress } = classifyDay(subject, dk, now, day);
      // v8: dithered partial-fill class for a not-yet-hit nutrition cell that has a
      // goal to measure against. Bayer density bucket 1..16 (mask tiles in styles.css);
      // bucket 0 (barely any intake) and 'hit' both stay unfilled here (hit = solid).
      let nfill = '';
      if (nStatus !== 'hit' && typeof nProgress === 'number') {
        const nb = Math.round(nProgress * 16);
        if (nb > 0) nfill = ` n-fill n-d${nb}`;
      }
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
        `<div class="gcell w-${wStatus} n-${nStatus}${nfill}${isMe ? ' me' : ''}${prejoin ? ' prejoin' : ''}${memberInactive(m, today) ? ' inactive' : ''}${daypopSelected && daypopSelected.uid === uid && daypopSelected.date === dk ? ' gcell-selected' : ''}" ` +
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
  // capture EVERY in-range point (key=lb) per visible member, PLUS the 3-letter name tag
  // the end-labels draw (v7.4 switched labels from emoji to abbrevName, so the sig must
  // track the NAME — tracking the emoji left a renamed member's tag stale). Editing any
  // point or renaming changes the sig, so the dirty-check can never leave a stale chart.
  // Cheap: <=rangeDays lookups x members, string concat only.
  const keys = [cur];
  for (let i = 1; i < rangeDays; i++) keys.push(prevBusinessDate(keys[i - 1]));
  const width = (elWchartSvg && elWchartSvg.clientWidth) || (elSocialChart && elSocialChart.clientWidth) || 0;
  const parts = [`r${rangeDays}`, `w${width}`, `m${wchartMode}`]; // v9.2: rel/abs mode redraws
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
    parts.push(uid + ':' + (abbrevName(displayNameOf(m)) || '?') + ':' + pts);
  }
  return parts.join('|');
}

function renderWeightChart(now) {
  if (!elSocialChart || !elWchartSvg) return;

  // sync the range label + toggle button states to the current selection. Cheap + always
  // safe to run (idempotent), so it stays OUTSIDE the dirty-check / rAF coalescing.
  if (elWchartRangeLabel) elWchartRangeLabel.textContent = String(wchartRange);
  if (elWchartToggle) {
    for (const btn of elWchartToggle.querySelectorAll('[data-range]')) {
      const on = Number(btn.dataset.range) === wchartRange;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    // v9.2: the REL/ABS mode pair syncs the same way (scoped by data-mode so the two
    // segmented groups never strip each other's .on).
    for (const btn of elWchartToggle.querySelectorAll('[data-mode]')) {
      const on = btn.dataset.mode === wchartMode;
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

// A "nice" gridline step (1/2/5 x 10^n) targeting ~`ticks` lines, so the chart shows a few
// clean reference lines instead of one every 10 lb (v5.3: was 7+ cramped lines).
function niceStep(range, ticks) {
  const raw = Math.max(1e-6, range / Math.max(1, ticks));
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag; // 1..10
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
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
  const PAD_L = 28, PAD_R = 16, PAD_T = 8, PAD_B = 6; // v5.3: tighter top/bottom so data fills the box

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
  // v7.2: X maps a (possibly fractional) date index -> svg x. The visible index window defaults
  // to the FULL range (vx0..vx1 = 0..rangeDays-1), so the unzoomed chart is byte-identical to
  // before. _wzoom narrows the window for pinch/wheel/pan zoom; idxAtX is the inverse (svg x ->
  // fractional index) the scrubber + zoom math need.
  const maxIdx = rangeDays - 1;
  let vx0 = 0, vx1 = maxIdx;
  if (_wzoom && Number.isFinite(_wzoom.i0) && Number.isFinite(_wzoom.i1) && _wzoom.i1 > _wzoom.i0) {
    vx0 = Math.max(0, Math.min(maxIdx, _wzoom.i0));
    vx1 = Math.max(0, Math.min(maxIdx, _wzoom.i1));
    if (!(vx1 > vx0)) { vx0 = 0; vx1 = maxIdx; }
  }
  const xSpan = (vx1 - vx0) || 1;
  const xOf = (idx) => PAD_L + (maxIdx <= 0 ? innerW : ((idx - vx0) / xSpan) * innerW);
  const idxAtX = (x) => (maxIdx <= 0 ? 0 : vx0 + ((x - PAD_L) / innerW) * xSpan);

  // ---- gather each visible member's in-range points. Hidden members (fetchWeights -> {})
  // and members with zero in-range points are omitted. "me" is collected first for color
  // assignment, but DRAWN last (see drawOrder below) so its red line paints on top.
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
      }
    }
    if (!pts.length) continue; // no in-range data -> no line (no flat zero, no NaN)
    // v7.6: Robinhood per-window re-basing. Each member re-bases to their EARLIEST in-window
    // weigh-in (pts[0], chronologically first since we walked keysOldestFirst); we plot the
    // DELTA lb-base so everyone starts level at 0 and trajectories are comparable. Pool the
    // deltas (not absolute lbs) so the shared y-axis fits the changes, not the weights.
    // v9.2: ABS mode sets base=0, which collapses every downstream (lb - base) to the real
    // absolute weight — one switch, same code path for both modes.
    const base = wchartMode === 'abs' ? 0 : pts[0].lb;
    for (const p of pts) {
      const dv = p.lb - base;
      if (dv < yMin) yMin = dv;
      if (dv > yMax) yMax = dv;
    }
    series.push({ uid, member: m, isMe: uid === myUserId, pts, base });
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
  // v7.2: remember the data-fit bounds so a full zoom-out can snap back to auto. When _wzoom is
  // set its weight window overrides lo/hi; null leaves the auto-fit untouched (no behavior change
  // for the default chart).
  const autoLo = lo, autoHi = hi;
  if (_wzoom && Number.isFinite(_wzoom.lo) && Number.isFinite(_wzoom.hi) && _wzoom.hi > _wzoom.lo) {
    lo = _wzoom.lo; hi = _wzoom.hi;
  }
  const span = hi - lo || 1;
  // dv = delta lbs from member base (re-based view); lo/hi/span are all in delta units.
  const yOf = (dv) => PAD_T + (1 - (dv - lo) / span) * innerH;

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
  // v5.4: soft red gradient used to fill under the ME line ONLY (instant self-locating).
  parts.push(
    '<defs><linearGradient id="wcMeFill" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="var(--red)" stop-opacity="0.18"/>' +
      '<stop offset="1" stop-color="var(--red)" stop-opacity="0"/>' +
      '</linearGradient></defs>'
  );
  // v7.2: when zoomed, clip the data layer to the plot rect so off-window points/lines don't
  // bleed into the axis gutter. The def + per-element clip attr are emitted ONLY while zoomed,
  // so the unzoomed SVG markup is byte-identical to before.
  if (_wzoom) {
    parts.push(
      `<clipPath id="wcPlotClip"><rect x="${(PAD_L - 0.5).toFixed(2)}" y="${(PAD_T - 4).toFixed(2)}" ` +
        `width="${(innerW + 1).toFixed(2)}" height="${(innerH + 8).toFixed(2)}" /></clipPath>`
    );
  }
  const clipAttr = _wzoom ? ' clip-path="url(#wcPlotClip)"' : '';
  // gridlines at NICE round steps targeting ~4 lines (v5.3: was every 10 lb => 7+ cramped
  // lines). Value labels sit on the LEFT, freeing the right edge for the emoji end-labels.
  const rng = hi - lo;
  const gstep = niceStep(rng, 6);
  const gridVals = [];
  for (let g = Math.ceil(lo / gstep) * gstep; g <= hi + 0.001; g += gstep) gridVals.push(g);
  if (!gridVals.length) gridVals.push(lo, hi);
  // v7.6: re-based axis -> labels are signed deltas (+2/+1/0/-1/-2), not absolute lbs.
  // niceStep can return 0.5 on a small re-based range, so Math.round would duplicate/mislabel;
  // use a sign+decimal-aware format with an fp-drift guard. The 0 line (always present since
  // every series contributes a delta-0 base point) gets a darker monochrome emphasis — NOT red
  // (red stays the ME accent per the single-accent rule).
  // v9.2: ABS mode labels are plain absolute lbs (no sign, no 0-line emphasis — 0 lb is
  // never in an absolute weight range anyway).
  const relMode = wchartMode !== 'abs';
  for (const gv of gridVals) {
    const gvr = Math.round(gv * 100) / 100;
    const isZero = relMode && Math.abs(gvr) < 1e-6;
    const gy = yOf(gv).toFixed(2);
    parts.push(`<line x1="${PAD_L}" y1="${gy}" x2="${(vbW - PAD_R).toFixed(2)}" y2="${gy}" stroke="${isZero ? 'var(--txt3)' : 'var(--hairline)'}" stroke-width="${isZero ? 1.1 : 0.6}" />`);
    const mag = Number.isInteger(gvr) ? Math.abs(gvr) : Math.abs(gvr).toFixed(1);
    let txt;
    if (relMode) {
      const sign = gvr > 0 ? '+' : gvr < 0 ? '-' : '';
      txt = isZero ? '0' : sign + mag;
    } else {
      txt = Number.isInteger(gvr) ? String(gvr) : gvr.toFixed(1);
    }
    parts.push(`<text x="${(PAD_L - 5).toFixed(2)}" y="${(yOf(gv) + 3).toFixed(2)}" font-size="7" fill="var(--txt3)" text-anchor="end">${txt}</text>`);
  }

  // one line (or dot) per member; collect end-labels anchored to each member's OWN
  // last point (NOT the chart's right edge) so a member who lapsed mid-window gets
  // their emoji next to their real last point. layoutChartEndLabels (logic.js)
  // resolves the x (own point, nudged, capped at the edge) + the vertical-dodge.
  const labels = [];
  // v5.4: draw "me" LAST so its red line/fill paints ON TOP of the gray others (SVG paints
  // in document order; whatever is emitted first sits underneath). Colors are already
  // assigned on each series above, so reordering the draw is purely about z-stacking.
  const drawOrder = series.slice().sort((a, b) => (a.isMe ? 1 : 0) - (b.isMe ? 1 : 0));
  for (const s of drawOrder) {
    const coords = s.pts.map((p) => ({ x: xOf(p.idx), y: yOf(p.lb - s.base) }));
    const last = coords[coords.length - 1];
    if (coords.length === 1) {
      parts.push(`<circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="2.2" fill="${s.color}" opacity="${s.opacity}"${clipAttr} />`);
    } else {
      const d = smoothPath(coords);
      if (s.isMe) {
        // v5.4: translucent red area under the ME line so you can find yourself at a glance.
        // v7.6: anchor the fill to the 0 (baseline) line, not the chart bottom — in delta space
        // a cutter's line dips below 0 and a fill-to-floor would yawn open. v9.2: ABS mode
        // has no 0 baseline in range — fill to the plot floor (the pre-relative behavior).
        const baseY = (relMode ? yOf(0) : vbH - PAD_B).toFixed(2);
        parts.push(
          `<path d="${d} L ${last.x.toFixed(2)} ${baseY} L ${coords[0].x.toFixed(2)} ${baseY} Z" ` +
            `fill="url(#wcMeFill)" stroke="none"${clipAttr} />`
        );
      }
      parts.push(
        `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width}" ` +
          `stroke-linecap="round" stroke-linejoin="round" opacity="${s.opacity}"${clipAttr} />`
      );
    }
    // v7.3: the per-point transparent <title> hover-circles were removed — the whole-chart
    // hover-scrub (wireWchartScrub) now shows the nearest line's weight on plain mouse-hover, so the
    // native per-point tooltips were redundant and double-rendered a second tooltip on desktop.
    // v7.1: a clean uppercase 3-letter tag instead of the person emoji (emoji end-labels read
    // as cringe — Soren 6/25). v7.4: abbrevName (logic.js) replaces the old slice(0,3) so the tag
    // is consonant-skeleton, not a blunt prefix: Soren->SRN, Hunter->HNT, Jacob->JCB, Olivia->OLV.
    const tag = abbrevName(displayNameOf(s.member)) || '?';
    labels.push({
      pointX: last.x, anchor: 'start',
      idealY: last.y,
      fill: s.isMe ? 'var(--red)' : s.color,
      text: tag,
    });
  }
  // dodge only WITHIN an x-cluster — a far-left lapsed emoji must not be shoved
  // vertically to clear the recent right-edge group (that was the old bug).
  layoutChartEndLabels(labels, {
    rightEdgeX: vbW - PAD_R + 2,
    nudge: 4,
    gap: 11,
    top: PAD_T + 4,
    bot: vbH - PAD_B + 1,
    overlapX: 12,
  });
  for (const L of labels) {
    parts.push(
      `<text x="${L.x.toFixed(2)}" y="${(L.y + 2).toFixed(2)}" font-size="8" ` +
        `fill="${L.fill}" text-anchor="${L.anchor}">${escapeHtml(L.text)}</text>`
    );
  }

  elWchartSvg.innerHTML =
    `<svg viewBox="0 0 ${vbW} ${vbH}" preserveAspectRatio="xMidYMid meet" ` +
    `role="img" aria-label="Weight over time, last ${rangeDays} days">${parts.join('')}</svg>`;

  // stash geometry for the tap/drag scrubber + zoom/pan (wired in wireWchartScrub). yOf/idxAtX
  // let the scrubber map a pointer to the same coords the chart drew at; autoLo/autoHi + vx0/vx1
  // let the zoom math know the current window and when a zoom-out reaches the full auto view.
  _wchartGeom = {
    vbW, vbH, PAD_L, PAD_R, PAD_T, PAD_B, innerW, innerH, rangeDays,
    keysOldestFirst, xOf, idxAtX, yOf, lo, hi, autoLo, autoHi, vx0, vx1, series,
  };
  // a visible scrub must re-anchor after any rebuild (range toggle, a freshly-logged weight,
  // a zoom step) since the geometry just changed. Rendered synchronously — never via rAF.
  if (_wscrubIdx !== null) renderScrub();
}

// =============================================================================
// FULL REPAINT (called on snapshot, on tap, on rollover, on heartbeat)
// v3.1: no bottom bar — repaint just renders the active screen + the sync pip.
// =============================================================================
function repaint() {
  const now = anchoredNow();
  // v7 (#B): desktop one-screen mode shows ALL FOUR panes at once, so a repaint must render
  // every pane (the mobile path renders only the active one, correct there because the others
  // are slid off-screen).
  if (isDesktop()) {
    renderMe(now);
    renderGrid(now);
    renderMonth(now);
    if (PLAYLIST_ENABLED) renderPlaylist();
    updateSyncPip();
    return;
  }
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
    // v7 #1: re-sync the real playlist on focus/visibility return (cache-guarded; no-op off-playlist).
    if (PLAYLIST_ENABLED && (isDesktop() || activeTab === 'playlist')) syncRealPlaylist(false);
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
// OFFLINE-TOLERANT WRITE HELPERS (v5.4)
//   Firestore's batch.commit()/setDoc resolve only on SERVER ack; offline or on
//   flaky signal (the literal gym case) they stay PENDING forever — they do NOT
//   reject, and the local cache already accepted the write and will sync on
//   reconnect. The nutrition/weight/meal/rest handlers used to `await` that write
//   before re-enabling the button / giving feedback, so a pending write bricked the
//   button until reload. These wrappers bound the wait: after `ms` the write is
//   treated as "queued" (it will sync), so the handler always finishes and gives
//   feedback, while a REAL rejection (rules/permission) still surfaces as an error.
// =============================================================================
function commitWithTimeout(promise, ms = 7000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve('queued'); } }, ms);
    promise.then(
      () => { if (!settled) { settled = true; clearTimeout(t); resolve('ok'); } },
      (err) => { if (!settled) { settled = true; clearTimeout(t); reject(err); } }
    );
    promise.catch(() => {}); // swallow a late rejection after a timeout (no unhandled rejection)
  });
}
// Await a best-effort refetch but never let it hang the handler (getDocs can stall offline).
function withSoftTimeout(promise, ms = 3000) {
  return Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

// v9.1: meal writes are READ-MODIFY-WRITE (data.addMeal/removeMeal getDoc a base, then
// merge recomputed totals), so two CONCURRENT calls read the same base and the second
// commit silently reverts the first — the quick-meal chips have no disable guard, so a
// double-tap logged only one meal (both toasts said "meal logged"). Serialize every
// meal-path write through one promise chain: each RMW starts only after the previous
// write settles, so it reads the committed totals. A rejection doesn't break the chain
// (each caller still awaits + handles its own error), and offline writes queue in order.
let _mealWriteChain = Promise.resolve();
function enqueueMealWrite(startWrite) {
  const run = _mealWriteChain.then(startWrite, startWrite);
  _mealWriteChain = run.then(() => {}, () => {});
  return run;
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
  // v7 (#B): on desktop the panes live in a CSS grid (no slide); an inline transform here would
  // push them out of their grid cells. The desktop @media also force-clears transform with
  // !important, but we skip writing it at all to keep state clean.
  if (isDesktop()) return;
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
  if (tab === 'playlist') syncRealPlaylist(false); // v7 #1: re-sync the real playlist on tab-open
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
    if (isDesktop()) { x0 = null; return; } // v7 (#B): no pane-slide swipe in desktop grid mode
    if (e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (isDesktop()) { x0 = null; return; } // v7 (#B): swipe is a no-op on desktop
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
// RESPONSIVE MODE (v7 #B) — desktop one-screen vs mobile tabbed.
//   isDesktop() (matchMedia '(min-width:1024px) and (pointer:fine)') is the SINGLE source of
//   truth. enterDesktop unhides every pane + clears stale inline transforms + repaints all 4.
//   enterMobile restores the tabbed single-pane view by re-running setTab(activeTab). Bound to
//   the MQL change event so a resize across 1024px OR a pointer-type change (docking a tablet to
//   a mouse) flips modes live. FAIL-SAFE: if the query is ever unreadable, isDesktop()===false
//   and we stay mobile.
// =============================================================================
function enterDesktopMode() {
  for (let i = 0; i < SCREENS.length; i++) {
    const el = elScreens[SCREENS[i]];
    if (!el) continue;
    el.hidden = false; // MONTH ships with the boolean `hidden` attr; the grid shows every pane
    el.setAttribute('aria-hidden', 'false');
    el.style.transform = ''; // drop any stale inline translateX from mobile
  }
  // v9.2: on desktop the weight chart is its OWN bottom-right panel (#desk-chart slot),
  // not the strip under the SOCIAL board — the middle column gives the week grid its full
  // height. A DOM move (not a rebuild) keeps the chart's listeners/scrub overlay intact;
  // the repaint below re-measures + redraws it at the slot's size (the sig tracks width).
  const slot = document.getElementById('desk-chart');
  if (slot && elSocialChart && !slot.contains(elSocialChart)) slot.appendChild(elSocialChart);
  if (slot) slot.hidden = false;
  closeDayPopover(); // a popover anchored to a mobile-positioned cell would be misplaced
  repaint();         // renders ALL panes (isDesktop() branch)
}
function enterMobileMode() {
  // v9.2: return the weight chart to its mobile home (last child of the SOCIAL pane,
  // under the grid — unchanged mobile layout) before the tabbed repaint.
  const slot = document.getElementById('desk-chart');
  const gridScreen = document.getElementById('screen-grid');
  if (slot && gridScreen && elSocialChart && slot.contains(elSocialChart)) gridScreen.appendChild(elSocialChart);
  if (slot) slot.hidden = true;
  setTab(activeTab); // re-applies the slide transforms, is-active, aria-hidden, repaints the active pane
}
function applyResponsiveMode() {
  if (isDesktop()) enterDesktopMode();
  else enterMobileMode();
}
function setupResponsiveMode() {
  applyResponsiveMode(); // initial evaluation at boot (fail-safe to mobile on a coarse pointer)
  if (typeof DESKTOP_MQ.addEventListener === 'function') {
    DESKTOP_MQ.addEventListener('change', applyResponsiveMode);
  } else if (typeof DESKTOP_MQ.addListener === 'function') {
    DESKTOP_MQ.addListener(applyResponsiveMode); // deprecated, for old WebKit
  }
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
// Sunday-start weekday header (calendar DISPLAY only — Soren 6/25). NOTE: this is the calendar's
// first-day-of-week, intentionally DECOUPLED from businessWeekKey's Mon..Sun week math + the
// playlist Mon–Wed/Thu–Sun slot boundary, which both stay Monday-anchored in logic.js.
const MONTH_DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

// The chip row: one tappable chip per member (me first), the selected subject ringed in
// --red. v9.2: chips show the SAME 3-letter abbrevName tag the weight chart uses (emoji
// removed — Soren 7/4). Rebuilt only when the member set / names / selection change.
function renderMonthChips() {
  if (!elMonthChips) return;
  const cols = orderedMembers();
  const sig = cols.map((m) => idOf(m) + ':' + (abbrevName(displayNameOf(m)) || '?')).join('|') + '#' + (monthSubjectUid || '');
  if (elMonthChips.dataset.sig !== sig) {
    elMonthChips.innerHTML = cols.map((m) => {
      const uid = idOf(m);
      const tag = abbrevName(displayNameOf(m)) || '?';
      const on = uid === monthSubjectUid;
      return (
        `<button class="month-chip${on ? ' on' : ''}" type="button" data-uid="${escapeHtml(uid)}" ` +
        `aria-pressed="${on ? 'true' : 'false'}" title="${escapeHtml(displayNameOf(m))}" ` +
        `aria-label="show ${escapeHtml(displayNameOf(m))}'s month">` +
        `<span class="month-chip-abbr" aria-hidden="true">${escapeHtml(tag)}</span></button>`
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
  // leading Sunday-start offset for the 1st (Sun->0 .. Sat->6) — matches the Sun-first MONTH_DOW
  // header. DISPLAY only; logic.js's businessWeekKey + playlist slot math stay Monday-anchored.
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun..6=Sat
  const lead = firstDow;
  // total visible cells = leading pad + the month, rounded UP to whole Mon..Sun weeks so the
  // grid is a clean 7-col rectangle (5 or 6 rows). Walk back `lead` days to the first cell,
  // then step forward one civil day per cell (nextDayKey) — pad cells fall outside monthPrefix.
  const total = Math.ceil((lead + daysInMonth) / 7) * 7;
  let k = firstKey;
  for (let i = 0; i < lead; i++) k = prevBusinessDate(k);

  const cells = [];
  // weekday header row (Sun..Sat).
  for (const d of MONTH_DOW) cells.push(`<div class="month-dow" aria-hidden="true">${d}</div>`);

  for (let i = 0; i < total; i++) {
    const inMonth = k.slice(0, 7) === monthPrefix;
    const dayNum = +k.slice(8, 10);
    if (!inMonth) {
      // adjacent-month pad cell: inert — dim number, no status, no tap.
      cells.push(`<div class="month-cell pad" aria-hidden="true"><span class="month-num">${dayNum}</span></div>`);
    } else {
      const day = effectiveDays(uid)[k];
      const { wStatus, nStatus, nProgress } = classifyDay(subject, k, now, day);
      const prejoin = wStatus === 'prejoin';
      // v9.2: the dithered nutrition partial-fill now paints MONTH cells too (same Bayer
      // bucket rule as renderGrid — the 12px mask tiles repeat at any cell size). And the
      // today red outline (col-today) is GONE (Soren 7/4) — no today marker on the month.
      let nfill = '';
      if (nStatus !== 'hit' && typeof nProgress === 'number') {
        const nb = Math.round(nProgress * 16);
        if (nb > 0) nfill = ` n-fill n-d${nb}`;
      }
      const aria = `${displayNameOf(member)} ${k} — workout ${CELL_LABEL[wStatus] || wStatus}, nutrition ${nStatus}`;
      // reuse the exact .gcell + w-/n- classes so the diagonal split + colors match the board.
      // No workout corner-tag in this density (too small to read; color carries the signal).
      cells.push(
        `<div class="gcell month-cell w-${wStatus} n-${nStatus}${nfill}${prejoin ? ' prejoin' : ''}" ` +
          `data-uid="${escapeHtml(uid)}" data-date="${escapeHtml(k)}" ` +
          `role="button" tabindex="0" aria-label="${escapeHtml(aria)}">` +
          `<div class="seg-w"></div><div class="seg-n"></div>` +
          `<span class="month-num">${dayNum}</span></div>`
      );
    }
    k = nextDayKey(k);
  }
  elMonthGrid.innerHTML = cells.join('');

  // v5.4 (#6): keep an open MONTH popover pinned to its rebuilt cell (or close it if the day
  // fell off this month), mirroring renderGrid. Without this a month repaint (heartbeat /
  // snapshot / the on-demand fetch below) left a stale popover floating at old coords.
  reanchorDayPopover();

  // on-demand fetch (skip weights): if this subject's month is outside the cached window,
  // ensureMonthDays merges it in and resolves true; we then repaint once (still on this tab +
  // subject). The dirty-check inside makes it fire at most once per subject+month, so this
  // never loops. Within the window it resolves false (a pure no-op).
  ensureMonthDays(uid, y, m, now).then((fetched) => {
    // desktop shows MONTH alongside the other panes with activeTab elsewhere, so the
    // post-fetch repaint needs the same isDesktop() gate every other callback uses.
    if (fetched && (isDesktop() || activeTab === 'month') && monthSubjectUid === uid) renderMonth(anchoredNow());
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
// RENDER: PLAYLIST (v5 #5 -> v7 #1) — the shared song wall now MIRRORS the real Spotify playlist.
//   The display source is the live Worker /list read (songs added natively in Spotify show up; native
//   removals disappear). The Firestore /playlist snapshot is demoted to attribution-only. Add by
//   pasting a Spotify link or typing "Song - Artist"; an optimistic row shows until the track lands in
//   the real playlist. A native (non-app) add shows a neutral '•' chip. The footer opens the real
//   playlist (or a whole-list search); a live "· N SONGS" count sits in the header. All user text is
//   escaped; every outbound link is rel="noopener". (#6: no remove — removal happens in Spotify.)
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

// One escaped row. `pending` (an optimistic, not-yet-acked add) dims it slightly until the
// snapshot confirms it (the id then matches a real doc and pending clears). v5.2: songs are
// PERMANENT (no remove ✕) — the Worker is add-only so a wall-remove could never reach Spotify
// (they'd drift), and the wall already wipes fresh each half-week.
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
    `</div>`
  );
}

// v5.2: the playlist's current week (Monday key) + the half for "now", from the viewer's clock.
function currentPlaylistSlot() {
  const today = viewerBusinessDate(new Date());
  return { week: businessWeekKey(today), half: playlistHalf(today) };
}
// v7 #3: NO A/B toggle — the PLAYLIST always shows the CURRENT live slot (the half-week boundary
// stays; only the on-screen toggle is gone). Past slots are reachable via the HISTORY dropdown.
function viewedPlaylistSlot() {
  const { week, half } = currentPlaylistSlot();
  return { week, half, key: playlistSlotId(week, half) };
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

// v5.2: refresh the "resets in 3D / 5H" badge — time until the CURRENT live half flips to the
// next themed playlist (Mon–Wed -> Thu, Thu–Sun -> next Mon, at the business-day rollover).
// Coarse (days, else hours). Called on render + a 60s tick (text-only, never reloads embeds).
function updateResetBadge() {
  if (!elPlReset || !myUserId) return;
  const me = memberById(myUserId);
  if (!me) return;
  const s = subjectOf(me);
  const today = currentBusinessDate(new Date(), s.ianaTz, s.rolloverHour, s.rolloverMinute);
  const p = playlistNextResetDayKey(today).split('-').map(Number);
  // boundary instant ≈ the reset day at the rollover hour, in local time (fine for a coarse badge).
  const boundary = new Date(p[0], p[1] - 1, p[2], s.rolloverHour || 0, s.rolloverMinute || 0, 0).getTime();
  elPlReset.textContent = `resets in ${formatResetCountdown(boundary - Date.now())}`;
}

// v7 #1 SYNC-MERGE display model:
//   • DISPLAY source = the REAL Spotify playlist (plRealTracks, read live via the Worker /list).
//     Rows = mergeRows(plRealTracks, attribMap): deduped by 22-char track id, each tagged with the
//     gym user who app-added it (or null = a NATIVE Spotify add -> a neutral anonymous chip).
//   • The Firestore /playlist snapshot is DEMOTED to attribution-only (spotifyTrackId -> addedBy).
//   • FALLBACK: if there's no real read for the slot (Worker down/403, or no playlist yet) we render
//     the Firestore wall, so the tab never blanks on a transient failure.
//   • Optimistic adds overlay on top until the same track lands in plRealTracks (P0 #2 reconcile).

// attribution map for a slot: { [spotifyTrackId]: addedByUserId } from the Firestore songs.
function buildAttribMap(key) {
  const m = {};
  for (const s of songs) {
    if (s.slot !== key) continue;
    if (typeof s.spotifyTrackId === 'string' && s.spotifyTrackId) m[s.spotifyTrackId] = s.addedByUserId || null;
  }
  return m;
}

// has this optimistic add landed in the real playlist yet? Links match by 22-char track id; typed
// songs (whose stored title IS the real song name) fall back to a normalized title+artist match.
function pendingMatchesReal(s) {
  if (s.trackId && plRealTracks.some((t) => t.id === s.trackId)) return true;
  const norm = normalizeTrackTitle(`${s.title || ''} ${s.artist || ''}`);
  if (norm && plRealTracks.some((t) => normalizeTrackTitle(`${t.name || ''} ${t.artist || ''}`) === norm)) return true;
  return false;
}

// drop optimistic adds that reconciled (now in the real playlist) or aged out (5-min safety cap so a
// Worker-add that never lands can't pin a stale row forever — well past add+sync latency).
function prunePendingAdds() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  plOptimisticAdds = plOptimisticAdds.filter((s) => !pendingMatchesReal(s) && (s.addedAt || 0) > cutoff);
}

// the optimistic rows still worth showing for a slot (in slot, not yet in the real playlist).
function visiblePendingAdds(key) {
  return plOptimisticAdds.filter((s) => s.slot === key && !pendingMatchesReal(s));
}

// run resolveThemeForPeriod ONCE per period (first open in it), fire-and-forget. The data call is
// itself guarded (no-op if the slot is already themed or has no submissions).
function maybeResolveTheme(key) {
  if (!key || _plResolvedPeriods.has(key)) return;
  _plResolvedPeriods.add(key);
  Promise.resolve(data.resolveThemeForPeriod(key)).catch(() => {});
}

// keep a live subscription to the NEXT period's idea submissions (for the "N ideas for next" hint).
// Re-points when the next-period key rolls over.
function ensureNextIdeasSub() {
  const next = nextPeriodKey(viewerBusinessDate(new Date()));
  if (next === _plNextIdeasPeriod) return;
  _plNextIdeasPeriod = next;
  if (plNextIdeasUnsub) { try { plNextIdeasUnsub(); } catch (_) {} plNextIdeasUnsub = null; }
  plNextIdeasCount = 0;
  if (!next) return;
  try {
    plNextIdeasUnsub = data.subscribeThemeSubmissions(next, (ideas) => {
      plNextIdeasCount = Array.isArray(ideas) ? ideas.length : 0;
      if (isDesktop() || activeTab === 'playlist') renderPlaylist();
    });
  } catch (_) { /* non-fatal: the count just stays 0 */ }
}

// v7.5 #A: keep a live subscription to the VIEWED period's idea submissions, so the resolved theme can
// be attributed to whoever submitted it ("submitted by X"). Re-points when the viewed slot rolls over.
function ensureViewedSubsSub(key) {
  if (key === _plViewedSubsPeriod) return;
  _plViewedSubsPeriod = key;
  if (plViewedSubsUnsub) { try { plViewedSubsUnsub(); } catch (_) {} plViewedSubsUnsub = null; }
  plViewedSubs = [];
  if (!key) return;
  try {
    plViewedSubsUnsub = data.subscribeThemeSubmissions(key, (ideas) => {
      plViewedSubs = Array.isArray(ideas) ? ideas : [];
      if (isDesktop() || activeTab === 'playlist') renderPlaylist();
    });
  } catch (_) { /* non-fatal: no attribution is shown */ }
}

// v7.5 #A: the displayName to attribute the current theme to ("submitted by X"), or '' when no setter
// is recorded — graceful: show nothing. Two sources, in priority order:
//   1) a /themeSubmissions idea whose text matches the live theme -> the true SUBMITTER. resolveTheme-
//      ForPeriod copies only the picked text onto the slot (slot.updatedByUserId is then the RESOLVER,
//      not the submitter), so the submission is the reliable source when the theme came that way.
//   2) else slot.updatedByUserId — an inline live-named theme stamps its namer there (no submission
//      doc exists for that path). This is how the current live themes are attributed (the submission
//      flow is new + unused so far), e.g. Jacob, who named the current vibe.
function themeSubmitterName(key) {
  const slot = plSlots[key] || {};
  const theme = (typeof slot.theme === 'string') ? slot.theme.trim() : '';
  if (!theme) return '';
  const want = theme.toLowerCase();
  const sub = plViewedSubs.find((s) => s && s.addedByUserId
    && typeof s.theme === 'string' && s.theme.trim().toLowerCase() === want);
  if (sub) {
    const m = memberById(sub.addedByUserId);
    if (m) return displayNameOf(m);
  }
  if (typeof slot.updatedByUserId === 'string' && slot.updatedByUserId) {
    const m = memberById(slot.updatedByUserId);
    if (m) return displayNameOf(m);
  }
  return '';
}

// "Jun 22 MON–WED" for a legacy (pre-MXT) slot key in the HISTORY list.
function slotDateLabel(slotKey) {
  const us = slotKey.indexOf('_');
  if (us < 0) return slotKey;
  const weekKey = slotKey.slice(0, us);
  const label = playlistSlotLabel(slotKey.slice(us + 1));
  const p = weekKey.split('-');
  const wk = p.length === 3 ? `${_PL_MON[+p[1] - 1] || ''} ${+p[2]}` : weekKey;
  return `${wk} ${label}`;
}

// v7 #3: fill the HISTORY <select> with archived slots (newest first); selecting one opens its URL.
function renderHistory(currentKey) {
  if (!elPlHistory) return;
  const hist = historySlots(plSlots, currentKey);
  const opts = ['<option value="" selected>HISTORY ▾</option>'];
  for (const h of hist) {
    const base = h.mxtNumber != null ? `MXT #${h.mxtNumber}` : slotDateLabel(h.key);
    const label = h.theme ? `${base}: ${h.theme}` : base;
    opts.push(`<option value="${escapeHtml(h.spotifyUrl || '')}">${escapeHtml(label)}</option>`);
  }
  elPlHistory.innerHTML = opts.join('');
  elPlHistory.disabled = hist.length === 0;
}

// one row for a REAL playlist track (the sync-merge display). Always a Spotify track, so it renders
// the inline player; the chip shows the gym user who app-added it, or a neutral '•' for a NATIVE
// Spotify add — NEVER the fake 'Someone'+hashed-emoji, which would mis-attribute it to a non-person.
function realRowHtml(track) {
  const uid = track.addedByUserId || '';
  const member = uid ? memberById(uid) : null;
  let chip;
  if (member) {
    const emoji = emojiOf({ emoji: member.emoji, id: uid });
    const who = displayNameOf(member);
    chip = `<span class="pl-row-emoji" title="${escapeHtml(who)}" aria-label="added by ${escapeHtml(who)}">${escapeHtml(emoji)}</span>`;
  } else {
    chip = '<span class="pl-row-emoji" title="added in Spotify" aria-label="added directly in Spotify">•</span>';
  }
  const spe = spotifyEmbed(track.url || track.uri || '');
  if (spe) {
    return (
      `<div class="pl-row pl-row-embed" role="listitem" data-id="${escapeHtml(track.id || '')}">` +
        chip +
        `<div class="pl-embed">` +
          `<iframe src="${escapeHtml(spe.src)}" frameborder="0" ` +
            `allow="encrypted-media; clipboard-write; picture-in-picture" ` +
            `title="Spotify player for ${escapeHtml(track.name || 'a song')}"></iframe>` +
        `</div>` +
      `</div>`
    );
  }
  const title = escapeHtml(track.name || 'Unknown track');
  const artist = track.artist ? escapeHtml(track.artist) : '';
  return (
    `<div class="pl-row" role="listitem" data-id="${escapeHtml(track.id || '')}">` +
      chip +
      `<div class="pl-row-main">` +
        `<div class="pl-row-title">${title}</div>` +
        (artist ? `<div class="pl-row-meta"><span class="pl-row-artist">${artist}</span></div>` : '') +
      `</div>` +
    `</div>`
  );
}

// v7 #1: re-read the real Spotify playlist for the current slot (the DISPLAY source). Cache-guarded
// (skip if <20s since the last fetch, unless `force`) to respect Spotify's rolling-30s window. Fired
// on app-open + tab-focus/visibility + the REFRESH button + ~after an add. No-op without a playlist id.
async function syncRealPlaylist(force) {
  const { key } = viewedPlaylistSlot();
  const playlistId = (plSlots[key] && plSlots[key].spotifyPlaylistId) || '';
  if (!playlistId) {
    // no real playlist yet for this slot -> nothing to read; clear any tracks left from another slot.
    if (plRealForSlot !== key) { plRealTracks = []; plRealForSlot = key; plRealFetchedAt = 0; }
    return;
  }
  const now = Date.now();
  if (!force && plRealForSlot === key && (now - plRealFetchedAt) < 20000) return; // cache guard
  if (_plRealSyncing) return;
  _plRealSyncing = true;
  try {
    const tracks = await data.fetchRealPlaylist(playlistId);
    plRealTracks = Array.isArray(tracks) ? tracks : [];
    plRealForSlot = key;
    plRealFetchedAt = Date.now();
    prunePendingAdds();
  } catch (_) {
    /* best-effort: keep whatever we had */
  } finally {
    _plRealSyncing = false;
  }
  if (isDesktop() || activeTab === 'playlist') renderPlaylist();
}

function renderPlaylist() {
  if (!PLAYLIST_ENABLED || !elPlList) return; // v9.2: parked (and the pane's markup is removed)
  const { key } = viewedPlaylistSlot();

  // v7 #4: lazily resolve this period's theme from submissions the first time it's opened in-period,
  // and keep the "ideas for next period" subscription pointed at the right key.
  maybeResolveTheme(key);
  ensureNextIdeasSub();
  ensureViewedSubsSub(key); // v7.5 #A: live submissions for this period (to attribute the theme)

  // time-based countdown — refresh on every call (cheap text, never reloads anything), even when the
  // signature guard below short-circuits the rest of the render.
  updateResetBadge();

  const attrib = buildAttribMap(key);
  const merged = mergeRows(plRealForSlot === key ? plRealTracks : [], attrib);
  merged.reverse(); // /list returns playlist/append order (oldest first) -> newest on top
  const pendingAdds = visiblePendingAdds(key);

  // FALLBACK source: when there's no real read for this slot, fall back to the Firestore wall so the
  // pane isn't blank (slot has no playlist yet, or the Worker read failed transiently).
  const useReal = merged.length > 0;
  const fallbackSnap = useReal ? [] : songs.filter((s) => s.slot === key);
  const total = pendingAdds.length + (useReal ? merged.length : fallbackSnap.length);

  // v7.5 #A: who submitted the current theme ('' when inline live-named / no matching submission).
  const themeBy = themeSubmitterName(key);

  // v7.3 (#F): a compact signature of everything this render draws. When it's unchanged, skip the
  // entire render — so the heartbeat + no-op /users snapshots (a teammate's lastActiveAt bump fires
  // repaint() ~every few seconds) stop rebuilding the pane (which used to reload every Spotify embed).
  const slotSig = Object.keys(plSlots).sort().map((k) => {
    const s = plSlots[k] || {};
    return `${k}:${s.theme || ''}:${s.mxtNumber == null ? '' : s.mxtNumber}:${s.spotifyUrl || ''}:${s.spotifyPlaylistId || ''}`;
  }).join('|');
  const sig = [
    key, total, useReal ? 1 : 0, plNextIdeasCount, plThemeEditing ? 1 : 0,
    merged.map((t) => t.id || t.name || '').join(','),
    pendingAdds.map((s) => `${s.id || ''}:${s.trackId || ''}:${s.title || ''}`).join(','),
    fallbackSnap.map((s) => s.id || '').join(','),
    plCollabUrl || '', slotSig, 'by:' + themeBy,
  ].join('');
  if (sig === _plRenderSig) return;
  _plRenderSig = sig;

  // theme line: the CURRENT period's theme (or the unset placeholder) + the next-period idea count.
  if (elPlThemeName && !plThemeEditing) {
    const theme = plSlots[key] && typeof plSlots[key].theme === 'string' ? plSlots[key].theme.trim() : '';
    elPlThemeName.textContent = theme || 'name this playlist’s vibe';
    elPlThemeName.classList.toggle('unset', !theme);
  }
  // v7.5 #A: attribute the resolved theme to its submitter; hidden when there's no matching submission.
  if (elPlThemeBy) {
    elPlThemeBy.textContent = themeBy ? `submitted by ${themeBy}` : '';
    elPlThemeBy.classList.toggle('hidden', !themeBy);
  }
  if (elPlThemeIdeas) {
    elPlThemeIdeas.textContent = plNextIdeasCount > 0 ? `${plNextIdeasCount} idea${plNextIdeasCount === 1 ? '' : 's'} for next` : '';
  }
  renderHistory(key);

  if (elPlCount) elPlCount.textContent = total ? ` · ${total} SONG${total === 1 ? '' : 'S'}` : '';

  // v7.4 (#6): LIST the songs again (the v7.3 compact "N songs" summary is reverted). Each row is
  // album COVER ART + title + artist — plain <img> thumbnails, NOT Spotify iframe embeds (those
  // reload-flickered on every render). Art comes from the Worker /list track (`t.art`, the smallest
  // album image). Rows with no art (optimistic adds not yet reconciled, or the Firestore fallback
  // when there's no real read) get a neutral ♪ placeholder, so the no-art case is a clean text list.
  // The scroller is #pl-scroll (.scrolly: scrollbar hidden via scrollbar-width:none + ::-webkit).
  if (!total) {
    elPlList.innerHTML = '<div class="empty-note">No songs in this playlist yet. Paste a Spotify link or type a song to start it.</div>';
  } else {
    const rowHtml = (o) => {
      const title = escapeHtml(o.title || 'Unknown track');
      const artist = o.artist ? escapeHtml(o.artist) : '';
      const art = (typeof o.art === 'string' && o.art) ? o.art : '';
      const artHtml = art
        ? `<img class="pl-row-art" src="${escapeHtml(art)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
        : '<div class="pl-row-art pl-row-art-empty" aria-hidden="true">♪</div>';
      return (
        `<div class="pl-row${o.pending ? ' pending' : ''}" role="listitem" data-id="${escapeHtml(o.id || '')}">` +
          artHtml +
          '<div class="pl-row-main">' +
            `<div class="pl-row-title">${title}</div>` +
            (artist ? `<div class="pl-row-meta"><span class="pl-row-artist">${artist}</span></div>` : '') +
          '</div>' +
        '</div>'
      );
    };
    const rows = [];
    // optimistic adds first (newest, not yet in the real read). A pasted-link add has no name/art
    // until the Worker /list reconciles it, so show "Adding…" rather than the raw URL it stored.
    for (const s of pendingAdds) {
      const t = (s.source === 'text' && s.title) ? s.title : 'Adding…';
      rows.push(rowHtml({ id: s.id, title: t, artist: s.artist, art: '', pending: true }));
    }
    if (useReal) { for (const t of merged) rows.push(rowHtml({ id: t.id, title: t.name, artist: t.artist, art: t.art })); }
    else { for (const s of fallbackSnap) rows.push(rowHtml({ id: s.id, title: s.title, artist: s.artist, art: '' })); }
    elPlList.innerHTML = rows.join('');
  }

  // footer "OPEN ON SPOTIFY": open the slot's real playlist when it exists, else a whole-list search.
  const wholeListQuery = (useReal
    ? merged.map((t) => `${t.name || ''} ${t.artist || ''}`)
    : fallbackSnap.map((s) => (s.source === 'text' ? [s.title, s.artist].filter(Boolean).join(' ') : '')))
    .concat(pendingAdds.map((s) => (s.source === 'text' ? [s.title, s.artist].filter(Boolean).join(' ') : '')))
    .filter(Boolean)
    .slice(0, 12)
    .join(' ');
  const slotSpotifyUrl = plSlots[key] && plSlots[key].spotifyUrl;
  const spSearch = wholeListQuery ? spotifySearchUrl(wholeListQuery) : '';
  const spHref = playlistLinkUrl(slotSpotifyUrl, spSearch) || 'https://open.spotify.com/search';
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

// /playlist snapshot handler: store the songs (now the ATTRIBUTION source, not the display source),
// prune any reconciled/aged optimistic adds, repaint if the playlist is visible. A new song's
// spotifyTrackId arriving here just updates the attribution chip on its real row.
function onSongs(songsArray) {
  songs = Array.isArray(songsArray) ? songsArray.slice() : [];
  prunePendingAdds();
  if (isDesktop() || activeTab === 'playlist') renderPlaylist();
}

// /playlistSlots snapshot handler — store the theme/mxt/spotify map, then re-sync the real playlist
// (a newly-recorded spotifyPlaylistId for the current slot is what kicks off the first real read).
function onSlots(slotsMap) {
  plSlots = slotsMap && typeof slotsMap === 'object' ? slotsMap : {};
  if (isDesktop() || activeTab === 'playlist') {
    renderPlaylist();
    syncRealPlaylist(false);
  }
}

// v7 #4: the theme line is repurposed. If the CURRENT period is UNNAMED, committing LIVE-NAMES it
// (the zero-submission fallback). Once it's named, committing SUBMITS an idea for the NEXT period
// (submitTheme -> /themeSubmissions; the rollover picks one — single auto, many random). Tap the name
// (or ✎) to open the input; Enter/blur commits, Esc cancels.
function startThemeEdit() {
  if (!elPlThemeInput || !elPlThemeName) return;
  const { key } = viewedPlaylistSlot();
  const curTheme = (plSlots[key] && typeof plSlots[key].theme === 'string' ? plSlots[key].theme : '').trim();
  plThemeEditing = true;
  elPlThemeInput.value = '';
  elPlThemeInput.placeholder = curTheme ? 'suggest next period’s theme' : 'name this period’s vibe';
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
  if (!val) { renderPlaylist(); return; }
  const curTheme = (plSlots[key] && typeof plSlots[key].theme === 'string' ? plSlots[key].theme : '').trim();
  if (!curTheme) {
    // zero-submission fallback: name the CURRENT (unnamed) period live.
    plSlots[key] = { ...(plSlots[key] || {}), theme: val }; // optimistic
    renderPlaylist();
    try {
      await data.setPlaylistTheme(key, val);
    } catch (err) {
      // Theme writes are allowlist-gated, not binding-gated, so a denial here is not a
      // reclaim; data.js probes + raises the modal if the binding is genuinely gone.
      plHint('Could not save the theme.', 'err');
    }
    return;
  }
  // current period already themed -> submit an idea for the NEXT period.
  const next = nextPeriodKey(viewerBusinessDate(new Date()));
  try {
    await data.submitTheme(next, val);
    plHint('Idea submitted for next period!', 'dupe'); // 'dupe' = the neutral (non-error) pulse style
  } catch (err) {
    plHint('Could not submit that idea.', 'err');
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

// Add the current input. parseSongInput → a {title,artist,url,source} payload; best-effort dedupe;
// ensure the slot's MXT playlist exists; addSong() write + Worker mirror; optimistic row reconciled
// by track id (links) / title (typed) against the real playlist (P0 #2).
async function submitSong() {
  if (!elPlInput) return;
  const raw = elPlInput.value || '';
  const parsed = parseSongInput(raw);
  if (parsed.kind === 'empty') { plHint('Type a song or paste a link first.', 'err'); return; }

  const source = ['spotify', 'ytmusic', 'url', 'text'].includes(parsed.kind) ? parsed.kind : 'text';
  const slot = viewedPlaylistSlot().key;
  const payload = {
    title: (parsed.title || '').trim(),
    artist: (parsed.artist || '').trim(),
    url: parsed.url || '',
    source,
    slot,
  };
  if (!payload.title) { plHint('Type a song or paste a link first.', 'err'); return; }

  // client-side dedupe (best-effort) against this slot's optimistic + Firestore rows.
  const dkey = playlistDedupeKey(payload);
  if (dkey) {
    const existing = visiblePendingAdds(slot).concat(songs.filter((s) => s.slot === slot));
    if (existing.some((s) => playlistDedupeKey(s) === dkey)) {
      plHint('Already added.', 'dupe');
      elPlInput.select();
      return;
    }
  }

  // v7 #2: ensure the slot's MXT-named real playlist exists BEFORE the add, so /add targets it (and
  // we don't race the Worker's gated-create into a second, un-MXT-named playlist). Idempotent.
  let playlistId = (plSlots[slot] && plSlots[slot].spotifyPlaylistId) || '';
  if (!playlistId) {
    const theme = (plSlots[slot] && plSlots[slot].theme) || '';
    try {
      const res = await data.ensurePlaylistForPeriod(slot, theme);
      if (res && res.playlistId) playlistId = res.playlistId;
    } catch (_) { /* fall back to the Worker /add gated-create */ }
  }

  const workerCtx = {
    playlistId,
    playlistName: slotPlaylistName(slot),
    onTrackResolved: onOptimisticTrackResolved, // P0 #2: stamp the resolved track id on the row
  };
  let songId;
  try {
    songId = await data.addSong(payload, workerCtx); // stamps addedBy* + createdAt; returns the id
  } catch (err) {
    plHint('Could not add that song.', 'err');
    return;
  }
  elPlInput.value = '';
  plHint('');
  // optimistic row: a pasted Spotify track link already knows its 22-char id; a typed song gets it
  // stamped later by onOptimisticTrackResolved (P0 #2). Render it dimmed until it lands in /list.
  let trackId = '';
  if (source === 'spotify') {
    const e = spotifyEmbed(payload.url);
    if (e && e.type === 'track') trackId = e.id;
  }
  plOptimisticAdds.unshift({
    id: songId,
    title: payload.title,
    artist: payload.artist,
    url: payload.url,
    source: payload.source,
    slot: payload.slot,
    addedByUserId: myUserId,
    trackId,
    addedAt: Date.now(),
  });
  renderPlaylist();
  // pull the just-added track into the real playlist so the optimistic row reconciles (the Worker
  // resolves+adds async; ~2.5s headroom, force past the cache guard). No-op if the slot has no id.
  setTimeout(() => { syncRealPlaylist(true); }, 2500);
}

// P0 #2: the Worker resolved a typed song to a real track id — stamp it on the optimistic row so the
// reconcile can drop the row once that id appears in the real playlist.
function onOptimisticTrackResolved(songId, trackId) {
  const row = plOptimisticAdds.find((s) => s.id === songId);
  if (row && trackId) row.trackId = trackId;
  if (isDesktop() || activeTab === 'playlist') renderPlaylist();
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
  // footer open-buttons: open the whole-list search (href stashed on the dataset by render).
  const openStashed = (el) => {
    const href = el && el.dataset && el.dataset.href;
    if (href) window.open(href, '_blank', 'noopener');
  };
  if (elPlOpenSpotify) elPlOpenSpotify.addEventListener('click', () => openStashed(elPlOpenSpotify));
  // elPlCollab is a real <a href> (set in render) — no JS click needed.

  // v7 #1: REFRESH — force a re-read of the real Spotify playlist (bypassing the cache guard).
  if (elPlRefresh) elPlRefresh.addEventListener('click', () => { plHint('Refreshing…', 'dupe'); syncRealPlaylist(true); });
  // v7 #3: HISTORY — selecting an archived slot opens its Spotify playlist; reset back to the label.
  if (elPlHistory) {
    elPlHistory.addEventListener('change', () => {
      const url = elPlHistory.value;
      elPlHistory.selectedIndex = 0;
      if (url) window.open(url, '_blank', 'noopener');
    });
  }
  // v7 #4: theme line (tap the name or ✎; Enter/blur commits, Esc cancels). commitThemeEdit decides
  // live-name-current vs submit-idea-for-next based on whether the current period is already themed.
  if (elPlThemeName) elPlThemeName.addEventListener('click', startThemeEdit);
  if (elPlThemeEdit) elPlThemeEdit.addEventListener('click', startThemeEdit);
  if (elPlThemeInput) {
    elPlThemeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitThemeEdit(); }
      else if (e.key === 'Escape') { e.preventDefault(); endThemeEdit(); renderPlaylist(); }
    });
    elPlThemeInput.addEventListener('blur', () => { commitThemeEdit(); });
  }
  // keep the reset countdown fresh while the playlist is visible (text-only tick, never reloads embeds).
  setInterval(() => { if (isDesktop() || activeTab === 'playlist') updateResetBadge(); }, 60000);
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
    elMeNutDone.textContent = isHit ? 'done ✓' : 'mark done manually';
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
      // 'X ago' is a wall-clock DURATION: compare the true-UTC serverTimestamp against
      // raw Date.now(), NOT anchoredNow(). A stale server offset (e.g. derived under a VPN)
      // would otherwise push `now` hours ahead and show a just-logged weigh-in as '6h ago'.
      const rt = relativeTime(laMs, Date.now());
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
    const status = await commitWithTimeout(data.setNutritionHit(cur, !wasManual));
    await withSoftTimeout(refetchMyDays());
    const sfx = status === 'queued' ? ' · will sync' : '';
    toast((!wasManual ? 'nutrition marked done' : 'nutrition cleared') + sfx);
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
    const status = await commitWithTimeout(enqueueMealWrite(() => data.addMeal(cur, { kcal, protein: protein != null ? protein : 0 })));
    if (elMeAddKcal) elMeAddKcal.value = '';
    if (elMeAddProtein) elMeAddProtein.value = '';
    await withSoftTimeout(refetchMyDays());
    toast(status === 'queued' ? 'meal saved · will sync' : 'meal logged');
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
    const status = await commitWithTimeout(enqueueMealWrite(() => data.removeMeal(cur, idx)));
    await withSoftTimeout(refetchMyDays());
    toast(status === 'queued' ? 'meal removed · will sync' : 'meal removed');
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
    const status = await commitWithTimeout(enqueueMealWrite(() => data.addMeal(cur, mealArg)));
    await withSoftTimeout(refetchMyDays());
    toast(status === 'queued' ? 'meal saved · will sync' : 'meal logged');
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
    const status = await commitWithTimeout(data.setDayOff(cur, !isOff));
    await withSoftTimeout(refetchMyDays());
    const sfx = status === 'queued' ? ' · will sync' : '';
    toast((!isOff ? "today won't go red" : 'rest day cleared') + sfx);
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
    const status = await commitWithTimeout(data.setWeight(cur, weight));
    await withSoftTimeout(refetchWeights(myUserId));
    toast(status === 'queued' ? 'weight saved · will sync' : 'weight logged');
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
  // The LOUD "signed out elsewhere" modal is NOT raised here anymore. A permission-
  // denied write can be a real binding takeover OR a non-binding rules rejection (a
  // field/shape skew), and only data.js can tell them apart: it probes write-ownership
  // and fires data.onReclaimNeeded (-> showReclaim) ONLY on a confirmed takeover. Here
  // we just report the failed save; a real takeover surfaces the modal a beat later.
  if (/bad-value|bad-date|bad-range/i.test(tag)) {
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
let daypopHover = false; // v7.1: true when opened via HOVER (transient preview) vs click (pinned)
let daypopSelected = null; // v7.1: {uid,date} of the CLICK-selected own cell (red ring), or null
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
  // nutrition status for THIS day, mode-aware (read-only; never red). v9: judged
  // against the day's own snapshotted goal (else live) via nutritionGoalOpts — the
  // SAME precedence classifyDay paints the cell with, so the popover can never
  // contradict the cell it was opened from after a goal change.
  const now = anchoredNow();
  const cur = currentBusinessDate(now, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
  const ns = nutritionStatus(day, { ...nutritionGoalOpts(day, subject), isPast: dateKey < cur });
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

  // v5.4 TAP-TO-EDIT: on the viewer's OWN cell, for today or a past day (never future,
  // never pre-join), show edit controls. Writes go through the existing owner-scoped paths
  // (commitWorkout / setNutritionHit), so the security model is unchanged.
  // v5.4 (#9): joinDate lives at profile.joinDate (subjectOf stores `profile`, never a
  // top-level joinDate), so the old `subject.joinDate` was always undefined and this
  // pre-join guard never fired. Read the canonical path, matching ui.js:433 / logic.js.
  const jd = subject.profile && subject.profile.joinDate;
  const ownEditable =
    uid === myUserId && dateKey <= cur && (!isDayKey(jd) || dateKey >= jd);
  if (ownEditable) {
    const curType = day.workout === true ? (day.workoutType || '') : '';
    const typeBtns = enabledTypesOf(member)
      .map(
        (k) =>
          `<button class="me-type-btn dd-edit-btn${k === curType ? ' on' : ''}" type="button" data-edit-wtype="${escapeHtml(k)}">${escapeHtml(WTYPE_LABEL[k])}</button>`
      )
      .join('');
    const nutHit = ns === 'hit';
    lines.push(
      `<div class="dd-edit" data-edit-date="${escapeHtml(dateKey)}">` +
        `<div class="dd-edit-h">Edit · workout</div>` +
        `<div class="dd-edit-types">${typeBtns}</div>` +
        `<button class="dd-edit-act" type="button" data-edit-workout="clear">Clear workout</button>` +
        `<div class="dd-edit-h">Edit · nutrition</div>` +
        `<button class="dd-edit-act${nutHit ? ' on' : ''}" type="button" data-edit-nut="${nutHit ? 'clear' : 'hit'}">${nutHit ? 'Clear hit' : 'Mark hit'}</button>` +
      `</div>`
    );
  }

  return lines.join('');
}

// v4 (#4): after a grid rebuild, keep an open popover pinned to its (uid+date) cell. If
// that cell is still present, just RE-POSITION against the fresh node (the body content is
// left as-is — read-only — and the original auto-dismiss timer + outside-tap listener keep
// running, so nothing is duplicated or leaked). If the cell fell out of the window, close.
function reanchorDayPopover() {
  if (!daypopOpen || !daypopAnchor || !elDayPop) return;
  // v5.4 (#6): the popover can be anchored to a SOCIAL grid cell OR a MONTH cell. Re-query
  // ONLY the pane it was OPENED from (stashed on the anchor) — grid and month cells share
  // .gcell + data-uid/data-date, so querying the other pane would cross-match its node.
  // v9.1: the pane comes from the anchor, NOT activeTab — on desktop all panes render at
  // once with activeTab parked elsewhere ('me'), so activeTab mis-picked the container and
  // every repaint either jumped a MONTH popover onto the social grid or closed it.
  const inMonth = daypopAnchor.pane === 'month';
  const container = inMonth ? elMonthGrid : elGrid;
  if (!container) return;
  const sel = `${inMonth ? '.month-cell' : '.gcell'}[data-uid="${cssAttrEscape(daypopAnchor.uid)}"][data-date="${cssAttrEscape(daypopAnchor.date)}"]`;
  const cell = container.querySelector(sel);
  if (cell) {
    positionDayPop(cell); // re-pin to the rebuilt node; don't touch the timer/listener
  } else {
    closeDayPopover(); // the anchored day is no longer on the visible board
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

function openDayPopover(member, dateKey, cellEl, opts) {
  if (!elDayPop) return;
  const hover = !!(opts && opts.hover); // v7.1: HOVER = transient preview (no 5s timer, no
  // outside-tap; closes on mouseleave). CLICK (default) = pinned, with the 5s/outside-tap
  // dismiss so own-cell edit buttons stay usable.
  // v9.2: name only — emoji removed app-wide (Soren 7/4).
  if (elDayPopTitle) elDayPopTitle.innerHTML =
    `<span>${escapeHtml(displayNameOf(member))}</span>`;
  if (elDayPopSub) {
    const g = fmtDateGutter(dateKey);
    elDayPopSub.textContent = `${g.dow} ${g.md}`;
  }
  if (elDayPopBody) elDayPopBody.innerHTML = buildDayPopBody(member, dateKey);

  // show first (so we can measure), then position beside the cell, clamped to #app.
  elDayPop.classList.remove('hidden');
  positionDayPop(cellEl);
  daypopOpen = true;
  daypopHover = hover;
  // v4 (#4): remember what it points at. v9.1: ALSO which pane the anchor cell lives in —
  // derived from the clicked element itself, so reanchorDayPopover re-queries the right
  // container on desktop, where grid + month are both live and activeTab says neither.
  const pane = elMonthGrid && cellEl && typeof elMonthGrid.contains === 'function' && elMonthGrid.contains(cellEl) ? 'month' : 'grid';
  daypopAnchor = { uid: idOf(member), date: dateKey, pane };

  clearTimeout(daypopTimer);
  removeDayPopOutside();
  if (hover) return; // a hover preview is managed by the grid mouseover/mouseleave handlers.

  // CLICK-opened (pinned): mark this cell SELECTED — a red ring that stays until you click away.
  daypopSelected = { uid: idOf(member), date: dateKey };
  if (cellEl && cellEl.classList) cellEl.classList.add('gcell-selected');

  // CLICK-opened: auto-dismiss after ~5s — but NOT while the owner is editing their own day
  // (the 5s timer would close it mid-edit). Editable popovers rely on the outside-tap close.
  const editable =
    idOf(member) === myUserId && isDayKey(dateKey) && (() => { const c = myCurrentBiz(); return !c || dateKey <= c; })();
  if (!editable) daypopTimer = setTimeout(closeDayPopover, DAYPOP_AUTO_MS);

  // dismiss on the NEXT outside tap (defer attach so the opening click doesn't close it).
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
  daypopHover = false;
  daypopAnchor = null; // v4 (#4)
  daypopSelected = null;
  document.querySelectorAll('.gcell-selected').forEach((c) => c.classList.remove('gcell-selected'));
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
  // v7.1: on a HOVER-capable device (desktop) a CLICK acts on your OWN cells only — others'
  // cells preview on mouseover. But touch devices have NO hover, so without this guard a TAP on
  // someone else's square did NOTHING on mobile (Soren 6/26). On no-hover devices let a tap open
  // ANY cell: own cells stay editable, others open the read-only popover (openDayPopover already
  // gates editing to your own cells, so a foreign cell opens read-only with the 5s auto-dismiss).
  const canHover = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
  if (uid !== myUserId && canHover) return;
  const member = memberById(uid);
  if (member) openDayPopover(member, dateKey, cell);
}

// v5.4 TAP-TO-EDIT: the edit buttons inside the open day popover write the viewer's OWN
// day via the existing owner-scoped paths. Delegated on the popover body so it survives the
// in-place body rebuild after each write. Works for both grid AND month taps (both open the
// same popover). Re-checks ownership + not-future on every click — never trusts the markup.
async function onDayPopEditClick(e) {
  const btn =
    e.target.closest && e.target.closest('[data-edit-wtype],[data-edit-workout],[data-edit-nut]');
  if (!btn || !daypopAnchor) return;
  const { uid, date } = daypopAnchor;
  if (uid !== myUserId || !isDayKey(date)) return; // own cells only
  const cur = myCurrentBiz();
  if (cur && date > cur) return; // never edit a future day
  // v5.4 (#9): mirror buildDayPopBody's pre-join guard at the WRITE so a stale popover can't
  // backfill a pre-join own day. joinDate lives at profile.joinDate.
  const me = memberById(myUserId);
  const jd = me && me.profile && me.profile.joinDate;
  if (isDayKey(jd) && date < jd) return;
  try {
    if (btn.dataset.editWtype) {
      // v5.4 (#7): a workout and a rest day are mutually exclusive. On a rest day the rule
      // rejects workout:true and data.markWorkout misreads the denial as a RECLAIM (the loud
      // "signed out elsewhere" modal). Block here exactly like the ME card does (meSetType).
      const days = effectiveDays(myUserId);
      if (days[date] && days[date].off === true) {
        showError('You marked this a rest day. Clear the rest day first to log a workout.');
        return;
      }
      await commitWorkout(date, true, { workoutType: btn.dataset.editWtype });
    } else if (btn.dataset.editWorkout === 'clear') {
      await commitWorkout(date, false);
    } else if (btn.dataset.editNut) {
      const status = await commitWithTimeout(data.setNutritionHit(date, btn.dataset.editNut === 'hit'));
      await withSoftTimeout(refetchMyDays());
      if (status === 'queued') toast('nutrition saved · will sync');
    }
  } catch (err) {
    handleWriteError(err);
  }
  // rebuild the popover body in place so it reflects the new state (delegation persists).
  const member = memberById(uid);
  if (member && elDayPopBody) elDayPopBody.innerHTML = buildDayPopBody(member, date);
}

function wireGridTaps() {
  elGrid.addEventListener('click', (e) => onGridCellActivate(e.target));
  elGrid.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onGridCellActivate(e.target);
    }
  });
  // v7.1: HOVER preview on desktop — moving over a social cell opens the popover instantly;
  // moving off the cell (or off the grid) closes it. A CLICK-pinned popover (daypopOpen &&
  // !daypopHover) is never disturbed, so its edit buttons stay usable.
  let hoverCell = null;
  elGrid.addEventListener('mouseover', (e) => {
    if (!isDesktop()) return;
    if (daypopOpen && !daypopHover) return; // a clicked/pinned popover is open — leave it
    const cell = e.target.closest && e.target.closest('.gcell');
    if (!cell) { if (daypopHover) closeDayPopover(); hoverCell = null; return; }
    if (cell === hoverCell && daypopOpen) return; // already previewing this exact cell
    hoverCell = cell;
    const uid = cell.dataset.uid, dk = cell.dataset.date;
    if (!uid || !isDayKey(dk)) return;
    const member = memberById(uid);
    if (member) openDayPopover(member, dk, cell, { hover: true });
  });
  elGrid.addEventListener('mouseleave', () => {
    hoverCell = null;
    if (daypopHover) closeDayPopover();
  });
  // own-day edit buttons inside the popover (delegated; covers both grid + month taps).
  if (elDayPopBody) elDayPopBody.addEventListener('click', onDayPopEditClick);
}

// =============================================================================
// WEIGHT-CHART SCRUBBER + ZOOM/PAN (v7.2, gestures revised v7.4)
// -----------------------------------------------------------------------------
// READ — DESKTOP: hovering the chart (mouse, no button) shows the NEAREST line's weight
// as a floating chip + a dot ON that line (no vertical line; v7.4 #3). TOUCH: tap/drag
// scrubs (there's no hover on touch). A member with no logged point at/spanning the
// hovered date shows nothing (v7.4 #2 — no clamp, no '*'). ZOOM/PAN: wheel (desktop) /
// pinch (touch) zooms a time+weight window; PLAIN left-mouse drag pans (v7.4 #1, was
// shift+drag); double-tap / dblclick / the reset chip restores. All rendering is
// SYNCHRONOUS (no requestAnimationFrame — a prior rAF on this chart silently never fired
// and left it blank; that bug must not recur). The scrub is an HTML overlay layered over
// the SVG, so it survives the innerHTML rebuilds buildWeightChart does.
// =============================================================================

// map a pointer's client x/y -> the inner-svg viewBox coords, honoring the svg's
// preserveAspectRatio="xMidYMid meet" (which centers + letterboxes when the host
// aspect doesn't match the viewBox). Returns null when the chart isn't measurable.
function wchartViewBox(clientX, clientY) {
  const g = _wchartGeom;
  if (!g || !elWchartSvg) return null;
  const rect = elWchartSvg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / g.vbW, rect.height / g.vbH);
  if (!(scale > 0)) return null;
  const offX = rect.left + (rect.width - g.vbW * scale) / 2;
  const offY = rect.top + (rect.height - g.vbH * scale) / 2;
  return {
    x: (clientX - offX) / scale,
    y: (clientY - offY) / scale,
    rect, scale, offX, offY,
  };
}

// invert yOf: a viewBox y -> a value, using the geometry the chart was drawn with.
// v7.6: lo/hi (and thus the returned value) are now DELTA lbs from each member's base, not
// absolute weights — this operates purely in delta space and is self-consistent. There is no
// single cross-member base, so do NOT add a base back here.
function wchartLbAtY(vy, g) {
  const span = (g.hi - g.lo) || 1;
  return g.lo + (1 - (vy - g.PAD_T) / g.innerH) * span;
}

// the weight to read for a series at a (snapped) date index: the exact point if one
// exists there, else a linear interpolation along the drawn line. v7.4 (#2): returns
// null when idx falls OUTSIDE the series' own logged range — i.e. before their first
// point OR after their last. The old code clamped to the nearest endpoint and flagged
// it with a '*', which surfaced a weight for a person on a date they hadn't logged
// (most jarring BEFORE their first weigh-in). Now a member is only "present" at x when
// they actually have a point at/spanning it, so they get no dot + no readout otherwise
// and they're skipped when picking the nearest line.
function wchartWeightAtIdx(s, idx) {
  const pts = s && s.pts;
  if (!pts || !pts.length) return null;
  const first = pts[0], last = pts[pts.length - 1];
  if (idx < first.idx || idx > last.idx) return null; // no data at/spanning x -> nothing
  if (idx === first.idx) return { lb: first.lb };
  if (idx === last.idx) return { lb: last.lb };
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    if (b.idx === idx) return { lb: b.lb };
    if (b.idx > idx) {
      const a = pts[i - 1];
      if (a.idx === idx) return { lb: a.lb };
      const t = (idx - a.idx) / (b.idx - a.idx);
      return { lb: a.lb + (b.lb - a.lb) * t };
    }
  }
  return { lb: last.lb };
}

function wchartFmtLb(v) {
  const r = Math.round(v * 10) / 10;
  return Math.abs(r - Math.round(r)) < 0.05 ? String(Math.round(r)) : r.toFixed(1);
}

// build the overlay once: a readout chip + a zoom-reset button, inside an absolutely-
// positioned layer over the SVG host. v7.4 (#3): the vertical scrub line is GONE — hover
// shows only the value chip + a dot on the nearest line. pointer-events stay off the layer
// (so the chart underneath still gets the gestures); only the reset button opts back in.
function ensureScrubOverlay() {
  if (_wscrubOverlay) return _wscrubOverlay;
  if (!elWchartSvg) return null;
  const body = elWchartSvg.parentElement; // .wchart-body
  if (!body) return null;
  if (getComputedStyle(body).position === 'static') body.style.position = 'relative';
  const ov = document.createElement('div');
  ov.className = 'wchart-scrub-overlay';
  ov.style.cssText = 'position:absolute; inset:0; pointer-events:none; z-index:5; overflow:hidden;';
  const box = document.createElement('div');
  box.style.cssText =
    'position:absolute; display:none; pointer-events:none; background:var(--g2); ' +
    'border:1px solid var(--hairline); border-radius:8px; padding:5px 8px; ' +
    'font-size:10px; line-height:1.4; color:var(--txt); white-space:nowrap; ' +
    'box-shadow:0 6px 18px rgba(0,0,0,.45);';
  ov.appendChild(box);
  const rb = document.createElement('button');
  rb.type = 'button';
  rb.textContent = 'reset zoom';
  rb.style.cssText =
    'position:absolute; top:5px; right:5px; display:none; pointer-events:auto; ' +
    'font:inherit; font-size:9px; letter-spacing:.04em; padding:3px 8px; border-radius:8px; ' +
    'background:var(--g3); border:1px solid var(--hairline); color:var(--txt2); cursor:pointer;';
  rb.addEventListener('click', (e) => { e.stopPropagation(); resetWchartZoom(); });
  ov.appendChild(rb);
  body.appendChild(ov);
  _wscrubOverlay = ov; _wscrubBox = box; _wscrubResetBtn = rb; _wscrubDots = [];
  return ov;
}

function wchartDot(i) {
  if (_wscrubDots[i]) return _wscrubDots[i];
  const d = document.createElement('div');
  d.style.cssText =
    'position:absolute; width:8px; height:8px; border-radius:50%; border:1.5px solid; ' +
    'box-sizing:border-box; display:none; pointer-events:none;';
  _wscrubOverlay.appendChild(d);
  _wscrubDots[i] = d;
  return d;
}

function hideScrub() {
  _wscrubIdx = null;
  if (_wscrubBox) _wscrubBox.style.display = 'none';
  for (const d of _wscrubDots) d.style.display = 'none';
}

function syncWchartResetBtn() {
  if (!_wscrubResetBtn) ensureScrubOverlay();
  if (_wscrubResetBtn) _wscrubResetBtn.style.display = _wzoom ? 'block' : 'none';
}

// v7.3: drive the scrub from a pointer's CLIENT position. Stashes the client coords (so a later
// geometry rebuild — zoom/pan/range — can re-derive the cursor's viewBox y under the NEW geometry
// and re-pick the nearest line), snaps to the nearest date index for the vertical scrub line, then
// re-renders. renderScrub() shows ONLY the single series whose line is nearest the cursor's y.
function updateScrub(clientX, clientY) {
  const g = _wchartGeom;
  if (!g) return;
  const vb = wchartViewBox(clientX, clientY);
  if (!vb) return;
  _wscrubClientX = clientX;
  _wscrubClientY = clientY;
  const maxIdx = g.rangeDays - 1;
  let idx = Math.round(g.idxAtX(vb.x));
  idx = Math.max(0, Math.min(maxIdx, idx));
  _wscrubIdx = idx;
  renderScrub();
}

// position the dot (on the nearest line, at its weight) + the readout chip for the current
// _wscrubIdx. v7.4 (#3): no vertical line anymore. Cheap DOM writes only — no SVG rebuild.
function renderScrub() {
  const g = _wchartGeom;
  const ov = ensureScrubOverlay();
  if (!ov) return;
  if (_wscrubIdx === null || !g || !g.series || !g.series.length) {
    _wscrubBox.style.display = 'none';
    for (const d of _wscrubDots) d.style.display = 'none';
    return;
  }
  const rect = elWchartSvg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const scale = Math.min(rect.width / g.vbW, rect.height / g.vbH);
  if (!(scale > 0)) return;
  const offX = rect.left + (rect.width - g.vbW * scale) / 2;
  const offY = rect.top + (rect.height - g.vbH * scale) / 2;
  const ovRect = ov.getBoundingClientRect();
  const toX = (vx) => offX + vx * scale - ovRect.left;
  const toY = (vy) => offY + vy * scale - ovRect.top;

  const idx = Math.max(0, Math.min(g.rangeDays - 1, _wscrubIdx));
  // the scrubbed-date x (no line is drawn anymore, but the dot + chip still anchor to it) and the
  // plot's top/bottom y (for clamping the chip on-chart).
  const lineX = toX(g.xOf(idx));
  const topY = toY(g.PAD_T);
  const botY = toY(g.vbH - g.PAD_B);

  // v7.3: pick the SINGLE series whose line is nearest the cursor's y (mapped from the stashed
  // client coords through the CURRENT geometry, so it stays correct after a zoom/pan/range rebuild),
  // and show only that one person's weight. Falls back to ME / the first series if the cursor isn't
  // measurable (e.g. a rebuild with no prior pointer move).
  let cursorVy = null;
  if (_wscrubClientX !== null && _wscrubClientY !== null) {
    const cvb = wchartViewBox(_wscrubClientX, _wscrubClientY);
    if (cvb) cursorVy = cvb.y;
  }
  let nearest = null, nearestW = null, best = Infinity;
  for (const s of g.series) {
    const w = wchartWeightAtIdx(s, idx);
    if (!w) continue;
    const d = cursorVy === null ? (s.isMe ? 0 : 1) : Math.abs(g.yOf(w.lb - s.base) - cursorVy);
    if (d < best) { best = d; nearest = s; nearestW = w; }
  }
  if (!nearest) {
    _wscrubBox.style.display = 'none';
    for (const dd of _wscrubDots) dd.style.display = 'none';
    return;
  }

  // a single dot, sitting on the nearest line at the scrubbed date.
  const dy = toY(g.yOf(nearestW.lb - nearest.base));
  const dot = wchartDot(0);
  dot.style.display = 'block';
  dot.style.left = (lineX - 4) + 'px';
  dot.style.top = (dy - 4) + 'px';
  dot.style.borderColor = nearest.color;
  dot.style.background = nearest.color;
  for (let j = 1; j < _wscrubDots.length; j++) _wscrubDots[j].style.display = 'none';

  // readout: date + the single nearest person (colored swatch + 3-letter tag + lb); red if ME.
  const dk = g.keysOldestFirst[idx];
  _wscrubBox.textContent = '';
  const head = document.createElement('div');
  head.style.cssText = 'font-size:9px; letter-spacing:.04em; color:var(--txt3); margin-bottom:3px;';
  head.textContent = dk ? fmtDateShort(dk) : '';
  _wscrubBox.appendChild(head);
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; align-items:center; gap:6px;' + (nearest.isMe ? ' font-weight:700;' : '');
  const sw = document.createElement('span');
  sw.style.cssText = 'width:7px; height:7px; border-radius:50%; flex:0 0 auto; background:' + nearest.color + ';';
  const tag = document.createElement('span');
  tag.style.cssText = 'color:' + (nearest.isMe ? 'var(--red)' : 'var(--txt2)') + '; min-width:26px;';
  tag.textContent = abbrevName(displayNameOf(nearest.member)) || '?';
  const val = document.createElement('span');
  val.style.cssText = 'color:var(--txt); margin-left:auto; padding-left:10px;';
  // v7.6: chart is re-based, but the scrub readout shows the REAL weight + signed delta from
  // their window base so "what do I weigh" is still answered (wchartFmtLb prints the minus for
  // negatives; we prefix '+' only for positives). v9.2: ABS mode plots real lbs already
  // (base=0 -> dlt IS the weight), so the delta suffix is suppressed there.
  const dlt = nearestW.lb - nearest.base;
  val.textContent = wchartFmtLb(nearestW.lb) +
    (wchartMode === 'abs' || Math.abs(dlt) < 0.05 ? '' : ' (' + (dlt > 0 ? '+' : '') + wchartFmtLb(dlt) + ')');
  row.appendChild(sw); row.appendChild(tag); row.appendChild(val);
  _wscrubBox.appendChild(row);

  // place the chip beside the scrubbed-date x, floating near the dot's y; flip/clamp to stay on-chart.
  _wscrubBox.style.display = 'block';
  const bw = _wscrubBox.offsetWidth || 60;
  let bx = lineX + 10;
  if (bx + bw > ovRect.width - 4) bx = lineX - bw - 10;
  if (bx < 4) bx = 4;
  _wscrubBox.style.left = bx + 'px';
  const bh = _wscrubBox.offsetHeight || 40;
  let by = dy - bh - 8; // float just above the dot
  if (by < topY) by = dy + 8; // not enough room above -> drop below the dot
  if (by + bh > botY) by = Math.max(topY, botY - bh);
  _wscrubBox.style.top = by + 'px';
}

function forceWchartRebuild() {
  _wchartSig = null;
  renderWeightChart(anchoredNow());
}

function resetWchartZoom() {
  if (_wzoom === null) { syncWchartResetBtn(); return; }
  _wzoom = null;
  forceWchartRebuild();
  syncWchartResetBtn();
  if (_wscrubIdx !== null) renderScrub();
}

// zoom both axes about the (vx,vy) viewBox anchor by per-axis factors (f<1 = zoom in).
function wchartZoomAbout(vx, vy, fx, fy) {
  const g = _wchartGeom;
  if (!g) return;
  const maxIdx = g.rangeDays - 1;
  if (maxIdx <= 0) return;
  const i0 = g.vx0, i1 = g.vx1, lo = g.lo, hi = g.hi;
  const spanX0 = (i1 - i0) || 1;
  const spanY0 = (hi - lo) || 1;
  const anchorIdx = Math.max(0, Math.min(maxIdx, g.idxAtX(vx)));
  const anchorLb = wchartLbAtY(vy, g);
  // X window
  let sx = Math.max(2, Math.min(maxIdx, spanX0 * fx));
  let n0 = anchorIdx - (anchorIdx - i0) * (sx / spanX0);
  let n1 = n0 + sx;
  if (n0 < 0) { n1 -= n0; n0 = 0; }
  if (n1 > maxIdx) { n0 -= (n1 - maxIdx); n1 = maxIdx; if (n0 < 0) n0 = 0; }
  // Y window
  let sy = Math.max(2, spanY0 * fy);
  let m0 = anchorLb - (anchorLb - lo) * (sy / spanY0);
  let m1 = m0 + sy;
  // a full zoom-out on both axes snaps back to the clean auto-fit view.
  if (n0 <= 0 && n1 >= maxIdx && m0 <= g.autoLo && m1 >= g.autoHi) { resetWchartZoom(); return; }
  _wzoom = { i0: n0, i1: n1, lo: m0, hi: m1 };
  forceWchartRebuild();
  syncWchartResetBtn();
  if (_wscrubIdx !== null) renderScrub();
}

// drag-pan the zoomed window by a viewBox delta (content follows the pointer).
function wchartPan(dvx, dvy) {
  const g = _wchartGeom;
  if (!g || !_wzoom) return;
  const maxIdx = g.rangeDays - 1;
  const i0 = g.vx0, i1 = g.vx1, lo = g.lo, hi = g.hi;
  const di = -(dvx / g.innerW) * (i1 - i0);
  let n0 = i0 + di, n1 = i1 + di;
  if (n0 < 0) { n1 -= n0; n0 = 0; }
  if (n1 > maxIdx) { n0 -= (n1 - maxIdx); n1 = maxIdx; if (n0 < 0) n0 = 0; }
  const dLb = (dvy / g.innerH) * (hi - lo);
  _wzoom = { i0: n0, i1: n1, lo: lo + dLb, hi: hi + dLb };
  forceWchartRebuild();
  if (_wscrubIdx !== null) renderScrub();
}

// two-finger pinch: per-axis zoom about the centroid + a centroid-follow pan, in one step.
// UNTESTED on real touch in this harness (no touch automation) — desktop wheel/drag cover the
// same math and are verified; verify pinch on a phone.
function wchartPinch(prev, a, b) {
  const g = _wchartGeom;
  if (!g) return null;
  const maxIdx = g.rangeDays - 1;
  if (maxIdx <= 0) return prev;
  const spanX = Math.abs(a.x - b.x), spanY = Math.abs(a.y - b.y);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const i0 = _wzoom ? _wzoom.i0 : g.vx0;
  const i1 = _wzoom ? _wzoom.i1 : g.vx1;
  const lo = _wzoom ? _wzoom.lo : g.lo;
  const hi = _wzoom ? _wzoom.hi : g.hi;
  const fx = (spanX > 4 && prev.spanX > 4) ? prev.spanX / spanX : 1;
  const fy = (spanY > 4 && prev.spanY > 4) ? prev.spanY / spanY : 1;
  const spanX0 = (i1 - i0) || 1, spanY0 = (hi - lo) || 1;
  const anchorIdx = Math.max(0, Math.min(maxIdx, g.idxAtX(cx)));
  const anchorLb = wchartLbAtY(cy, g);
  let sx = Math.max(2, Math.min(maxIdx, spanX0 * fx));
  let sy = Math.max(2, spanY0 * fy);
  let n0 = anchorIdx - (anchorIdx - i0) * (sx / spanX0);
  let n1 = n0 + sx;
  let m0 = anchorLb - (anchorLb - lo) * (sy / spanY0);
  let m1 = m0 + sy;
  // centroid-follow pan
  const dcx = cx - prev.cx, dcy = cy - prev.cy;
  n0 += -(dcx / g.innerW) * sx; n1 += -(dcx / g.innerW) * sx;
  const dLb = (dcy / g.innerH) * sy; m0 += dLb; m1 += dLb;
  if (n0 < 0) { n1 -= n0; n0 = 0; }
  if (n1 > maxIdx) { n0 -= (n1 - maxIdx); n1 = maxIdx; if (n0 < 0) n0 = 0; }
  _wzoom = { i0: n0, i1: n1, lo: m0, hi: m1 };
  forceWchartRebuild();
  syncWchartResetBtn();
  if (_wscrubIdx !== null) renderScrub();
  return { spanX, spanY, cx, cy };
}

// wire all weight-chart pointer interactions ONCE. Pointer events unify mouse + touch + pen;
// a wheel handler adds desktop zoom, dblclick + a document-level off-tap manage reset/hide.
function wireWchartScrub() {
  if (_wscrubWired) return;
  const host = elWchartSvg;
  if (!host) return;
  _wscrubWired = true;
  ensureScrubOverlay();
  host.style.touchAction = 'none'; // let us own pinch/drag instead of the browser scrolling/zooming

  const pointers = new Map(); // pointerId -> last viewBox {x,y}
  let mode = null; // 'scrub' | 'pan' | 'pinch'
  let panPrev = null; // viewBox {x,y}
  let pinchPrev = null; // {spanX, spanY, cx, cy}
  let lastTapT = 0, lastTapX = 0;

  host.addEventListener('pointerdown', (e) => {
    const g = _wchartGeom;
    if (!g) return;
    const vb = wchartViewBox(e.clientX, e.clientY);
    if (!vb) return;
    try { host.setPointerCapture(e.pointerId); } catch (_) {}
    pointers.set(e.pointerId, vb);
    if (pointers.size >= 2) {
      mode = 'pinch';
      hideScrub();
      const it = [...pointers.values()];
      pinchPrev = { spanX: Math.abs(it[0].x - it[1].x), spanY: Math.abs(it[0].y - it[1].y), cx: (it[0].x + it[1].x) / 2, cy: (it[0].y + it[1].y) / 2 };
      e.preventDefault();
      return;
    }
    // v7.4 (#1): PLAIN left-mouse (or pen) drag = PAN — replacing the old shift+drag. A mouse already
    // scrubs on HOVER (the no-button pointermove path), so a press never needs to scrub; starting a pan
    // on press means the drag can't be mis-read as a scrub mid-gesture. Pan is a no-op until zoomed
    // (wchartPan guards on _wzoom) — wheel to zoom, then drag to pan. TOUCH has no hover, so a one-finger
    // tap/drag still SCRUBS there (the only way to read a value without a pointer hover).
    if (e.pointerType !== 'touch') {
      mode = 'pan';
      panPrev = { x: vb.x, y: vb.y };
      e.preventDefault();
      return;
    }
    mode = 'scrub';
    updateScrub(e.clientX, e.clientY);
    e.preventDefault();
  });

  host.addEventListener('pointermove', (e) => {
    // DESKTOP HOVER (v7.3): a mouse moving with NO button held drives the scrub — no click needed.
    // Touch never hovers (no events without a finger down), and a held button (drag/pan) has
    // e.buttons != 0, so this branch is purely the mouse-hover path. Leaving the chart hides it
    // (pointerleave below). A held-button drag falls through to the pan branch (v7.4 #1); wheel-zoom
    // owns its own gesture.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      if (_wchartGeom) updateScrub(e.clientX, e.clientY);
      return;
    }
    if (!pointers.has(e.pointerId)) return;
    const vb = wchartViewBox(e.clientX, e.clientY);
    if (!vb) return;
    pointers.set(e.pointerId, vb);
    if (mode === 'pinch' && pointers.size >= 2) {
      const it = [...pointers.values()];
      pinchPrev = wchartPinch(pinchPrev, it[0], it[1]) || pinchPrev;
      e.preventDefault();
      return;
    }
    if (mode === 'pan' && panPrev) {
      wchartPan(vb.x - panPrev.x, vb.y - panPrev.y);
      panPrev = { x: vb.x, y: vb.y };
      e.preventDefault();
      return;
    }
    if (mode === 'scrub') {
      updateScrub(e.clientX, e.clientY);
      e.preventDefault();
    }
  });

  // DESKTOP (v7.3): leaving the chart with the mouse hides the hover scrub. (No-op for touch; and a
  // captured drag-pan won't fire leave anyway, but guard mid-gesture to be safe.)
  host.addEventListener('pointerleave', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (mode === 'pan' || mode === 'pinch') return;
    hideScrub();
  });

  const onEnd = (e) => {
    const wasScrub = mode === 'scrub';
    pointers.delete(e.pointerId);
    try { host.releasePointerCapture(e.pointerId); } catch (_) {}
    if (pointers.size < 2) pinchPrev = null;
    if (pointers.size === 0) {
      // double-tap (touch) = reset zoom
      if (wasScrub && e.pointerType !== 'mouse') {
        const t = Date.now();
        if (t - lastTapT < 320 && Math.abs(e.clientX - lastTapX) < 24) { resetWchartZoom(); }
        lastTapT = t; lastTapX = e.clientX;
      }
      mode = null; panPrev = null;
    } else if (mode === 'pinch' && pointers.size === 1) {
      // a finger lifted mid-pinch: fall back to scrub with the remaining finger
      mode = null;
    }
  };
  host.addEventListener('pointerup', onEnd);
  host.addEventListener('pointercancel', onEnd);

  // desktop wheel zoom (anchored on the cursor); needs passive:false to preventDefault the page scroll.
  host.addEventListener('wheel', (e) => {
    const g = _wchartGeom;
    if (!g) return;
    const vb = wchartViewBox(e.clientX, e.clientY);
    if (!vb) return;
    e.preventDefault();
    const f = e.deltaY < 0 ? 0.82 : 1 / 0.82;
    wchartZoomAbout(vb.x, vb.y, f, f);
  }, { passive: false });

  // desktop double-click resets zoom.
  host.addEventListener('dblclick', (e) => { e.preventDefault(); resetWchartZoom(); });

  // tap/click anywhere OFF the chart (and off the overlay/reset button) hides the scrub readout.
  document.addEventListener('pointerdown', (e) => {
    if (_wscrubIdx === null) return;
    if (host.contains(e.target)) return;
    if (_wscrubOverlay && _wscrubOverlay.contains(e.target)) return;
    hideScrub();
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
    // v5.4: the body now ANIMATES open (height 0 -> 152px). The SVG reads clientHeight for
    // its viewBox, so rebuild only AFTER the height transition finishes — rebuilding
    // mid-slide (height ~0) yields a wrong aspect. Collapsing needs no rebuild. (No rAF —
    // a prior rAF-wrapped rebuild silently never fired; a transitionend + timeout fallback
    // is robust, incl. prefers-reduced-motion where no transitionend fires.)
    if (!collapsed) {
      const body = elSocialChart.querySelector('.wchart-body');
      const rebuild = () => { _wchartSig = null; renderWeightChart(anchoredNow()); };
      if (body && typeof body.addEventListener === 'function') {
        let done = false;
        const once = (ev) => {
          if (ev.propertyName !== 'height') return;
          done = true;
          body.removeEventListener('transitionend', once);
          rebuild();
        };
        body.addEventListener('transitionend', once);
        setTimeout(() => { if (!done) { body.removeEventListener('transitionend', once); rebuild(); } }, 320);
      } else {
        rebuild();
      }
    }
  });
}

// v4 (#3): the 30d/90d range toggle is a PURE re-render — the 90-day weights window is
// already fetched (WEIGHT_WINDOW_DAYS=90), so switching never refetches.
function wireWeightChart() {
  if (!elWchartToggle) return;
  elWchartToggle.addEventListener('click', (e) => {
    // v9.2: REL/ABS mode pair (checked FIRST — the mode buttons reuse .wc-range for styling).
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) {
      const m = modeBtn.dataset.mode;
      if ((m !== 'rel' && m !== 'abs') || m === wchartMode) return;
      wchartMode = m;
      // the y space changes entirely (deltas vs absolute lbs) — a carried zoom window or
      // scrub index would be meaningless, same reasoning as the range switch below.
      _wzoom = null;
      _wscrubIdx = null;
      _wchartSig = null;
      renderWeightChart(anchoredNow());
      syncWchartResetBtn();
      renderScrub();
      return;
    }
    const btn = e.target.closest('[data-range]');
    if (!btn) return;
    const r = Number(btn.dataset.range);
    if (r !== 30 && r !== 90) return;
    if (r === wchartRange) return;
    wchartRange = r;
    // v7.2: the index space changes with the range, so a carried-over zoom window or scrub index
    // would be meaningless — drop both before the rebuild.
    _wzoom = null;
    _wscrubIdx = null;
    _wchartSig = null; // v4 (#1c): force a rebuild — the range changed, the dirty-check must not skip it
    renderWeightChart(anchoredNow());
    if (typeof syncWchartResetBtn === 'function') syncWchartResetBtn();
    if (typeof renderScrub === 'function') renderScrub();
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

// v9.2 (perf): CACHE-FIRST content paint. On a returning device the first /users
// snapshot arrives from IndexedDB in ~ms, but every cell then sat 'pending' until the
// members' /days + /weights getDocs returned from the SERVER (a full round-trip on gym
// wifi). Prime both maps from the local Firestore cache once — last session's truth
// paints instantly — then the normal server fetch below overwrites with live truth.
// Guards: per-uid has() checks so a server result that somehow lands first is never
// clobbered by the (stale) cache pass; a fresh install just gets empty maps back.
let _cachePrimed = false;
function primeFromCache(uids, now) {
  if (_cachePrimed || !uids.length) return;
  _cachePrimed = true;
  const cur = viewerBusinessDate(now);
  const fromD = fromKeyFor(cur, 120);
  const fromW = fromKeyFor(cur, WEIGHT_WINDOW_DAYS);
  Promise.all(uids.map(async (uid) => {
    try {
      const [d, w] = await Promise.all([
        data.fetchDays(uid, fromD, cur, { fromCache: true }),
        data.fetchWeights(uid, fromW, cur, { fromCache: true }),
      ]);
      if (d && Object.keys(d).length && !daysByUser.has(uid)) daysByUser.set(uid, d);
      if (w && Object.keys(w).length && !weightsByUser.has(uid)) weightsByUser.set(uid, w);
    } catch (_) { /* cache miss — the server pass fills it */ }
  })).then(() => repaint());
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

  // v9.2 (perf): instant content from the local cache on the very first snapshot; the
  // server fetch below then overwrites it with live truth (per-uid guards inside).
  primeFromCache(members.map(idOf), now);

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
  hideLoading(); // board has painted — drop the loading overlay + re-enable taps
}

// =============================================================================
// LOADING OVERLAY — shown until the board first paints; blocks taps so nobody clicks a
// not-yet-interactive board. Hidden on the first render or when a fatal banner shows.
// =============================================================================
let _loadingHidden = false;
function hideLoading() {
  if (_loadingHidden) return;
  _loadingHidden = true;
  const el = document.getElementById('loading');
  if (el) el.classList.add('hidden');
}

// =============================================================================
// FATAL BANNER
// =============================================================================
function fatal(title, bodyHtml) {
  hideLoading();
  elBoot.innerHTML =
    `<div class="boot-title">${escapeHtml(title)}</div><div class="boot-body">${bodyHtml}</div>`;
  elBoot.classList.remove('hidden');
}

// =============================================================================
// BOOT SEQUENCE (order is load-bearing)
// =============================================================================
async function boot() {
  // safety net: if the first Firestore snapshot never arrives (offline / permission), still
  // drop the loading overlay after 12s so the app is never stuck behind the spinner.
  setTimeout(hideLoading, 12000);
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

  // 3. self-create the minimal first-run /users doc if absent (joinDate + rest anchor).
  // Fire-and-forget: the live subscribe below does NOT depend on it. A returning user's
  // doc already exists; a first-run doc lands in the snapshot the moment its create commits.
  // Awaiting it here previously put a serial getDoc round-trip in front of the first paint on
  // EVERY boot (the biggest avoidable cold-load stall after auth+bind). Still non-fatal.
  data.ensureUserDoc(myUserId).catch(() => {
    /* non-fatal: doc may already exist (admin-seeded) or self-create races the snapshot */
  });

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

  // 4b. v5 (#5): live PLAYLIST wall — PARKED behind PLAYLIST_ENABLED (v9.2): skips both
  // onSnapshot listeners, the playlistMeta getDoc, and everything downstream of them.
  if (PLAYLIST_ENABLED) {
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
  }

  // wire interactions + timers
  wireTabs();
  wireTheme();
  wireSwipe();
  setupResponsiveMode(); // v7 (#B): pick desktop one-screen vs mobile tabbed + watch the MQL
  wireMe();
  wireGridTaps();
  wireWeekNav();
  wireMonth(); // v5 (#4): MONTH tab — chip selector + month nav + day taps
  if (PLAYLIST_ENABLED) wirePlaylist(); // v5 (#5): parked — add-bar wiring + the 60s reset-badge tick
  wireWeightChart();
  wireWchartScrub(); // v7.2: tap/drag scrubber + pinch/wheel zoom on the weight chart
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
