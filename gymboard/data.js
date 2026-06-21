// =============================================================================
// gymboard — data layer  (data.js)
// -----------------------------------------------------------------------------
// The ONLY module that touches Firebase. ui.js calls exactly the surface at the
// bottom of this file and nothing else; every date / missed / streak / week
// computation is delegated to the already-tested logic.js (we never re-derive
// time math here). data.js owns: App Check init, anonymous Auth, the token-gated
// binding + rebind, the reclaim signal, the /users onSnapshot, bounded /days
// reads, the 2-write atomic WORKOUT batch with optimistic semantics + an offline
// outbox, and the server-time offset used to anchor `now`.
//
// SDK: Firebase v10+ MODULAR web SDK, imported as ES modules from the gstatic
// CDN. 12.15.0 is the pinned version below (in the v10+ modular line).
//
// PROD HARDENING TODO (Subresource Integrity): these CDN imports should be
// SRI-pinned (or the SDK self-hosted in the repo) to shrink the injected-script
// attack surface, since the capability token transits this origin. Plain ESM
// `import` has no integrity attribute, so for prod either (a) self-host the SDK
// files under /gymboard/vendor/ and import locally, or (b) load via a
// <script type="module" integrity="sha384-..."> shim. Left as plain CDN imports
// for Phase 1 dev velocity; DO NOT ship to the real domain without this.
// =============================================================================

