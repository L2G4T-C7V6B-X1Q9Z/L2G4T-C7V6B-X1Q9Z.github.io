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
  randomEmoji,
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

// v3: the optional workout-type enum (lowercase storage, matches the rule's
// `workoutType in [...]` check). Defined up here (not next to VALID_GOALS below)
// because commitWorkoutBatch references it; const hoisting is fine since the
// batch only runs at call time, but a top-level decl keeps it unambiguous.
const WORKOUT_TYPES = ['upper', 'lower', 'push', 'pull', 'legs', 'full', 'cardio'];

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
    // v4: a random curated personal symbol on first create (rule whitelists 'emoji').
    // Existing/seeded docs without it fall back to logic.emojiOf's deterministic id hash.
    emoji: randomEmoji(),
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
    // v2: a workout IS a log action, so it bumps last-active like nutrition/weight.
    lastActiveAt: serverTimestamp(),
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
async function commitWorkoutBatch(userId, businessDate, done, streakCache, workoutType) {
  const batch = writeBatch(_db);
  const dayRef = doc(_db, 'users', userId, 'days', businessDate);
  const userRef = doc(_db, 'users', userId);

  // merge so we never clobber ate/kcal/protein/meals/off set by other flows.
  const dayPatch = { workout: done, updatedAt: serverTimestamp() };
  // v3: a typed mark-done also stamps the (lowercase enum) workoutType. Only on a
  // DONE mark — undo (done===false) leaves whatever type is there (clearing a type
  // on a non-trained day is cosmetic; we skip it). Validated against the enum so a
  // bad value never reaches the rule's `in [...]` check.
  if (done && workoutType && WORKOUT_TYPES.includes(workoutType)) {
    dayPatch.workoutType = workoutType;
  }
  batch.set(dayRef, dayPatch, { merge: true });
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
  // v3: optional workout type, validated against the enum (ignored on undo).
  const workoutType =
    value && opts.workoutType && WORKOUT_TYPES.includes(opts.workoutType) ? opts.workoutType : undefined;
  const key = outboxKey(id, businessDate, 'workout');

  // Record intent in the durable outbox BEFORE the attempt, so a crash mid-flight
  // still replays. Idempotent upsert keyed on (user,date,workout). The workoutType
  // rides along so an offline-queued typed workout replays WITH its type.
  enqueueOutbox({
    key,
    userId: id,
    businessDate,
    field: 'workout',
    value,
    streakCache,
    workoutType,
    authoredAtMs: anchoredNow(),
  });

  const sentAt = Date.now();
  try {
    await commitWorkoutBatch(id, businessDate, value, streakCache, workoutType);
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
        await commitWorkoutBatch(item.userId, item.businessDate, item.value, item.streakCache, item.workoutType);
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


// =============================================================================
// gymboard v2 Ã¢â‚¬â€ data.js ADDITIONS
// -----------------------------------------------------------------------------
// Paste these into app/data.js. They follow the existing module's conventions
// exactly: assertInit() first, _userId is the bound capability user id (the
// /users/{userId} doc id, NOT the anon auth uid), all writes are owner-only and
// merge-safe (setDoc({...},{merge:true}) Ã¢â‚¬â€ never clobbers sibling fields, and
// deep-merges nested maps so profile.joinDate survives a profile.displayName
// write), every owner write routes a binding-mismatch permission-denied through
// maybeFireReclaim() and re-throws a tagged 'gymboard/reclaim-needed' the same
// way markWorkout() does, and every offset refinement is best-effort.
//
// LOG actions (workout/nutrition/weight) bump /users/{uid}.lastActiveAt in the
// SAME WriteBatch as the data write (atomic, one round-trip, can't half-apply).
// SETTINGS actions (goal / hideWeight / displayName / rollover / restPattern) do
// NOT bump lastActiveAt Ã¢â‚¬â€ per SPEC, lastActiveAt tracks LOGS only.
//
// REQUIRES one import addition (see integration_notes): `updateDoc` is NOT used;
// everything here uses setDoc(merge) + writeBatch, both already imported. No
// arrayUnion needed. Add `businessWeekKey` to the logic.js import IF you want the
// optional rollup.week cache mirror in setNutritionHit (left OUT below to keep
// the writes minimal and rule-safe; see the note in setNutritionHit).
// =============================================================================


// =============================================================================
// validation helpers (clamp / reject typos Ã¢â‚¬â€ SPEC Ã‚Â§Validation)
// =============================================================================

/**
 * Validate a finite number in [lo, hi]. Rejects NaN / non-finite / out-of-range
 * with a tagged 'gymboard/bad-value' so ui.js can show a clean inline error
 * (the rules ALSO enforce the bounds server-side; this is the friendly front
 * line, not the security boundary). `round` is the number of decimal places to
 * snap to (0 => integer kcal/protein, 1 => one-decimal weight).
 */
function validateNumber(val, lo, hi, name, round = 0) {
  const n = typeof val === 'number' ? val : Number(val);
  if (!Number.isFinite(n)) {
    throw taggedError('gymboard/bad-value', `${name}: not a number (${val}).`);
  }
  if (n < lo || n > hi) {
    throw taggedError('gymboard/bad-value', `${name}: ${n} out of range ${lo}..${hi}.`);
  }
  const f = Math.pow(10, round);
  return Math.round(n * f) / f;
}


// =============================================================================
// lastActiveAt Ã¢â‚¬â€ single internal bumper, batched with the log write
// =============================================================================

/**
 * Add the lastActiveAt bump to an existing WriteBatch as a merge-set on the
 * owner's /users/{userId} doc. We merge ONLY { lastActiveAt } so no sibling
 * field (userId / archived / profile / rollup / sharing Ã¢â‚¬Â¦) is touched, and the
 * rule re-validates everything else unchanged. Used by every LOG action
 * (workout/nutrition/weight) so "last active" reflects real activity, never a
 * settings tweak. Centralized here so the field name + stamp live in one place.
 *
 * NOTE: lastActiveAt must be added to the userShapeOk() whitelist in the v2
 * rules (see integration_notes) or these batched sets will be denied.
 */
function bumpLastActiveInBatch(batch, userId) {
  const userRef = doc(_db, 'users', userId);
  batch.set(userRef, { lastActiveAt: serverTimestamp() }, { merge: true });
}


// =============================================================================
// setNutritionHit Ã¢â‚¬â€ set the nutrition triangle (ate) on own day cell + bump
// =============================================================================

/**
 * setNutritionHit(businessDate, ate) -> Promise<void>
 *
 * Set the SHARED nutrition flag `ate` on the bound owner's own day cell, plus a
 * lastActiveAt bump, in one atomic 2-write batch:
 *   write 1: set /users/{me}/days/{bizDate} { ate, updatedAt } (merge)
 *   write 2: set /users/{me}            { lastActiveAt }        (merge)
 * Merge-safe: never clobbers workout/off/kcal/protein already on the cell.
 * `ate` is coerced to bool. A binding-mismatch denial routes to reclaim and
 * re-throws 'gymboard/reclaim-needed'; any other error propagates (no outbox Ã¢â‚¬â€
 * the offline outbox is workout-only by design; Firestore's own offline cache
 * still queues the set, but we surface the error so ui.js can decide).
 */
export async function setNutritionHit(businessDate, ate) {
  assertInit();
  const id = _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'setNutritionHit: no bound userId.');
  if (!isDayKey(businessDate)) {
    throw taggedError('gymboard/bad-date', `setNutritionHit: businessDate not a day-key: ${businessDate}`);
  }
  const value = ate !== false; // coerce to bool; default true

  const batch = writeBatch(_db);
  const dayRef = doc(_db, 'users', id, 'days', businessDate);
  // merge so workout / off / kcal / protein on this cell are preserved.
  batch.set(dayRef, { ate: value, updatedAt: serverTimestamp() }, { merge: true });
  bumpLastActiveInBatch(batch, id);

  const sentAt = Date.now();
  try {
    await batch.commit();
  } catch (err) {
    if (isPermissionDenied(err)) {
      maybeFireReclaim(err);
      throw taggedError('gymboard/reclaim-needed', 'Write rejected Ã¢â‚¬â€ this device was signed out elsewhere.');
    }
    throw err;
  }
  // best-effort offset refinement from the cell's resolved updatedAt.
  try {
    const after = await getDoc(dayRef);
    const ts = after.exists() ? after.data().updatedAt : null;
    if (ts instanceof Timestamp) refineOffsetFromServerTimestamp(ts, sentAt);
  } catch (_) {
    /* ignore */
  }
}


// =============================================================================
// setMacros Ã¢â‚¬â€ set kcal/protein numbers on own day cell (validated) + bump
// =============================================================================

/**
 * setMacros(businessDate, { kcal?, protein? }) -> Promise<void>
 *
 * Write optional macro NUMBERS onto the bound owner's own day cell (v2 lifts the
 * v1 number-ban on the day cell), plus a lastActiveAt bump, atomically:
 *   write 1: set /users/{me}/days/{bizDate} { kcal?, protein?, updatedAt } (merge)
 *   write 2: set /users/{me}            { lastActiveAt }                   (merge)
 * Validation: kcal 0..10000 (integer), protein 0..1000 (integer). At least one
 * of kcal/protein must be present (an empty object is a no-op error). Only the
 * provided keys are written, so setting just protein leaves an existing kcal
 * intact (merge). Does NOT set `ate` Ã¢â‚¬â€ call setNutritionHit for the triangle
 * (the bottom-bar MACROS button calls setNutritionHit; the editor calls this for
 * the numbers).
 */
export async function setMacros(businessDate, macros = {}) {
  assertInit();
  const id = _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'setMacros: no bound userId.');
  if (!isDayKey(businessDate)) {
    throw taggedError('gymboard/bad-date', `setMacros: businessDate not a day-key: ${businessDate}`);
  }
  if (!macros || typeof macros !== 'object') {
    throw taggedError('gymboard/bad-value', 'setMacros: opts must be { kcal?, protein? }.');
  }

  const payload = { updatedAt: serverTimestamp() };
  if (macros.kcal !== undefined && macros.kcal !== null) {
    payload.kcal = validateNumber(macros.kcal, 0, 10000, 'kcal', 0);
  }
  if (macros.protein !== undefined && macros.protein !== null) {
    payload.protein = validateNumber(macros.protein, 0, 1000, 'protein', 0);
  }
  // require at least one real macro field (besides updatedAt).
  if (Object.keys(payload).length < 2) {
    throw taggedError('gymboard/bad-value', 'setMacros: provide kcal and/or protein.');
  }

  const batch = writeBatch(_db);
  const dayRef = doc(_db, 'users', id, 'days', businessDate);
  batch.set(dayRef, payload, { merge: true });
  bumpLastActiveInBatch(batch, id);

  try {
    await batch.commit();
  } catch (err) {
    if (isPermissionDenied(err)) {
      maybeFireReclaim(err);
      throw taggedError('gymboard/reclaim-needed', 'Write rejected Ã¢â‚¬â€ this device was signed out elsewhere.');
    }
    throw err;
  }
}


