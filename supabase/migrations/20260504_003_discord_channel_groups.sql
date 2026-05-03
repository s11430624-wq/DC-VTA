-- Canonicalize Discord group mode on groups.group_id = Discord channel id.
-- Legacy non-Discord group ids are preserved for history but should not be used by the bot anymore.

create unique index if not exists groups_group_id_unique
on public.groups (group_id);

create unique index if not exists group_members_group_user_unique
on public.group_members (group_id, user_id);

create index if not exists quiz_responses_group_id_idx
on public.quiz_responses (group_id);

comment on column public.groups.group_id is
'Canonical Discord channel id for Discord bot group mode. Legacy non-Discord ids are historical only.';
