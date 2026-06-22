// =============================================================================
// gymboard — pure logic core  (logic.js)
// -----------------------------------------------------------------------------
// Pure ES module. NO Firebase, NO DOM, only the built-in `Intl`. Everything in
// here is deterministic given its inputs, so logic.test.mjs can prove it under
// plain Node with no network and no SDK.
//
// The contract these functions implement is the DESIGN.md "Time & Missed Logic"
// and "Data Model" sections, verbatim:
//   - businessDate buckets an instant to the subject's zoned calendar date,
//     shifted back by a per-user rollover (default 04:00). A 02:00 workout with
//     a 04:00 cutoff belongs to the PREVIOUS calendar day.
//   - "previous business-date" is ALWAYS a calendar-field decrement on a
//     'YYYY-MM-DD' string — NEVER `-24*60*60*1000` ms. DST local days are 23/25h
//     long, so fixed-ms subtraction is wrong on those days.
//   - `missed` is computed on read, never stored, evaluated against the SUBJECT's
//     own clock, and fails SAFE (false) for a brand-new/unconfigured user.
//   - rest resolution: pick the restPattern entry with the largest
//     effectiveFrom <= D, test D's weekday against its `weekdays`, THEN apply
//     perDateOverrides[D] (override wins).
//   - group consistency excludes bonuses and can never exceed 100%.
//
// `instant`/`nowInstant` are epoch-millisecond numbers (Date.now()-style). The
// caller is responsible for anchoring `nowInstant` to the server-time offset
// (Date.now() + serverOffset) before passing it here for missed/streak — this
// module just does the math on whatever instant it is handed.
// =============================================================================

// ---- date-key string helpers (pure string/number math, DST-irrelevant) ------

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** True if `s` is a well-formed 'YYYY-MM-DD' calendar-date string. */
export function isDayKey(s) {
  return typeof s === 'string' && DAY_KEY_RE.test(s);
}

/**
 * Decrement a 'YYYY-MM-DD' calendar date by one day, rolling month/year.
 * Pure string/number arithmetic on the calendar fields — DST cannot affect this
 * because no instant/offset is involved. This is the ONLY way the codebase ever
 * computes a "previous business-date".
 *
 * Uses Date.UTC purely as a civil-calendar lookup (days-in-month, leap years);
 * UTC is chosen so it carries no timezone/DST behaviour of its own.
 */
export function prevBusinessDate(dateKey) {
  if (!isDayKey(dateKey)) {
    throw new TypeError(`prevBusinessDate: not a YYYY-MM-DD key: ${dateKey}`);
  }
  const y = +dateKey.slice(0, 4);
  const m = +dateKey.slice(5, 7); // 1-12
  const d = +dateKey.slice(8, 10); // 1-31
  if (d > 1) {
    return `${pad2(y)}-${pad2(m)}-${pad2(d - 1)}`;
  }
  // First of the month: step into the last day of the previous month. Date.UTC
  // with day=0 yields the last day of the prior month and rolls the year for us.
  const prev = new Date(Date.UTC(y, m - 1, 0)); // month is 0-based here
  return `${pad2(prev.getUTCFullYear())}-${pad2(prev.getUTCMonth() + 1)}-${pad2(prev.getUTCDate())}`;
}

// ---- the core: zoned wall-clock bucketing ------------------------------------

// Cache one DateTimeFormat per zone — constructing them is the expensive part,
// and missed()/streak walks call businessDate repeatedly for the same zone.
const _dtfCache = new Map();
function dtfFor(ianaTz) {
  let dtf = _dtfCache.get(ianaTz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaTz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23', // 00..23, so midnight is hour 00 not 24 (avoids the h24/12h trap)
    });
  }
  _dtfCache.set(ianaTz, dtf);
  return dtf;
}

/**
 * Render an epoch-ms instant as the subject's wall-clock components in `ianaTz`.
 * DST is applied by the Intl zone database — we never touch UTC offsets.
 * @returns {{year:number,month:number,day:number,hour:number,minute:number}}
 */
function wallClockParts(instant, ianaTz) {
  const parts = dtfFor(ianaTz).formatToParts(new Date(instant));
  const get = (t) => {
    const p = parts.find((x) => x.type === t);
    return p ? +p.value : NaN;
  };
  let hour = get('hour');
  // h23 should give 0..23, but some engines historically emitted '24' at midnight.
  if (hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'), // 1-12
    day: get('day'), // 1-31
    hour,
    minute: get('minute'),
  };
}

