import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from './logic.js';
const T0 = Date.parse('2026-10-16T09:00:00Z');
const s = n => n * 1000;
const run = () => L.newRun({ id: 'r1', now: T0, plannedSeconds: 1500, project: 'Writing' });

test('timeLeft counts down and floors at 0', () => {
  assert.equal(L.timeLeft(run(), T0 + s(100)), 1400);
  assert.equal(L.timeLeft(run(), T0 + s(9999)), 0);
});
test('paused time does not count', () => {
  let r = L.pause(run(), { id: 'p1', now: T0 + s(100) });
  assert.equal(L.timeLeft(r, T0 + s(400)), 1400);
  r = L.resume(r, { now: T0 + s(400), note: ' Slack ' });
  assert.equal(L.timeLeft(r, T0 + s(500)), 1300);
  assert.equal(r.pauses[0].note, 'Slack');
});
test('closeRun finished normally', () => {
  const { session } = L.closeRun(run(), T0 + s(1500), 'finished');
  assert.equal(session.focus_seconds, 1500);
  assert.equal(session.ended_at, new Date(T0 + s(1500)).toISOString());
  assert.equal(session.status, 'finished');
});
test('closeRun after sleep ends at planned end, not wake time', () => {
  const r = L.resume(L.pause(run(), { id: 'p1', now: T0 + s(100) }), { now: T0 + s(160), note: '' });
  const { session, interruptions } = L.closeRun(r, T0 + s(99999), 'finished');
  assert.equal(session.ended_at, new Date(T0 + s(1560)).toISOString());
  assert.equal(session.focus_seconds, 1500);
  assert.deepEqual(interruptions[0], { id: 'p1', session_id: 'r1', kind: 'pause',
    at: new Date(T0 + s(100)).toISOString(), duration_seconds: 60, note: null });
});
test('closeRun closes an open pause', () => {
  const r = L.pause(run(), { id: 'p1', now: T0 + s(200) });
  const { session, interruptions } = L.closeRun(r, T0 + s(260), 'abandoned');
  assert.equal(session.focus_seconds, 200);
  assert.equal(interruptions[0].duration_seconds, 60);
});
test('distraction rows have no duration', () => {
  const r = L.addDistraction(run(), { id: 'd1', now: T0 + s(50), note: '' });
  assert.equal(L.timeLeft(r, T0 + s(50)), 1450);
  const { interruptions } = L.closeRun(r, T0 + s(60), 'abandoned');
  assert.equal(interruptions[0].kind, 'distraction');
  assert.equal(interruptions[0].duration_seconds, null);
});
test('breakSeconds: long after every 4th finished session', () => {
  assert.equal(L.breakSeconds(1), 300);
  assert.equal(L.breakSeconds(4), 900);
  assert.equal(L.breakSeconds(8), 900);
});
test('flushOutbox removes written items', async () => {
  const items = [{ session: { id: 'a' } }, { session: { id: 'b' } }];
  const out = await L.flushOutbox(items, async () => {});
  assert.deepEqual(out, { remaining: [], error: null });
});
test('flushOutbox keeps item when any write fails', async () => {
  const items = [{ session: { id: 'a' } }, { session: { id: 'b' } }];
  const out = await L.flushOutbox(items, async it => { if (it.session.id === 'a') throw new Error('net'); });
  assert.deepEqual(out.remaining.map(i => i.session.id), ['a']);
  assert.equal(out.error.message, 'net');
});
test('validateSettings', () => {
  assert.deepEqual(L.validateSettings({ session_minutes: '30', volume: '0.5', notification_text: ' Hi ', daily_target: '5' }),
    { ok: true, value: { session_minutes: 30, volume: 0.5, notification_text: 'Hi', daily_target: 5 } });
  const bad = L.validateSettings({ session_minutes: '0', volume: '2', notification_text: '  ', daily_target: '21' });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['daily_target', 'notification_text', 'session_minutes', 'volume']);
});
test('cleanNote', () => {
  assert.equal(L.cleanNote('   '), null);
  assert.equal(L.cleanNote(' x '), 'x');
});

const row = (startIso, o = {}) => ({ id: startIso, started_at: startIso, status: 'finished',
  focus_seconds: 1500, project: 'A', rating: 4, ...o });