// =============================================================================
// setDayOff Ã¢â‚¬â€ toggle the one-off day-off flag on own day cell
// =============================================================================

const MAX_MEALS_PER_DAY = 50; // matches the rule's meals.size() <= 50 cap.

/**
 * addMeal(businessDate, { kcal, protein }) -> Promise<void>
 *
 * READ-MODIFY-WRITE a meal onto the bound owner's own day cell (SPEC-v3 §3):
 *   1. getDoc the day cell.
 *   2. newKcal = (existing.kcal||0)+mealKcal, newProtein = (existing.protein||0)+
 *      mealProtein, newMeals = (existing.meals||[]).concat([{kcal,protein,at}]).
 *      `at` is a CLIENT-clocked Timestamp.fromMillis(anchoredNow()) because
 *      Firestore forbids serverTimestamp() sentinels INSIDE array elements; it's
 *      server-anchored via the offset (within seconds) and display-only.
 *   3. set(merge) { kcal, protein, meals, updatedAt:serverTimestamp() } + a
 *      lastActive bump, in one atomic 2-write batch (this is a LOG action).
 *
 * Validation: meal kcal 0..10000 (REQUIRED, > 0), protein 0..1000 (optional => 0).
 * Rejects 'gymboard/bad-value' if the RESULTING total would exceed 10000/1000
 * ("daily total too high") or if meals.length >= 50 ("too many meals today").
 *
 * NOT outbox-queued: a queued meal-add would replay against a stale base and
 * double-count, so meal-add is online-only (Firestore's offline cache still queues
 * the single set; we surface any error so ui.js can react — SPEC §3).
 */