/**
 * businessDate(instant, ianaTz, rolloverHour=4, rolloverMinute=0)
 *
 * The business-date is the calendar date IN THE SUBJECT'S ZONE of the instant,
 * shifted back by the rollover. Steps (DESIGN.md "Time & Missed Logic"):
 *   1. Render instant as zoned wall-clock {y,m,d,hour,minute} via Intl.
 *   2. localMinutes = hour*60 + minute.
 *   3. cutoff = rolloverHour*60 + rolloverMinute  (default 240 = 04:00).
 *   4. If localMinutes < cutoff -> business-date = local calendar date MINUS ONE
 *      DAY (calendar-field decrement). Else -> the local calendar date as-is.
 *   5. Format 'YYYY-MM-DD'.
 *
 * The cutoff is inclusive of the new day: local 04:00 with a 04:00 cutoff is the
 * SAME day (240 is not < 240); local 02:00 is the previous day. The minus-one-day
 * step is a pure calendar decrement (prevBusinessDate), never an ms subtraction,
 * so it is correct on 23h/25h DST days.
 */
export function businessDate(instant, ianaTz, rolloverHour = 4, rolloverMinute = 0) {
  const { year, month, day, hour, minute } = wallClockParts(instant, ianaTz);
  const localKey = `${pad2(year)}-${pad2(month)}-${pad2(day)}`;
  const localMinutes = hour * 60 + minute;
  const cutoff = rolloverHour * 60 + rolloverMinute;
  return localMinutes < cutoff ? prevBusinessDate(localKey) : localKey;
}

/**
 * currentBusinessDate(nowInstant, ianaTz, rolloverHour=4, rolloverMinute=0)
 * The subject's business-date for "now". Thin wrapper over businessDate so call
 * sites read intentionally; `nowInstant` should be the server-anchored now.
 */
export function currentBusinessDate(nowInstant, ianaTz, rolloverHour = 4, rolloverMinute = 0) {
  return businessDate(nowInstant, ianaTz, rolloverHour, rolloverMinute);
}

// ---- business week key (Mon-Sun) ---------------------------------------------

/**
 * businessWeekKey(dateKey) -> the Monday 'YYYY-MM-DD' that opens the ISO-style
 * Mon..Sun week containing dateKey. A pure civil-calendar computation on the
 * date STRING (no instant, so DST-irrelevant). Sunday belongs to the week that
 * started the PRIOR Monday (Mon=start, Sun=end), matching DESIGN's "Mon-Sun
 * week window" for the consistency hero.
 *
 * The returned key is the week id; two dates in the same Mon..Sun span share it.
 */
export function businessWeekKey(dateKey) {
  if (!isDayKey(dateKey)) {
    throw new TypeError(`businessWeekKey: not a YYYY-MM-DD key: ${dateKey}`);
  }
  const y = +dateKey.slice(0, 4);
  const m = +dateKey.slice(5, 7);
  const d = +dateKey.slice(8, 10);
  // getUTCDay: 0=Sun..6=Sat. Days to step back to land on Monday:
  //   Mon(1)->0, Tue(2)->1, ... Sun(0)->6.
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const back = (dow + 6) % 7;
  let key = dateKey;
  for (let i = 0; i < back; i++) key = prevBusinessDate(key);
  return key;
}

// ---- rest-day resolution ------------------------------------------------------

function weekdayOf(dateKey) {
  const y = +dateKey.slice(0, 4);
  const m = +dateKey.slice(5, 7);
  const d = +dateKey.slice(8, 10);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun..6=Sat
}

/**
 * isRestDay(restPattern, perDateOverrides, dateKey)
 *
 * Resolve whether business-date `dateKey` is a scheduled REST day:
 *   1. From restPattern (array of {effectiveFrom:'YYYY-MM-DD', weekdays:[0..6]}),
 *      pick the entry with the LARGEST effectiveFrom <= dateKey.
 *   2. dateKey is a rest day if its weekday (0=Sun..6=Sat) is in that entry's
 *      `weekdays`.
 *   3. THEN apply perDateOverrides[dateKey] ('rest' | 'train'); the override
 *      WINS over the pattern.
 *
 * Fail-safe: no pattern / no applicable version / malformed inputs -> not a rest
 * day from the pattern (a brand-new user has no rest days, so nothing reds — but
 * also nothing is wrongly excused; missed() handles the fail-safe at the top).
 * An explicit override still wins even when no pattern applies.
 */
