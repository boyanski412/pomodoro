# Pomodoro web app — design

Date: 2026-10-16 · Status: awaiting review (rev 2: password login, remember-this-computer, browsers)

## 1. Purpose

A personal Pomodoro timer used in desktop browsers (Mac and other computers) to track deep-work sessions and improve focus over time. Single user. Zero running cost.

Success after a few weeks of use:
- **Consistency** — hits a daily session target; streak visible.
- **Insight** — can see when and on what focus is best (time of day, project).
- **Quality** — rates each session; average rating and interruptions trend in the right direction.

Out of scope for v1: iPhone/mobile, distraction blocking, multiple users, keyboard shortcuts, data export, adjustable break lengths, sync between two tabs on one computer.

## 2. Architecture

- **Frontend:** static site — `index.html`, `app.js`, `logic.js`, `style.css`. No build step, no framework. Libraries loaded from CDN: `@supabase/supabase-js`, Chart.js (stats page).
- **Hosting:** GitHub Pages (free).
- **Backend:** Supabase free tier (Auth + Postgres). No server code.
  - Free tier (as of May 2026): 2 projects, 500 MB DB. Projects pause after 1 week of inactivity; data survives, restore from dashboard.
- **Auth:** Supabase email + password. Public sign-ups disabled after the owner's account is created.
- **Storage on each computer:** a "Remember this computer" checkbox at login decides where the browser keeps the login, running session and outbox. Ticked → `localStorage` (survives closing the tab). Unticked → `sessionStorage` (erased when the tab closes; survives refresh). The choice is itself kept only in that same storage, so an unticked computer keeps nothing after the tab closes. Supabase client is created with `auth.storage` set to the chosen store.
- **Browsers:** current Safari and Chrome on macOS, including private/incognito windows.

`logic.js` holds all pure logic (no DOM, no network) so it can be tested in Node. `app.js` holds UI, timer loop, Supabase calls.

## 3. Data model (Postgres)

```sql
create table sessions (
  id uuid primary key,                       -- generated in browser at start
  user_id uuid not null default auth.uid() references auth.users,
  started_at timestamptz not null,
  ended_at timestamptz,
  planned_seconds int not null check (planned_seconds > 0),
  focus_seconds int not null default 0 check (focus_seconds >= 0),  -- excludes paused time
  status text not null check (status in ('finished','abandoned')),
  project text,
  rating smallint check (rating between 1 and 5),
  note text
);

create table interruptions (
  id uuid primary key,
  session_id uuid not null references sessions on delete cascade,
  user_id uuid not null default auth.uid() references auth.users,
  kind text not null check (kind in ('pause','distraction')),
  at timestamptz not null,
  duration_seconds int check (duration_seconds >= 0),  -- pauses only
  note text
);
create index on interruptions (session_id);
create index on sessions (user_id, started_at);

create table settings (
  user_id uuid primary key default auth.uid() references auth.users,
  session_minutes int not null default 25 check (session_minutes between 1 and 180),
  volume real not null default 0.7 check (volume between 0 and 1),
  notification_text text not null default 'Session done. Time for a break.',
  daily_target int not null default 4 check (daily_target between 1 and 20)
);
```

Row Level Security enabled on all three tables, with one policy each: `user_id = auth.uid()` for select, insert, update, delete.

Breaks are not stored.

## 4. Screens and flow

1. **Login** — email, password, "Remember this computer" checkbox (unticked by default).
2. **Timer (main)**
   - Project label: pick from recent labels or type new.
   - Mug visual (see §5) drains as the session runs; time left shown below.
   - Controls: Start → during session: Pause/Resume, Distracted, Give up.
   - Pause: clock and mug freeze. On Resume, prompt "What pulled you away?" (note, skippable). Logged as a `pause` interruption with duration.
   - Distracted: clock keeps running; logs a `distraction` interruption with optional note.
   - Give up: ends the session as `abandoned`, then goes to the end-of-session form.
3. **End of session**
   - Notification (settings text) + sound (settings volume).
   - Form: rating 1–5, optional note, list of the session's interruptions with editable notes.
   - Save → break starts: 5 min, or 15 min after every 4th finished session. The mug slowly refills during the break.
4. **Stats** (one page)
   - Consistency: sessions today vs daily target, current streak (consecutive days with finished sessions ≥ daily target, ending today, or yesterday if today isn't met yet; days use the browser's local time zone), last 7 days bar chart.
   - Insight: focus minutes per day (last 30 days), focus minutes by project, average rating by hour of day.
   - Quality: average rating over time, pauses per session over time, most common distraction notes.
5. **Settings** — default session length, volume (with test button), notification text, daily target. Stored in `settings`, so they follow the account across computers. If no row exists on first load, the app uses the defaults and inserts the row on the first save.

## 5. Visual design

The mug is a bold flat icon on a dark rounded tile, following the reference image:
- thick white rounded outline
- U-shaped mug body with a handle on the right
- flat amber coffee whose level equals the fraction of session time left
- no gradients or realism

The rest of the UI stays minimal and quiet around the mug.

## 6. Timer behaviour

- The state is timestamps: `started_at`, a list of pauses, and `planned_seconds`. Time left = planned − (now − started − paused time). The display loop only redraws, so it stays accurate when the browser throttles a background tab.
- The running session is saved to the chosen store (see §2) on every state change, so a refresh resumes it; a closed tab resumes it only on a remembered computer.
- **Sleep or wake past the end:** the session is closed at the planned end time. Focus time then equals the planned time, not the wake time.
- **Audio:** pressing Start unlocks audio, because browsers block sound until the user clicks. If notifications are denied, the sound still plays and the tab title changes to "Time's up".
- If another tab on the same computer already has a running session in `localStorage` (remembered computers only), show a warning.

## 7. Error handling

- **Idempotent saves:** the browser generates the IDs, and saves use `upsert`. A retry never creates a duplicate.
- **Outbox:** a finished session and its interruptions go into an outbox in the chosen store first, and are removed only after Supabase confirms the write.
  - The outbox is flushed on app load and on the `online` event.
  - While it isn't empty, a banner says "Not saved yet, will retry."
  - If the error shows the project is paused or unreachable, the banner adds a hint to restore it from the Supabase dashboard.
- **Unremembered computer:** closing the tab while the outbox is not empty loses those sessions; the app warns via the browser's leave-page prompt while the outbox is not empty.
- **Expired login:** the session stays local. You log in again, then the outbox flushes.
- Errors are shown as one plain sentence, never as raw exception text.

## 8. Testing

- `logic.test.js` uses Node's built-in `node --test` and covers:
  - time left with pauses
  - focus seconds
  - sleep-past-end closing
  - long-break every 4th session
  - streak calculation
  - stats aggregations
- Security check: query each table with the anon key while logged out, and confirm that zero rows come back.
- Manual checklist, run once in Safari and once in a Chrome incognito window:
  - notification and sound
  - volume
  - refresh mid-session
  - pause → resume note
  - finish while offline → reconnect → saved
  - stats render
  - unticked "Remember this computer": close tab, reopen → logged out, browser storage for the site empty

## 9. Setup steps (owner)

1. Create a free Supabase project.
2. Run the SQL from §3.
3. Enable email + password login, turn off email confirmation (single user), and set the site URL to the GitHub Pages address.
4. Log in once, then disable sign-ups.
5. Create a GitHub repo and enable Pages.
6. Put the Supabase URL and anon key in `app.js`. The anon key is public by design, and RLS protects the data.