export async function addMeal(businessDate, meal = {}) {
  assertInit();
  const id = _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'addMeal: no bound userId.');
  if (!isDayKey(businessDate)) {
    throw taggedError('gymboard/bad-date', `addMeal: businessDate not a day-key: ${businessDate}`);
  }
  if (!meal || typeof meal !== 'object') {
    throw taggedError('gymboard/bad-value', 'addMeal: meal must be { kcal, protein? }.');
  }

  const mealKcal = validateNumber(meal.kcal, 0, 10000, 'meal kcal', 0);
  if (!(mealKcal > 0)) {
    throw taggedError('gymboard/bad-value', 'addMeal: a meal needs some calories.');
  }
  const mealProtein =
    meal.protein === undefined || meal.protein === null
      ? 0
      : validateNumber(meal.protein, 0, 1000, 'meal protein', 0);

  const dayRef = doc(_db, 'users', id, 'days', businessDate);

  let snap;
  try {
    snap = await getDoc(dayRef);
  } catch (err) {
    if (maybeFireReclaim(err)) {
      throw taggedError('gymboard/reclaim-needed', 'Write rejected - this device was signed out elsewhere.');
    }
    throw err;
  }
  const existing = snap.exists() ? snap.data() : {};
  const prevMeals = Array.isArray(existing.meals) ? existing.meals : [];

  if (prevMeals.length >= MAX_MEALS_PER_DAY) {
    throw taggedError('gymboard/bad-value', 'too many meals today');
  }

  const newKcal = (Number.isFinite(existing.kcal) ? existing.kcal : 0) + mealKcal;
  const newProtein = (Number.isFinite(existing.protein) ? existing.protein : 0) + mealProtein;
  if (newKcal > 10000) {
    throw taggedError('gymboard/bad-value', 'daily total too high (calories)');
  }
  if (newProtein > 1000) {
    throw taggedError('gymboard/bad-value', 'daily total too high (protein)');
  }

  const at = Timestamp.fromMillis(anchoredNow()); // the one client-clocked field.
  // v4 (#8): when a meal is logged from a quick-meal preset WITH a name, carry that
  // label onto the meal element so TODAY'S MEALS can show "Lunch — 600 kcal / 45g".
  // Meal elements are client-trusted by the rules (is-list + size cap), so no rule
  // change is needed. Trim + cap at 24 chars; omit if empty/non-string.
  const mealEl = { kcal: mealKcal, protein: mealProtein, at };
  if (meal.label !== undefined && meal.label !== null && meal.label !== '') {
    if (typeof meal.label === 'string') {
      const label = meal.label.trim().slice(0, 24);
      if (label) mealEl.label = label;
    }
  }
  // v4 (#7): a quick-meal preset can carry a free-text note; copy a trimmed, capped
  // copy onto the meal element the same way as the label (client-trusted, no rule change).
  if (typeof meal.note === 'string' && meal.note.trim()) {
    mealEl.note = meal.note.trim().slice(0, 80);
  }
  const newMeals = prevMeals.concat([mealEl]);

  const batch = writeBatch(_db);
  batch.set(
    dayRef,
    { kcal: newKcal, protein: newProtein, meals: newMeals, updatedAt: serverTimestamp() },
    { merge: true }
  );
  bumpLastActiveInBatch(batch, id);

  const sentAt = Date.now();
  try {
    await batch.commit();
  } catch (err) {
    if (isPermissionDenied(err)) {
      maybeFireReclaim(err);
      throw taggedError('gymboard/reclaim-needed', 'Write rejected - this device was signed out elsewhere.');
    }
    throw err;
  }
  try {
    const after = await getDoc(dayRef);
    const ts = after.exists() ? after.data().updatedAt : null;
    if (ts instanceof Timestamp) refineOffsetFromServerTimestamp(ts, sentAt);
  } catch (_) {
    /* ignore */
  }
}

