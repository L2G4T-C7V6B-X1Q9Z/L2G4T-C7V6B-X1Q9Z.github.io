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
    // DESIGN §12 fail-safe (mirrors missed/computeStreak/computeCompliance): an
    // unconfigured member (no joinDate anchor) contributes NOTHING — otherwise
    // every past non-rest week-day would count as expected-and-uncompleted while
    // the board renders those same cells 'pending' (missed() fails safe to false).
    if (!isDayKey(joinDate)) continue;

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

/**
 * nextDayKey(dateKey) -> the 'YYYY-MM-DD' one calendar day AFTER dateKey, rolling
 * month/year. The forward mirror of prevBusinessDate: pure string/number math on
 * the calendar fields, so DST cannot affect it (no instant/offset involved). Used
 * by groupConsistency's week builder AND by the v5 month-grid / week-nav forward
 * iteration, so it is exported alongside prevBusinessDate.
 *
 * Uses Date.UTC purely as a civil-calendar lookup (days-in-month, leap years); UTC
 * carries no timezone/DST behaviour of its own here.
 */
export function nextDayKey(dateKey) {
  if (!isDayKey(dateKey)) {
    throw new TypeError(`nextDayKey: not a YYYY-MM-DD key: ${dateKey}`);
  }
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

// A member is INACTIVE when their last activity OR, if they never logged, their join
// is >= thresholdDays civil days before today (DST-safe via dayKeyDiff, not raw ms).
// Branches are mutually exclusive on whether a lastActiveKey exists, so this IS the
// brief's OR. No lastActive AND no join -> can't judge -> active. Join <3d ago with no
// logs -> diff<3 -> active (the grace window so brand-new joiners aren't grayed).
export function memberInactiveByKeys(lastActiveKey, joinDateKey, todayKey, thresholdDays = 3) {
  if (!isDayKey(todayKey)) return false;
  if (isDayKey(lastActiveKey)) return dayKeyDiff(lastActiveKey, todayKey) >= thresholdDays;
  if (isDayKey(joinDateKey)) return dayKeyDiff(joinDateKey, todayKey) >= thresholdDays;
  return false;
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
// v9: one-sided hit tolerance for gain/lose + a grace on the protein floor, so a day
// within logging noise of goal isn't marked a miss. gain/lose only; maintain uses its
// own MAINTAIN_PCT band.
const HIT_TOL_PCT = 0.05; // +/-5%

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
 *        d. calTol = HIT_TOL_PCT*kcalGoal; band = MAINTAIN_PCT*kcalGoal; the protein
 *           floor gets a HIT_TOL_PCT grace too. Direction rule (inclusive bounds):
 *             lose     : K <= KG + calTol AND P >= PG - protTol
 *             gain     : K >= KG - calTol AND P >= PG - protTol
 *             maintain : |K - KG| <= band AND P >= PG - protTol  (unknown => maintain)
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
    if (!Number.isFinite(proteinGoal) || proteinGoal < 0) return notMet; // unset/negative -> manual-only (v5.4 #22)
    const P = day && Number.isFinite(day.protein) ? day.protein : 0;
    // 0 intake never auto-hits, but ONLY when there's a positive goal to meet; a
    // proteinGoal of 0 is satisfied by 0 (0>=0), matching 'both' mode's goal-0 floor.
    if (proteinGoal > 0 && !(P > 0)) return notMet;
    return P >= proteinGoal ? 'hit' : notMet;
  }

  // 4. BOTH (default): calories-in-range (by goal direction) AND protein floor.
  // 4a. Both goals must be finite AND non-negative; half-configured or negative treated as
  // unset (manual-only). Negative slips past Number.isFinite, so check it explicitly (v5.4 #22).
  if (!Number.isFinite(kcalGoal) || !Number.isFinite(proteinGoal) || kcalGoal < 0 || proteinGoal < 0) return notMet;

  // 4b. Some real intake required — an empty/0-kcal day never auto-greens.
  const K = day && day.kcal;
  if (!Number.isFinite(K) || K <= 0) return notMet;

  const P = day && Number.isFinite(day.protein) ? day.protein : 0; // protein floor
  const KG = kcalGoal;
  const PG = proteinGoal;

  // 4d. Direction rule with a tolerance band (v9): a little on the "wrong" side of the
  // goal still counts (over logging noise). gain/lose get a one-sided HIT_TOL_PCT grace
  // (the "right" side always counts); maintain keeps its two-sided +/-10% band. The
  // protein floor gets the same small grace. Unknown goal falls back to maintain.
  const calTol = HIT_TOL_PCT * KG;
  const proteinOk = P >= PG - HIT_TOL_PCT * PG;
  let calorieOk;
  if (goal === 'lose') {
    calorieOk = K <= KG + calTol; // a little over the cap still counts
  } else if (goal === 'gain') {
    calorieOk = K >= KG - calTol; // a little under the target still counts
  } else {
    const band = MAINTAIN_PCT * KG; // maintain (and any unknown goal)
    calorieOk = Math.abs(K - KG) <= band;
  }

  // 4e. Both conditions => hit; otherwise past=>none, today/future=>pending.
  return calorieOk && proteinOk ? 'hit' : notMet;
}

