-- Support per-class ranking and profile grouping for Discord students.
alter table if exists public.users
add column if not exists class_name text;