export function isRestDay(restPattern, perDateOverrides, dateKey) {
  if (!isDayKey(dateKey)) return false;

  // 1-2: resolve from the pattern version effective at dateKey.
  let restFromPattern = false;
  if (Array.isArray(restPattern) && restPattern.length) {
    let chosen = null;
    for (const entry of restPattern) {
      if (!entry || !isDayKey(entry.effectiveFrom)) continue;
      if (entry.effectiveFrom <= dateKey) {
        if (!chosen || entry.effectiveFrom > chosen.effectiveFrom) chosen = entry;
      }
    }
    if (chosen && Array.isArray(chosen.weekdays)) {
      restFromPattern = chosen.weekdays.includes(weekdayOf(dateKey));
    }
  }

  // 3: per-date override wins.
  if (perDateOverrides && Object.prototype.hasOwnProperty.call(perDateOverrides, dateKey)) {
    const ov = perDateOverrides[dateKey];
    if (ov === 'rest') return true;
    if (ov === 'train') return false;
  }
  return restFromPattern;
}

// ---- the missed predicate (computed on read, never stored) -------------------

/**
 * A `subject` is the public /users doc shape this module needs:
 *   {
 *     ianaTz: string,
 *     rolloverHour?: number, rolloverMinute?: number,
 *     restPattern?: Array<{effectiveFrom, weekdays}>,
 *     perDateOverrides?: { [dateKey]: 'rest'|'train' },
 *     profile?: { joinDate?: 'YYYY-MM-DD' },
 *   }
 * Day cells are passed separately (daysMap) so this module never imports data.
 */

function rollover(subject) {
  return {
    h: Number.isFinite(subject?.rolloverHour) ? subject.rolloverHour : 4,
    m: Number.isFinite(subject?.rolloverMinute) ? subject.rolloverMinute : 0,
  };
}

/**
 * missed(subject, dateKey, nowInstant, day)
 *
 * DESIGN's predicate, all five conjuncts:
 *   missed =  isPast(D, S)               // D strictly before S's CURRENT bizdate
 *         AND not isRestDay(S, D)        // pattern-at-D then perDateOverrides[D]
 *         AND not day.workout
 *         AND not day.off
 *         AND D >= S.profile.joinDate    // pre-join days never red
 *
 * `day` is the DayEntry at /users/{u}/days/{dateKey} or undefined/null if no doc
 * exists for that date (a brand-new user has none). Missing doc => workout/off
 * both falsey => still gated by the other conjuncts.
 *
 * Fails SAFE: a subject with no ianaTz, or any malformed input, returns false.
 * `nowInstant` should be the server-anchored now (Date.now()+offset).
 */
export function missed(subject, dateKey, nowInstant, day) {
  if (!subject || !subject.ianaTz || !isDayKey(dateKey)) return false;

  // Fail SAFE for an unconfigured user. DESIGN §12: a brand-new user (no
  // restPattern, no day docs) is "not missed" EVERYWHERE. The structural anchor
  // for that is joinDate: first-open setup writes joinDate + the first
  // restPattern version effective from it (§11), so a configured subject always
  // has a joinDate. Without a joinDate there is no date from which "you should
  // have trained" can be asserted, so nothing can be missed. This also makes
  // pre-setup days never retro-red the moment a pattern is later added.
  const joinDate = subject.profile && subject.profile.joinDate;
  if (!isDayKey(joinDate)) return false;

  // pre-join: any date before joinDate is never missed (design rule).
  if (dateKey < joinDate) return false;

  // isPast: D strictly before the subject's CURRENT business-date (their clock).
  const { h, m } = rollover(subject);
  const cur = currentBusinessDate(nowInstant, subject.ianaTz, h, m);
  if (!(dateKey < cur)) return false; // current + future are never missed

  // rest days are never missed.
  if (isRestDay(subject.restPattern, subject.perDateOverrides, dateKey)) return false;

  // a logged workout or an OFF flag clears it.
  if (day && day.workout === true) return false;
  if (day && day.off === true) return false;

  return true;
}

// ---- streak (consecutive non-missed, ending at the most recent decided day) --

/**
 * computeStreak(daysMap, subject, nowInstant)
 *
 * Per-person streak = consecutive NON-MISSED business-dates ending at the most
 * recent decided day. A day counts (preserves the streak) if it is NOT missed:
 * trained, rest, OFF, bonus, and pre-join all preserve it; ONLY a missed day
 * breaks it (resets to 0). Current/future days are never missed, so a pending
 * today never breaks the streak.
 *
 * daysMap: { [dateKey]: DayEntry } — the subject's authoritative /days docs.
 *          The board RECOMPUTES this on read (a viewer's recompute wins over any
 *          cached `streak`), which is exactly what this function is for.
 *
 * Algorithm: walk backward by CALENDAR-DAY decrement (prevBusinessDate) from the
 * day just before the subject's current business-date (today is still pending and
 * not yet decided). Count consecutive non-missed days; stop at the first missed
 * day, at joinDate, or after a bounded look-back so an empty history terminates.
 */
