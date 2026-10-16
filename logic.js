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
