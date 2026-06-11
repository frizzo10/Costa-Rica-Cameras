-- TheDeck AI — Supabase setup
-- Run this in the Supabase SQL editor.

create table if not exists deck_alerts (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  camera       text not null default 'camera',
  subject      text,
  category     text not null default 'unclear',   -- person | vehicle | animal | false_alarm | unclear
  threat_level int  not null default 2,           -- 1 routine · 2 attention · 3 urgent
  summary      text,
  snapshot_url text,
  notified     boolean not null default false
);

create index if not exists deck_alerts_created_idx on deck_alerts (created_at desc);

-- Dashboard reads alerts with the anon key (read-only).
alter table deck_alerts enable row level security;

create policy "public read alerts"
  on deck_alerts for select
  to anon
  using (true);

-- Writes happen only from the Netlify function using the service_role key
-- (service_role bypasses RLS, so no insert policy is needed for anon).

-- Storage: create a PUBLIC bucket named  deck-snapshots
-- (Dashboard → Storage → New bucket → name: deck-snapshots → Public: ON)
-- Public is required so WhatsApp can fetch the image via MediaUrl.
