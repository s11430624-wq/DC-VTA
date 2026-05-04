-- Ensure quiz_responses can store student reaction time in seconds.

alter table if exists public.quiz_responses
add column if not exists reaction_time double precision;