/**
 * removeMeal(businessDate, index) -> Promise<void>
 *
 * READ-MODIFY-WRITE: drop meals[index], recompute scalar kcal/protein as the SUM of
 * the REMAINING array (re-summing, not subtraction, self-heals any prior drift).
 * Write back { kcal, protein, meals, updatedAt } + a lastActive bump.
 *
 * Caveat (SPEC §3): a day whose total included a pre-array manual number loses that
 * amount on the first remove (the array never held it). Acceptable for a ~5-person
 * app; the day editor can re-set the number. Empty array => totals go to 0.
 */
export async function removeMeal(businessDate, index) {
  assertInit();
  const id = _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'removeMeal: no bound userId.');
  if (!isDayKey(businessDate)) {
    throw taggedError('gymboard/bad-date', `removeMeal: businessDate not a day-key: ${businessDate}`);
  }
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0) {
    throw taggedError('gymboard/bad-value', `removeMeal: bad index ${index}.`);
  }

  const dayRef = doc(_db, 'users', id, 'days', businessDate);
  let snap;
  try {
    snap = await getDoc(dayRef);
  } catch (err) {
    if (maybeFireReclaim(err)) {
      throw taggedError('gymboard/reclaim-needed', 'Write rejected - this device was signed out elsewhere.');
    }
    throw err;
  }
  const existing = snap.exists() ? snap.data() : {};
  const prevMeals = Array.isArray(existing.meals) ? existing.meals : [];
  if (idx >= prevMeals.length) {
    throw taggedError('gymboard/bad-value', `removeMeal: index ${idx} out of range.`);
  }

  const newMeals = prevMeals.slice(0, idx).concat(prevMeals.slice(idx + 1));
  let newKcal = 0;
  let newProtein = 0;
  for (const mDoc of newMeals) {
    if (mDoc && Number.isFinite(mDoc.kcal)) newKcal += mDoc.kcal;
    if (mDoc && Number.isFinite(mDoc.protein)) newProtein += mDoc.protein;
  }

  const batch = writeBatch(_db);
  batch.set(
    dayRef,
    { kcal: newKcal, protein: newProtein, meals: newMeals, updatedAt: serverTimestamp() },
    { merge: true }
  );
  bumpLastActiveInBatch(batch, id);

  try {
    await batch.commit();
  } catch (err) {
    if (isPermissionDenied(err)) {
      maybeFireReclaim(err);
      throw taggedError('gymboard/reclaim-needed', 'Write rejected - this device was signed out elsewhere.');
    }
    throw err;
  }
}


// =============================================================================
// setDayOff - toggle the one-off day-off flag on own day cell
// =============================================================================

/**
 * setDayOff(businessDate, off) -> Promise<void>
 *
 * Toggle the one-off `off` flag on the bound owner's own day cell (a day off is
 * NOT a miss; logic.missed() honors it). LOG action; bumps lastActiveAt.
 * Merge-safe: leaves workout/ate/kcal/protein/meals untouched. `off` coerced bool.
 */