/**
 * nutritionProgress(day, opts) -> number in [0,1], or null
 *
 * The FRACTION of the day's calorie (or protein) goal that's logged — drives the
 * SEGMENTED partial-fill on the nutrition triangle. Companion to nutritionStatus:
 * status decides hit/pending/none (and color); this decides how FULL a not-yet-hit
 * cell reads. Returns null when there is no measurable goal to fill against (manual
 * mode, or the relevant goal unset/<=0) -> the caller falls back to the binary
 * triangle. Mode-aware, matching nutritionStatus's metric:
 *   manual  -> null (no auto goal).
 *   protein -> protein / proteinGoal.
 *   both    -> kcal / kcalGoal (calorie progress; direction-AGNOSTIC — a 'lose' day
 *              still reads as "budget used"; hit/miss stays nutritionStatus's job).
 * Clamped to [0,1]; absent/0 intake reads as 0 (empty).
 */
export function nutritionProgress(day, opts = {}) {
  const { nutritionMode, kcalGoal, proteinGoal } = opts;
  const mode =
    nutritionMode === 'manual' || nutritionMode === 'protein' ? nutritionMode : 'both';
  if (mode === 'manual') return null;
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  if (mode === 'protein') {
    if (!Number.isFinite(proteinGoal) || proteinGoal <= 0) return null;
    const P = day && Number.isFinite(day.protein) ? day.protein : 0;
    return clamp01(P / proteinGoal);
  }
  // both
  if (!Number.isFinite(kcalGoal) || kcalGoal <= 0) return null;
  const K = day && Number.isFinite(day.kcal) ? day.kcal : 0;
  return clamp01(K / kcalGoal);
}

/**
 * nutritionGoalOpts(day, subject) -> { nutritionMode, kcalGoal, proteinGoal, goal }
 *
 * v9 goal-freeze READ helper: the goal set a day is judged against. A day
 * SNAPSHOTS kcalGoal/proteinGoal/goalDir when nutrition is logged onto it
 * (data.js setMacros/addMeal, the admin day-close), so a later goal change never
 * rewrites that day's hit/dither. Precedence is PER FIELD: the day's snapshotted
 * value when valid (finite number / known direction), else the subject's LIVE
 * value (covers pre-v9 days with no snapshot). nutritionMode is NEVER
 * snapshotted — always the subject's live mode. Missing subject goal -> 'maintain'
 * (nutritionStatus's own unknown-goal fallback, made explicit here).
 *
 * This is the ONE precedence rule. Every read path — the grid/month cell
 * (classifyDay), the day popover, computeCompliance's nutrition % — must build
 * its nutritionStatus/nutritionProgress opts through it, so two views of the
 * same day can never disagree. Pure; day/subject may be null/undefined.
 */
