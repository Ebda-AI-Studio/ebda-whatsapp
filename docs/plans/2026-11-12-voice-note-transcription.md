# Voice-note transcription for Ebda Chat (2026-11-12)

Today the AI agent answers text only; an inbound voice note gets a "text only" note. Goal: transcribe it (Arabic incl. Egyptian dialect, English) and feed it to the agent exactly like a typed message.

## Finish line
- **Must work:** an inbound `audio` message on an agent-enabled workspace is transcribed with Workers AI `@cf/openai/whisper-large-v3-turbo` (docs: developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo, input `audio` = base64, optional `language`, output `text`; $0.000513 per audio minute). The transcript is stored in the message's own `body`/`preview` (same search, retention, erasure and backup path as text), the agent answers it like a text turn (handoff phrases, turn cap, credits, reply guard all apply), the reply goes out.
- **Pipeline:** the existing `media_fetch` task already stores the audio in R2 (existing media path, nothing new persisted). The agent turn reads it from R2 (retries until it is stored); no new download code, token handling untouched.
- **Caps (fail polite):** over 2 min or over 5 MB, or the store's daily cap (default 60, var `VOICE_DAILY_CAP`) reached: no AI call, Egyptian-Arabic reply asking for text. Duration comes from the Ogg/Opus last-page granule; unreadable audio is estimated from size.
- **Fail-closed:** any transcription failure (model error, empty text, media never stored) -> reply asking the customer to type + inbox shows "voice note (not transcribed)". Never silent.
- **Idempotent:** `messages.voice_state` (new DO migration) is the once-marker: a webhook retry or a replayed task never calls the model again for the same wamid; finished turns are already guarded by `agent_turns`.
- **Cost:** audio minutes x `AI_STT_PRICE_USD_PER_MIN` x FX added to the turn's cost in the existing AI cost average/alert and the Analytics Engine row.
- **UI:** the inbox shows the transcript under the voice note with a "transcript" mark, or "voice note (not transcribed)".
- **Logging:** no token, audio or transcript text in any log; alert `voice_transcribe_failed` (P1, runbook) carries an error class only.
- **Must NOT change:** text/image/ordering-bot flow, video/document "text only" note, send pipeline, billing credits per turn (a voice turn costs one credit like a text turn), shopper copy names no provider.
- **Done =** touched tests green (new tests fail on old code, proven by revert), `npm run typecheck` exit 0, lint (none configured: stated), docs updated, PR open (not merged). Not provable offline: real whisper on real WhatsApp ogg/opus and Egyptian-dialect accuracy.
