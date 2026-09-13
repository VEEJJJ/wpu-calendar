-- Run this in Supabase: Project > SQL Editor > New query > paste > Run

create table if not exists activities (
  id text primary key,
  year int not null,
  month int not null,
  date int not null,
  end_year int not null,
  end_month int not null,
  end_date int not null,
  name text not null,
  in_charge text not null,
  organizer text default '',
  participants text default '',
  venue text default '',
  activity_status text not null default 'Pending',
  series_id text,
  note_thread jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  action text not null,
  title text not null,
  detail text default ''
);

alter table activities enable row level security;
alter table audit_log enable row level security;

-- Open access policies (internal staff tool, gated by the app's own PIN screen).
create policy "public read activities" on activities for select using (true);
create policy "public write activities" on activities for insert with check (true);
create policy "public update activities" on activities for update using (true);
create policy "public delete activities" on activities for delete using (true);

create policy "public read audit" on audit_log for select using (true);
create policy "public write audit" on audit_log for insert with check (true);

-- If you already ran the schema above previously, just run this one line
-- to add the new Time field to your existing table:
alter table activities add column if not exists time text default '';

-- Renaming "Ongoing" to "Cancelled": update any existing rows to match.
update activities set activity_status = 'Cancelled' where activity_status = 'Ongoing';

-- Reschedule feature: link an old (kept-for-history) activity to its
-- replacement occurrence, and vice versa.
alter table activities add column if not exists rescheduled_from text;
alter table activities add column if not exists rescheduled_to text;

-- Enable realtime sync so all devices see live updates
alter publication supabase_realtime add table activities;
alter publication supabase_realtime add table audit_log;

