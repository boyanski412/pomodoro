import * as L from './logic.js';

const SUPABASE_URL = 'https://dsppxrommspqzpzylska.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_TIOmBnsjxXAxjk7jcad0Rg_rD7xO9qO'; // public by design; RLS protects the data
const DEFAULTS = { session_minutes: 25, volume: 0.7, notification_text: 'Session done. Time for a break.', daily_target: 4 };

const $ = id => document.getElementById(id);
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

// ---- Browser storage: localStorage only on a remembered computer, otherwise sessionStorage ----
function remembered() { try { return localStorage.getItem('pomo:remember') === '1'; } catch { return false; } }
const store = () => (remembered() ? localStorage : sessionStorage);
const get = k => { try { return JSON.parse(store().getItem('pomo:' + k)); } catch { return null; } };
const set = (k, v) => { try { v == null ? store().removeItem('pomo:' + k) : store().setItem('pomo:' + k, JSON.stringify(v)); } catch {} };
function clearAll() {
  for (const s of [localStorage, sessionStorage]) {
    try { Object.keys(s).filter(k => k.startsWith('pomo:')).forEach(k => s.removeItem(k)); } catch {}
  }
}

let loggingOut = false;
function makeDb() {
  const client = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY,
    { auth: { storage: store(), storageKey: 'pomo:auth', persistSession: true } });
  // Expired or revoked login: go to the login screen but keep the outbox and running session; afterLogin flushes.
  client.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT' && !loggingOut) show('login'); });
  return client;
}
let db = makeDb();
let settings = { ...DEFAULTS };

async function loadSettings() {
  const { data, error } = await db.from('settings').select('*').maybeSingle();
  if (!error) settings = { ...DEFAULTS, ...(data ?? {}) };
}

// ---- Views ----
function show(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
  $('nav').hidden = id === 'login';
  for (const b of document.querySelectorAll('nav [data-view]')) b.toggleAttribute('aria-current', b.dataset.view === id);
  if (id === 'stats') renderStats();
  if (id === 'settings') fillSettings();
  if (id === 'timer') controls();
}
for (const b of document.querySelectorAll('nav [data-view]')) b.onclick = () => show(b.dataset.view);

// ---- Login ----
$('login-form').onsubmit = async e => {
  e.preventDefault();
  $('login-error').textContent = '';
  const before = store();
  try { $('remember').checked ? localStorage.setItem('pomo:remember', '1') : localStorage.removeItem('pomo:remember'); } catch {}
  try { L.moveStore(before, store()); } catch {}
  db = makeDb();
  const { error } = await db.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  if (error) {
    $('login-error').textContent = error.status === 400 ? 'Wrong email or password.' : "Couldn't reach the server. Check your connection and try again.";
    return;
  }
  $('password').value = '';
  await afterLogin();
};

$('logout').onclick = async () => {
  if ((get('outbox') ?? []).length) { banner('Some sessions aren’t saved yet. Reconnect, then log out.'); return; }
  if (run && !confirm('A session is running. Log out and lose it?')) return;
  if (ended && !confirm('Your rating for the last session isn’t saved yet. Log out anyway?')) return;
  loggingOut = true;
  await db.auth.signOut({ scope: 'local' }).catch(() => {}); // local: don't log out other computers
  loggingOut = false;
  clearAll();
  run = null; brk = null; ended = null;
  db = makeDb();
  show('login');
};

async function afterLogin() {
  await loadSettings().catch(() => {});
  flush();
  loadProjects();
  run = get('run');
  ended = get('ended');
  if (ended) openEnd(); else show('timer');
}

// ---- Mug ----
function drawMug(fraction) {
  const top = 52, bottom = 157; // inside of the mug, from rim to base
  const y = bottom - (bottom - top) * Math.min(1, Math.max(0, fraction));
  $('coffee').setAttribute('y', y);
  $('coffee').setAttribute('height', bottom - y + 10);
}

