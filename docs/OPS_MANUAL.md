# VTA Discord Bot Ops Manual

## Purpose

This document is the local operations and evolution manual for the VTA Discord Bot project.

Primary goal:

- Keep the classroom quiz pipeline stable.
- Evolve in small, testable steps.
- Prevent regressions while extending features.

Current stable pipeline:

- Teacher generates question drafts with `/ask`
- Teacher can batch-generate with `/batch_generate`
- Teacher confirms drafts before insertion
- Teacher opens question with `/open`
- Students answer multiple-choice by buttons or short-answer by modal
- Responses are stored in `quiz_responses`
- Teacher checks stats with `/check`
- Teacher routes to grading with `/grading_queue` or `/grade_link`
- Teacher grades short answers in the frontend dashboard
- Students/teacher view ranking with `/rank`

## Command Map

Student/general commands:

- `/help`
- `/link student_id name`
- `/me`
- `/rank [limit]`
- `/ask prompt`
- `/clear_memory`

Teacher-only commands:

- `/add content`
- `/add_short content rubric`
- `/open id`
- `/check id`
- `/grading_queue`
- `/grade_link id`
- `/batch_generate prompt count`

Permission gate:

- Teacher commands must pass `requireTeacher(interaction)`.

## Data Flow

### Question lifecycle

1. `/ask` or `/batch_generate` creates draft data.
2. Teacher confirms the draft.
3. Confirmed questions are inserted into `question_bank`.
4. `/open` reads question data and posts Discord interaction UI.

### Answer lifecycle

1. Student clicks a multiple-choice button or submits a short-answer modal.
2. Bot validates user identity from `users`.
3. Multiple-choice answers are judged immediately.
4. Short answers are stored with `status='pending'`.
5. Records are upserted into `quiz_responses` by `(user_id, question_id)`.

### Grading lifecycle

- `/check id` for short-answer includes the grading link.
- `/grading_queue` groups pending short-answer submissions by question.
- `/grade_link id` builds a deep link into the teacher dashboard.
- The dashboard handles manual grading and AI-assisted grading.

## Required Environment

`.env` keys:

```env
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=
QUESTION_MODEL=
TEACHER_ROLE_ID=
FRONTEND_BASE_URL=
```

Rules:

- Never log or expose `DISCORD_TOKEN`.
- Never log or expose `SUPABASE_SERVICE_ROLE_KEY`.
- Keep `.env` local only.
- `FRONTEND_BASE_URL` must point to a frontend that supports grading deep links.

## Stability Rules

1. No large refactors on a stable classroom day.
2. Any behavior change must include command-level regression checks.
3. Prefer fallback-safe database writes over hard failures.
4. Keep reply visibility intentional:
   - private data/results => `ephemeral: true`
   - general ranking => public allowed
5. Teacher authorization trusts only the Discord role `TEACHER_ROLE_ID`; `users.role` is not a bot permission source.

## Regression Checklist (Run Every Iteration)

1. `/help` command list is complete.
2. `/link` succeeds for a student account.
3. `/me` matches linked data.
4. `/ask` draft generation works.
5. `/batch_generate` works.
6. `/open` posts embed/buttons or short-answer modal entry.
7. Student answer writes and replies correctly.
8. `/check` reflects latest answer and short-answer grading link.
9. `/grading_queue` returns pending grading links.
10. `/grade_link id` returns the expected frontend URL.
11. TypeScript compiles:
    - `npx tsc --noEmit`

## Local Run

```powershell
npm run bot:start
```

Slash commands are auto-registered on bot startup for the configured guild.
