# VTA Discord Bot Smoke Test

## Goal

Run this checklist after any bot logic change, deployment, or environment update.

## Preconditions

- Bot is running.
- Slash commands are registered successfully.
- Supabase is reachable.
- Teacher account has teacher permissions.
- Student account is available for real answer flow testing.

## Start

```powershell
npm run typecheck
npm run start
```

Expected startup logs:

```text
✅ 機器人已上線
✅ Slash Commands 註冊成功
```

## Core Flow

1. `/help`
- Student account:
- Confirm student help does not include `/list` or `/question`.
- Confirm student help does not present teacher-only creation or grading commands.
- Teacher account:
- Confirm teacher help includes question management and grading commands.

2. `/link student_id name`
- Confirm student binding succeeds with an ephemeral reply.

3. `/me`
- Confirm the bound profile matches the previous step.

4. Student permission regression
- `/list`
- Confirm student is rejected.
- `/question id`
- Confirm student is rejected.
- `/ask prompt:幫我出一題資料庫正規化四選一題`
- Confirm student is rejected from question generation and does not receive any draft preview or create buttons.

5. `/add content`
- Teacher-only.
- Confirm question creation returns a question id.

6. `/add_short content rubric`
- Teacher-only.
- Confirm short-answer question creation returns a question id.

7. `/list`
- Teacher-only.
- Confirm the recently created question ids appear in recent results.

8. `/question id`
- Teacher-only.
- Confirm question detail rendering works for both multiple choice and short answer.

9. `/open id`
- Teacher-only.
- For multiple choice, confirm embed + A/B/C/D buttons are posted.
- For short answer, confirm embed + "提交短答" button are posted.

10. Student multiple-choice answer
- Click one answer button.
- Confirm ephemeral result shows correctness, explanation, and personal stats.

11. Student short-answer submission
- Click "提交短答".
- Submit text through modal.
- Confirm ephemeral success reply.

12. `/check id`
- Teacher-only.
- Confirm multiple-choice stats or short-answer grading link is correct.

13. `/grading_queue`
- Teacher-only.
- Confirm pending short-answer questions appear with grading links.

14. `/grade_link id`
- Teacher-only.
- Confirm a valid grading deep link is returned.

15. `/rank`
- Confirm ranked users, score, total answered, and accuracy are sensible.
- Pending short answers must not distort ranking.

16. `/ask prompt`
- Student prompt example: `我目前答對幾題？`
- Confirm student Q&A works for read-only classroom help and personal stats.
- Teacher prompt example: `幫我出一題資料庫正規化四選一題`
- Confirm teacher question generation returns a non-empty draft with category, content, 4 options, answer, and explanation.

17. `/batch_generate prompt count`
- Teacher-only.
- Confirm draft preview returns multiple questions and can be approved/discarded.

18. `/clear_memory`
- Confirm agent memory and pending drafts are cleared for the current channel.

## Regression Focus

- Student must not use `/list` or `/question`
- Student `/ask` must not enter question-generation flow
- Teacher permission gating on `/add`, `/add_short`, `/open`, `/check`, `/grading_queue`, `/grade_link`, `/batch_generate`
- Pending short answers do not count toward ranking or personal correctness stats
- Discord channels used by the bot create or refresh `groups.group_id = channelId`
- Group-linked channels update `groups.current_question_id` when `/open` is used
- Group-linked answers populate `quiz_responses.group_id`

## Failure Notes

- If command list is stale, restart the bot and wait for slash command registration.
- If grading links are wrong, verify `FRONTEND_BASE_URL`.
- If rankings look inflated, inspect `quiz_responses.status` and confirm pending short answers are excluded.