// ---- Sound and notification ----
let audio;
function unlockAudio() { try { audio ??= new AudioContext(); audio.resume(); } catch {} }
function beep(volume = settings.volume, delay = 0) {
  unlockAudio();
  if (!audio) return [];
  const t = audio.currentTime + delay, nodes = [];
  for (let i = 0; i < 3; i++) {
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(volume, t + i * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.35 + 0.25);
    osc.connect(gain).connect(audio.destination);
    osc.start(t + i * 0.35); osc.stop(t + i * 0.35 + 0.26);
    nodes.push(osc);
  }
  return nodes;
}
// Chrome slows timers in hidden tabs to ~1/min; the audio clock isn't throttled, so the end beep is scheduled on it.
let alarm = [];
function cancelAlarm() { alarm.forEach(o => { try { o.stop(); } catch {} }); alarm = []; }
function scheduleAlarm() { cancelAlarm(); if (run && !L.isPaused(run)) alarm = beep(settings.volume, L.timeLeft(run, Date.now())); }
function announce(text) {
  if (alarm.length) alarm = []; else beep(); // already scheduled on the audio clock
  document.title = "Time's up";
  try { if (Notification.permission === 'granted') new Notification(text); } catch {}
}
addEventListener('focus', () => { if (document.title === "Time's up") document.title = 'Pomodoro'; });

// ---- Timer state ----
let run = null;      // running focus session (logic.js Run)
let brk = null;      // { start, seconds } — breaks are never stored
let ended = null;    // closed session awaiting the end form
let noteFor = null;  // { kind: 'resume' | 'distraction', at }

function controls() {
  const idle = !run && !brk, paused = run && L.isPaused(run);
  $('start').hidden = !idle;
  $('pause').hidden = !run || paused;
  $('resume').hidden = !paused;
  $('distract').hidden = !run || paused;
  $('giveup').hidden = !run;
  $('skipbreak').hidden = !brk;
  $('project').disabled = !idle;
  $('phase').textContent = run ? (paused ? 'Paused' : run.project ?? 'Focus') : brk ? 'Break' : '';
  if (idle) { drawMug(1); $('time').textContent = fmt(settings.session_minutes * 60); }
  tick();
}

function tick() {
  const now = Date.now();
  if (run) {
    const left = L.timeLeft(run, now);
    drawMug(left / run.plannedSeconds);
    $('time').textContent = fmt(left);
    if (left === 0 && !L.isPaused(run)) endRun('finished');
  } else if (brk) {
    const left = Math.max(0, brk.seconds - (now - brk.start) / 1000);
    drawMug(1 - left / brk.seconds); // the mug refills during a break
    $('time').textContent = fmt(Math.ceil(left));
    if (left === 0) { brk = null; beep(); controls(); }
  }
}
setInterval(tick, 500);
document.addEventListener('visibilitychange', tick);

$('start').onclick = () => {
  unlockAudio();
  try { if (Notification.permission === 'default') Notification.requestPermission(); } catch {}
  run = L.newRun({ id: crypto.randomUUID(), now: Date.now(), plannedSeconds: settings.session_minutes * 60, project: $('project').value });
  set('run', run);
  scheduleAlarm();
  controls();
};
$('pause').onclick = () => { run = L.pause(run, { id: crypto.randomUUID(), now: Date.now() }); set('run', run); cancelAlarm(); controls(); };
$('resume').onclick = () => askNote('resume', 'What pulled you away?');
$('distract').onclick = () => askNote('distraction', 'What distracted you?');
$('giveup').onclick = () => endRun('abandoned');
$('skipbreak').onclick = () => { brk = null; controls(); };

function askNote(kind, label) {
  if (noteFor) return; // keep the first click's time
  noteFor = { kind, at: Date.now() };
  $('note-label').textContent = label;
  $('note-input').value = '';
  $('note-box').hidden = false;
  $('note-input').focus();
}
function saveNote(note) {
  if (!noteFor || !run) return;
  run = noteFor.kind === 'resume'
    ? L.resume(run, { now: noteFor.at, note })
    : L.addDistraction(run, { id: crypto.randomUUID(), now: noteFor.at, note });
  noteFor = null;
  $('note-box').hidden = true;
  set('run', run);
  if (!audio) unlockAudio(); // a click; after a reload this is the first chance to unlock audio
  scheduleAlarm();
  controls();
}
$('note-box').onsubmit = e => { e.preventDefault(); saveNote($('note-input').value); };
$('note-skip').onclick = () => saveNote('');

