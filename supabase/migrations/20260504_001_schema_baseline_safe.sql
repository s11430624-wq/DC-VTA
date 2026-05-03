-- Safe baseline schema adjustments for VTA Discord Bot
-- This migration only adds missing columns/defaults and does not force uniqueness.

-- users.platform (optional in code, recommended in schema)
alter table if exists public.users
add column if not exists platform text default 'discord';

-- quiz_responses short-answer support fields
alter table if exists public.quiz_responses
add column if not exists answer_text text;

alter table if exists public.quiz_responses
add column if not exists status text not null default 'graded';

-- enforce known status domain when constraint not present
do $$
begin
    if not exists (
        select 1
        from pg_constraint
        where conname = 'quiz_responses_status_check'
    ) then
        alter table public.quiz_responses
        add constraint quiz_responses_status_check
        check (status in ('pending', 'graded'));
    end if;
end
$$;