import {
  initializeApp,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js';
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-app-check.js';
import {
  getAuth,
  signInAnonymously,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  memoryLocalCache,
  doc,
  collection,
  query,
  where,
  onSnapshot,
  getDoc,
  getDocs,
  setDoc,
  writeBatch,
  serverTimestamp,
  Timestamp,
  documentId,
  orderBy,
  startAt,
  endAt,
} from 'https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js';

import {
  currentBusinessDate,
  isDayKey,
} from './logic.js';

// =============================================================================
// module-private state
// =============================================================================

let _app = null;
let _appCheck = null;
let _auth = null;
let _db = null;

let _userId = null; // the bound userId for THIS session (capability-link `u`)
let _token = null; // the capability token (`t`); kept in-memory for rebind/markWorkout proof refresh
let _uid = null; // this install's anonymous auth uid

let _initialized = false; // initApp() ran
let _bound = false; // a successful binding exists this session

// server-time offset (serverTime - Date.now()), in ms. Established from a
// serverTimestamp round-trip on an OWNED, readable doc (the /users doc's
// createdAt/updatedAt). ui.js anchors `now` as Date.now() + this, so all viewers
// agree through the rollover edge. Defaults to 0 (raw device time) until a
// round-trip lands; refined opportunistically on every owned-doc write/read.
let _serverOffsetMs = 0;
let _serverOffsetEstablished = false;

// reclaim callback (LOUD "signed out elsewhere — tap to reclaim").
let _reclaimCb = null;
let _reclaimFired = false; // de-dup: only fire the loud prompt once per detection

// live listeners + timers to detach on teardown.
const _unsubs = new Set();

// offline outbox: persisted queue of pending WORKOUT writes, replayed in order
// on reconnect. Each item is idempotent on (userId+businessDate+'workout').
let _outbox = []; // [{ key, userId, businessDate, field, value, authoredAtMs }]
let _outboxFlushing = false;

const LS_CAP_URL = 'gymboard.capabilityURL'; // full https://.../#u=..&t=.. for rebind
const LS_OUTBOX = 'gymboard.outbox';
const LS_OFFSET = 'gymboard.serverOffsetMs';

const TOKEN_RE = /^[0-9a-f]{32}$/; // rules: ^[0-9a-f]{32}$ (128-bit hex), pre-get shape gate

// =============================================================================
// small internal helpers
// =============================================================================

function assertInit() {
  if (!_initialized || !_db) {
    throw new Error('gymboard/data: initApp() must run before any other call.');
  }
}

/** A tagged error so ui.js can branch on auth/binding failures. */
function taggedError(code, message) {
  const e = new Error(message || code);
  e.code = code; // e.g. 'gymboard/no-capability', 'gymboard/bad-token'
  return e;
}

/** Firestore permission-denied detector (modular SDK puts the code on .code). */
function isPermissionDenied(err) {
  return !!err && (err.code === 'permission-denied' || err.code === 'firestore/permission-denied');
}

/**
 * Parse `#u=<userId>&t=<token>` out of a hash string (with or without leading #).
 * Returns { userId, token } or null. Tolerant of key order and extra params.
 */
function parseCapabilityHash(hash) {
  if (typeof hash !== 'string') return null;
  const h = hash.charAt(0) === '#' ? hash.slice(1) : hash;
  if (!h) return null;
  const params = new URLSearchParams(h);
  const userId = params.get('u');
  const token = params.get('t');
  if (!userId || !token) return null;
  return { userId, token };
}

/** Read the persisted full capability URL (the rebind / re-open source). */
function readStoredCapabilityURL() {
  try {
    return localStorage.getItem(LS_CAP_URL) || null;
  } catch (_) {
    return null;
  }
}

function persistCapabilityURL(url) {
  try {
    localStorage.setItem(LS_CAP_URL, url);
  } catch (_) {
    /* storage may be unavailable (private mode); rebind degrades to "reopen link" */
  }
}

/** Resolve the capability {userId, token} for this load: live hash first, else stored URL. */
function resolveCapability() {
  // 1) live fragment on this load.
  const fromHash = parseCapabilityHash(typeof location !== 'undefined' ? location.hash : '');
  if (fromHash) {
    return { ...fromHash, source: 'hash' };
  }
  // 2) re-open path: the full URL persisted in localStorage.
  const stored = readStoredCapabilityURL();
  if (stored) {
    const idx = stored.indexOf('#');
    if (idx >= 0) {
      const fromStored = parseCapabilityHash(stored.slice(idx));
      if (fromStored) return { ...fromStored, source: 'stored' };
    }
  }
  return null;
}

/** Strip the whole fragment from the address bar (token must not linger in location.hash). */
function stripFragment() {
  try {
    if (typeof history !== 'undefined' && history.replaceState) {
      const url = location.pathname + location.search;
      history.replaceState(null, '', url);
    }
  } catch (_) {
    /* non-fatal */
  }
}

// ---- server-time offset persistence + estimation ---------------------------

function loadPersistedOffset() {
  try {
    const v = localStorage.getItem(LS_OFFSET);
    if (v != null) {
      const n = Number(v);
      if (Number.isFinite(n)) {
        _serverOffsetMs = n;
        _serverOffsetEstablished = true;
      }
    }
  } catch (_) {
    /* ignore */
  }
}

function persistOffset() {
  try {
    localStorage.setItem(LS_OFFSET, String(_serverOffsetMs));
  } catch (_) {
    /* ignore */
  }
}

/**
 * Refine the server-time offset from a resolved serverTimestamp.
 * `serverTs` is a Firestore Timestamp (the doc's resolved createdAt/updatedAt);
 * `clientSentAtMs` is Date.now() captured just before we issued the write that
 * produced it. The true server instant lies between send and ack; using the
 * send time slightly under-estimates by the one-way latency, which is far below
 * our minute-scale rollover tolerance. We only adopt sane offsets (< 24h) so a
 * corrupt timestamp can't poison `now`.
 */
function refineOffsetFromServerTimestamp(serverTs, clientSentAtMs) {
  if (!serverTs || typeof serverTs.toMillis !== 'function') return;
  const serverMs = serverTs.toMillis();
  if (!Number.isFinite(serverMs)) return;
  const offset = serverMs - clientSentAtMs;
  if (Math.abs(offset) > 24 * 60 * 60 * 1000) return; // implausible; ignore
  _serverOffsetMs = offset;
  _serverOffsetEstablished = true;
  persistOffset();
}

/** Anchored "now" instant (epoch ms) the same way ui.js will compute it. */
function anchoredNow() {
  return Date.now() + _serverOffsetMs;
}

// ---- outbox persistence -----------------------------------------------------

function loadOutbox() {
  try {
    const raw = localStorage.getItem(LS_OUTBOX);
    _outbox = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(_outbox)) _outbox = [];
  } catch (_) {
    _outbox = [];
  }
}

function saveOutbox() {
  try {
    localStorage.setItem(LS_OUTBOX, JSON.stringify(_outbox));
  } catch (_) {
    /* ignore */
  }
}

function outboxKey(userId, businessDate, field) {
  return `${userId}|${businessDate}|${field}`;
}

