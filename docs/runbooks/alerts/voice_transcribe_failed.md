# voice_transcribe_failed (P1)
**Severity:** P1 look today
## What it means
Fires in src/core/ai/transcribe.ts when a customer's voice note could not be transcribed: the speech model call threw, or the AI binding is missing (`error: no_binding`), or the file never reached R2 before the turn was abandoned. Fields: `workspace`, `error` (an error class name only; never audio, transcript or token).
## Impact
That voice note is marked "voice note (not transcribed)" in the inbox and the customer is asked to type. No money moves and no AI credit is spent for the unheard note. One failure is normal (a corrupt file); a run of them is not.
## Check first
1. Search logs for `{"alert":"voice_transcribe_failed"...}` and note `error`.
2. `no_binding` on every workspace = the `AI` binding is missing from the deploy (also `binding_missing`); one workspace only = look at its recent voice notes.
3. Check Cloudflare Workers AI status and the model `@cf/openai/whisper-large-v3-turbo` (src/core/ai/transcribe.ts `STT_MODEL`).
## Fix
1. Staff answer the "not transcribed" conversations from the inbox (the audio plays there).
2. Provider outage: wait; nothing is replayed, customers type instead. Model removed or renamed by Cloudflare: change `STT_MODEL`, check the input shape on the model page, deploy.
## Verify it is resolved
A new voice note shows its transcript under the audio in the inbox and the alert stops.
## Related
docs/ai-agent.md; agent_model_failed; media_fetch_abandoned
