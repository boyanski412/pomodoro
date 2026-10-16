// Pure logic: no DOM, no network. Times are epoch ms, durations seconds.

const iso = ms => new Date(ms).toISOString();

export const cleanNote = text => (text ?? '').trim() || null;

export function newRun({ id, now, plannedSeconds, project }) {
  return { id, startedAt: now, plannedSeconds, project: cleanNote(project), pauses: [], distractions: [] };
}

export const isPaused = run => run.pauses.some(p => p.end === null);

export function pausedSeconds(run, now) {
  return run.pauses.reduce((sum, p) => sum + ((p.end ?? now) - p.start) / 1000, 0);
}

export function timeLeft(run, now) {
  const elapsed = (now - run.startedAt) / 1000 - pausedSeconds(run, now);
  return Math.max(0, Math.round(run.plannedSeconds - elapsed));
}

export function pause(run, { id, now }) {
  if (isPaused(run)) return run;
  return { ...run, pauses: [...run.pauses, { id, start: now, end: null, note: null }] };
}

export function resume(run, { now, note }) {
  return { ...run, pauses: run.pauses.map(p => (p.end === null ? { ...p, end: now, note: cleanNote(note) } : p)) };
}

export function addDistraction(run, { id, now, note }) {
  return { ...run, distractions: [...run.distractions, { id, at: now, note: cleanNote(note) }] };
}

export function closeRun(run, now, status) {
  // An open pause stops the clock, so the planned end moves with "now" while paused.
  const plannedEnd = run.startedAt + (run.plannedSeconds + pausedSeconds(run, now)) * 1000;
  const end = Math.min(now, plannedEnd);
  const pauses = run.pauses.map(p => (p.end === null ? { ...p, end } : p));
  const paused = pauses.reduce((s, p) => s + (p.end - p.start) / 1000, 0);
  const session = {
    id: run.id,
    started_at: iso(run.startedAt),
    ended_at: iso(end),
    planned_seconds: run.plannedSeconds,
    focus_seconds: Math.round(Math.min(run.plannedSeconds, (end - run.startedAt) / 1000 - paused)),
    status,
    project: run.project,
    rating: null,
    note: null,
  };
  const interruptions = [
    ...pauses.map(p => ({ id: p.id, session_id: run.id, kind: 'pause', at: iso(p.start),
      duration_seconds: Math.round((p.end - p.start) / 1000), note: p.note })),
    ...run.distractions.map(d => ({ id: d.id, session_id: run.id, kind: 'distraction', at: iso(d.at),
      duration_seconds: null, note: d.note })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return { session, interruptions };
}

export const breakSeconds = finishedToday => (finishedToday > 0 && finishedToday % 4 === 0 ? 900 : 300);

export async function flushOutbox(items, writeItem) {
  const remaining = [];
  let error = null;
  for (const item of items) {
    try { await writeItem(item); } catch (e) { remaining.push(item); error = e; }
  }
  return { remaining, error };
}

export function validateSettings(raw) {
  const errors = {};
  const minutes = Number(raw.session_minutes);
  const volume = Number(raw.volume);
  const target = Number(raw.daily_target);
  const text = (raw.notification_text ?? '').trim();
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) errors.session_minutes = 'Use a whole number from 1 to 180.';
  if (raw.volume === '' || !(volume >= 0 && volume <= 1)) errors.volume = 'Use a volume from 0 to 1.';
  if (!text) errors.notification_text = 'Enter the notification text.';
  if (!Number.isInteger(target) || target < 1 || target > 20) errors.daily_target = 'Use a whole number from 1 to 20.';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { session_minutes: minutes, volume, notification_text: text, daily_target: target } };
}

// ---- Stats (days are local-time days; a session belongs to the day it started) ----

const pad = n => String(n).padStart(2, '0');
export const localDay = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDays = (day, n) => { const [y, m, d] = day.split('-').map(Number); return localDay(new Date(y, m - 1, d + n, 12)); };
const weekOf = day => { const [y, m, d] = day.split('-').map(Number); return addDays(day, -((new Date(y, m - 1, d, 12).getDay() + 6) % 7)); };
const round1 = x => Math.round(x * 10) / 10;
const daysEnding = (today, n) => Array.from({ length: n }, (_, i) => addDays(today, i - n + 1));
const avgBy = (rows, key, val) => {
  const m = new Map();
  for (const r of rows) { const k = key(r), v = val(r); if (v == null) continue; const a = m.get(k) ?? [0, 0]; m.set(k, [a[0] + v, a[1] + 1]); }
  return [...m].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, [s, c]]) => [k, round1(s / c)]);
};