/** Upsert by idempotency key so a double-tap / retry collapses to one item. */
function enqueueOutbox(item) {
  const existingIdx = _outbox.findIndex((x) => x.key === item.key);
  if (existingIdx >= 0) {
    _outbox[existingIdx] = item; // last write wins for the same (user,date,field)
  } else {
    _outbox.push(item);
  }
  saveOutbox();
}

function dequeueOutbox(key) {
  _outbox = _outbox.filter((x) => x.key !== key);
  saveOutbox();
}

// =============================================================================
// initApp — App Check FIRST, then Auth, then Firestore w/ offline persistence
// =============================================================================

/**
 * initApp(firebaseConfig, appCheckSiteKey) -> Promise<void>
 *
 * Order is LOAD-BEARING: App Check is initialized BEFORE Auth/Firestore so every
 * Auth and Firestore request from this page carries an App Check token from the
 * real origin (off-origin scripts are rejected before they reach the rules).
 * Firestore is created with persistent (IndexedDB) offline cache so an
 * unsendable write queues locally and reads survive a flaky connection.
 *
 * Accepts an optional 3rd arg `{ appCheckDebugToken }` for localhost dev: pass
 * `true` to print a debug token, or a fixed debug-token string. In prod leave it
 * undefined (a live debug token bypasses App Check enforcement).
 */