export function computeStreak(daysMap, subject, nowInstant, maxLookback = 800) {
  if (!subject || !subject.ianaTz) return 0;

  // An unconfigured user (no joinDate) has no anchored history. missed() now
  // fails safe to false for them (DESIGN §12), so a naive walk would count
  // maxLookback phantom "non-missed" days. Their streak is simply 0 until setup
  // writes a joinDate. (A configured subject always has one — §11.)
  const joinDate = subject.profile && subject.profile.joinDate;
  if (!isDayKey(joinDate)) return 0;

  const { h, m } = rollover(subject);
  const cur = currentBusinessDate(nowInstant, subject.ianaTz, h, m);
  const days = daysMap || {};

  let streak = 0;
  let cursor = prevBusinessDate(cur); // most recent DECIDED day (yesterday in-zone)

  for (let i = 0; i < maxLookback; i++) {
    // Stop once we step before the join date — pre-join days don't extend it.
    if (cursor < joinDate) break;

    if (missed(subject, cursor, nowInstant, days[cursor])) break; // a real miss ends it
    streak += 1;
    cursor = prevBusinessDate(cursor);
  }
  return streak;
}

// ---- group weekly consistency % ----------------------------------------------

/**
 * groupConsistency(allMembersDays, weekKey, nowInstant)
 *
 * The hero stat. DESIGN §8 semantics, recomputed from authoritative /days docs:
 *   - denominator (expected) = sum over members of their SCHEDULED TRAINING days
 *     (not rest, not OFF, on/after joinDate) that are PAST (strictly before the
 *     member's current business-date) within the Mon..Sun week of weekKey.
 *   - numerator (completed)  = of those expected days, the count with
 *     day.workout === true.
 *   - a bonus (rest-day or OFF-day workout) enters NEITHER, so the % can never
 *     exceed 100%. Bonuses are surfaced separately as a count.
 *   - each subject is evaluated against THEIR OWN clock/rest pattern, then summed.
 *
 * `allMembersDays` is an array of { subject, days } where `subject` is the public
 * doc shape used elsewhere here and `days` is that member's { [dateKey]: DayEntry }.
 * Archived members must be filtered out by the caller before passing in.
 *
 * Returns { expected, completed, percent, bonus } where percent is an integer
 * 0..100 (0 when expected===0, never >100), and the displayed fraction is the
 * caller's to clamp (completed<=expected always holds here by construction).
 */
export function groupConsistency(allMembersDays, weekKey, nowInstant) {
  if (!isDayKey(weekKey)) throw new TypeError(`groupConsistency: bad weekKey ${weekKey}`);

  // Build the 7 date keys of the Mon..Sun week, forward from the Monday weekKey.
  const weekStart = businessWeekKey(weekKey); // normalize (accept any day in-week)
  const weekDays = [weekStart];
  for (let i = 1; i < 7; i++) weekDays.push(nextDayKey(weekDays[i - 1]));

  let expected = 0;
  let completed = 0;
  let bonus = 0;

  for (const member of allMembersDays || []) {
    const subject = member && member.subject;
    if (!subject || !subject.ianaTz) continue;
    const days = (member && member.days) || {};
    const { h, m } = rollover(subject);
    const cur = currentBusinessDate(nowInstant, subject.ianaTz, h, m);
    const joinDate = subject.profile && subject.profile.joinDate;

    for (const D of weekDays) {
      // pre-join days are out of scope entirely.
      if (isDayKey(joinDate) && D < joinDate) continue;
      // only PAST days count toward expected (a pending today isn't "expected" yet).
      if (!(D < cur)) continue;

      const day = days[D];
      const rest = isRestDay(subject.restPattern, subject.perDateOverrides, D);
      const off = !!(day && day.off === true);
      const trained = !!(day && day.workout === true);

      if (rest || off) {
        // rest/OFF days are excluded from the denominator. A workout on one is a
        // BONUS — counts in neither numerator nor denominator, surfaced separately.
        if (trained) bonus += 1;
        continue;
      }

      // a scheduled training day, in the past:
      expected += 1;
      if (trained) completed += 1; // missed (expected & not trained) stays out of numerator
    }
  }

  const percent = expected === 0 ? 0 : Math.round((completed / expected) * 100);
  return { expected, completed, percent, bonus };
}

