// Fresh renderer / unchanged persistence boundary. No dependency on legacy ui.js.
import * as data from './data.js';
import * as L from './logic.js';

const TYPES = ['upper', 'lower', 'push', 'pull', 'legs', 'full', 'cardio'];
const DAY_WINDOW = 120;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : '';
const typeLabel = (type) => type === 'full' ? 'Full body' : cap(type);
const typeKey = (type) => String(type || '').toLowerCase().replace(/^full body$/,'full');
const ui = () => window.GymBoardUI;
const idOf = (m) => m.userId || m.id;
const now = () => Date.now() + (data.serverNowOffset?.() || 0);
const getMillis = (v) => typeof v?.toMillis === 'function' ? v.toMillis() : Number.isFinite(v) ? v : null;
const number = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;
const step = (key, n) => { for (let i = 0; i < Math.abs(n); i++) key = n < 0 ? L.prevBusinessDate(key) : L.nextDayKey(key); return key; };
const daysBetween = (from, to) => { const result = []; for (let k = from; k <= to; k = L.nextDayKey(k)) result.push(k); return result; };
const local = { myId: null, members: [], days: new Map(), weights: new Map(), overlay: new Map(), loaded: false, readSeq: new Map(), coverage: new Map(), readErrors: new Map(), busy: new Set(), pending: new Set(), stopped: false };
let mealChain = Promise.resolve();
let heartbeat, rolloverTimer, subscription;

export function subjectOf(member = {}) {
  return {
    ...member,
    profile: member.profile || {},
    ianaTz: member.ianaTz || TZ,
    rolloverHour: number(member.rolloverHour, 4), rolloverMinute: number(member.rolloverMinute),
    restPattern: Array.isArray(member.restPattern) ? member.restPattern : [],
    perDateOverrides: member.perDateOverrides || {},
    workoutPauses: Array.isArray(member.workoutPauses) ? member.workoutPauses : [],
    vacations: Array.isArray(member.vacations) ? member.vacations : [],
    nutritionMode: ['manual', 'protein', 'both'].includes(member.nutritionMode) ? member.nutritionMode : 'both',
    goal: member.goal || 'maintain',
  };
}

const byId = (id) => local.members.find((m) => idOf(m) === id);
const me = () => byId(local.myId);
const currentDate = (member = me()) => { const s = subjectOf(member); return L.currentBusinessDate(now(), s.ianaTz, s.rolloverHour, s.rolloverMinute); };
function rawDay(id, date) { return { ...(local.days.get(id)?.[date] || {}), ...(local.overlay.get(`${id}|${date}`) || {}) }; }
function hasDateData(id, date) { const range=local.coverage.get(id);return !!range&&date>=range.from&&date<=range.to; }
function effectiveDays(id) {
  const result = { ...(local.days.get(id) || {}) };
  for (const [key, patch] of local.overlay) if (key.startsWith(`${id}|`)) {
    const date = key.slice(id.length + 1); result[date] = { ...(result[date] || {}), ...patch };
  }
  return result;
}

export function classifyDay(subject, date, at, day = {}) {
  if (L.isDayKey(subject.profile?.joinDate) && date < subject.profile.joinDate) return { workoutStatus: 'prejoin', nutritionStatus: 'prejoin', nutritionProgress: null };
  const vacation = L.vacationOn?.(subject, date) === true;
  const paused = L.workoutsPausedOn?.(subject, date) === true;
  const rest = L.isRestDay(subject.restPattern, subject.perDateOverrides, date);
  const today = L.currentBusinessDate(at, subject.ianaTz, subject.rolloverHour, subject.rolloverMinute);
  const goals = L.nutritionGoalOpts(day, subject);
  const n = L.nutritionStatus(day, { ...goals, isPast: date < today });
  return {
    workoutStatus: day.workout === true ? 'done' : vacation ? 'vacation' : day.off === true ? 'off' : rest ? 'rest' : paused ? 'paused' : L.missed(subject, date, at, day) ? 'missed' : 'pending',
    nutritionStatus: vacation && n !== 'hit' ? 'vacation' : n,
    nutritionProgress: vacation && n !== 'hit' ? null : L.nutritionProgress(day, goals),
  };
}

function mealModel(m, index, date = '') {
  return { id: String(index), index, name: m.label || '', calories: number(m.kcal), protein: number(m.protein), note: m.note || '', time: getMillis(m.at) ? new Date(getMillis(m.at)).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}) : '', date };
}

