# Pomodoro Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-user Pomodoro web app with a draining-mug timer, session/interruption logging to Supabase, settings, and a stats page, hosted free on GitHub Pages.

**Architecture:** Static site, no build step. `logic.js` is a pure ES module (no DOM, no network) tested with `node --test`; `app.js` is an ES module that imports it and owns DOM, timer loop, storage and Supabase calls. Supabase (Auth + Postgres with RLS) is the only backend.

**Tech Stack:** HTML/CSS/vanilla JS (ES modules), `@supabase/supabase-js@2` and `chart.js@4` from jsDelivr as UMD globals, Node ≥ 20 built-in test runner, GitHub Pages, Supabase free tier.

**Spec:** `docs/superpowers/specs/2026-10-16-pomodoro-web-app-design.md`

## Global Constraints

- Files: `index.html`, `app.js`, `logic.js`, `style.css`, plus `logic.test.js`, `schema.sql`, `package.json` (`{"type":"module","scripts":{"test":"TZ=Europe/Sofia node --test"}}`). No other dependencies.
- CDN scripts (classic `<script>` before `app.js`): `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`, `https://cdn.jsdelivr.net/npm/chart.js@4`.
- Defaults: session 25 min, short break 5 min, long break 15 min after every 4th finished session **of the local day**, volume 0.7, notification text `Session done. Time for a break.`, daily target 4.
- Settings bounds: session_minutes 1–180, volume 0–1, daily_target 1–20.
- Storage: "Remember this computer" ticked → `localStorage`, unticked (default) → `sessionStorage`. Every key the app writes is prefixed `pomo:`. Nothing else is ever written to browser storage.
- Copy, exact: Pause prompt `What pulled you away?`; outbox banner `Not saved yet, will retry.`; paused-project hint `If this keeps happening, restore your project in the Supabase dashboard.`; tab title on finish `Time's up`.
- Errors shown to the user are one plain sentence, never raw exception text.
- Days are local-time days (`YYYY-MM-DD` in the browser's time zone). A session belongs to the day it started.
- Mug: bold flat icon, dark rounded tile, thick white rounded outline, U-shaped body, handle right, flat amber coffee. No gradients.

## Review Focus

1. Brand-new account with no sessions → stats page renders zeros/empty charts, no errors. Pinned in Task 2 (`stats of empty history`).
2. Give up or close while a pause is still open → the open pause is closed at that moment and its duration counted. Pinned in Task 1 (`closeRun closes an open pause`).
3. Session that starts before midnight and ends after → counted on its start day for streak and charts. Pinned in Task 2 (`session across midnight counts on start day`).
4. Outbox where the session saved but its interruptions failed → stays in outbox, retry upserts without duplicates. Pinned in Task 1 (`flushOutbox keeps item when any write fails`).
5. Settings form given out-of-range or empty values (0 minutes, volume 2, blank text) → rejected with a field message before saving, matching DB checks. Pinned in Task 1 (`validateSettings`).

---

### Task 1: Timer, run lifecycle, outbox and settings logic

**Files:**
- Create: `package.json`, `logic.js`, `logic.test.js`, `.gitignore` (`node_modules/`, `.DS_Store`)

**Interfaces:**
- Produces (all exported from `logic.js`; times are epoch ms, durations seconds):
  - `Run = { id, startedAt, plannedSeconds, project, pauses: [{id, start, end|null, note}], distractions: [{id, at, note}] }`
  - `newRun({id, now, plannedSeconds, project}) -> Run`
  - `pausedSeconds(run, now) -> number`
  - `timeLeft(run, now) -> number` (never below 0)
  - `isPaused(run) -> boolean`
  - `pause(run, {id, now}) -> Run` / `resume(run, {now, note}) -> Run` / `addDistraction(run, {id, now, note}) -> Run` (return new objects, never mutate)
  - `closeRun(run, now, status) -> { session, interruptions }` — rows shaped exactly like the `sessions`/`interruptions` tables (snake_case, ISO strings, no `user_id`); `rating` and `note` null.
  - `breakSeconds(finishedToday) -> number`
  - `flushOutbox(items, writeItem) -> Promise<{ remaining, error }>` — `items` is an array of `{session, interruptions}`; `writeItem` is an async fn that throws on failure.
  - `validateSettings(raw) -> { ok: true, value } | { ok: false, errors: {field: message} }`
  - `cleanNote(text) -> string|null`

- [ ] **Step 1: Write failing tests in `logic.test.js`**

```js
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
```

- [ ] **Step 2: Run `npm test` — expected: FAIL, cannot find exports.**

- [ ] **Step 3: Implement the exports in `logic.js`.** Planned end = `startedAt + plannedSeconds*1000 + pausedSeconds*1000`; `closeRun` uses `end = min(now, plannedEnd)`, closes an open pause at `end`, and computes `focus_seconds = round(min(plannedSeconds, (end - startedAt)/1000 - paused))`. `flushOutbox` writes items in order, keeps every item whose write threw, returns the last error. `validateSettings` enforces the Global Constraints bounds; integers for minutes/target.

- [ ] **Step 4: Run `npm test` — expected: all pass.**

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: timer, outbox and settings logic"`

---

### Task 2: Streak and stats logic

**Files:**
- Modify: `logic.js`, `logic.test.js`

**Interfaces:**
- Consumes: session/interruption row shapes from Task 1.
- Produces:
  - `localDay(isoOrMs) -> 'YYYY-MM-DD'` (browser local time)
  - `finishedOnDay(sessions, day) -> number`
  - `streak(sessions, target, today) -> number`
  - `stats(sessions, interruptions, target, today) -> { todayCount, target, streak, last7: [{day, count}], focusByDay30: [{day, minutes}], focusByProject: [{project, minutes}], ratingByHour: [{hour, avg}], ratingByWeek: [{week, avg}], pausesPerSessionByWeek: [{week, avg}], topDistractionNotes: [{note, count}] }`
    - `last7`/`focusByDay30` include zero days, oldest first, ending `today`.
    - `week` = local day of that week's Monday. Project null → `"(none)"`. `focusByProject` sorted by minutes desc, ties in order of first appearance. Averages rounded to 1 decimal; rows with no rated sessions omitted. `topDistractionNotes`: notes from both kinds, case-insensitive grouping, top 5.

- [ ] **Step 1: Add failing tests** (package script pins `TZ=Europe/Sofia`):

```js
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
```

- [ ] **Step 2: Run `npm test` — expected: new tests FAIL.**
- [ ] **Step 3: Implement in `logic.js`.**
- [ ] **Step 4: Run `npm test` — expected: all pass.**
- [ ] **Step 5: Commit** — `feat: streak and stats logic`

---

### Task 3: Supabase project and schema (guided with the owner)

The owner has never used Supabase or GitHub. The executor walks them through each click in chat, one step at a time, and waits for confirmation. The owner never pastes their password into the chat.

**Files:**
- Create: `schema.sql`: the spec §3 SQL, plus `alter table … enable row level security` for each table, plus one policy per table: `create policy own on <t> for all using (user_id = auth.uid()) with check (user_id = auth.uid());`

**Interfaces:**
- Produces: the Supabase project URL and the anon (publishable) key. Task 4 needs both.

- [ ] **Step 1:** Write `schema.sql` and commit it with the message `feat: database schema with RLS`.
- [ ] **Step 2:** Guide the owner through the setup:
  - Create a Supabase account and a free project, using the Frankfurt (EU) region.
  - Paste `schema.sql` into the SQL Editor and run it. Expected result: "Success. No rows returned."
- [ ] **Step 3:** Guide the owner through auth settings:
  - Authentication → Providers: Email on, "Confirm email" off.
  - Authentication → Users: Add user, with auto-confirm on.
  - Authentication settings: turn off "Allow new users to sign up".
- [ ] **Step 4:** The owner copies the Project URL and the anon key from Project Settings → API into the chat. Never the service_role key.
- [ ] **Step 5: Security check.** From the workspace, run:

  `curl -s "$URL/rest/v1/sessions?select=*" -H "apikey: $ANON"`

  Expected: `[]`. Repeat for `interruptions` and `settings`.

---

### Task 4: Shell, storage choice and login

**Files:**
- Create: `index.html`, `style.css`, `app.js`

**Interfaces:**
- Consumes: the URL and key from Task 3.
- Produces, in `app.js`:
  - `SUPABASE_URL` and `SUPABASE_ANON_KEY` constants
  - `store()`: returns `localStorage` when `localStorage['pomo:remember'] === '1'`, otherwise `sessionStorage`
  - `db`: the Supabase client, created with `{ auth: { storage: store(), storageKey: 'pomo:auth', persistSession: true } }`
  - `show(viewId)`: shows exactly one of the views `#login`, `#timer`, `#end`, `#stats`, `#settings`
  - `settings` and `loadSettings()`: after login, read the user's `settings` row; when there is none, use the defaults from Global Constraints
  - a nav with Timer, Stats, Settings and Log out

- [ ] **Step 1: Login form** with email, password, a "Remember this computer" checkbox (unticked) and a Log in button.
  - On submit: if the box is ticked, set `localStorage['pomo:remember']='1'`; otherwise remove the key.
  - Recreate `db`, call `signInWithPassword`, then `loadSettings()`.
  - On a failed login, show `Wrong email or password.`
  - On load: if there's a session, show `#timer`; otherwise show `#login`.
  - Log out calls `signOut()`, then removes every `pomo:` key from both stores.
- [ ] **Step 2: Manual check.** Serve the folder locally with `python3 -m http.server`. In a private window, log in without ticking the box, then close and reopen the tab.

  Expected: you're logged out. DevTools → Application shows no `pomo:` keys in local storage.

  Then log in with the box ticked, close and reopen. Expected: still logged in.
- [ ] **Step 3: Commit** with the message `feat: app shell and login`.

---

### Task 5: Timer screen and mug

**Files:**
- Modify: `index.html`, `style.css`, `app.js`

**Interfaces:**
- Consumes the `Run` functions from Task 1, plus `store()`, `db` and `show()` from Task 4.
- Produces, in `app.js`:
  - `drawMug(fraction: 0..1)`, which updates the coffee level of the inline SVG
  - the run state saved under the store key `pomo:run`
  - `onRunEnd(status)`, which calls `closeRun` and then shows `#end`

- [ ] **Step 1: Inline SVG mug** per Global Constraints.
  - The coffee is a `<rect>` clipped to the mug interior; its `y` and `height` are set from the fraction.
  - The time left shows as `mm:ss` below the mug.
- [ ] **Step 2: Project input** is an `<input list>` with a `<datalist>` of the last 10 distinct `project` values, loaded from `sessions`.
- [ ] **Step 3: Controls.**
  - **Start:**
    - creates the run with `crypto.randomUUID()` and the length from settings
    - saves `pomo:run`
    - unlocks audio by creating or resuming an `AudioContext`
    - asks for notification permission if it's still `default`
  - **Pause / Resume:** on Resume, show an inline field with the label `What pulled you away?`, plus Save and Skip buttons.
  - **Distracted:** adds a distraction, with an optional note in the same inline field.
  - **Give up:** calls `onRunEnd('abandoned')`.
  - Every state change rewrites `pomo:run`.
- [ ] **Step 4: Display loop.**
  - `setInterval(tick, 500)` redraws from `timeLeft(run, Date.now())`, and also redraws on `visibilitychange`.
  - When the time left reaches 0:
    - call `onRunEnd('finished')`
    - play a beep with Web Audio, using the volume from settings
    - send a `new Notification(settings.notification_text)` if permission is granted
    - set `document.title = "Time's up"`
  - On load: if `pomo:run` exists, resume it. If it's already past its end, it closes through the same path.
  - Remembered computers only: if another tab already holds `pomo:run`, listen for the `storage` event and show `This session is already running in another tab.`
- [ ] **Step 5: Manual check.** Set a 1-minute session in settings (or use a temporary constant), then check:
  - the mug drains
  - pause freezes the timer
  - a refresh mid-session resumes it
  - when time is up, the sound plays and the title changes
  - Give up shows the `#end` view
- [ ] **Step 6: Commit** with the message `feat: timer screen with draining mug`.

---

### Task 6: End-of-session form, outbox save and break

**Files:**
- Modify: `index.html`, `app.js`

**Interfaces:**
- Consumes: `closeRun`, `flushOutbox`, `breakSeconds`, `finishedOnDay` and `cleanNote` (Tasks 1–2), `store()` and `db`.
- Produces: the outbox under the store key `pomo:outbox` (a JSON array), and `flush()`.

- [ ] **Step 1: The `#end` form.**
  - Rating 1–5 as five radio buttons; rating is optional.
  - A note textarea.
  - One row per interruption, with an editable note.
  - **Save** pushes `{session, interruptions}` (with the edited notes cleaned) to `pomo:outbox`, removes `pomo:run`, then calls `flush()`.
- [ ] **Step 2: `flush()`** calls `flushOutbox` with this `writeItem`:
  - `db.from('sessions').upsert(session)`, then `db.from('interruptions').upsert(interruptions)`
  - throws on any `error`, then writes back `remaining`
  - While `remaining` isn't empty, the banner shows `Not saved yet, will retry.`. Add the paused-project hint when the error is a network or `fetch` failure.
  - Call it on load, on `online`, and after Save.
  - While the outbox isn't empty, `beforeunload` calls `preventDefault()`.
- [ ] **Step 3: Break.**
  - After Save, count today's finished sessions from the database, plus the session just saved if it's finished.
  - Run a break of `breakSeconds(count)` on the same mug, filling from 0 up to 1.
  - Show a "Skip break" button.
  - Breaks are never stored.
- [ ] **Step 4: Manual check.**
  - Finish a session and confirm the row appears in the Supabase Table Editor.
  - Then turn the network off in DevTools and finish another. The banner should show.
  - Turn the network back on. The banner should clear, the row should appear, and there should be no duplicates.
- [ ] **Step 5: Commit** with the message `feat: save sessions via outbox, breaks`.

---

### Task 7: Settings

**Files:**
- Modify: `index.html`, `app.js`

**Interfaces:**
- Consumes: `validateSettings`, `db`, `settings` and `loadSettings()` (from Task 4).

- [ ] **Step 1: The `#settings` form** has four fields: minutes, volume (a range from 0 to 1 in steps of 0.05), notification text, and daily target. It also has a **Test sound** button that plays the beep at the slider's volume.
- [ ] **Step 2: Save** runs `validateSettings`.
  - Any errors show next to their fields.
  - If valid, call `db.from('settings').upsert(value)` and update `settings`.
  - When it's done, show `Settings saved`.
- [ ] **Step 3: Manual check.** Save a 30-minute session length, reload, and confirm the timer defaults to 30:00. Enter 0 minutes and confirm the field error shows.
- [ ] **Step 4: Commit** with the message `feat: settings`.

---

### Task 8: Stats page

**Files:**
- Modify: `index.html`, `style.css`, `app.js`

**Interfaces:**
- Consumes: `stats` (Task 2), `settings.daily_target`, `db`, and the global `Chart`.

- [ ] **Step 1: Load the data.**
  - Fetch sessions from the last 91 days: `sessions` with `started_at >= now-91d`, ordered by `started_at`.
  - Fetch their interruptions with `in('session_id', ids)`. Skip this call when `ids` is empty.
- [ ] **Step 2: Render the summary tiles:** today against the target, and the streak.
- [ ] **Step 3: Render six charts:**
  - last 7 days, as bars
  - focus minutes over 30 days, as bars
  - minutes by project, as horizontal bars
  - average rating by hour, as bars
  - average rating by week, as a line
  - pauses per session by week, as a line
- [ ] **Step 4: Render the list of top distraction notes.**
- [ ] **Step 5:** Destroy each chart before redrawing it. An empty data set should show an empty chart, not an error.
- [ ] **Step 6: Manual check.**
  - With 2–3 saved sessions, the numbers should match the Table Editor.
  - On a fresh account, the page should render without console errors.
- [ ] **Step 7: Commit** with the message `feat: stats page`.

---

### Task 9: Deploy and acceptance (guided with the owner)

- [ ] **Step 1: Publish the site.** Guide the owner to create a GitHub account and a **public** repo named `pomodoro`. Free Pages needs a public repo; the code contains no secrets.

  Then push the code:
  - If the owner authorises it, push with `gh`.
  - Otherwise, the owner uploads the files through GitHub's web upload.

  Finally, enable Pages under Settings → Pages: Deploy from branch, `main`, `/root`.
- [ ] **Step 2: Point Supabase at the site.** Set the Supabase Authentication → URL Configuration → Site URL to `https://<user>.github.io/pomodoro/`.
- [ ] **Step 3: Run the spec §8 manual checklist** together with the owner, once in Safari on their own Mac and once in Chrome incognito on the company Mac.

  Record any failures as new tasks; don't patch them silently.
- [ ] **Step 4: Repeat the logged-out security check** from Task 3, Step 5, against the live project.
