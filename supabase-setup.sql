-- After Dark chat tables and baseline Row Level Security.
-- Run this in Supabase Dashboard > SQL Editor after creating a project.
-- Room and member creation should be done by a trusted server-side matcher.
-- Also enable anonymous sign-ins in Auth and disable public channel access in Realtime settings.

create table if not exists public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  room_type text not null check (room_type in ('direct', 'interest')),
  interest text,
  created_at timestamptz not null default now()
);

create table if not exists public.chat_members (
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.chat_rooms(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete cascade,
  sender_name text,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
alter table public.chat_messages add column if not exists sender_name text;
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'chat_messages_sender_name_length'
      and conrelid = 'public.chat_messages'::regclass
  ) then
    alter table public.chat_messages
      add constraint chat_messages_sender_name_length
      check (sender_name is null or char_length(sender_name) between 3 and 32);
  end if;
end;
$$;

-- Stores only each user's most recently ended conversation.
create table if not exists public.after_dark_last_chat (
  user_id uuid primary key references auth.users(id) on delete cascade,
  room_id uuid not null,
  ended_at timestamptz not null default now(),
  messages jsonb not null default '[]'::jsonb
);

alter table public.chat_rooms enable row level security;
alter table public.chat_members enable row level security;
alter table public.chat_messages enable row level security;
alter table public.after_dark_last_chat enable row level security;

revoke all on public.chat_rooms, public.chat_members, public.chat_messages
from anon, authenticated;
revoke all on public.after_dark_last_chat from anon, authenticated;

-- This helper checks membership for the current signed-in or anonymous user.
create or replace function public.is_after_dark_chat_member(target_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.chat_members as member_row
    where member_row.room_id = target_room_id
      and member_row.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_after_dark_chat_member(uuid) from public;
grant execute on function public.is_after_dark_chat_member(uuid) to authenticated;

drop policy if exists "room members can view their rooms" on public.chat_rooms;
create policy "room members can view their rooms"
on public.chat_rooms for select to authenticated
using ((select public.is_after_dark_chat_member(id)));

drop policy if exists "members can view members in their rooms" on public.chat_members;
create policy "members can view members in their rooms"
on public.chat_members for select to authenticated
using ((select public.is_after_dark_chat_member(room_id)));

drop policy if exists "members can read room messages" on public.chat_messages;
create policy "members can read room messages"
on public.chat_messages for select to authenticated
using ((select public.is_after_dark_chat_member(room_id)));

drop policy if exists "members can send as themselves" on public.chat_messages;
create policy "members can send as themselves"
on public.chat_messages for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and (select public.is_after_dark_chat_member(room_id))
);

grant select on public.chat_rooms, public.chat_members to authenticated;
grant select, insert on public.chat_messages to authenticated;
drop policy if exists "users can view their own last chat" on public.after_dark_last_chat;
create policy "users can view their own last chat"
on public.after_dark_last_chat for select to authenticated
using (user_id = (select auth.uid()));
grant select on public.after_dark_last_chat to authenticated;

-- Postgres Changes are delivered only for tables in this publication.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end;
$$;

-- Private Realtime topics must be named with the room UUID. In the Supabase
-- Dashboard, disable public channel access under Project Settings > Realtime.
drop policy if exists "chat members can receive private room events" on realtime.messages;
create policy "chat members can receive private room events"
on realtime.messages for select to authenticated
using (
  extension in ('broadcast', 'presence')
  and exists (
    select 1 from public.chat_members as member_row
    where member_row.room_id::text = (select realtime.topic())
      and member_row.user_id = (select auth.uid())
  )
);

drop policy if exists "chat members can send private room events" on realtime.messages;
create policy "chat members can send private room events"
on realtime.messages for insert to authenticated
with check (
  extension in ('broadcast', 'presence')
  and exists (
    select 1 from public.chat_members as member_row
    where member_row.room_id::text = (select realtime.topic())
      and member_row.user_id = (select auth.uid())
  )
);

-- Live one-to-one matchmaking and reporting for the browser MVP.
create table if not exists public.after_dark_queue (
  user_id uuid primary key references auth.users(id) on delete cascade,
  room_id uuid references public.chat_rooms(id) on delete cascade,
  queued_at timestamptz not null default now()
);
alter table public.after_dark_queue add column if not exists gender text;
alter table public.after_dark_queue add column if not exists country text;
alter table public.after_dark_queue add column if not exists preferred_gender text;
alter table public.after_dark_queue add column if not exists preferred_country text;
alter table public.after_dark_queue enable row level security;
revoke all on public.after_dark_queue from anon, authenticated;

create table if not exists public.after_dark_reports (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reported_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.after_dark_reports enable row level security;
revoke all on public.after_dark_reports from anon, authenticated;

create or replace function public.find_after_dark_chat(
  p_gender text,
  p_country text,
  p_preferred_gender text,
  p_preferred_country text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  waiting_user uuid;
  new_room uuid;
begin
  if me is null then raise exception 'Please reconnect and try again.'; end if;
  if p_gender is null or p_gender not in ('woman', 'man', 'nonbinary', 'prefer_not_to_say') then
    raise exception 'Choose your gender before searching.';
  end if;
  if p_country is null or p_country not in ('India', 'United States', 'United Kingdom', 'Brazil', 'Japan', 'other') then
    raise exception 'Choose your country before searching.';
  end if;
  if p_preferred_gender is null or p_preferred_gender not in ('any', 'woman', 'man', 'nonbinary') then
    raise exception 'Choose who you would like to meet.';
  end if;
  if p_preferred_country is null or p_preferred_country not in ('anywhere', 'India', 'United States', 'United Kingdom', 'Brazil', 'Japan') then
    raise exception 'Choose a location preference.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(me::text, 0));

  select queue.room_id into new_room
  from public.after_dark_queue as queue
  where queue.user_id = me;
  if new_room is not null then return new_room; end if;

  -- Expire abandoned searches. Active searches refresh queued_at on each poll.
  delete from public.after_dark_queue
  where room_id is null and queued_at < now() - interval '2 minutes';

  insert into public.after_dark_queue as existing_queue(
    user_id, room_id, gender, country, preferred_gender, preferred_country, queued_at
  ) values (
    me, null, p_gender, p_country, p_preferred_gender, p_preferred_country, now()
  )
  on conflict (user_id) do update set
    room_id = null,
    gender = excluded.gender,
    country = excluded.country,
    preferred_gender = excluded.preferred_gender,
    preferred_country = excluded.preferred_country,
    queued_at = now()
  where existing_queue.room_id is null;

  -- Another search may have matched this user while their request waited on the queue row.
  select queue.room_id into new_room
  from public.after_dark_queue as queue
  where queue.user_id = me;
  if new_room is not null then return new_room; end if;

  select queue.user_id into waiting_user
  from public.after_dark_queue as queue
  where queue.room_id is null
    and queue.user_id <> me
    and queue.queued_at > now() - interval '2 minutes'
    and (p_preferred_gender = 'any' or queue.gender = p_preferred_gender)
    and (p_preferred_country = 'anywhere' or queue.country = p_preferred_country)
    and (coalesce(queue.preferred_gender, 'any') = 'any' or queue.preferred_gender = p_gender)
    and (coalesce(queue.preferred_country, 'anywhere') = 'anywhere' or queue.preferred_country = p_country)
  order by queue.queued_at
  for update skip locked
  limit 1;

  if waiting_user is null then return null; end if;

  insert into public.chat_rooms(room_type) values ('direct') returning id into new_room;
  insert into public.chat_members(room_id, user_id) values (new_room, waiting_user), (new_room, me);
  update public.after_dark_queue
  set room_id = new_room, gender = null, country = null, preferred_gender = null, preferred_country = null
  where user_id in (waiting_user, me);
  return new_room;
end;
$$;
create or replace function public.leave_after_dark_chat(target_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'Please reconnect and try again.'; end if;
  if target_room_id is not null and public.is_after_dark_chat_member(target_room_id) then
    insert into public.after_dark_last_chat(user_id, room_id, ended_at, messages)
    select me, target_room_id, now(), coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'mine', recent.sender_id = me,
          'body', recent.body,
          'created_at', recent.created_at
        ) order by recent.created_at
      )
      from (
        select sender_id, body, created_at
        from public.chat_messages
        where room_id = target_room_id
        order by created_at desc
        limit 5
      ) as recent
    ), '[]'::jsonb)
    on conflict (user_id) do update set
      room_id = excluded.room_id,
      ended_at = excluded.ended_at,
      messages = excluded.messages;
  end if;
  delete from public.after_dark_queue where user_id = me;
  delete from public.chat_members where room_id = target_room_id and user_id = me;
end;
$$;

create or replace function public.report_after_dark_chat(target_room_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  me uuid := auth.uid();
  other_user uuid;
begin
  if me is null or not public.is_after_dark_chat_member(target_room_id) then
    raise exception 'You are not a member of this chat.';
  end if;
  select member_row.user_id into other_user
  from public.chat_members as member_row
  where member_row.room_id = target_room_id and member_row.user_id <> me
  limit 1;
  insert into public.after_dark_reports(room_id, reporter_id, reported_user_id)
  values (target_room_id, me, other_user);
  delete from public.after_dark_queue where user_id = me;
  delete from public.chat_members where room_id = target_room_id and user_id = me;
end;
$$;

revoke all on function public.find_after_dark_chat(text, text, text, text) from public, anon;
revoke all on function public.leave_after_dark_chat(uuid) from public, anon;
revoke all on function public.report_after_dark_chat(uuid) from public, anon;
grant execute on function public.find_after_dark_chat(text, text, text, text) to authenticated;
grant execute on function public.leave_after_dark_chat(uuid) to authenticated;
grant execute on function public.report_after_dark_chat(uuid) to authenticated;