export function nutritionGoalOpts(day, subject) {
  const goal =
    day && (day.goalDir === 'gain' || day.goalDir === 'lose' || day.goalDir === 'maintain')
      ? day.goalDir
      : ((subject && subject.goal) || 'maintain');
  return {
    nutritionMode: subject ? subject.nutritionMode : undefined,
    kcalGoal: day && Number.isFinite(day.kcalGoal) ? day.kcalGoal : subject ? subject.kcalGoal : undefined,
    proteinGoal:
      day && Number.isFinite(day.proteinGoal) ? day.proteinGoal : subject ? subject.proteinGoal : undefined,
    goal,
  };
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
 *   intentional, not special-cased. v9: each day is judged against its OWN
 *   snapshotted goal (nutritionGoalOpts), falling back to the live goal for
 *   un-snapshotted days — so the % agrees with the painted cells and a goal
 *   change never rewrites history.
 *
 * Pure: no Firebase/DOM. Fail-safe: a subject with no ianaTz or no joinDate
 * yields all-zero expected => percent null on both.
 */
export function computeCompliance(daysMap, subject, nowInstant, opts = {}) {
  const windowDays =
    Number.isFinite(opts.windowDays) && opts.windowDays > 0 ? Math.max(1, Math.floor(opts.windowDays)) : 30;
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
      // v9: judge the day against its own snapshotted goal (else the live one) —
      // the same precedence classifyDay paints the cell with (nutritionGoalOpts).
      const ns = nutritionStatus(day, { ...nutritionGoalOpts(day, subject), isPast: true });
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

/**
 * layoutChartEndLabels(labels, opts) -> the same labels, with resolved {x, y}.
 *
 * Positions the weight-chart end-labels (the per-member emoji at the end of each
 * line). The fix this encodes: anchor each label to its OWN last data point's x
 * (nudged just right), NOT the chart's right edge — so a member who stopped weighing
 * in mid-window gets their emoji next to their actual last point instead of dragged
 * to today's column and stacked with everyone else.
 *
 * After x is resolved, a vertical-dodge runs WITHIN each horizontal cluster only:
 * two emojis can visually collide only when their x are within `overlapX`, so labels
 * far apart in x must never shove each other vertically (the old bug was a single
 * global right-edge dodge that dragged a lapsed member's emoji to clear the recent
 * cluster). Within a cluster: sort by idealY, push >= `gap` apart, shift the whole
 * cluster up if it overruns `bot`, then clamp to `top`.
 *
 *   labels : array of { pointX, idealY, ...passthrough } — pointX is the member's own
 *            last point x (SVG units); idealY is that point's y.
 *   opts   : { rightEdgeX, nudge, gap, top, bot, overlapX }
 *
 * Mutates + returns the same label objects (input order preserved), each gaining a
 * numeric `x` (draw x) and `y` (dodged draw y). Pure: no globals, no clock read.
 */
export function layoutChartEndLabels(labels, opts) {
  const list = Array.isArray(labels) ? labels : [];
  const { rightEdgeX, nudge = 4, gap = 11, top = 0, bot = Infinity, overlapX = 12 } = opts || {};
  // 1. resolve each label's x: its own point nudged right, never past the edge.
  for (const L of list) {
    const px = Number.isFinite(L.pointX) ? L.pointX : rightEdgeX;
    L.x = Number.isFinite(rightEdgeX) ? Math.min(px + nudge, rightEdgeX) : px + nudge;
    L.y = L.idealY; // default; the dodge below may push it
  }
  if (!list.length) return list;
  // 2. cluster by x-proximity: a new cluster opens when the x-gap to the running
  //    cluster max exceeds overlapX (emojis that far apart can't horizontally overlap).
  const sorted = list.slice().sort((a, b) => a.x - b.x || a.idealY - b.idealY);
  const clusters = [];
  for (const L of sorted) {
    const cur = clusters.length ? clusters[clusters.length - 1] : null;
    if (cur && L.x - cur.maxX <= overlapX) {
      cur.items.push(L);
      cur.maxX = Math.max(cur.maxX, L.x);
    } else {
      clusters.push({ items: [L], maxX: L.x });
    }
  }
  // 3. vertical-dodge each cluster independently (the v4.3 algorithm, scoped to the cluster).
  for (const c of clusters) {
    const g = c.items;
    g.sort((a, b) => a.idealY - b.idealY);
    for (let i = 0; i < g.length; i++) {
      g[i].y = i > 0 ? Math.max(g[i].idealY, g[i - 1].y + gap) : g[i].idealY;
    }
    const overflow = g[g.length - 1].y - bot;
    if (overflow > 0) for (const L of g) L.y -= overflow;
    for (const L of g) if (L.y < top) L.y = top;
  }
  return list;
}

/**
 * abbrevName(name) -> a 3-letter UPPERCASE tag for the weight-chart end-labels (and the
 * hover readout). Replaces the old slice(0,3), which read poorly (Olivia->OLI, Soren->SOR).
 *
 * Rule:
 *   - trimmed length <= 3  -> the whole name, uppercased            (Dan -> DAN)
 *   - else                 -> keep the FIRST letter, then append the
 *     subsequent CONSONANTS (skip a/e/i/o/u after the first letter) until 3 chars; if there
 *     aren't enough consonants, fill from the skipped letters (the vowels) in order; uppercase.
 *
 * Worked examples (asserted in logic.test.mjs):
 *   Soren->SRN  Jacob->JCB  Hunter->HNT  Dan->DAN  Olivia->OLV  Lars->LRS
 *
 * Non-letters in the tail are ignored (treated as neither consonant nor vowel) so a stray
 * space / apostrophe never lands in the tag. Pure + deterministic. '' for empty/non-string.
 */
export function abbrevName(name) {
  const s = (typeof name === 'string' ? name : '').trim();
  if (!s) return '';
  if (s.length <= 3) return s.toUpperCase();
  const chars = Array.from(s);
  const out = [chars[0]];
  const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
  const skippedVowels = [];
  // pass 1: first letter + subsequent consonants.
  for (let i = 1; i < chars.length && out.length < 3; i++) {
    const c = chars[i];
    const lc = c.toLowerCase();
    if (!/[a-z]/.test(lc)) continue;          // non-letter -> ignore entirely
    if (VOWELS.has(lc)) { skippedVowels.push(c); continue; } // vowel -> defer
    out.push(c);
  }
  // pass 2: still short -> backfill from the skipped vowels, in order.
  for (let i = 0; i < skippedVowels.length && out.length < 3; i++) out.push(skippedVowels[i]);
  return out.join('').toUpperCase().slice(0, 3);
}

// ---- playlist: song-input parsing + cross-service deep-link builders ----------
// The shared song wall (v5) stores exactly what's typed/pasted and deep-links out
// to Spotify + YT Music — it NEVER fetches metadata (no Cloud Function, the SPA
// can't call the Spotify Web API). These helpers are the pure half: parse one
// input line into {kind,url,title,artist}, build a stable dedupe key, and build
// the two search URLs. The random song-id generator lives in data.js instead, so
// this module stays deterministic (no crypto/random) and fully unit-testable.

// Hosts we recognize as a direct track/playlist link (vs a "Song - Artist" line).
// Matched case-insensitively against the URL's hostname, with an optional leading
// "www." / "music." / "open." subdomain. Anything else that parses as a URL is
// kept as kind:'url' with title=the raw URL (still deep-linkable verbatim).
const SPOTIFY_HOST_RE = /(^|\.)spotify\.com$/i;
const YT_HOST_RE = /(^|\.)(music\.youtube\.com|youtube\.com|youtu\.be)$/i;

/**
 * parseSongInput(raw) -> { kind, url, title, artist }
 *
 * Classify one line of song input. Three shapes:
 *   1. A Spotify URL        -> { kind:'spotify', url, title:<raw url>, artist:'' }
 *   2. A YouTube/YT-Music URL -> { kind:'ytmusic', url, title:<raw url>, artist:'' }
 *   3. Any other http(s) URL  -> { kind:'url',     url, title:<raw url>, artist:'' }
 *   4. A plain "Song - Artist" string -> { kind:'text', url:null, title, artist }
 *      (splits on the FIRST ' - ' / ' — ' / ' – ' separator; no separator => the
 *       whole string is the title and artist is '').
 *
 * URL detection is host-based (not substring), so "Song - spotify.com cover" is
 * correctly treated as text, not a link. A bare "open.spotify.com/track/.." with
 * no scheme is still recognized (we retry with an https:// prefix). Returns
 * { kind:'empty', url:null, title:'', artist:'' } for blank/non-string input.
 */
export function parseSongInput(raw) {
  const EMPTY = { kind: 'empty', url: null, title: '', artist: '' };
  if (typeof raw !== 'string') return EMPTY;
  const s = raw.trim();
  if (!s) return EMPTY;

  // Try to read it as a URL. Accept a scheme-less host (open.spotify.com/..) by
  // retrying with an https:// prefix, but ONLY when the first token looks like a
  // host (has a dot, no spaces) — so "Song - Artist" never parses as a URL.
  const url = tryParseUrl(s);
  if (url) {
    const host = url.hostname || '';
    if (SPOTIFY_HOST_RE.test(host)) return { kind: 'spotify', url: url.href, title: s, artist: '' };
    if (YT_HOST_RE.test(host)) return { kind: 'ytmusic', url: url.href, title: s, artist: '' };
    return { kind: 'url', url: url.href, title: s, artist: '' };
  }

  // Plain text: split on the first dash-style separator into title - artist.
  // Spaced separators only (' - ' / ' — ' / ' – ') so a hyphenated title like
  // "Spider-Man Theme" isn't split mid-word.
  const m = s.match(/^(.*?)\s+[-—–]\s+(.*)$/);
  if (m) {
    return { kind: 'text', url: null, title: m[1].trim(), artist: m[2].trim() };
  }
  return { kind: 'text', url: null, title: s, artist: '' };
}

/**
 * tryParseUrl(s) -> URL | null. Parse with the WHATWG URL constructor; if `s`
 * has no scheme but its first whitespace-free token contains a dot (a hostname),
 * retry as https://. Returns null on anything that isn't a valid http(s) URL.
 * Kept module-private (not exported) — parseSongInput is the public surface.
 */
function tryParseUrl(s) {
  const attempt = (str) => {
    try {
      const u = new URL(str);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
    } catch {
      return null;
    }
  };
  if (/^https?:\/\//i.test(s)) return attempt(s);
  // scheme-less: only treat as a URL if it's a single token that looks like a host.
  if (!/\s/.test(s) && /^[^/]+\.[^/]+/.test(s)) return attempt('https://' + s);
  return null;
}

/**
 * playlistDedupeKey({title, artist, url}) -> a lowercased canonical string used
 * for best-effort client-side de-duplication of the song wall (a same-second add
 * race can still slip two rows past it; harmless, anyone removes one).
 *
 * Rules:
 *   - If a `url` is present, key off the URL with its QUERY STRING and HASH
 *     stripped and a trailing slash removed (so ...?si=abc tracking params and a
 *     trailing / don't make "the same link" look distinct), lowercased.
 *   - Otherwise key off `title` + `artist`: lowercased, "feat." / "ft." segments
 *     removed, all punctuation stripped, and whitespace collapsed.
 *
 * Pure and deterministic. Returns '' for input with no usable url/title/artist.
 */
export function playlistDedupeKey(song) {
  const url = song && typeof song.url === 'string' ? song.url.trim() : '';
  if (url) {
    // Strip ?query and #hash, drop a single trailing slash, lowercase.
    let u = url.replace(/[?#].*$/, '').replace(/\/+$/, '');
    return u.toLowerCase();
  }
  const title = song && typeof song.title === 'string' ? song.title : '';
  const artist = song && typeof song.artist === 'string' ? song.artist : '';
  const norm = (s) =>
    s
      .toLowerCase()
      // drop "feat. xyz" / "ft xyz" / "featuring xyz" to end-of-string or before a bracket.
      .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/g, ' ')
      // strip anything that isn't a letter/number/space (punctuation, brackets, &).
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const t = norm(title);
  const a = norm(artist);
  if (!t && !a) return '';
  // pipe-joined; norm() strips '|' from both sides so this separator can't collide
  // (e.g. {title:'ab',artist:'c'} -> "ab | c" stays distinct from {title:'a',artist:'bc'}).
  return a ? `${t} | ${a}` : t;
}

/**
 * spotifySearchUrl(q) -> an open.spotify.com search URL for the query string `q`,
 * with `q` percent-encoded into the PATH (Spotify's search route is
 * open.spotify.com/search/<encoded query>). Returns '' for a blank/non-string q.
 */
export function spotifySearchUrl(q) {
  if (typeof q !== 'string' || !q.trim()) return '';
  return `https://open.spotify.com/search/${encodeURIComponent(q.trim())}`;
}

/**
 * ytMusicSearchUrl(q) -> a music.youtube.com search URL for `q`, with `q`
 * percent-encoded into the ?q= QUERY param (YT Music's search route is
 * music.youtube.com/search?q=<encoded query>). Returns '' for a blank/non-string q.
 */
export function ytMusicSearchUrl(q) {
  if (typeof q !== 'string' || !q.trim()) return '';
  return `https://music.youtube.com/search?q=${encodeURIComponent(q.trim())}`;
}

/**
 * playlistLinkUrl(playlistUrl, searchUrl) -> the URL an "open on <service>" button should use.
 * Prefer the slot's REAL auto-created playlist URL; fall back to a whole-list search URL when
 * the slot has no playlist yet; '' when neither (the caller supplies its own last resort).
 * Fixes the bug where "OPEN ON SPOTIFY" opened Spotify's HOME: the button built a search from
 * TYPED songs only, so a slot full of pasted links produced an empty search and the button
 * never used the real playlist URL the Worker had already created. Service-agnostic (reused for
 * the YouTube open-link in v6).
 */
export function playlistLinkUrl(playlistUrl, searchUrl) {
  if (typeof playlistUrl === 'string' && playlistUrl.trim()) return playlistUrl.trim();
  if (typeof searchUrl === 'string' && searchUrl.trim()) return searchUrl.trim();
  return '';
}

// ---- playlist: Spotify embed helper (rich row display, v5.1) ------------------
// Turn a stored Spotify URL into the embed URL the row needs to render an inline
// player (cover art + title + artist + play) instead of a bare URL. A PURE URL
// parser — it never fetches. Returns null when the URL isn't an embeddable
// Spotify resource, so the caller falls back to the plain text row. This is what
// fixes the "a pasted link just shows the URL" problem: parseSongInput stores a
// link's title AS the raw URL (it can't know the song name without a network
// call), so the row must show the embed, not the title.

/**
 * spotifyEmbed(url) -> { type, id, src } | null
 * Recognize an open.spotify.com link (or a spotify: URI) for a track / album /
 * playlist / episode / show and build the matching embed URL
 * (open.spotify.com/embed/<type>/<id>, which renders an inline player with cover
 * art + title + artist + a play button, no auth). Tolerates a locale path prefix
 * (/intl-de/) and ?si= tracking params. Spotify ids are 22-char base62. Returns
 * null if the URL isn't an embeddable Spotify resource.
 */
export function spotifyEmbed(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const s = url.trim();
  // spotify:track:<id> URI form (rare from a paste, but handle it).
  let m = s.match(/spotify:(track|album|playlist|episode|show):([A-Za-z0-9]{22})(?![A-Za-z0-9])/i);
  // https://open.spotify.com/[intl-xx/]<type>/<id>[?si=..]. The trailing (?![A-Za-z0-9])
  // boundary (v5.4 #21) makes a malformed 23+ char id fail instead of silently matching its
  // first 22 chars (a different/truncated track). Real ids are exactly 22 base62 chars.
  if (!m) m = s.match(/open\.spotify\.com\/(?:[a-z-]+\/)?(track|album|playlist|episode|show)\/([A-Za-z0-9]{22})(?![A-Za-z0-9])/i);
  if (!m) return null;
  const type = m[1].toLowerCase();
  const id = m[2];
  return { type, id, src: `https://open.spotify.com/embed/${type}/${id}` };
}

// ---- playlist: YouTube embed + playlist helpers (v6 dual-service) -------------

/**
 * youtubeEmbed(url) -> { id, src } | null
 * Recognize a YouTube VIDEO link (watch?v=, youtu.be/, music.youtube.com/watch?v=, /embed/,
 * /shorts/) and build the inline-player embed URL (youtube.com/embed/<id>). Video ids are
 * exactly 11 chars [A-Za-z0-9_-]; the trailing boundary makes a 12+ char garbage id fail
 * (mirrors spotifyEmbed's #21 fix) instead of silently embedding a truncated id. Returns null
 * for a playlist-only link or a non-YouTube URL so the caller falls back to the plain row.
 */
export function youtubeEmbed(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const s = url.trim();
  const m = s.match(
    /(?:youtube\.com\/(?:watch\?(?:[^&\s]*&)*v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i
  );
  if (!m) return null;
  return { id: m[1], src: `https://www.youtube.com/embed/${m[1]}` };
}

/**
 * youtubePlaylistUrl(listId) -> the public playlist URL, or '' for a blank/non-string id.
 */
export function youtubePlaylistUrl(listId) {
  if (typeof listId !== 'string' || !listId.trim()) return '';
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(listId.trim())}`;
}

/**
 * isSlotLive(viewedHalf, nowHalf) -> bool
 * A themed half-week slot accepts new songs ONLY while it is the live half (the one "now" falls
 * in). Past/future halves are frozen archives. Kept pure so the freeze gate is unit-tested
 * rather than buried in ui.js.
 */
export function isSlotLive(viewedHalf, nowHalf) {
  return viewedHalf === nowHalf && (viewedHalf === 'a' || viewedHalf === 'b');
}

// ---- playlist: weekly themed "slots" (v5.2) -----------------------------------
// The song wall splits into TWO themed playlists per week: the FIRST HALF
// (Mon–Wed) and the SECOND HALF (Thu–Sun). Each (week, half) is one "slot" with
// its own theme + its own songs; every new week starts fresh. These PURE helpers
// turn a business-date key into the slot it belongs to. A slot id is
// "<weekMonday>_<half>" (e.g. "2026-06-22_a") — stable, human-readable, and
// slash-free so it's a valid Firestore doc id.

/** playlistHalf(dateKey) -> 'a' (Mon–Wed) | 'b' (Thu–Sun). */
export function playlistHalf(dateKey) {
  if (!isDayKey(dateKey)) throw new TypeError(`playlistHalf: not a YYYY-MM-DD key: ${dateKey}`);
  const dow = weekdayOf(dateKey); // 0=Sun..6=Sat
  return dow >= 1 && dow <= 3 ? 'a' : 'b'; // Mon,Tue,Wed -> a ; Thu,Fri,Sat,Sun -> b
}

/** playlistSlotKey(dateKey) -> "<weekMonday>_<half>", the themed-playlist slot id. */
export function playlistSlotKey(dateKey) {
  return `${businessWeekKey(dateKey)}_${playlistHalf(dateKey)}`;
}

/** playlistSlotId(weekKey, half) -> the slot id from an explicit week Monday + half. */
export function playlistSlotId(weekKey, half) {
  return `${weekKey}_${half}`;
}

/** playlistSlotLabel(dateKeyOrHalf) -> 'MON–WED' | 'THU–SUN' (the half's day range). */
export function playlistSlotLabel(dateKeyOrHalf) {
  const half = dateKeyOrHalf === 'a' || dateKeyOrHalf === 'b' ? dateKeyOrHalf : playlistHalf(dateKeyOrHalf);
  return half === 'a' ? 'MON–WED' : 'THU–SUN';
}

/**
 * playlistNextResetDayKey(dateKey) -> the YYYY-MM-DD when the CURRENT half ends and
 * the next themed playlist goes live: from a Mon–Wed slot -> that week's Thursday;
 * from a Thu–Sun slot -> the FOLLOWING Monday. (The flip happens at the business-day
 * rollover on that day; the UI turns this into the countdown badge.)
 */
export function playlistNextResetDayKey(dateKey) {
  const monday = businessWeekKey(dateKey);
  const steps = playlistHalf(dateKey) === 'a' ? 3 : 7; // Mon->Thu = +3 ; Mon->next Mon = +7
  let key = monday;
  for (let i = 0; i < steps; i++) key = nextDayKey(key);
  return key;
}

/**
 * formatResetCountdown(ms) -> a coarse "time remaining" badge: "3D" when >= 1 day
 * out, else "5H" (whole hours, floored to a minimum of 1). 'now' for a
 * non-positive / non-number input.
 */
export function formatResetCountdown(ms) {
  if (typeof ms !== 'number' || !(ms > 0)) return 'now';
  const DAY = 86400000;
  const HR = 3600000;
  const days = Math.floor(ms / DAY);
  if (days >= 1) return `${days}D`;
  return `${Math.max(1, Math.floor(ms / HR))}H`;
}

// ---- v7: dual-display merge + MXT naming + history + theme-submission period ----

/**
 * mxtPlaylistName(n, theme) -> the SHORT auto-playlist name "MXT #<n>: <theme>".
 * n is the global MXT counter (>=1, floored); a blank theme renders "untitled". The Worker's
 * /create endpoint validates the name matches /^MXT #\d+:/ so a public secret can't mint
 * arbitrary names — this builder must stay in that shape.
 */
export function mxtPlaylistName(n, theme) {
  const num = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  const t = typeof theme === 'string' ? theme.trim() : '';
  return `MXT #${num}: ${t || 'untitled'}`;
}

/**
 * nextPeriodKey(dateKey) -> the slotKey of the NEXT themed half-week (where theme submissions
 * go). Composes the existing primitives: the next-reset day, mapped to its slot. From a Mon–Wed
 * day -> that week's Thu–Sun slot; from a Thu–Sun day -> next week's Mon–Wed slot. Crosses the
 * Wed->Thu and Sun->Mon boundaries correctly because playlistNextResetDayKey already does.
 */
export function nextPeriodKey(dateKey) {
  return playlistSlotKey(playlistNextResetDayKey(dateKey));
}

/**
 * historySlots(plSlotsMap, currentKey) -> archived slots (those that have a real playlist URL),
 * excluding the current one, newest first. Tolerates legacy pre-MXT slots (mxtNumber null) so the
 * history list doesn't break on old data. Slot keys sort lexically = chronologically (newer week,
 * then _b before _a), so a string desc sort is newest-first.
 */
export function historySlots(plSlotsMap, currentKey) {
  if (!plSlotsMap || typeof plSlotsMap !== 'object') return [];
  return Object.keys(plSlotsMap)
    .filter((k) => k !== currentKey)
    .filter((k) => {
      const s = plSlotsMap[k] || {};
      return (typeof s.spotifyUrl === 'string' && s.spotifyUrl) ||
        (typeof s.youtubeUrl === 'string' && s.youtubeUrl);
    })
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .map((k) => {
      const s = plSlotsMap[k] || {};
      return {
        key: k,
        mxtNumber: Number.isFinite(s.mxtNumber) ? s.mxtNumber : null,
        theme: typeof s.theme === 'string' ? s.theme : '',
        spotifyUrl: typeof s.spotifyUrl === 'string' ? s.spotifyUrl : '',
        youtubeUrl: typeof s.youtubeUrl === 'string' ? s.youtubeUrl : '',
      };
    });
}

/**
 * mergeRows(realTracks, attribMap) -> the displayed song rows, deduped by Spotify track id, with
 * gym-user attribution attached where known. realTracks come from the real playlist (Worker /list);
 * attribMap (Map or plain object) maps a Spotify track id -> the gym userId that added it via the
 * app. A track with no attrib match is a NATIVE add (addedByUserId null -> anonymous chip). Pure.
 */
export function mergeRows(realTracks, attribMap) {
  if (!Array.isArray(realTracks)) return [];
  const lookup = (id) => {
    if (!id) return null;
    if (attribMap instanceof Map) return attribMap.get(id) || null;
    if (attribMap && typeof attribMap === 'object') return attribMap[id] || null;
    return null;
  };
  const seen = new Set();
  const rows = [];
  for (const t of realTracks) {
    if (!t || !t.id || seen.has(t.id)) continue; // dedupe on the 22-char track id (exact)
    seen.add(t.id);
    rows.push({ ...t, addedByUserId: lookup(t.id) });
  }
  return rows;
}

/**
 * normalizeTrackTitle(s) -> a loose key for matching the SAME song across services (Spotify id !=
 * YouTube id, so a future cross-service dedupe needs title+artist). Lowercases, drops parentheticals
 * /brackets, trailing "feat ...", common version words, and punctuation. Pure. (YouTube is dormant;
 * this is staged for the cross-service merge.)
 */
export function normalizeTrackTitle(s) {
  if (typeof s !== 'string') return '';
  let out = s.toLowerCase();
  out = out.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  out = out.replace(/\b(feat\.?|ft\.?|featuring)\b.*$/, ' ');
  out = out.replace(/\b(remaster(ed)?|radio edit|live|explicit)\b/g, ' ');
  out = out.replace(/[^a-z0-9\s]/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}