export async function initApp(firebaseConfig, appCheckSiteKey, opts = {}) {
  if (_initialized) return; // idempotent

  if (!firebaseConfig || typeof firebaseConfig !== 'object') {
    throw taggedError('gymboard/bad-config', 'initApp: firebaseConfig is required.');
  }
  // App Check is OPTIONAL: it initializes only when a non-empty reCAPTCHA v3 site
  // key is supplied. An empty/missing key cleanly skips it (App Check is not
  // enforced on the project). Auth + Firestore below initialize either way.

  _app = initializeApp(firebaseConfig);

  // (0) App Check BEFORE anything that talks to Firebase, but only when enabled.
  // reCAPTCHA v3 web provider, with auto-refresh so tokens stay fresh.
  // Debug token (dev only) must be set on globalThis BEFORE initializeAppCheck.
  if (appCheckSiteKey && typeof appCheckSiteKey === 'string') {
    const debugToken = opts.appCheckDebugToken;
    if (debugToken !== undefined && debugToken !== false) {
      // eslint-disable-next-line no-undef
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken; // true => printed token, or a fixed string
    }
    _appCheck = initializeAppCheck(_app, {
      provider: new ReCaptchaV3Provider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }

  // (1) Auth (anonymous provider; sign-in happens in authAndBind()).
  _auth = getAuth(_app);

  // (2) Firestore WITH offline persistence (the offline outbox + flaky-network
  // resilience). persistentLocalCache survives reloads; the multi-tab manager
  // keeps a shared cache if the link is open in two tabs. Fall back to in-memory
  // cache if IndexedDB is unavailable (e.g. Safari private mode) so the app
  // still runs (our own localStorage outbox covers the persistence gap).
  try {
    _db = initializeFirestore(_app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
  } catch (_) {
    _db = initializeFirestore(_app, { localCache: memoryLocalCache() });
  }

  loadPersistedOffset();
  loadOutbox();

  _initialized = true;
}

// =============================================================================
// authAndBind — anonymous sign-in + token-gated binding + meta/active append
// =============================================================================

/** Wrap signInAnonymously, resolving with the (stable-per-install) uid. */
async function ensureSignedIn() {
  if (_auth.currentUser) {
    _uid = _auth.currentUser.uid;
    return _uid;
  }
  const cred = await signInAnonymously(_auth);
  _uid = cred.user.uid;
  return _uid;
}

/**
 * Write the binding doc {uid, token, boundAt:serverTimestamp()}. The rule
 * re-checks the token against the admin-only /_tokenIndex on EVERY write
 * (create AND update), so re-presenting the link rebinds (overwriting uid) and a
 * stale binding grants nothing. A binding-uid mismatch from another device shows
 * up later as permission-denied on owner writes/reads, which routes to reclaim.
 */
async function writeBinding(userId, token) {
  await setDoc(doc(_db, 'bindings', userId), {
    uid: _uid,
    token,
    boundAt: serverTimestamp(),
  });
}

/**
 * Append THIS uid to /meta/active (active-reader allowlist). The rule permits a
 * signed-in client to append ONLY its own uid (read current, add me, write back;
 * nothing removed, nothing foreign added). Non-fatal: if the doc is missing or
 * the write loses a race, reads simply stay gated until the next attempt — auth
 * itself does not fail. Skips the write if this uid is already present.
 */
async function appendSelfToActive() {
  try {
    const ref = doc(_db, 'meta', 'active');
    const snap = await getDoc(ref);
    const current = snap.exists() && Array.isArray(snap.data().uids) ? snap.data().uids : [];
    if (current.includes(_uid)) return; // already enrolled
    // setDoc with the full array (the rule compares post-write to old.concat([me])).
    await setDoc(ref, { uids: [...current, _uid] }, { merge: true });
  } catch (_) {
    // meta/active may be admin-seed-pending or contended; never block auth on it.
  }
}

/**
 * authAndBind() -> Promise<{ userId, uid }>
 *
 * The load-bearing sequence: resolve capability (hash, else stored URL) ->
 * signInAnonymously -> setDoc /bindings (token proof) -> append own uid to
 * /meta/active -> strip the fragment -> persist the full capability URL for the
 * rebind path. Throws a tagged error if no capability is present or the token is
 * malformed. App Check is already initialized (initApp ran first).
 */
export async function authAndBind() {
  assertInit();

  const cap = resolveCapability();
  if (!cap) {
    throw taggedError(
      'gymboard/no-capability',
      'No capability link: open your personal gymboard link (#u=..&t=..).'
    );
  }
  if (!TOKEN_RE.test(cap.token)) {
    throw taggedError(
      'gymboard/bad-token',
      'Malformed capability token (expected 32 hex chars / 128 bits).'
    );
  }

  // Persist the FULL capability URL up front so the rebind path always has it,
  // even if a later step throws. From the live hash we persist the current URL;
  // from a stored URL we keep what we already had.
  if (cap.source === 'hash') {
    persistCapabilityURL(location.href);
  }

  await ensureSignedIn();

  // Token-proof binding. A permission-denied HERE means the presented token did
  // not match /_tokenIndex (wrong/rotated link) — NOT a uid mismatch — so it is
  // a hard bad-token, surfaced as such (reclaim is for the post-bind mismatch).
  try {
    await writeBinding(cap.userId, cap.token);
  } catch (err) {
    if (isPermissionDenied(err)) {
      throw taggedError(
        'gymboard/bind-denied',
        'This link was rejected (token rotated or revoked). Ask Soren for a fresh link.'
      );
    }
    throw err;
  }

  _userId = cap.userId;
  _token = cap.token;
  _bound = true;
  _reclaimFired = false; // a fresh successful bind re-arms the loud prompt

  // Self-enroll for reads (non-fatal).
  await appendSelfToActive();

  // Strip the fragment so the token isn't left in location.hash for later
  // scripts / screenshots / the BF cache. The persisted localStorage copy (same
  // exposure as the bookmark) remains for rebind.
  stripFragment();

  return { userId: _userId, uid: _uid };
}

/**
 * reclaim() -> Promise<{userId, uid}>
 * The tap-to-reclaim path: re-run the bind from the stored capability URL. New
 * device / clobbered binding just re-presents the token and re-takes ownership.
 */
export async function reclaim() {
  assertInit();
  const stored = readStoredCapabilityURL();
  if (!stored) {
    throw taggedError('gymboard/no-stored-capability', 'No saved link to reclaim from — reopen your gymboard link.');
  }
  const idx = stored.indexOf('#');
  const cap = idx >= 0 ? parseCapabilityHash(stored.slice(idx)) : null;
  if (!cap || !TOKEN_RE.test(cap.token)) {
    throw taggedError('gymboard/bad-token', 'Saved link is malformed — reopen your gymboard link.');
  }

  await ensureSignedIn(); // a new install mints a fresh uid here
  try {
    await writeBinding(cap.userId, cap.token);
  } catch (err) {
    if (isPermissionDenied(err)) {
      throw taggedError('gymboard/bind-denied', 'Saved link was rejected (rotated/revoked). Ask Soren for a fresh link.');
    }
    throw err;
  }

  _userId = cap.userId;
  _token = cap.token;
  _bound = true;
  _reclaimFired = false;
  await appendSelfToActive();

  // After a successful reclaim, retry anything stranded in the outbox.
  flushOutbox();

  return { userId: _userId, uid: _uid };
}

/** currentUserId() -> string|null (sync) : the bound userId for this session. */
export function currentUserId() {
  if (_userId) return _userId;
  // Allow a sync answer before authAndBind from the stored/hash capability, so
  // ui.js can pre-render its own row id; the binding still gates all writes.
  const cap = resolveCapability();
  return cap ? cap.userId : null;
}

// =============================================================================
// reclaim signal (binding-uid mismatch detection)
// =============================================================================

/**
 * onReclaimNeeded(cb) -> void
 * Register the handler fired when an owner read/write yields permission-denied
 * traced to a binding-uid mismatch (we are signed in AND bound this session, so
 * a denial on our OWN doc means another device overwrote /bindings to its uid).
 * cb() drives the LOUD prompt; the reclaim action calls reclaim().
 */
export function onReclaimNeeded(cb) {
  _reclaimCb = typeof cb === 'function' ? cb : null;
}

/**
 * Decide whether a permission-denied on an OWN-doc operation is the
 * single-active-device mismatch (vs a transient/other denial), and if so fire
 * the loud prompt exactly once. Returns true if it was treated as a reclaim.
 */
function maybeFireReclaim(err) {
  if (!isPermissionDenied(err)) return false;
  // Only meaningful once we've successfully bound this session and are signed in.
  if (!_bound || !_uid) return false;
  if (_reclaimFired) return true; // already prompted; treat as reclaim, don't spam
  _reclaimFired = true;
  if (_reclaimCb) {
    try {
      _reclaimCb();
    } catch (_) {
      /* a throwing UI handler must not break the data layer */
    }
  }
  return true;
}

// =============================================================================
// ensureUserDoc — self-create the minimal first-run shape the rules allow
// =============================================================================

const DEFAULT_TZ = 'America/New_York'; // Phase 1 default zone (per-user UI deferred)
const DEFAULT_ROLLOVER_HOUR = 4;
const DEFAULT_ROLLOVER_MINUTE = 0;

/**
 * The canonical first-run /users/{userId} shape. MUST match seed-person.js so
 * the self-create path and the admin seed never drift (DESIGN §11). joinDate is
 * the subject's CURRENT businessDate (server-anchored now), and restPattern[0]
 * is seeded effective-from joinDate with NO rest days, so missed() has its
 * required joinDate anchor and never retro-reds pre-setup days (DESIGN §11/§12).
 *
 * Only whitelisted top-level keys (userShapeOk): userId, createdAt, archived,
 * profile, rolloverHour, rolloverMinute, ianaTz, restPattern, perDateOverrides,
 * sharing. NO kcal/protein/weight, NO weightTrend, sharing forced off.
 */
function buildFirstRunUserDoc(userId, joinDate) {
  return {
    userId,
    createdAt: serverTimestamp(), // rule: == request.time
    archived: false, // rule: == false on create
    profile: {
      joinDate, // 'YYYY-MM-DD' — the missed()/streak anchor; immutable once set
    },
    ianaTz: DEFAULT_TZ,
    rolloverHour: DEFAULT_ROLLOVER_HOUR,
    rolloverMinute: DEFAULT_ROLLOVER_MINUTE,
    // first restPattern version: effective from join, zero rest days (forward-only).
    restPattern: [{ effectiveFrom: joinDate, weekdays: [] }],
    perDateOverrides: {},
    sharing: { shareMacros: false, shareWeight: false }, // rule: both must be false
  };
}

/**
 * ensureUserDoc(userId) -> Promise<void>
 * If /users/{userId} is absent, self-create the minimal first-run shape. If it
 * already exists, do nothing (don't clobber a seeded/admin doc or an existing
 * joinDate). A read or create denial that traces to a binding mismatch routes to
 * the reclaim prompt.
 */
export async function ensureUserDoc(userId) {
  assertInit();
  const id = userId || _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'ensureUserDoc: no bound userId.');

  const ref = doc(_db, 'users', id);
  let snap;
  try {
    snap = await getDoc(ref);
  } catch (err) {
    if (maybeFireReclaim(err)) return; // mismatch -> reclaim UI; don't create
    throw err;
  }

  if (snap.exists()) {
    // Opportunistically refine the server offset from the existing createdAt.
    const data = snap.data();
    if (data && data.createdAt instanceof Timestamp) {
      // We didn't author this write, so we can't bound it tightly; only adopt if
      // we have nothing better yet (don't override a write-derived offset).
      if (!_serverOffsetEstablished) {
        refineOffsetFromServerTimestamp(data.createdAt, data.createdAt.toMillis());
      }
    }
    return;
  }

  // Compute joinDate from the server-anchored now in the subject's (default) zone.
  const joinDate = currentBusinessDate(anchoredNow(), DEFAULT_TZ, DEFAULT_ROLLOVER_HOUR, DEFAULT_ROLLOVER_MINUTE);
  const sentAt = Date.now();
  try {
    await setDoc(ref, buildFirstRunUserDoc(id, joinDate));
  } catch (err) {
    if (maybeFireReclaim(err)) return;
    throw err;
  }

  // Read back to capture the resolved createdAt and refine the server offset.
  try {
    const after = await getDoc(ref);
    const createdAt = after.exists() ? after.data().createdAt : null;
    if (createdAt instanceof Timestamp) refineOffsetFromServerTimestamp(createdAt, sentAt);
  } catch (_) {
    /* offset refinement is best-effort */
  }
}

// =============================================================================
// subscribeUsers — live /users where archived==false
// =============================================================================

/**
 * subscribeUsers(cb) -> unsubscribeFn (sync return)
 * onSnapshot on /users where archived==false; cb(usersArray) on every change.
 * Each element is { id, ...docData } (id == userId == the doc id). The single
 * where('archived','==',false) needs the single-field index the console offers
 * on first run — accept it. A permission-denied on the stream (our uid dropped
 * from /meta/active, or a binding mismatch) routes to the reclaim prompt.
 */
export function subscribeUsers(cb) {
  assertInit();
  const q = query(collection(_db, 'users'), where('archived', '==', false));
  const unsub = onSnapshot(
    q,
    (qs) => {
      const users = [];
      qs.forEach((d) => {
        users.push({ id: d.id, ...d.data() });
      });
      // Opportunistically refine offset from OUR OWN doc's updatedAt-class field
      // if present (createdAt is the stable owned server stamp here).
      if (_userId) {
        const mine = users.find((u) => u.id === _userId);
        if (mine && mine.createdAt instanceof Timestamp && !_serverOffsetEstablished) {
          refineOffsetFromServerTimestamp(mine.createdAt, mine.createdAt.toMillis());
        }
      }
      if (typeof cb === 'function') cb(users);
    },
    (err) => {
      maybeFireReclaim(err);
    }
  );
  _unsubs.add(unsub);
  return () => {
    _unsubs.delete(unsub);
    try {
      unsub();
    } catch (_) {
      /* already detached */
    }
  };
}

// =============================================================================
// fetchDays — bounded getDocs over /users/{userId}/days
// =============================================================================

/**
 * fetchDays(userId, fromKey, toKey) -> Promise<{[dateKey]:DayEntry}>
 * getDocs of /users/{userId}/days bounded fromKey..toKey (inclusive), returned
 * as a map keyed by dateKey for direct hand-off to computeStreak / missed /
 * groupConsistency. Bounds by documentId() (the date key) so it needs no extra
 * index. Both bounds must be valid 'YYYY-MM-DD'.
 */
export async function fetchDays(userId, fromKey, toKey) {
  assertInit();
  const id = userId || _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'fetchDays: no userId.');
  if (!isDayKey(fromKey) || !isDayKey(toKey)) {
    throw taggedError('gymboard/bad-range', `fetchDays: bad range ${fromKey}..${toKey}`);
  }

  const daysCol = collection(_db, 'users', id, 'days');
  const q = query(daysCol, orderBy(documentId()), startAt(fromKey), endAt(toKey));
  let qs;
  try {
    qs = await getDocs(q);
  } catch (err) {
    if (maybeFireReclaim(err)) return {};
    throw err;
  }
  const map = {};
  qs.forEach((d) => {
    map[d.id] = d.data();
  });
  return map;
}

// =============================================================================
// markWorkout — the 2-write atomic WriteBatch (day cell + rollup self-cache)
// =============================================================================

/**
 * Compose the rollup self-cache update for a workout mark. The rule shape-checks
 * rollup.keys().hasOnly(['week','today','streak']); we therefore set exactly
 * those three nested fields via dotted paths so updateDoc touches only them and
 * the rest of the user doc (userId/archived/profile.joinDate) is preserved (and
 * re-validated unchanged by the rule against the existing values).
 *
 * `streak` here is a local-cache convenience only; the board RECOMPUTES streak
 * on read from /days (a viewer's recompute wins), so we do not need the
 * authoritative value at write time. We pass through whatever the caller has
 * (or leave it untouched if undefined) to avoid writing a wrong number.
 */
function rollupUpdateFields(businessDate, done, streakCache) {
  const fields = {
    // rollup.today reflects the most recent action target.
    'rollup.today': { businessDate, workout: done },
    // rollup.week[businessDate] is the per-day cache for the cheap Today paint.
    [`rollup.week.${businessDate}`]: { workout: done },
  };
  if (Number.isFinite(streakCache)) {
    fields['rollup.streak'] = streakCache;
  }
  return fields;
}

/**
 * Perform the actual 2-write batch against Firestore. Returns on success;
 * throws on failure (caller handles optimistic rollback / outbox).
 *   write 1: set /users/{u}/days/{bizDate} {workout, updatedAt} (merge)
 *   write 2: update /users/{u} rollup.* (self-cache)
 * Both stamped with serverTimestamp via the day doc's updatedAt (the rule
 * requires updatedAt == request.time on the day cell).
 */
async function commitWorkoutBatch(userId, businessDate, done, streakCache) {
  const batch = writeBatch(_db);
  const dayRef = doc(_db, 'users', userId, 'days', businessDate);
  const userRef = doc(_db, 'users', userId);

  // merge so we never clobber splitLabel/macros/off set by other flows.
  batch.set(dayRef, { workout: done, updatedAt: serverTimestamp() }, { merge: true });
  batch.update(userRef, rollupUpdateFields(businessDate, done, streakCache));

  await batch.commit();
}

/**
 * markWorkout(userId, businessDate, done) -> Promise<void>
 *
 * The 2-write atomic batch with OPTIMISTIC + offline-outbox semantics, idempotent
 * on (userId+businessDate+'workout'). The caller (ui.js) has ALREADY painted the
 * cell optimistically; this resolves only the persistence:
 *   - On success: dequeue the outbox item (if any) and return.
 *   - On a binding-mismatch permission-denied: fire the reclaim prompt and
 *     re-throw a tagged 'gymboard/reclaim-needed' so ui.js rolls back / shows the
 *     loud prompt. (HARD reject -> rollback.)
 *   - On any OTHER error (offline, transient, resource-exhausted): keep the write
 *     in the persisted outbox (stamped with its authored businessDate) for replay
 *     on reconnect, and return WITHOUT throwing (it stays optimistic-with-dot;
 *     NOT a rollback). Firestore's own offline cache also queues the batch, but
 *     our localStorage outbox is the durable, rollover-aware record.
 *
 * `businessDate` MUST be computed by the caller via logic.businessDate(serverNow,
 * subjectTz, rollH, rollM) — never device-local Date — so a tap near the cutoff
 * lands in the correct bucket. We validate it is a day-key but do not recompute
 * it (single source of truth: logic.js at the call site).
 */
export async function markWorkout(userId, businessDate, done, opts = {}) {
  assertInit();
  const id = userId || _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'markWorkout: no userId.');
  if (!isDayKey(businessDate)) {
    throw taggedError('gymboard/bad-date', `markWorkout: businessDate not a day-key: ${businessDate}`);
  }
  const value = done !== false; // coerce to bool; default true
  const streakCache = Number.isFinite(opts.streakCache) ? opts.streakCache : undefined;
  const key = outboxKey(id, businessDate, 'workout');

  // Record intent in the durable outbox BEFORE the attempt, so a crash mid-flight
  // still replays. Idempotent upsert keyed on (user,date,workout).
  enqueueOutbox({
    key,
    userId: id,
    businessDate,
    field: 'workout',
    value,
    streakCache,
    authoredAtMs: anchoredNow(),
  });

  const sentAt = Date.now();
  try {
    await commitWorkoutBatch(id, businessDate, value, streakCache);
    dequeueOutbox(key);
    // Refine offset from the day doc's resolved updatedAt (best-effort).
    try {
      const after = await getDoc(doc(_db, 'users', id, 'days', businessDate));
      const ts = after.exists() ? after.data().updatedAt : null;
      if (ts instanceof Timestamp) refineOffsetFromServerTimestamp(ts, sentAt);
    } catch (_) {
      /* ignore */
    }
  } catch (err) {
    if (isPermissionDenied(err)) {
      // HARD reject. A bound session denied on its OWN write == binding mismatch
      // (another device took ownership) or a revoked link. Drop the outbox item
      // (it can never succeed under this session) and route to reclaim.
      dequeueOutbox(key);
      maybeFireReclaim(err);
      throw taggedError('gymboard/reclaim-needed', 'Write rejected — this device was signed out elsewhere.');
    }
    // TRANSIENT (offline / unavailable / resource-exhausted): leave it queued.
    // Do NOT throw — ui.js keeps the optimistic state with an unsynced dot.
    // Firestore's offline cache will also retry; flushOutbox() reconciles.
    return;
  }
}