export async function setDayOff(businessDate, off) {
  assertInit();
  const id = _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'setDayOff: no bound userId.');
  if (!isDayKey(businessDate)) {
    throw taggedError('gymboard/bad-date', `setDayOff: businessDate not a day-key: ${businessDate}`);
  }
  const value = off !== false; // coerce to bool; default true

  const batch = writeBatch(_db);
  const dayRef = doc(_db, 'users', id, 'days', businessDate);
  batch.set(dayRef, { off: value, updatedAt: serverTimestamp() }, { merge: true });
  bumpLastActiveInBatch(batch, id);

  try {
    await batch.commit();
  } catch (err) {
    if (isPermissionDenied(err)) {
      maybeFireReclaim(err);
      throw taggedError('gymboard/reclaim-needed', 'Write rejected Ã¢â‚¬â€ this device was signed out elsewhere.');
    }
    throw err;
  }
}


// =============================================================================
// setWeight Ã¢â‚¬â€ write a weigh-in to the read-gated /weights subcollection + bump
// =============================================================================

/**
 * setWeight(businessDate, lb) -> Promise<void>
 *
 * Write a weigh-in to /users/{me}/weights/{bizDate} = { lb, at:serverTimestamp }
 * (one decimal, 50..600), plus a lastActiveAt bump, atomically:
 *   write 1: set /users/{me}/weights/{bizDate} { lb, at } (merge)
 *   write 2: set /users/{me}               { lastActiveAt } (merge)
 * One weigh-in per business date (the date IS the doc id); a re-weigh same day
 * overwrites that date's number (latest shown). The whole subcollection is
 * READ-gated on hideWeight in the v2 rules Ã¢â‚¬â€ hiding instantly revokes group read
 * of the entire weight history. Owner-only write. A binding-mismatch denial
 * routes to reclaim; any other error propagates.
 */
export async function setWeight(businessDate, lb) {
  assertInit();
  const id = _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'setWeight: no bound userId.');
  if (!isDayKey(businessDate)) {
    throw taggedError('gymboard/bad-date', `setWeight: businessDate not a day-key: ${businessDate}`);
  }
  const value = validateNumber(lb, 50, 600, 'weight', 1); // one decimal, sane bounds

  const batch = writeBatch(_db);
  const weightRef = doc(_db, 'users', id, 'weights', businessDate);
  batch.set(weightRef, { lb: value, at: serverTimestamp() }, { merge: true });
  bumpLastActiveInBatch(batch, id);

  const sentAt = Date.now();
  try {
    await batch.commit();
  } catch (err) {
    if (isPermissionDenied(err)) {
      maybeFireReclaim(err);
      throw taggedError('gymboard/reclaim-needed', 'Write rejected Ã¢â‚¬â€ this device was signed out elsewhere.');
    }
    throw err;
  }
  // best-effort offset refinement from the resolved `at`.
  try {
    const after = await getDoc(weightRef);
    const ts = after.exists() ? after.data().at : null;
    if (ts instanceof Timestamp) refineOffsetFromServerTimestamp(ts, sentAt);
  } catch (_) {
    /* ignore */
  }
}


// =============================================================================
// SETTINGS writes (own /users doc) Ã¢â‚¬â€ merge-safe, NO lastActiveAt bump
// =============================================================================

/**
 * Shared owner-doc settings writer: merge-set `patch` onto /users/{me} so only
 * the named fields change and every sibling is preserved + re-validated
 * unchanged by the rule. Settings actions do NOT bump lastActiveAt (that field
 * tracks LOGS, not config). Binding-mismatch -> reclaim; other errors propagate.
 */
async function updateOwnUser(patch, callerName) {
  assertInit();
  const id = _userId;
  if (!id) throw taggedError('gymboard/not-bound', `${callerName}: no bound userId.`);
  const ref = doc(_db, 'users', id);
  try {
    await setDoc(ref, patch, { merge: true });
  } catch (err) {
    if (isPermissionDenied(err)) {
      maybeFireReclaim(err);
      throw taggedError('gymboard/reclaim-needed', 'Write rejected Ã¢â‚¬â€ this device was signed out elsewhere.');
    }
    throw err;
  }
}

const VALID_GOALS = ['gain', 'lose', 'maintain'];

/**
 * setGoal(goal) -> Promise<void>
 * Set the weight goal ('gain' | 'lose' | 'maintain') on own user doc. Drives the
 * weight-arrow color (logic.weightTrend). Rejects anything outside the enum.
 */
export async function setGoal(goal) {
  if (!VALID_GOALS.includes(goal)) {
    throw taggedError('gymboard/bad-value', `setGoal: goal must be one of ${VALID_GOALS.join('/')}.`);
  }
  await updateOwnUser({ goal }, 'setGoal');
}

/**
 * setNutritionGoals({ kcalGoal?, proteinGoal? }) -> Promise<void>
 *
 * v3: set the daily calorie + protein goals on own user doc. These drive the
 * nutritionStatus() auto-check (direction comes from `goal`). One combined writer so
 * changing both in the GOAL card costs one round-trip. Validation: kcalGoal
 * 800..10000, proteinGoal 0..500 (both integers via validateNumber). At least one
 * must be provided. This is a SETTING, so it does NOT bump lastActiveAt (consistent
 * with setGoal/setRollover). Only the provided keys are written (merge), so setting
 * just the protein goal leaves an existing kcalGoal intact.
 */