function dayModel(member, date) {
  const id = idOf(member), s = subjectOf(member), d = rawDay(id, date), cur = currentDate(member);
  const status = classifyDay(s, date, now(), d), goals = L.nutritionGoalOpts(d, s);
  const base = L.untrackedBase(d), own = id === local.myId;
  const prejoin = L.isDayKey(s.profile.joinDate) && date < s.profile.joinDate;
  const dataUnavailable = !prejoin && date <= cur && !hasDateData(id,date);
  const privateWeight = member.hideWeight === true && !own;
  const weights = privateWeight ? {} : local.weights.get(id) || {};
  const recentKey = Object.keys(weights).filter((k) => k <= date && Number.isFinite(weights[k])).sort().at(-1);
  return {
    date, own, editable: own && !prejoin && date <= cur && !dataUnavailable, prejoin, future: date > cur, dataUnavailable,
    calories: number(d.kcal), protein: number(d.protein), nutritionHit: status.nutritionStatus === 'hit', nutritionManual: d.ate === true || d.macros === true,
    workout: d.workout === true, workoutType: TYPES.includes(d.workoutType) ? typeLabel(d.workoutType) : '',
    rest: d.off === true, scheduledRest: L.isRestDay(s.restPattern, s.perDateOverrides, date), paused: L.workoutsPausedOn?.(s, date) === true, vacation: L.vacationOn?.(s, date) === true,
    weight: recentKey ? weights[recentKey] : null, weightDate: recentKey || null, weightToday: Number.isFinite(weights[date]),
    calorieGoal: goals.kcalGoal ?? null, proteinGoal: goals.proteinGoal ?? null, goal: goals.goal, nutritionMode: goals.nutritionMode,
    meals: (Array.isArray(d.meals) ? d.meals : []).map((m, i) => mealModel(m, i, date)),
    baseCalories: base.kcal, baseProtein: base.protein, ...status,
    ...(dataUnavailable ? {workoutStatus:'unavailable',nutritionStatus:'unavailable',nutritionProgress:null} : {}),
  };
}

function restDays(member, date) {
  const active = (member.restPattern || []).filter((r) => r?.effectiveFrom <= date).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)).at(-1);
  return active?.weekdays || [];
}

function project() {
  if (!me() || !ui() || !local.days.has(local.myId)) return;
  const today = currentDate(), member = me(), s = subjectOf(member), previous = ui().state || {};
  const offset = Math.min(0, Number(previous.weekOffset) || 0);
  const monday = step(L.businessWeekKey(today), offset * 7), week = daysBetween(monday, step(monday, 6));
  const user = { id: local.myId, name: member.profile?.displayName || 'Member', emoji: L.emojiOf({...member, id: local.myId}),
    calorieGoal: member.kcalGoal ?? null, proteinGoal: member.proteinGoal ?? null, nutritionMode: s.nutritionMode, goal: s.goal,
    weightPrivate: member.hideWeight === true, rolloverHour: s.rolloverHour, rolloverMinute: s.rolloverMinute,
    restDays: restDays(member, today), workoutTypes: ((member.enabledWorkoutTypes || []).filter((t) => TYPES.includes(t)).length ? member.enabledWorkoutTypes.filter((t) => TYPES.includes(t)) : TYPES).map(typeLabel),
    paused: L.workoutsPausedOn?.(s, today) === true, vacations: s.vacations.map((v)=>({...v,start:v.from,end:v.to})), workoutPauses: s.workoutPauses, joinDate: member.profile?.joinDate || today };
  const members = local.members.map((m) => {
    const id = idOf(m), subject = subjectOf(m), own = id === local.myId, hidden = m.hideWeight === true && !own;
    const dmap = effectiveDays(id), weights = hidden ? {} : local.weights.get(id) || {};
    const stats = L.computeCompliance(dmap, subject, now(), { windowDays: 30 });
    const trend = L.weightTrend(weights, subject.goal, currentDate(m));
    const daysByDate = Object.fromEntries(Object.keys(dmap).map((date) => [date, dayModel(m, date)]));
    const month = previous.historyMonth || today.slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(month)) for (const date of daysBetween(`${month}-01`, new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10))) daysByDate[date] = dayModel(m, date);
    for (const date of week) daysByDate[date] = dayModel(m, date);
    return { id, name: m.profile?.displayName || 'Member', emoji: L.emojiOf({...m, id}), own,
      streak: L.computeStreak(dmap, subject, now()), compliance: stats.workout.percent, complianceNutrition: stats.nutrition.percent,
      lastActivity: getMillis(m.lastActiveAt) ? L.relativeTime(getMillis(m.lastActiveAt), now()).text : 'No activity yet',
      dataUnavailable: week.some((date)=>daysByDate[date].dataUnavailable),
      weightPrivate: hidden, weight: trend.latestLb, weightDelta: trend.toward == null ? null : trend.dir === 'up' ? '↑' : trend.dir === 'down' ? '↓' : '→', weightTrend: trend,
      days: week.map((date) => daysByDate[date]), daysByDate, calorieGoal: m.kcalGoal ?? null, proteinGoal: m.proteinGoal ?? null, nutritionMode: subject.nutritionMode };
  });
  const weights = local.members.filter((m) => m.hideWeight !== true || idOf(m) === local.myId).map((m) => ({ id: idOf(m), name: m.profile?.displayName || 'Member', own: idOf(m) === local.myId,
    points: Object.entries(local.weights.get(idOf(m)) || {}).filter(([date, value]) => L.isDayKey(date) && date <= today && Number.isFinite(value)).sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({date, value})) }));
  ui().setState({ ready: true, demo: typeof data.snapshot === 'function' || !!window.__gymboardDemo, today,
    selectedDate: previous.selectedDate && previous.selectedDate <= today ? previous.selectedDate : today,
    user, day: dayModel(member, today), presets: (member.savedMeals || []).map((m, i) => mealModel(m, i)), members, weights,
    weekOffset: offset, historyMonth: previous.historyMonth || today.slice(0, 7), historyMember: byId(previous.historyMember) ? previous.historyMember : local.myId,
    chartRange: local.loaded ? (previous.chartRange || 90) : 90,
    pending: [...local.pending], syncState: local.pending.size ? 'pending' : local.readErrors.size ? 'stale' : 'synced', connection: local.pending.size ? 'Saving…' : local.readErrors.size ? 'Refresh needed' : 'Saved', error: null });
  local.loaded = true;
  window.GymBoardBackend.ready = true;
}