// next-day calendar increment, mirror of prevBusinessDate (kept private; the
// week builder needs to step forward from the Monday).
function nextDayKey(dateKey) {
  const y = +dateKey.slice(0, 4);
  const m = +dateKey.slice(5, 7);
  const d = +dateKey.slice(8, 10);
  const next = new Date(Date.UTC(y, m - 1, d + 1)); // day+1 rolls month/year
  return `${pad2(next.getUTCFullYear())}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

// ---- weight trend (under-name arrow, colored by goal) ------------------------

// Whole-day count between two 'YYYY-MM-DD' keys (b - a), via UTC midnight
// arithmetic. Both are pure civil dates with no instant, so UTC carries no
// timezone/DST behaviour of its own (mirrors prevBusinessDate's use of Date.UTC
// as a plain calendar lookup). Returns b minus a in days (can be negative).
function dayKeyDiff(a, b) {
  const ua = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const ub = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  return Math.round((ub - ua) / 86400000);
}

// Maintain band: a move within +/-1.0 lb of the comparison reads as "holding",
// which for a maintain goal is TOWARD the goal. Stored once so the helper and
// its tests agree on the threshold.
const MAINTAIN_BAND_LB = 1.0;

/**
 * weightTrend(weightsByDate, goal, asOfKey)
 *
 * Compute the under-name weight figure + trend arrow for one member.
 * SPEC-v2 "Weight/goal": the number is neutral; the ARROW is colored by goal —
 * green when moving TOWARD the goal (gain=up, lose=down, maintain=within +/-1 lb
 * over ~7 days), red when away. Compare the latest weigh-in vs ~7 days before it
 * (or the nearest EARLIER weigh-in if none sits exactly at 7d).
 *
 *   weightsByDate : { [dateKey:'YYYY-MM-DD']: lb:number } — a member's weigh-ins,
 *                   one lb per business-date (latest-per-day; data.js dedupes).
 *   goal          : 'gain' | 'lose' | 'maintain' (anything else treated as maintain).
 *   asOfKey       : 'YYYY-MM-DD' — evaluate "as of" this business-date; the latest
 *                   entry ON or BEFORE it is the current figure. Pass the viewer's
 *                   current business-date so future backfills don't leak in.
 *
 * Returns { latestLb, dir, toward }:
 *   latestLb : number | null — the latest lb on/before asOfKey (null if none).
 *   dir      : 'up' | 'down' | 'flat' — latest vs the comparison point. 'flat'
 *              when they're exactly equal OR when there is no comparison point.
 *   toward   : boolean | null — is the move TOWARD the goal? null when there
 *              isn't enough data to decide (no latest, or no earlier comparison
 *              point). gain: up=>true. lose: down=>true. maintain: |delta|<=1lb
 *              => true. A flat move (delta 0) is toward for maintain, and is
 *              NOT toward for gain/lose (you haven't moved the right way).
 *
 * Pure: no Firebase, no DOM, no clock. Hidden-weight gating happens upstream
 * (the caller passes {} / no entries for a hidden member, yielding all-null).
 */
export function weightTrend(weightsByDate, goal, asOfKey) {
  const NONE = { latestLb: null, dir: 'flat', toward: null };
  if (!weightsByDate || typeof weightsByDate !== 'object') return NONE;
  if (!isDayKey(asOfKey)) return NONE;

  // Valid (key, lb) pairs on/before asOfKey, ascending by date.
  const entries = [];
  for (const key of Object.keys(weightsByDate)) {
    if (!isDayKey(key)) continue;
    if (key > asOfKey) continue; // ignore future backfills relative to "as of"
    const lb = weightsByDate[key];
    if (!Number.isFinite(lb)) continue;
    entries.push([key, lb]);
  }
  if (entries.length === 0) return NONE;
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const [latestKey, latestLb] = entries[entries.length - 1];

  // Comparison point: the entry nearest to ~7 days before latestKey, choosing
  // among entries STRICTLY EARLIER than latestKey. "Nearest" = smallest absolute
  // distance from the 7-day mark; ties (e.g. equidistant 6d vs 8d) prefer the
  // OLDER (further-back) one, which never overstates a short-window swing.
  let cmpLb = null;
  let bestScore = Infinity;
  for (let i = entries.length - 2; i >= 0; i--) {
    const gap = dayKeyDiff(entries[i][0], latestKey); // days before latest (>0)
    const score = Math.abs(gap - 7);
    // i descends => older entries seen later; `<=` lets an equal-or-better older
    // entry win the tie, so the further-back point is preferred on a tie.
    if (score <= bestScore) {
      bestScore = score;
      cmpLb = entries[i][1];
    }
  }

  if (cmpLb === null) {
    // Only one weigh-in (or all on the same day): a number, but no trend.
    return { latestLb, dir: 'flat', toward: null };
  }

  const delta = latestLb - cmpLb;
  const dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

  let toward;
  if (goal === 'gain') toward = delta > 0;
  else if (goal === 'lose') toward = delta < 0;
  else toward = Math.abs(delta) <= MAINTAIN_BAND_LB; // maintain (and default)

  return { latestLb, dir, toward };
}

// ---- nutrition auto-check (derived from goals + running totals) --------------

// Maintain band: kcal within +/-MAINTAIN_PCT of kcalGoal reads as on-target.
// Stored once so the helper and its tests agree on the threshold (mirrors the
// MAINTAIN_BAND_LB pattern weightTrend uses).
const MAINTAIN_PCT = 0.1; // +/-10%

/**
 * nutritionStatus(day, opts) -> 'hit' | 'pending' | 'none'
 *
 * SPEC-v4 §4+§6. MODE-AWARE nutrition auto-check. Each person has a
 * `nutritionMode` ('manual' | 'protein' | 'both') that decides which goals (if
 * any) auto-check the day. Nutrition NEVER uses red — these three values map to
 * green (hit) / quiet fill (pending) / quiet gray (none), none of them red.
 *
 *   day  : the DayEntry { kcal?, protein?, ate?, macros?, ... } or undefined/null.
 *   opts : { nutritionMode, kcalGoal, proteinGoal, goal, isPast }
 *          nutritionMode : 'manual' | 'protein' | 'both'. Anything else
 *                          (incl. undefined) => 'both' (back-compat default).
 *          goal    : 'gain' | 'lose' | 'maintain' (anything else => 'maintain').
 *                    Only consulted in 'both' mode.
 *          isPast  : true if dateKey < the subject's current business-date.
 *                    The caller computes this via currentBusinessDate; this fn
 *                    stays pure and only branches on the boolean.
 *
 * Returns:
 *   'hit'     -> mode satisfied (or manual override) — green.
 *   'pending' -> today/future, not yet met — quiet fill (NEVER red).
 *   'none'    -> a past day that never met — quiet gray (NEVER red).
 *
 * Resolution order (SPEC-v4 §4, NO logic gaps):
 *   notMet = isPast ? 'none' : 'pending'
 *   1. MANUAL OVERRIDE (all modes): day.ate === true || day.macros === true
 *      => 'hit'. Manual always wins, in every mode including 'manual'.
 *   2. MODE 'manual': no auto-check ever -> notMet (step 1 was the only hit path).
 *   3. MODE 'protein':
 *        a. proteinGoal not finite (unset) -> manual-only -> notMet.
 *        b. P = finite day.protein else 0; if !(P > 0) -> notMet (0 never hits).
 *        c. P >= proteinGoal -> 'hit', else notMet. (Calories IGNORED.)
 *   4. MODE 'both' (and default):
 *        a. NOT (kcalGoal finite AND proteinGoal finite) -> manual-only -> notMet
 *           (half-configured treated as unset, no accidental silent pass).
 *        b. K = finite day.kcal; if !(K > 0) -> notMet (0-kcal never auto-greens).
 *        c. P = finite day.protein else 0.
 *        d. band = MAINTAIN_PCT*kcalGoal; direction rule (inclusive bounds):
 *             lose     : K <= KG          AND P >= PG
 *             gain     : K >= KG          AND P >= PG
 *             maintain : |K - KG| <= band AND P >= PG   (unknown goal => maintain)
 *        e. rule met -> 'hit', else notMet.
 *
 * protein is treated as 0 when absent (so a kcal-only 'both' day can't pass the
 * floor unless proteinGoal is 0).
 */
export function nutritionStatus(day, opts = {}) {
  const { nutritionMode, kcalGoal, proteinGoal, goal, isPast } = opts;
  const notMet = isPast ? 'none' : 'pending';

  // 1. Manual override always wins, in EVERY mode. Legacy `macros` bool too.
  if (day && (day.ate === true || day.macros === true)) return 'hit';

  // Normalize the mode; anything unrecognized => 'both' (back-compat default).
  const mode =
    nutritionMode === 'manual' || nutritionMode === 'protein' ? nutritionMode : 'both';

  // 2. MANUAL: no auto-check ever — step 1 was the only way it could hit.
  if (mode === 'manual') return notMet;

  // 3. PROTEIN: auto-hit when protein >= proteinGoal; calories ignored entirely.
  if (mode === 'protein') {
    if (!Number.isFinite(proteinGoal)) return notMet; // unset -> manual-only
    const P = day && Number.isFinite(day.protein) ? day.protein : 0;
    // 0 intake never auto-hits, but ONLY when there's a positive goal to meet; a
    // proteinGoal of 0 is satisfied by 0 (0>=0), matching 'both' mode's goal-0 floor.
    if (proteinGoal > 0 && !(P > 0)) return notMet;
    return P >= proteinGoal ? 'hit' : notMet;
  }

  // 4. BOTH (default): calories-in-range (by goal direction) AND protein floor.
  // 4a. Both goals must be finite; half-configured treated as unset (manual-only).
  if (!Number.isFinite(kcalGoal) || !Number.isFinite(proteinGoal)) return notMet;

  // 4b. Some real intake required — an empty/0-kcal day never auto-greens.
  const K = day && day.kcal;
  if (!Number.isFinite(K) || K <= 0) return notMet;

  const P = day && Number.isFinite(day.protein) ? day.protein : 0; // protein floor
  const KG = kcalGoal;
  const PG = proteinGoal;

  // 4d. Direction rule. Unknown goal falls back to maintain (matches weightTrend).
  const proteinOk = P >= PG;
  let calorieOk;
  if (goal === 'lose') {
    calorieOk = K <= KG;
  } else if (goal === 'gain') {
    calorieOk = K >= KG;
  } else {
    const band = MAINTAIN_PCT * KG; // maintain (and any unknown goal)
    calorieOk = Math.abs(K - KG) <= band;
  }

  // 4e. Both conditions => hit; otherwise past=>none, today/future=>pending.
  return calorieOk && proteinOk ? 'hit' : notMet;
}

// ---- compliance % over a trailing window (SPEC-v4 §5) ------------------------

/**
 * computeCompliance(daysMap, subject, nowInstant, { windowDays = 30 })
 *   -> { workout:   { expected, completed, percent|null },
 *        nutrition: { expected, completed, percent|null } }
 *
 * Two trailing-window accountability numbers for one subject (SPEC-v4 §5).
 *
 *   daysMap   : { [dateKey]: DayEntry } — the subject's /days (with the viewer's
 *               optimistic overlay; the caller passes effectiveDays(uid)).
 *   subject   : the logic subject shape (ianaTz, rollover, restPattern,
 *               perDateOverrides, profile.joinDate) PLUS nutritionMode, kcalGoal,
 *               proteinGoal, goal for the nutrition %.
 *   nowInstant: server-anchored now.
 *   windowDays: trailing window length (default 30).
 *
 * `percent` is an integer 0..100, or NULL when expected === 0 (caller renders
 * "—", never NaN/0).
 *
 * Window (DST-safe): cur = currentBusinessDate(now). Walk back from
 * prevBusinessDate(cur) — today is still pending and excluded — collecting up to
 * windowDays PAST decided business-dates via prevBusinessDate (never raw ms).
 * Stop early once a date is before joinDate (pre-join is out of scope).
 *
 * WORKOUT %: rest/off days are NOT scheduled training days -> excluded from BOTH
 *   numerator and denominator (a workout on one is a bonus, ignored — mirrors
 *   groupConsistency). Every other in-window past non-prejoin day is expected;
 *   completed when day.workout === true. completed <= expected by construction.
 *
 * NUTRITION %: nutrition is expected on EVERY in-window past non-prejoin day
 *   (you eat on rest days too). completed when nutritionStatus(...isPast:true)
 *   === 'hit' for the subject's mode/goals. Unset goals honestly yield low % —
 *   intentional, not special-cased.
 *
 * Pure: no Firebase/DOM. Fail-safe: a subject with no ianaTz or no joinDate
 * yields all-zero expected => percent null on both.
 */
export function computeCompliance(daysMap, subject, nowInstant, opts = {}) {
  const windowDays =
    Number.isFinite(opts.windowDays) && opts.windowDays > 0 ? Math.floor(opts.windowDays) : 30;
  const empty = {
    workout: { expected: 0, completed: 0, percent: null },
    nutrition: { expected: 0, completed: 0, percent: null },
  };
  if (!subject || !subject.ianaTz) return empty;

  const joinDate = subject.profile && subject.profile.joinDate;
  if (!isDayKey(joinDate)) return empty;

  const { h, m } = rollover(subject);
  const cur = currentBusinessDate(nowInstant, subject.ianaTz, h, m);
  const days = daysMap || {};
  const mode = subject.nutritionMode;
  const kcalGoal = subject.kcalGoal;
  const proteinGoal = subject.proteinGoal;
  const goal = subject.goal;

  let wExpected = 0;
  let wCompleted = 0;
  let nExpected = 0;
  let nCompleted = 0;

  let cursor = prevBusinessDate(cur); // most recent DECIDED day (today excluded)
  for (let i = 0; i < windowDays; i++) {
    if (cursor < joinDate) break; // pre-join: out of scope, and nothing older qualifies
    const day = days[cursor];

    // ---- workout + nutrition: only scheduled (non rest/off) past days count ----
    // Both numbers exclude rest, off, prejoin, and future days so the two %s mean the
    // same thing ("of the days it counted, how often you hit") and are comparable. The
    // prejoin/future exclusions come from the loop bounds (cursor<joinDate breaks; the
    // walk starts at yesterday). rest/off are skipped here, mirroring the workout side.
    const rest = isRestDay(subject.restPattern, subject.perDateOverrides, cursor);
    const off = !!(day && day.off === true);
    if (!(rest || off)) {
      wExpected += 1;
      if (day && day.workout === true) wCompleted += 1;

      nExpected += 1;
      const ns = nutritionStatus(day, {
        nutritionMode: mode,
        kcalGoal,
        proteinGoal,
        goal,
        isPast: true,
      });
      if (ns === 'hit') nCompleted += 1;
    }

    cursor = prevBusinessDate(cursor);
  }

  const pct = (c, e) => (e === 0 ? null : Math.round((c / e) * 100));
  return {
    workout: { expected: wExpected, completed: wCompleted, percent: pct(wCompleted, wExpected) },
    nutrition: { expected: nExpected, completed: nCompleted, percent: pct(nCompleted, nExpected) },
  };
}

// ---- per-person emoji (curated set + deterministic fallback) — SPEC-v4 §14 ---

/**
 * The curated emoji set (single source of truth, importable by data.js for the
 * random default and by ui.js for the picker + fallback). 24 entries.
 */
export const EMOJI_SET = [
  '💪', '🔥', '🏋️', '🥇', '⚡', '🚀', '🦍', '🐺', '🦅', '🐉', '🦁', '🐻',
  '🦏', '🦈', '🐅', '🦌', '🍀', '⭐', '🎯', '💎', '🧨', '🥊', '🏆', '🧗',
];

/**
 * hashId(id) -> a small stable non-negative integer hash of a string (FNV-1a,
 * 32-bit). Deterministic, so the same userId always maps to the same emoji.
 * Returns 0 for a non-string / empty input.
 */
export function hashId(id) {
  if (typeof id !== 'string' || id.length === 0) return 0;
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts (stay in 32-bit unsigned space).
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * emojiOf(member) -> the member's chosen emoji if a non-empty string, else a
 * DETERMINISTIC fallback derived from the userId (so demo users with no emoji
 * field still show a stable symbol). Accepts the member id under `id`, `userId`,
 * or `uid` (whichever the caller's shape uses).
 */
export function emojiOf(member) {
  if (member && typeof member.emoji === 'string' && member.emoji.trim()) {
    return member.emoji;
  }
  const id = (member && (member.id || member.userId || member.uid)) || '';
  return EMOJI_SET[hashId(id) % EMOJI_SET.length];
}

/**
 * randomEmoji() -> a random pick from EMOJI_SET. Client Math.random is fine;
 * used only by ensureUserDoc's first-run default.
 */
export function randomEmoji() {
  return EMOJI_SET[Math.floor(Math.random() * EMOJI_SET.length)];
}

// ---- relative "last active" label --------------------------------------------

const MIN_MS = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const STALE_MS = 2 * DAY_MS; // SPEC: "text dims when stale > 2 days"

/**
 * relativeTime(fromMs, nowMs)
 *
 * The compact last-active label under each name. SPEC-v2: "2h"/"3d"/"just now",
 * and the text DIMS when stale (older than 2 days).
 *
 *   fromMs : epoch-ms of the member's lastActiveAt (Firestore Timestamp ->
 *            .toMillis()). null/undefined/non-finite => never active.
 *   nowMs  : the server-anchored now (data.js anchoredNow() = Date.now()+offset).
 *
 * Returns { text, stale }:
 *   text  : 'just now' (< 60s), else 'Nm' (minutes), 'Nh' (hours), 'Nd' (days),
 *           'Nw' (weeks, >= 7d). Each bucket floors to a whole unit. Empty string
 *           '' when fromMs is missing/invalid (caller renders nothing).
 *   stale : true when the gap is strictly greater than 2 days. Always false for
 *           a missing fromMs (nothing to dim) and for future/zero gaps.
 *
 * A future fromMs (clock skew) clamps to 0 => 'just now', not a negative label.
 * Pure: no clock read of its own — `nowMs` is supplied so it's deterministic.
 */
export function relativeTime(fromMs, nowMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs)) {
    return { text: '', stale: false };
  }
  const gap = Math.max(0, nowMs - fromMs); // clamp future/skew to "now"
  const stale = gap > STALE_MS;

  if (gap < MIN_MS) return { text: 'just now', stale };
  if (gap < HOUR_MS) return { text: `${Math.floor(gap / MIN_MS)}m`, stale };
  if (gap < DAY_MS) return { text: `${Math.floor(gap / HOUR_MS)}h`, stale };
  if (gap < WEEK_MS) return { text: `${Math.floor(gap / DAY_MS)}d`, stale };
  return { text: `${Math.floor(gap / WEEK_MS)}w`, stale };
}