function endRun(status) {
  if (noteFor && run) { saveNote($('note-input').value); if (!run) return; } // saveNote's tick may already have ended it
  if (status === 'abandoned') cancelAlarm();
  ended = L.closeRun(run, Date.now(), status);
  run = null;
  set('run', null);
  set('ended', ended);
  enqueue(ended); // saved right away, so closing the tab before the form still keeps the session
  if (status === 'finished') announce(settings.notification_text);
  openEnd();
}

// Another tab on a remembered computer started a session.
addEventListener('storage', e => { if (e.key === 'pomo:run') $('tab-warning').hidden = !(e.newValue && !run); });

// ---- End-of-session form ----
function openEnd() {
  $('end-title').textContent = ended.session.status === 'finished' ? 'Session done' : 'Session ended early';
  $('end-form').reset();
  const list = $('end-ints');
  list.replaceChildren();
  for (const i of ended.interruptions) {
    const label = document.createElement('label');
    const time = new Date(i.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    label.textContent = `${i.kind === 'pause' ? `Pause (${fmt(i.duration_seconds)})` : 'Distraction'} at ${time}`;
    const input = document.createElement('input');
    input.dataset.id = i.id;
    input.value = i.note ?? '';
    input.maxLength = 200;
    label.append(input);
    list.append(label);
  }
  show('end');
}

$('end-form').onsubmit = async e => {
  e.preventDefault();
  const rating = Number(new FormData(e.target).get('rating')) || null;
  const notes = Object.fromEntries([...$('end-ints').querySelectorAll('input')].map(i => [i.dataset.id, i.value]));
  const item = {
    session: { ...ended.session, rating, note: L.cleanNote($('end-note').value) },
    interruptions: ended.interruptions.map(i => ({ ...i, note: L.cleanNote(notes[i.id]) })),
  };
  const finished = item.session.status === 'finished';
  ended = null;
  set('ended', null);
  enqueue(item);
  show('timer');
  if (finished) startBreak();
};

async function startBreak() {
  await flush();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const { count, error } = await db.from('sessions').select('id', { count: 'exact', head: true })
    .eq('status', 'finished').gte('started_at', dayStart.toISOString());
  const today = L.localDay(Date.now());
  const pending = (get('outbox') ?? []).filter(i => i.session.status === 'finished' && L.localDay(i.session.started_at) === today).length;
  brk = { start: Date.now(), seconds: L.breakSeconds((error ? 0 : count) + pending) };
  controls();
}

// ---- Outbox: nothing leaves it until Supabase confirms the write ----
function enqueue(item) {
  const box = (get('outbox') ?? []).filter(i => i.session.id !== item.session.id);
  set('outbox', [...box, item]);
  flush();
}

let flushing = null;
function flush() {
  flushing ??= (async () => {
    const { error } = await L.drainOutbox({ read: () => get('outbox') ?? [], write: b => set('outbox', b), writeItem: async it => {
      const a = await db.from('sessions').upsert(it.session);
      if (a.error) throw a.error;
      if (it.interruptions.length) {
        const b = await db.from('interruptions').upsert(it.interruptions);
        if (b.error) throw b.error;
      }
    } });
    const left = get('outbox') ?? [];
    if (left.length) {
      const serverDown = navigator.onLine && /fetch|network|load failed/i.test(String(error?.message));
      banner('Not saved yet, will retry.' + (serverDown ? ' If this keeps happening, restore your project in the Supabase dashboard.' : ''));
    } else banner(null);
  })().finally(() => { flushing = null; });
  return flushing;
}
addEventListener('online', flush);
addEventListener('beforeunload', e => { if ((get('outbox') ?? []).length) { e.preventDefault(); e.returnValue = ''; } });

function banner(text) { $('banner').hidden = !text; $('banner').textContent = text ?? ''; }

// ---- Recent project labels ----
async function loadProjects() {
  const { data } = await db.from('sessions').select('project').not('project', 'is', null)
    .order('started_at', { ascending: false }).limit(100);
  const names = [...new Set((data ?? []).map(r => r.project))].slice(0, 10);
  $('projects').replaceChildren(...names.map(n => Object.assign(document.createElement('option'), { value: n })));
}

// ---- Settings ----
function fillSettings() {
  $('set-minutes').value = settings.session_minutes;
  $('set-volume').value = settings.volume;
  $('set-text').value = settings.notification_text;
  $('set-target').value = settings.daily_target;
  $('settings-status').textContent = '';
  for (const p of document.querySelectorAll('[data-for]')) p.textContent = '';
}
$('test-sound').onclick = () => beep(Number($('set-volume').value));
$('settings-form').onsubmit = async e => {
  e.preventDefault();
  for (const p of document.querySelectorAll('[data-for]')) p.textContent = '';
  const res = L.validateSettings({
    session_minutes: $('set-minutes').value, volume: $('set-volume').value,
    notification_text: $('set-text').value, daily_target: $('set-target').value,
  });
  if (!res.ok) {
    for (const [field, msg] of Object.entries(res.errors)) document.querySelector(`[data-for="${field}"]`).textContent = msg;
    return;
  }
  const { error } = await db.from('settings').upsert(res.value);
  if (error) { $('settings-status').textContent = "Couldn't save settings. Check your connection and try again."; return; }
  settings = { ...settings, ...res.value };
  $('settings-status').textContent = 'Settings saved';
};

// ---- Stats ----
const charts = {};
function chart(id, type, labels, data, horizontal = false) {
  charts[id]?.destroy();
  const color = getComputedStyle(document.documentElement).getPropertyValue('--coffee').trim();
  charts[id] = new Chart($(id), {
    type,
    data: { labels, datasets: [{ data, backgroundColor: color, borderColor: color, tension: 0.3 }] },
    options: { indexAxis: horizontal ? 'y' : 'x', plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } }, animation: false },
  });
}
async function renderStats() {
  $('stats-error').textContent = '';
  const since = new Date(Date.now() - 91 * 864e5).toISOString();
  // shortcut: Supabase returns at most 1000 rows per query; fine for ~10 sessions/day, page the queries if that's ever exceeded.
  const [s, i] = await Promise.all([
    db.from('sessions').select('*').gte('started_at', since).order('started_at'),
    db.from('interruptions').select('session_id, kind, note').gte('at', since),
  ]);
  if (s.error || i.error) { $('stats-error').textContent = "Couldn't load your stats. Check your connection and try again."; return; }
  const st = L.stats(s.data, i.data, settings.daily_target, L.localDay(Date.now()));
  $('st-today').textContent = `${st.todayCount} / ${st.target}`;
  $('st-streak').textContent = `${st.streak} ${st.streak === 1 ? 'day' : 'days'}`;
  const short = d => d.slice(5);
  chart('ch-last7', 'bar', st.last7.map(r => short(r.day)), st.last7.map(r => r.count));
  chart('ch-day30', 'bar', st.focusByDay30.map(r => short(r.day)), st.focusByDay30.map(r => r.minutes));
  chart('ch-project', 'bar', st.focusByProject.map(r => r.project), st.focusByProject.map(r => r.minutes), true);
  chart('ch-hour', 'bar', st.ratingByHour.map(r => `${r.hour}:00`), st.ratingByHour.map(r => r.avg));
  chart('ch-rweek', 'line', st.ratingByWeek.map(r => short(r.week)), st.ratingByWeek.map(r => r.avg));
  chart('ch-pweek', 'line', st.pausesPerSessionByWeek.map(r => short(r.week)), st.pausesPerSessionByWeek.map(r => r.avg));
  $('st-notes').replaceChildren(...(st.topDistractionNotes.length
    ? st.topDistractionNotes.map(n => Object.assign(document.createElement('li'), { textContent: `${n.note} (${n.count})` }))
    : [Object.assign(document.createElement('li'), { textContent: 'No notes yet.' })]));
}

// ---- Start ----
const { data: { session } } = await db.auth.getSession();
if (session) await afterLogin(); else show('login');
