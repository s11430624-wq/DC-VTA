# VTA Discord Bot

## Environment variables

Create a local `.env` file with:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
TEACHER_ROLE_ID=
STUDENT_ROLE_ID=
```

Do not commit `.env` or `.env.local`.

## Supabase notes

The bot runs as a backend Node.js Discord Bot, so `SUPABASE_SERVICE_ROLE_KEY` is read from `.env` only and must never be sent to Discord or client-side code.

For Discord user records, add the optional `platform` column:

```sql
alter table users add column if not exists platform text default 'discord';
```

The current `/link` implementation safely falls back if the column does not exist, but adding the column is recommended.

## Commands

```powershell
npx ts-node src/index.ts
```

Slash commands are registered automatically when the bot starts.