test('stats of empty history', () => {
  const st = L.stats([], [], 4, '2026-10-16');
  assert.equal(st.todayCount, 0); assert.equal(st.streak, 0);
  assert.equal(st.last7.length, 7); assert.equal(st.focusByDay30.length, 30);
  assert.deepEqual(st.focusByProject, []); assert.deepEqual(st.topDistractionNotes, []);
});
test('streak counts back from today, or yesterday if today unmet', () => {
  const ss = ['2026-10-14', '2026-10-15'].flatMap(d => [1,2].map(h => row(`${d}T0${h}:00:00Z`)));
  assert.equal(L.streak(ss, 2, '2026-10-16'), 2);
  assert.equal(L.streak(ss, 2, '2026-10-17'), 0);
  assert.equal(L.streak(ss, 3, '2026-10-16'), 0);
});
test('abandoned sessions do not count toward target', () => {
  assert.equal(L.finishedOnDay([row('2026-10-16T08:00:00Z', { status: 'abandoned' })], '2026-10-16'), 0);
});
test('session across midnight counts on start day', () => {
  assert.equal(L.localDay('2026-10-15T20:50:00Z'), '2026-10-15'); // 23:50 Sofia
  assert.equal(L.localDay('2026-10-15T21:10:00Z'), '2026-10-16'); // 00:10 Sofia
});
test('stats aggregates', () => {
  const ss = [row('2026-10-16T06:00:00Z'), row('2026-10-16T07:00:00Z', { project: null, rating: 2 })];
  const ints = [{ session_id: ss[0].id, kind: 'pause', note: 'Slack' },
                { session_id: ss[1].id, kind: 'distraction', note: 'slack' }];
  const st = L.stats(ss, ints, 4, '2026-10-16');
  assert.equal(st.todayCount, 2);
  assert.deepEqual(st.focusByProject, [{ project: 'A', minutes: 25 }, { project: '(none)', minutes: 25 }]);
  assert.deepEqual(st.ratingByHour, [{ hour: 9, avg: 4 }, { hour: 10, avg: 2 }]);
  assert.deepEqual(st.topDistractionNotes, [{ note: 'slack', count: 2 }]);
  assert.equal(st.pausesPerSessionByWeek.at(-1).avg, 0.5);
});

// ---- Final-review fixes ----
const fakeStore = (init = {}) => { const m = new Map(Object.entries(init)); return {
  getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k),
  key: i => [...m.keys()][i] ?? null, get length() { return m.size; }, dump: () => Object.fromEntries(m) }; };

test('moveStore carries unsaved work over and leaves nothing behind', () => {
  const from = fakeStore({ 'pomo:outbox': '[1]', 'pomo:run': '{}', 'pomo:ended': 'null', 'pomo:auth': 'tok', other: 'x' });
  const to = fakeStore({ 'pomo:outbox': '[0]' });
  L.moveStore(from, to);
  assert.deepEqual(to.dump(), { 'pomo:outbox': '[0,1]', 'pomo:run': '{}', 'pomo:ended': 'null' });
  assert.deepEqual(from.dump(), { other: 'x' });
});
test('moveStore keeps the remember flag where it is', () => {
  const from = fakeStore({ 'pomo:remember': '1' }), to = fakeStore();
  L.moveStore(from, to);
  assert.deepEqual(from.dump(), { 'pomo:remember': '1' });
});
test('drainOutbox writes an item replaced while a write was in flight', async () => {
  let box = [{ session: { id: 'a', rating: null } }];
  const written = [];
  await L.drainOutbox({
    read: () => box, write: b => { box = b; },
    writeItem: async it => { written.push(it.session.rating); if (it.session.rating === null) box = [{ session: { id: 'a', rating: 5 } }]; },
  });
  assert.deepEqual(written, [null, 5]);
  assert.deepEqual(box, []);
});
test('drainOutbox stops when nothing can be written', async () => {
  let box = [{ session: { id: 'a' } }], calls = 0;
  const out = await L.drainOutbox({ read: () => box, write: b => { box = b; }, writeItem: async () => { calls++; throw new Error('off'); } });
  assert.equal(calls, 1);
  assert.equal(box.length, 1);
  assert.equal(out.error.message, 'off');
});