export async function setNutritionGoals(goals = {}) {
  if (!goals || typeof goals !== 'object') {
    throw taggedError('gymboard/bad-value', 'setNutritionGoals: opts must be { kcalGoal?, proteinGoal? }.');
  }
  const patch = {};
  if (goals.kcalGoal !== undefined && goals.kcalGoal !== null) {
    patch.kcalGoal = validateNumber(goals.kcalGoal, 800, 10000, 'kcalGoal', 0);
  }
  if (goals.proteinGoal !== undefined && goals.proteinGoal !== null) {
    patch.proteinGoal = validateNumber(goals.proteinGoal, 0, 500, 'proteinGoal', 0);
  }
  if (Object.keys(patch).length === 0) {
    throw taggedError('gymboard/bad-value', 'setNutritionGoals: provide kcalGoal and/or proteinGoal.');
  }
  await updateOwnUser(patch, 'setNutritionGoals');
}

/**
 * setHideWeight(hide) -> Promise<void>
 * Flip the hideWeight flag on own user doc. true instantly revokes the group's
 * read of the ENTIRE /weights history (the v2 rule gates weights read on this
 * flag) and blanks the under-name weight+arrow for everyone else. Coerced bool.
 */
export async function setHideWeight(hide) {
  await updateOwnUser({ hideWeight: hide !== false }, 'setHideWeight');
}

/**
 * setDisplayName(name) -> Promise<void>
 * Self-rename: write profile.displayName on own user doc (<= 24 chars after
 * trim, non-empty). Deep-merges into `profile`, so profile.joinDate (the
 * immutable missed()/streak anchor) is preserved. The v2 rule must whitelist
 * profile.displayName as owner-editable while keeping joinDate locked.
 */
export async function setDisplayName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw taggedError('gymboard/bad-value', 'setDisplayName: name is empty.');
  }
  if (trimmed.length > 24) {
    throw taggedError('gymboard/bad-value', 'setDisplayName: name exceeds 24 characters.');
  }
  // merge:true on a nested map is a DEEP merge Ã¢â‚¬â€ profile.joinDate survives.
  await updateOwnUser({ profile: { displayName: trimmed } }, 'setDisplayName');
}

/**
 * setRollover(hour, min) -> Promise<void>
 * Set the owner's day-rollover wall-clock time (default 4:00). hour 0..23,
 * min 0..59, both integers. This is what flips "today-not-yet" to red in the
 * owner's own zone; viewers read it off the user doc.
 */
export async function setRollover(hour, min) {
  const h = validateNumber(hour, 0, 23, 'rolloverHour', 0);
  const m = validateNumber(min, 0, 59, 'rolloverMinute', 0);
  await updateOwnUser({ rolloverHour: h, rolloverMinute: m }, 'setRollover');
}

/**
 * setRestPattern(pattern) -> Promise<void>
 * Replace the owner's weekly rest pattern. `pattern` is the restPattern LIST the
 * rules/logic expect: an array of { effectiveFrom:'YYYY-MM-DD', weekdays:[0..6] }
 * version objects (0=Sun..6=Sat). We validate the SHAPE (array of versions with a
 * valid effectiveFrom day-key and a weekdays array of unique ints 0..6) but do
 * not reorder or inject versions Ã¢â‚¬â€ the ME page composes the new version list
 * (append-a-version, forward-only) and hands it in whole. logic.isRestDay()
 * resolves the effective version per date, so a bad list would silently mis-paint
 * rest days; hence the strict client check here.
 */
export async function setRestPattern(pattern) {
  if (!Array.isArray(pattern) || pattern.length === 0) {
    throw taggedError('gymboard/bad-value', 'setRestPattern: expected a non-empty version array.');
  }
  for (const v of pattern) {
    if (!v || typeof v !== 'object') {
      throw taggedError('gymboard/bad-value', 'setRestPattern: each version must be an object.');
    }
    if (!isDayKey(v.effectiveFrom)) {
      throw taggedError('gymboard/bad-value', `setRestPattern: bad effectiveFrom ${v.effectiveFrom}.`);
    }
    if (!Array.isArray(v.weekdays)) {
      throw taggedError('gymboard/bad-value', 'setRestPattern: weekdays must be an array.');
    }
    const seen = new Set();
    for (const d of v.weekdays) {
      if (!Number.isInteger(d) || d < 0 || d > 6) {
        throw taggedError('gymboard/bad-value', `setRestPattern: weekday ${d} not in 0..6.`);
      }
      if (seen.has(d)) {
        throw taggedError('gymboard/bad-value', `setRestPattern: duplicate weekday ${d}.`);
      }
      seen.add(d);
    }
  }
  await updateOwnUser({ restPattern: pattern }, 'setRestPattern');
}

const MAX_SAVED_MEALS = 20; // matches the rule's savedMeals.size() <= 20 cap.