// =============================================================================
// offline outbox flush (retry on reconnect / after reclaim)
// =============================================================================

/**
 * Replay queued workout writes in order. Each item is idempotent, so replaying a
 * partially-succeeded queue is safe. A flush item is re-targeted to the
 * business-date it was AUTHORED for (already stored on the item), so a flush that
 * crosses the rollover writes the now-previous business-date rather than today.
 * Hard rejects (permission-denied) drop the item + route to reclaim; transient
 * failures stop the flush (kept for the next reconnect tick).
 */
async function flushOutbox() {
  if (_outboxFlushing) return;
  if (!_bound || !_userId) return;
  _outboxFlushing = true;
  try {
    // snapshot the queue; iterate in insertion order.
    const items = [..._outbox];
    for (const item of items) {
      if (item.field !== 'workout') {
        dequeueOutbox(item.key); // unknown field types are not produced in Phase 1
        continue;
      }
      try {
        await commitWorkoutBatch(item.userId, item.businessDate, item.value, item.streakCache);
        dequeueOutbox(item.key);
      } catch (err) {
        if (isPermissionDenied(err)) {
          dequeueOutbox(item.key);
          maybeFireReclaim(err);
          // stop the flush; the session is no longer the owner.
          break;
        }
        // transient: stop here, retry on the next reconnect/online event.
        break;
      }
    }
  } finally {
    _outboxFlushing = false;
  }
}

