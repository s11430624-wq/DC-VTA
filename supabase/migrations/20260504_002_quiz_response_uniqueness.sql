-- Uniqueness hardening for quiz_responses(user_id, question_id)
-- Run this after duplicates are cleaned, or use the helper query below first.

-- 1) Check duplicates first
-- select user_id, question_id, count(*) as duplicate_count
-- from public.quiz_responses
-- group by user_id, question_id
-- having count(*) > 1
-- order by duplicate_count desc;

-- 2) Add unique constraint only when no duplicates exist
do $$
begin
    if exists (
        select 1
        from public.quiz_responses
        group by user_id, question_id
        having count(*) > 1
    ) then
        raise notice 'Skip adding unique constraint: duplicate (user_id, question_id) rows still exist.';
    elsif not exists (
        select 1
        from pg_constraint
        where conname = 'quiz_responses_user_question_unique'
    ) then
        alter table public.quiz_responses
        add constraint quiz_responses_user_question_unique
        unique (user_id, question_id);
    end if;
end
$$;