/**
 * setSavedMeals(arr) -> Promise<void>
 *
 * v3.1: merge-SET the whole savedMeals preset array on the owner user doc. Each entry is
 * { kcal:number(0..10000), protein:number(0..1000), label?:string(<=24 chars) }. Validates
 * + normalizes every element (kcal/protein snapped to integers, label trimmed), caps the
 * list at 20. This is a SETTING, so it does NOT bump lastActiveAt (consistent with
 * setGoal/setRollover/setRestPattern). Per-element shape is CLIENT-trusted by the rules
 * (same posture as restPattern); this is the friendly front-line validator. A non-array
 * or an over-cap list is rejected before the write.
 */
export async function setSavedMeals(arr) {
  if (!Array.isArray(arr)) {
    throw taggedError('gymboard/bad-value', 'setSavedMeals: expected an array of presets.');
  }
  if (arr.length > MAX_SAVED_MEALS) {
    throw taggedError('gymboard/bad-value', `setSavedMeals: too many presets (max ${MAX_SAVED_MEALS}).`);
  }
  const clean = arr.map((m, i) => {
    if (!m || typeof m !== 'object') {
      throw taggedError('gymboard/bad-value', `setSavedMeals: entry ${i} must be an object.`);
    }
    const kcal = validateNumber(m.kcal, 0, 10000, `savedMeals[${i}].kcal`, 0);
    const protein = validateNumber(m.protein, 0, 1000, `savedMeals[${i}].protein`, 0);
    const out = { kcal, protein };
    if (m.label !== undefined && m.label !== null && m.label !== '') {
      if (typeof m.label !== 'string') {
        throw taggedError('gymboard/bad-value', `setSavedMeals: entry ${i} label must be a string.`);
      }
      const label = m.label.trim();
      if (label.length > 24) {
        throw taggedError('gymboard/bad-value', `setSavedMeals: entry ${i} label exceeds 24 characters.`);
      }
      if (label) out.label = label;
    }
    // v4 (#7): optional free-text note (<=80 chars). Per-element shape is client-trusted
    // by the rules (savedMeals is is-list + size<=20), so 'note' needs no rule change.
    if (m.note !== undefined && m.note !== null && m.note !== '') {
      if (typeof m.note !== 'string') {
        throw taggedError('gymboard/bad-value', `setSavedMeals: entry ${i} note must be a string.`);
      }
      const note = m.note.trim();
      if (note.length > 80) {
        throw taggedError('gymboard/bad-value', `setSavedMeals: entry ${i} note exceeds 80 characters.`);
      }
      if (note) out.note = note;
    }
    return out;
  });
  await updateOwnUser({ savedMeals: clean }, 'setSavedMeals');
}

/**
 * addSavedMeal(currentArr, meal) -> Promise<void>
 * Convenience wrapper: append one preset to the caller-supplied current array and re-set
 * the whole list (the rules require the full array; there is no arrayUnion path here).
 */
export async function addSavedMeal(currentArr, meal) {
  const base = Array.isArray(currentArr) ? currentArr.slice() : [];
  base.push(meal);
  await setSavedMeals(base);
}

/**
 * removeSavedMeal(currentArr, index) -> Promise<void>
 * Convenience wrapper: drop the preset at `index` from the caller-supplied current array
 * and re-set the whole list.
 */
export async function removeSavedMeal(currentArr, index) {
  const base = Array.isArray(currentArr) ? currentArr.slice() : [];
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= base.length) {
    throw taggedError('gymboard/bad-value', `removeSavedMeal: bad index ${index}.`);
  }
  base.splice(idx, 1);
  await setSavedMeals(base);
}

// the canonical workout-type enum (matches WORKOUT_TYPES above + the rule's `in [...]`).
const ENABLED_TYPES_ENUM = WORKOUT_TYPES;

/**
 * setEnabledWorkoutTypes(arr) -> Promise<void>
 *
 * v3.1: merge-SET the enabledWorkoutTypes subset on the owner user doc — which of the 7
 * canonical types appear in the daily picker. Validates every element is in the canonical
 * enum, dedupes (preserving first-seen order), caps at 7. An empty/unset array means "all
 * 7" at the UI layer (back-compat), so we permit an empty array through. This is a SETTING
 * (no lastActiveAt bump).
 */
export async function setEnabledWorkoutTypes(arr) {
  if (!Array.isArray(arr)) {
    throw taggedError('gymboard/bad-value', 'setEnabledWorkoutTypes: expected an array of type keys.');
  }
  const seen = new Set();
  const clean = [];
  for (const t of arr) {
    if (!ENABLED_TYPES_ENUM.includes(t)) {
      throw taggedError('gymboard/bad-value', `setEnabledWorkoutTypes: ${t} is not a canonical type.`);
    }
    if (seen.has(t)) continue; // dedupe
    seen.add(t);
    clean.push(t);
  }
  if (clean.length > 7) {
    throw taggedError('gymboard/bad-value', 'setEnabledWorkoutTypes: too many types (max 7).');
  }
  await updateOwnUser({ enabledWorkoutTypes: clean }, 'setEnabledWorkoutTypes');
}