// Wire reconnect-driven flushing once, at module load (guarded for non-browser
// test contexts). `online` covers OS-level reconnect; visibilitychange covers a
// phone resuming a suspended tab.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const onlineHandler = () => {
    flushOutbox();
  };
  const visHandler = () => {
    if (document.visibilityState === 'visible') flushOutbox();
  };
  window.addEventListener('online', onlineHandler);
  window.addEventListener('visibilitychange', visHandler);
  // record removers so teardown() can detach them.
  _unsubs.add(() => window.removeEventListener('online', onlineHandler));
  _unsubs.add(() => window.removeEventListener('visibilitychange', visHandler));
}

// =============================================================================
// serverNowOffset / teardown
// =============================================================================

/**
 * serverNowOffset() -> number (sync) : the maintained (serverTime - Date.now())
 * offset in ms. ui.js computes anchored now as Date.now() + serverNowOffset()
 * and passes THAT as nowInstant into missed()/computeStreak()/
 * currentBusinessDate(). Defaults to 0 (raw device time) until a serverTimestamp
 * round-trip on an owned doc establishes it; persisted across reloads.
 */
export function serverNowOffset() {
  return _serverOffsetMs;
}

/**
 * teardown() -> void (sync) : detach all onSnapshot listeners + the
 * online/visibility handlers (tab close / sign-out). Idempotent.
 */
export function teardown() {
  for (const off of _unsubs) {
    try {
      off();
    } catch (_) {
      /* ignore */
    }
  }
  _unsubs.clear();
}