async function refresh({ users = local.members, older = false } = {}) {
  const jobs = users.filter(Boolean).map((member)=>{const id=idOf(member),seq=(local.readSeq.get(id)||0)+1;local.readSeq.set(id,seq);return {member,id,seq};});
  const results = await Promise.allSettled(jobs.map(async ({member,id,seq}) => {
    const today = currentDate(member), from = step(today, -DAY_WINDOW);
    const wantsOlder = older && ui()?.state?.historyMonth;
    const extraFrom = wantsOlder ? `${ui().state.historyMonth}-01` : null;
    const weekStart = step(L.businessWeekKey(currentDate()), Math.min(0, Number(ui()?.state?.weekOffset) || 0) * 7);
    const actualFrom = [from, extraFrom, weekStart].filter(Boolean).sort()[0];
    const dayPromise = actualFrom < from && data.fetchOlderDays ? data.fetchOlderDays(id, actualFrom, today) : data.fetchDays(id, from, today);
    const [days, weights] = await Promise.all([dayPromise, member.hideWeight === true && id !== local.myId ? Promise.resolve({}) : data.fetchWeights(id, step(today, -90), today)]);
    return {id, seq, days, weights, from:actualFrom, to:today};
  }));
  if (local.stopped) return;
  for (let i=0;i<results.length;i++) {
    const result=results[i],job=jobs[i];
    if(job.seq!==local.readSeq.get(job.id))continue;
    if(result.status==='rejected'){local.readErrors.set(job.id,result.reason);continue;}
    const {id, days, weights, from, to} = result.value;
    local.readErrors.delete(id);
    // Each successful read is authoritative for its complete covered interval,
    // including days deleted elsewhere since the previous read.
    const next={...(local.days.get(id)||{})};
    for(const date of Object.keys(next))if(date>=from&&date<=to)delete next[date];
    Object.assign(next,days);local.days.set(id,next);local.weights.set(id,weights);
    const previous=local.coverage.get(id);
    local.coverage.set(id,{from:previous&&previous.from<from?previous.from:from,to:previous&&previous.to>to?previous.to:to});
    for (const [key, patch] of local.overlay) if (key.startsWith(`${id}|`)) {
      const date = key.slice(id.length + 1);
      if (Object.entries(patch).every(([field, value]) => days[date]?.[field] === value)) local.overlay.delete(key);
    }
  }
  if (!local.days.has(local.myId) && users.length && !local.loaded) throw new Error('Could not load your daily log. Check your connection and retry.');
  project();
}

function assertOwnDate(payload, {past = false} = {}) {
  if (!me()) throw new Error('Your profile is still loading.');
  if (payload.memberId && payload.memberId !== local.myId || payload.userId && payload.userId !== local.myId) throw new Error('Only your own days can be edited.');
  const date = payload.date || currentDate();
  if (!L.isDayKey(date) || date > currentDate() || date < (me().profile?.joinDate || date) || past && date >= currentDate()) throw new Error(past ? 'Choose an earlier day on or after your join date.' : 'This day is read-only.');
  if (!hasDateData(local.myId,date)) throw new Error('This day has not finished loading. Retry before editing it.');
  if (past && date < step(currentDate(), -DAY_WINDOW)) throw new Error('Catch-up is available for the last 120 days.');
  return date;
}
function assertToday(payload) {
  const date=assertOwnDate(payload);
  if(date!==currentDate())throw new Error('This daily form is for an earlier day. Reopen today’s log and try again.');
  return date;
}