const VALID_NUTRITION_MODES = ['manual', 'protein', 'both'];

/**
 * setNutritionMode(mode) -> Promise<void>
 *
 * v4 (#6): set the per-person nutrition auto-check mode on own user doc:
 *   'manual'  = nutrition hits ONLY when manually marked done (ate===true).
 *   'protein' = auto-hit when protein >= proteinGoal (calories ignored).
 *   'both'    = auto-hit when calories in-range (by goal direction) AND protein floor.
 * Drives logic.nutritionStatus. Rejects anything outside the enum (the rule ALSO
 * enforces `nutritionMode in ['manual','protein','both']`). This is a SETTING, so it
 * does NOT bump lastActiveAt (consistent with setGoal/setRollover).
 */
export async function setNutritionMode(mode) {
  if (!VALID_NUTRITION_MODES.includes(mode)) {
    throw taggedError('gymboard/bad-value', `setNutritionMode: mode must be one of ${VALID_NUTRITION_MODES.join('/')}.`);
  }
  await updateOwnUser({ nutritionMode: mode }, 'setNutritionMode');
}

/**
 * setEmoji(emoji) -> Promise<void>
 *
 * v4 (#14): set the personal symbol shown by the name on the SOCIAL board. The rule
 * caps `emoji.size() <= 8` (UTF-16 code units) so a multi-codepoint ZWJ/flag emoji is
 * permitted; the picker only offers single curated graphemes in practice. We restrict
 * to one grapheme (<=2 code points) here as the friendly front line, while still
 * allowing up to 8 UTF-16 units (the rule's cap) for ZWJ sequences. SETTING, no bump.
 */
export async function setEmoji(emoji) {
  if (typeof emoji !== 'string' || !emoji.trim()) {
    throw taggedError('gymboard/bad-value', 'setEmoji: emoji must be a non-empty string.');
  }
  // one grapheme (allow a ZWJ sequence up to 8 UTF-16 code units, mirroring the rule).
  if ([...emoji].length > 2 || emoji.length > 8) {
    throw taggedError('gymboard/bad-value', 'setEmoji: expected a single emoji.');
  }
  await updateOwnUser({ emoji }, 'setEmoji');
}


// =============================================================================
// fetchWeights Ã¢â‚¬â€ read a member's weights window (permission-denied => hidden)
// =============================================================================

/**
 * fetchWeights(userId, fromKey, toKey) -> Promise<{[dateKey]: number}>
 *
 * getDocs of /users/{userId}/weights bounded fromKey..toKey (inclusive),
 * returned as a flat map dateKey -> lb (pounds, one decimal) for direct hand-off
 * to logic.weightTrend(). Bounds by documentId() (the date key) so it needs no
 * extra index. Both bounds must be valid 'YYYY-MM-DD'.
 *
 * The whole subcollection is READ-gated on the subject's hideWeight flag in the
 * v2 rules. Per SPEC, a permission-denied here MEANS "this member's weight is
 * hidden" -> we resolve {} (caller renders a blank weight + no arrow), we do NOT
 * route it to the reclaim prompt: a weight read is gated by privacy, and even on
 * the caller's OWN id a denial is the hide-gate, not a binding mismatch (real
 * binding mismatches still surface on the owner WRITES, which do route to
 * reclaim). Any non-permission error (offline/transient) propagates so ui.js can
 * distinguish "hidden" (={}) from "couldn't load".
 */
export async function fetchWeights(userId, fromKey, toKey) {
  assertInit();
  const id = userId || _userId;
  if (!id) throw taggedError('gymboard/not-bound', 'fetchWeights: no userId.');
  if (!isDayKey(fromKey) || !isDayKey(toKey)) {
    throw taggedError('gymboard/bad-range', `fetchWeights: bad range ${fromKey}..${toKey}`);
  }

  const weightsCol = collection(_db, 'users', id, 'weights');
  const q = query(weightsCol, orderBy(documentId()), startAt(fromKey), endAt(toKey));
  let qs;
  try {
    qs = await getDocs(q);
  } catch (err) {
    if (isPermissionDenied(err)) return {}; // gated => hidden (SPEC); not a reclaim.
    throw err;
  }
  const map = {};
  qs.forEach((d) => {
    const data = d.data();
    if (data && typeof data.lb === 'number') map[d.id] = data.lb;
  });
  return map;
}


// =============================================================================
// fetchOlderDays Ã¢â‚¬â€ scroll-back alias over the bounded fetchDays
// =============================================================================

/**
 * fetchOlderDays(userId, fromKey, toKey) -> Promise<{[dateKey]: DayEntry}>
 * Thin alias for the scroll-up "load past weeks" path. fetchDays() is already a
 * bounded documentId() range read, so older weeks are just an earlier window;
 * kept as a named export so ui.js reads intent at the call site (and so a future
 * older-only optimization has a seam). Same reclaim/return semantics as fetchDays.
 */
export async function fetchOlderDays(userId, fromKey, toKey) {
  return fetchDays(userId, fromKey, toKey);
}