export const finishedOnDay = (sessions, day) =>
  sessions.filter(s => s.status === 'finished' && localDay(s.started_at) === day).length;

export function streak(sessions, target, today) {
  let day = finishedOnDay(sessions, today) >= target ? today : addDays(today, -1);
  let n = 0;
  while (finishedOnDay(sessions, day) >= target) { n++; day = addDays(day, -1); }
  return n;
}

export function stats(sessions, interruptions, target, today) {
  const minutesOn = day => Math.round(sessions.filter(s => localDay(s.started_at) === day)
    .reduce((m, s) => m + s.focus_seconds, 0) / 60);
  const byProject = new Map();
  for (const s of sessions) { const p = s.project ?? '(none)'; byProject.set(p, (byProject.get(p) ?? 0) + s.focus_seconds); }
  const pausesBySession = new Map();
  for (const i of interruptions) if (i.kind === 'pause') pausesBySession.set(i.session_id, (pausesBySession.get(i.session_id) ?? 0) + 1);
  const notes = new Map();
  for (const i of interruptions) { const k = i.note?.trim().toLowerCase(); if (k) notes.set(k, (notes.get(k) ?? 0) + 1); }
  return {
    todayCount: finishedOnDay(sessions, today),
    target,
    streak: streak(sessions, target, today),
    last7: daysEnding(today, 7).map(day => ({ day, count: finishedOnDay(sessions, day) })),
    focusByDay30: daysEnding(today, 30).map(day => ({ day, minutes: minutesOn(day) })),
    focusByProject: [...byProject].sort((a, b) => b[1] - a[1]).map(([project, s]) => ({ project, minutes: Math.round(s / 60) })),
    ratingByHour: avgBy(sessions, s => new Date(s.started_at).getHours(), s => s.rating).map(([hour, avg]) => ({ hour, avg })),
    ratingByWeek: avgBy(sessions, s => weekOf(localDay(s.started_at)), s => s.rating).map(([week, avg]) => ({ week, avg })),
    pausesPerSessionByWeek: avgBy(sessions, s => weekOf(localDay(s.started_at)), s => pausesBySession.get(s.id) ?? 0).map(([week, avg]) => ({ week, avg })),
    topDistractionNotes: [...notes].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([note, count]) => ({ note, count })),
  };
}

// ---- Outbox draining and storage moves (Storage-like objects passed in, so these stay testable) ----

// Flushes until every item present has been tried once; picks up items added or replaced mid-flush.
export async function drainOutbox({ read, write, writeItem }) {
  const tried = new Set();
  let error = null;
  for (;;) {
    const items = read();
    const fresh = items.filter(i => !tried.has(JSON.stringify(i)));
    if (!fresh.length) return { error };
    fresh.forEach(i => tried.add(JSON.stringify(i)));
    const res = await flushOutbox(fresh, writeItem);
    error = res.error;
    const written = new Set(fresh.filter(i => !res.remaining.includes(i)).map(i => JSON.stringify(i)));
    write(read().filter(i => !written.has(JSON.stringify(i))));
  }
}

// Moves unsaved work (outbox, running and ended session) to the newly chosen storage and wipes our keys from the old one.
export function moveStore(from, to) {
  if (from === to) return;
  const parse = k => { try { return JSON.parse(from.getItem(k)); } catch { return null; } };
  const outbox = parse('pomo:outbox');
  if (Array.isArray(outbox) && outbox.length) {
    let existing = [];
    try { existing = JSON.parse(to.getItem('pomo:outbox')) ?? []; } catch {}
    to.setItem('pomo:outbox', JSON.stringify([...existing, ...outbox]));
  }
  for (const k of ['pomo:run', 'pomo:ended']) { const v = from.getItem(k); if (v !== null) to.setItem(k, v); }
  const ours = [];
  for (let i = 0; i < from.length; i++) { const k = from.key(i); if (k.startsWith('pomo:') && k !== 'pomo:remember') ours.push(k); }
  ours.forEach(k => from.removeItem(k));
}
