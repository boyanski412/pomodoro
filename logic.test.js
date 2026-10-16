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