function numeric(raw, label, min, max, optional = false, decimals = 0) {
  if (raw == null || raw === '') { if (optional) return undefined; throw new Error(`Enter ${label.toLowerCase()}.`); }
  const v = Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${label} must be ${min.toLocaleString()}–${max.toLocaleString()}.`);
  const factor = 10 ** decimals;
  return Math.round(v * factor) / factor;
}
function mealInput(p) {
  const label = String(p.name ?? p.label ?? '').trim(), note = String(p.note || '').trim();
  if (label.length > 24) throw new Error('Meal names can contain up to 24 characters.');
  if (note.length > 80) throw new Error('Meal notes can contain up to 80 characters.');
  return { kcal: numeric(p.calories ?? p.kcal, 'Calories', 1, 10000), protein: numeric(p.protein == null || p.protein === '' ? 0 : p.protein, 'Protein', 0, 1000), ...(label ? {label} : {}), ...(note ? {note} : {}) };
}
function indexOf(p, array) {
  const index = Number(p.index ?? p.id);
  if (!Number.isInteger(index) || index < 0 || index >= array.length) throw new Error('This item changed. Reopen it and try again.');
  return index;
}
const notify = (message) => ui()?.notify(message);
function presentError(error) {
  const message = /stale-module/.test(error?.code || '') ? 'The app is mid-update. Reload and try again.' : error?.message || 'Could not save. Try again.';
  notify(message);
  window.dispatchEvent(new CustomEvent('gymboard:error', {detail: {message}}));
}

function completeAction(action,payload,result) {
  window.dispatchEvent(new CustomEvent('gymboard:action-complete',{detail:{action,payload,...result}}));
  return result;
}
const FIELD_LABELS={calories:'calories',protein:'protein',nutritionHit:'nutrition completion',calorieGoal:'calorie goal',proteinGoal:'protein goal',goal:'weight direction',nutritionMode:'nutrition mode',name:'name',rolloverHour:'rollover hour',weightPrivate:'weight privacy'};
async function writeSteps(steps,{profile=false}={}) {
  const savedFields=[];
  for(let i=0;i<steps.length;i++) {
    const step=steps[i];
    try {await step.run();savedFields.push(...step.fields);}
    catch(cause) {
      const unsavedFields=steps.slice(i).flatMap(s=>s.fields);
      const labels=fields=>fields.map(f=>FIELD_LABELS[f]||f).join(', ');
      const message=`${savedFields.length?`Saved: ${labels(savedFields)}.`:'Nothing saved.'} Not saved: ${labels(unsavedFields)}. ${cause?.message||'Try again.'}`;
      throw Object.assign(new Error(message),{savedFields,unsavedFields,refreshProfile:profile});
    }
  }
  return {savedFields};
}
function patchOwner(patch) {
  // A subscription may replace the member object while a write is pending.
  // Apply only acknowledged fields to the current object, preserving siblings.
  const owner=me();if(!owner)return;
  if(patch.profile)owner.profile={...owner.profile,...patch.profile};
  Object.assign(owner,Object.fromEntries(Object.entries(patch).filter(([key])=>key!=='profile')));
}
function refreshOwnerSnapshot() {
  // The unchanged data API exposes owner settings through its live subscription.
  // Take one fresh snapshot after a partial settings write, then unsubscribe.
  return new Promise(resolve=>{
    let unsubscribe,timer,finished=false;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);unsubscribe?.();resolve(value);};
    timer=setTimeout(()=>finish(false),3000);
    try {
      unsubscribe=data.subscribeUsers(members=>{
        const owner=members.find(m=>idOf(m)===local.myId);
        if(!owner){finish(false);return;}
        local.members=local.members.map(m=>idOf(m)===local.myId?owner:m);finish(true);
      });
      if(finished)unsubscribe?.();
    }catch{finish(false);}
  });
}
async function refreshAfterWrite(profile) {
  let refreshed=true;
  if(profile)refreshed=await refreshOwnerSnapshot();
  let timer;
  try {
    const result=await Promise.race([
      refresh({users:[me()],older:true}).then(()=>!local.readErrors.has(local.myId),()=>false),
      new Promise(resolve=>{timer=setTimeout(()=>resolve(false),3000);})
    ]);
    return refreshed&&result;
  }finally{clearTimeout(timer);}
}

async function withWrite(action, payload, operation) {
  // Saved meals are one read/modify/write array; overlapping manager actions
  // must not each persist a different stale copy of it.
  const kind=ALIASES[action]||action,date=payload.date||currentDate();
  const key = ['save-preset','delete-preset'].includes(kind) ? 'saved-meals'
    : ['day-workout','workout-toggle','workout-type','day-rest','rest-toggle'].includes(kind) ? `training|${date}`
    : ['save-macros','day-nutrition','nutrition-toggle'].includes(kind) ? `nutrition|${date}`
    : ['add-vacation','remove-vacation'].includes(kind) ? 'vacations'
    : ['pause-toggle','resume-workouts'].includes(kind) ? 'workout-pauses'
    : `${action}|${date}|${payload.id ?? payload.index ?? ''}`;
  if (local.busy.has(key) || local.pending.has(key)) {const message='A save is already in progress. Wait for it to finish.';notify(message);return completeAction(action,payload,{status:'error',message});}
  local.busy.add(key); local.pending.add(key); project();
  let timer;
  const terminal=Promise.resolve().then(operation).then(
    result=>({status:'saved',...result}),
    error=>({status:error.savedFields?.length?'partial':'error',message:error.message,
      ...(error.savedFields?{savedFields:error.savedFields,unsavedFields:error.unsavedFields}:{}),refreshProfile:error.refreshProfile})
  ).then(async result=>{
    // Pending is an interim notification, never the end of a mutation's lock.
    // Both fast and late settlement follow this same refresh/completion path.
    if(result.status!=='error'||result.savedFields) {
      const refreshed=await refreshAfterWrite(result.refreshProfile);
      if(!refreshed){result.refreshIncomplete=true;result.message=`${result.message||(result.status==='saved'?'Saved.':'')} Latest data could not be refreshed. Retry to reload it.`.trim();}
    }
    delete result.refreshProfile;
    clearTimeout(timer);local.pending.delete(key);local.busy.delete(key);project();
    if(result.status==='saved')notify(result.message||'Saved');else presentError(result);
    return completeAction(action,payload,result);
  });
  return Promise.race([terminal,new Promise(resolve=>{
    timer=setTimeout(()=>{notify('Save pending · waiting to sync');resolve(completeAction(action,payload,{status:'pending'}));},7000);
  })]);
}

async function writeAction(action, p) {
  const member = me();
  switch (action) {
    case 'add-meal': {
      const date = assertToday(p), meal = mealInput(p);
      if ((rawDay(local.myId,date).meals || []).length >= 50) throw new Error('A day can contain up to 50 meals.');
      const run = mealChain.then(() => data.addMeal(date,meal)); mealChain = run.catch(() => {}); await run; break;
    }
    case 'log-preset': {
      const date = assertToday(p), presets = member.savedMeals || [], index = indexOf(p,presets);
      const run = mealChain.then(() => data.addMeal(date,{...presets[index]})); mealChain = run.catch(() => {}); await run; break;
    }
    case 'remove-meal': {
      const date = assertToday(p), before = rawDay(local.myId,date).meals || [], index = indexOf(p,before), selected = before[index];
      const run = mealChain.then(async () => {
        const actual = await data.fetchDays(local.myId,date,date), list = actual[date]?.meals || [];
        const same = (m) => m.kcal === selected.kcal && m.protein === selected.protein && (m.label || '') === (selected.label || '') && (m.note || '') === (selected.note || '') && getMillis(m.at) === getMillis(selected.at);
        const currentIndex = list.findIndex(same);
        if (currentIndex < 0) throw new Error('This meal was already removed.');
        await data.removeMeal(date,currentIndex);
      }); mealChain = run.catch(() => {}); await run; break;
    }
    case 'nutrition-toggle': case 'day-nutrition': {
      const date = assertOwnDate(p), d = rawDay(local.myId,date);
      await data.setNutritionHit(date, typeof p.value === 'boolean' ? p.value : !(d.ate === true || d.macros === true)); break;
    }
    case 'workout-toggle': case 'workout-type': case 'day-workout': {
      const date = assertOwnDate(p), d = rawDay(local.myId,date), typed = action === 'workout-type' || !!p.type || !!p.workoutType;
      const done = typeof p.value === 'boolean' ? p.value : typed ? true : !d.workout;
      if (done && d.off === true) throw new Error('Clear this rest day before logging a workout.');
      const type = typeKey(p.type || p.workoutType || d.workoutType);
      if (typed && !TYPES.includes(type)) throw new Error('Choose a workout type.');
      local.overlay.set(`${local.myId}|${date}`,{workout:done,...(done && type ? {workoutType:type} : {})}); project();
      try { await data.markWorkout(local.myId,date,done,done && type ? {workoutType:type} : {}); }
      catch (error) {local.overlay.delete(`${local.myId}|${date}`); throw error;} break;
    }
    case 'rest-toggle': case 'day-rest': {
      const date = assertOwnDate(p), d = rawDay(local.myId,date), off = typeof p.value === 'boolean' ? p.value : d.off !== true;
      if (off && d.workout === true) throw new Error('Clear this workout before marking a rest day.');
      const key=`${local.myId}|${date}`,previous=local.overlay.get(key);
      local.overlay.set(key,{...(previous||{}),off});project();
      try{await data.setDayOff(date,off);}catch(error){if(previous)local.overlay.set(key,previous);else local.overlay.delete(key);throw error;}break;
    }
    case 'log-weight': {
      const date = assertToday(p);
      await data.setWeight(date,numeric(p.weight ?? p.value,'Weight',50,600,false,1)); break;
    }
    case 'save-macros': {
      const date = assertOwnDate(p,{past:true}), kcal = numeric(p.calories ?? p.kcal,'Calories',0,10000,true), protein = numeric(p.protein,'Protein',0,1000,true);
      if (kcal === undefined && protein === undefined) throw new Error('Enter calories, protein, or both.');
      if(p.nutritionHit!==undefined&&typeof p.nutritionHit!=='boolean')throw new Error('Choose a valid nutrition completion value.');
      const totals = L.sumMeals(rawDay(local.myId,date).meals);
      if (kcal !== undefined && kcal < totals.kcal || protein !== undefined && protein < totals.protein) throw new Error(`Totals cannot be below recorded meals (${totals.kcal} calories, ${totals.protein} g protein).`);
      return writeSteps([
        {fields:[...(kcal!==undefined?['calories']:[]),...(protein!==undefined?['protein']:[])],run:()=>data.setMacros(date,{...(kcal!==undefined?{kcal}:{}),...(protein!==undefined?{protein}:{})})},
        ...(typeof p.nutritionHit==='boolean'?[{fields:['nutritionHit'],run:()=>data.setNutritionHit(date,p.nutritionHit)}]:[])
      ]);
    }
    case 'save-preset': {
      const meal = mealInput(p), presets = member.savedMeals || [];
      if (p.id != null && p.id !== '' || p.index != null) { const index = indexOf(p,presets); const next = presets.slice(); next[index] = meal; await data.setSavedMeals(next); member.savedMeals=next; }
      else { if(presets.length>=20) throw new Error('You can save up to 20 meals.'); await data.addSavedMeal(presets,meal); member.savedMeals=presets.concat(meal); } break;
    }
    case 'delete-preset': {
      const presets = member.savedMeals || [], index = indexOf(p,presets); await data.removeSavedMeal(presets,index); member.savedMeals=presets.filter((_,i)=>i!==index); break;
    }
    case 'save-goals': {
      const goals = {kcalGoal:numeric(p.calorieGoal ?? p.calories ?? p.kcalGoal,'Calorie goal',800,10000,true),proteinGoal:numeric(p.proteinGoal ?? p.protein,'Protein goal',0,500,true)};
      if(goals.kcalGoal === undefined && goals.proteinGoal === undefined) throw new Error('Enter a calorie or protein goal.');
      if(p.goal!==undefined&&!['gain','lose','maintain'].includes(p.goal))throw new Error('Choose a valid weight direction.');
      if(p.nutritionMode!==undefined&&!['manual','protein','both'].includes(p.nutritionMode))throw new Error('Choose a valid nutrition mode.');
      const suppliedGoals=Object.fromEntries(Object.entries(goals).filter(([,value])=>value!==undefined));
      return writeSteps([
        {fields:[...(goals.kcalGoal!==undefined?['calorieGoal']:[]),...(goals.proteinGoal!==undefined?['proteinGoal']:[])],run:async()=>{await data.setNutritionGoals(suppliedGoals);patchOwner(suppliedGoals);}},
        ...(p.goal!==undefined&&p.goal!==member.goal?[{fields:['goal'],run:async()=>{await data.setGoal(p.goal);patchOwner({goal:p.goal});}}]:[]),
        ...(p.nutritionMode!==undefined&&p.nutritionMode!==member.nutritionMode?[{fields:['nutritionMode'],run:async()=>{await data.setNutritionMode(p.nutritionMode);patchOwner({nutritionMode:p.nutritionMode});}}]:[])
      ],{profile:true});
    }
    case 'set-goal': await data.setGoal(p.goal || p.value); member.goal=p.goal || p.value; break;
    case 'set-nutrition-mode': await data.setNutritionMode(p.mode || p.value); member.nutritionMode=p.mode || p.value; break;
    case 'save-rest-days': {
      const weekdays = [...new Set((p.days || p.restDays || []).map(Number))].sort((a,b)=>a-b);
      if(weekdays.some((n)=>!Number.isInteger(n)||n<0||n>6)) throw new Error('Choose valid weekdays.');
      const date = currentDate(), pattern=(member.restPattern || []).filter((r)=>r.effectiveFrom!==date).concat({effectiveFrom:date,weekdays}).sort((a,b)=>a.effectiveFrom.localeCompare(b.effectiveFrom));
      await data.setRestPattern(pattern); member.restPattern=pattern; break;
    }
    case 'pause-toggle': case 'resume-workouts': {
      const pause=typeof p.paused==='boolean'?p.paused:action!=='resume-workouts' && !(L.workoutsPausedOn?.(subjectOf(member),currentDate())===true);
      member.workoutPauses=await (pause ? data.pauseWorkouts(member.workoutPauses||[],currentDate()) : data.resumeWorkouts(member.workoutPauses||[],currentDate())); break;
    }
    case 'add-vacation': {
      const from=p.from || p.start,to=p.to || p.end;
      if(!L.isDayKey(from)||!L.isDayKey(to)||to<from) throw new Error('Choose a valid start and end date.');
      if(to>currentDate().replace(/^\d{4}/,(y)=>String(Number(y)+2))) throw new Error('The end date is more than two years away. Check the year.');
      member.vacations=await data.addVacation(member.vacations||[],from,to);break;
    }
    case 'remove-vacation': {
      const range=p.from && p.to ? p : (member.vacations||[])[indexOf(p,member.vacations||[])];
      member.vacations=await data.removeVacation(member.vacations||[],range.from,range.to);break;
    }
    case 'save-workout-types': {
      const types=(p.types || p.workoutTypes || []).map(typeKey);
      if(!types.length||types.some((t)=>!TYPES.includes(t))) throw new Error('Keep at least one valid workout type.');
      await data.setEnabledWorkoutTypes(types); member.enabledWorkoutTypes=types;break;
    }
    case 'weight-privacy': {
      const hide=typeof p.value==='boolean'?p.value:member.hideWeight!==true;await data.setHideWeight(hide);member.hideWeight=hide;break;
    }
    case 'save-profile': {
      const name=String(p.name??p.displayName??member.profile?.displayName??'').trim();
      if(!name||name.length>24) throw new Error('Use a profile name with 1–24 characters.');
      const hour=numeric(p.rolloverHour ?? member.rolloverHour ?? 4,'Rollover hour',0,23);
      if(p.weightPrivate!==undefined&&typeof p.weightPrivate!=='boolean')throw new Error('Choose a valid weight privacy setting.');
      return writeSteps([
        {fields:['name'],run:async()=>{await data.setDisplayName(name);patchOwner({profile:{displayName:name}});}},
        {fields:['rolloverHour'],run:async()=>{await data.setRollover(hour,0);patchOwner({rolloverHour:hour,rolloverMinute:0});scheduleRollover();}},
        ...(p.weightPrivate!==undefined&&p.weightPrivate!==(member.hideWeight===true)?[{fields:['weightPrivate'],run:async()=>{await data.setHideWeight(p.weightPrivate);patchOwner({hideWeight:p.weightPrivate});}}]:[])
      ],{profile:true});
    }
    case 'reclaim': await data.reclaim(); ui().setState({reclaimNeeded:false}); break;
    default: throw new Error(`Unsupported action: ${action}`);
  }
}

const ALIASES = {'delete-meal':'remove-meal','set-workout':'day-workout','set-rest':'day-rest','set-nutrition':'day-nutrition','save-weight':'log-weight','save-catchup':'save-macros','set-pause':'pause-toggle','delete-vacation':'remove-vacation','set-privacy':'weight-privacy'};
const WRITES = new Set(['add-meal','remove-meal','log-preset','nutrition-toggle','day-nutrition','workout-toggle','workout-type','day-workout','rest-toggle','day-rest','log-weight','save-macros','save-preset','delete-preset','save-goals','set-goal','set-nutrition-mode','save-rest-days','pause-toggle','resume-workouts','add-vacation','remove-vacation','save-workout-types','weight-privacy','save-profile','reclaim',...Object.keys(ALIASES)]);
export async function dispatch(action,payload={}) {
  if(WRITES.has(action)) {
    if(!local.loaded && action!=='reclaim') {const message='The board is still loading.';notify(message);return completeAction(action,payload,{status:'error',message});}
    if(ui()?.state?.reclaimNeeded&&action!=='reclaim'){const message='Reconnect this device before logging.';notify(message);return completeAction(action,payload,{status:'error',message});}
    const adapted={...payload};
    if(action==='set-workout')adapted.value=payload.complete;
    if(action==='set-rest')adapted.value=payload.rest;
    if(action==='set-nutrition')adapted.value=payload.hit;
    if(action==='set-privacy')adapted.value=payload.weightPrivate;
    return withWrite(action,payload,()=>writeAction(ALIASES[action] || action,adapted));
  }
  if(action==='change-week') {ui().setState({weekOffset:Math.min(0,Number(payload.offset)||0)});await refresh({older:true});return;}
  if(action==='change-month') {if(L.isDayKey(`${payload.month}-01`)&&payload.month<=currentDate().slice(0,7))ui().setState({historyMonth:payload.month});await refresh({older:true});return;}
  if(action==='change-member') {if(byId(payload.id))ui().setState({historyMember:payload.id});project();return;}
  if(action==='retry') {if(local.myId)await refresh({older:true});else await boot();return;}
  if(action==='week-prev'||action==='week-next'||action==='week-today') {
    ui().setState({weekOffset:action==='week-today'?0:Math.min(0,(ui().state.weekOffset||0)+(action==='week-prev'?-1:1))});
    await refresh({older:true}); return;
  }
  if(action==='history-prev'||action==='history-next'||action==='history-member') {
    if(action==='history-member') ui().setState({historyMember:payload.id||payload.memberId||payload.value});
    else {const parts=(ui().state.historyMonth||currentDate().slice(0,7)).split('-').map(Number);const date=new Date(Date.UTC(parts[0],parts[1]-1+(action==='history-prev'?-1:1),1));ui().setState({historyMonth:date.toISOString().slice(0,7)});}
    await refresh({older:true}); return;
  }
}

function onAction(event) {
  const {action,payload={}}=event.detail||{};
  if(!WRITES.has(action)&&!['week-prev','week-next','week-today','history-prev','history-next','history-member','change-week','change-month','change-member','retry'].includes(action)) return;
  event.preventDefault();
  const result=dispatch(action,payload);event.detail.promise=result;
  result.catch(presentError);
}

function scheduleRollover() {
  clearTimeout(rolloverTimer);
  if(!me()||local.stopped)return;
  const s=subjectOf(me()),at=now(),today=currentDate();
  let hi=26*3600000,lo=0;
  // Search the next actual business-date boundary, including DST transitions.
  while(hi-lo>1000){const mid=Math.floor((lo+hi)/2);if(L.currentBusinessDate(at+mid,s.ianaTz,s.rolloverHour,s.rolloverMinute)>today)hi=mid;else lo=mid;}
  rolloverTimer=setTimeout(()=>{project();refresh().catch(presentError);scheduleRollover();},hi+1000);
}

async function onMembers(members) {
  local.members=Array.isArray(members)?members:[];
  // Privacy revocation must clear previously fetched points before another render.
  for(const member of local.members) if(member.hideWeight===true&&idOf(member)!==local.myId)local.weights.set(idOf(member),{});
  try {await refresh({older:true});scheduleRollover();}catch(error){fatal(error);}
}

function fatal(error) {
  const message=error?.message||String(error);
  ui()?.setState({ready:false,error:message});
  window.dispatchEvent(new CustomEvent('gymboard:boot-error',{detail:{message}}));
  notify(message);
}

async function boot() {
  window.GymBoardBackend={ready:false,dispatch,refresh,snapshot:()=>({myId:local.myId,members:local.members,days:Object.fromEntries(local.days),weights:Object.fromEntries(local.weights)}),getDay:(id,date)=>byId(id)&&L.isDayKey(date)?dayModel(byId(id),date):null};
  window.addEventListener('gymboard:action',onAction);
  ui()?.setState({ready:false,error:null,demo:false});
  try {
    const conf=await import('./firebase-config.js');
    let key=conf.recaptchaSiteKey;if(key&&/^TODO_/.test(String(key)))key='';
    await data.initApp(conf.firebaseConfig,key,{appCheckDebugToken:conf.appCheckDebugToken,spotifyWorker:conf.spotifyWorker});
    data.onReclaimNeeded(()=>{ui()?.setState({reclaimNeeded:true});ui()?.openSheet?.('reclaim');window.dispatchEvent(new CustomEvent('gymboard:reclaim'));});
    const bound=await data.authAndBind();local.myId=bound?.userId||data.currentUserId();
    data.ensureUserDoc(local.myId).catch(()=>{});
    subscription=data.subscribeUsers(onMembers);
    heartbeat=setInterval(()=>{if(document.visibilityState==='visible')project();},60000);
    document.addEventListener('visibilitychange',onFocus);window.addEventListener('focus',onFocus);
    // Fixture previews never install a worker; the staged production shell keeps PWA updates.
    if('serviceWorker' in navigator&&!window.__gymboardDemo&&typeof data.snapshot!=='function')navigator.serviceWorker.register(new URL('./sw.js',import.meta.url)).catch(()=>{});
  }catch(error){fatal(error);}
}
function onFocus(){if(document.visibilityState==='visible'){project();refresh({older:true}).catch(presentError);scheduleRollover();}}
function teardown(){local.stopped=true;clearInterval(heartbeat);clearTimeout(rolloverTimer);subscription?.();data.teardown();}
window.addEventListener('pagehide',(event)=>{if(!event.persisted)teardown();});
window.addEventListener('beforeunload',teardown);
if(window.GymBoardUI)boot();else window.addEventListener('gymboard:ui-ready',boot,{once:true});
