-- Pomodoro app schema. Run once in the Supabase SQL Editor.

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

alter table sessions enable row level security;
alter table interruptions enable row level security;
alter table settings enable row level security;

create policy own on sessions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on interruptions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own on settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());
