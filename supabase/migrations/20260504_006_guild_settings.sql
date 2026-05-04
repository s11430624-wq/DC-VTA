create table if not exists public.guild_settings (
    guild_id text primary key,
    guild_name text,
    teacher_role_id text,
    teacher_log_channel_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create or replace function public.set_guild_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists guild_settings_set_updated_at on public.guild_settings;

create trigger guild_settings_set_updated_at
before update on public.guild_settings
for each row
execute function public.set_guild_settings_updated_at();
