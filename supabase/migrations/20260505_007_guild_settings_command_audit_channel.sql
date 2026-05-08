alter table if exists public.guild_settings
add column if not exists command_audit_channel_id text;
