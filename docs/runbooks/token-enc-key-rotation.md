# Rotating TOKEN_ENC_KEY (M-173)

`TOKEN_ENC_KEY` encrypts every merchant's Meta business token (`waba_credentials.token_enc`) and every number's registration PIN (`phone_numbers.pin_enc`), and
derives the InstaPay proof-link signing key. Rotate it on a schedule you decide (at least yearly), after any suspected exposure, and when a person who held it leaves.
`AGENT_SECRETS_KEY` (merchants' own model keys) is a different key with its own procedure; this one does not touch it.

How it stays safe: **writes** always use `TOKEN_ENC_KEY`; **reads** try `TOKEN_ENC_KEY`, then `TOKEN_ENC_KEY_PREVIOUS` when it is set. So there is never a moment when a credential
cannot be opened. A read that needed the previous key re-encrypts that row under the new one on the spot; the operator route finishes the rest.

## Procedure
1. Generate the new key locally (never in chat or git): `node -e "console.log(crypto.randomBytes(32).toString('base64'))"`.
2. `npx wrangler whoami` must show the personal account. Then, in this order:
   - `npx wrangler secret put TOKEN_ENC_KEY_PREVIOUS` and paste the CURRENT (old) key.
   - `npx wrangler secret put TOKEN_ENC_KEY` and paste the NEW key.
3. Deploy (or redeploy) so the Worker picks up both. `node scripts/verify-prod.mjs --base https://<host> --expect <tip of main>` must end VERIFIED (`/health` 200: both keys are checked for shape; the names appear only in the alert line, never the values).
4. `GET /api/v1/operator/token-key/status` (super admin). Expect `previousKeyConfigured: true`. `onPrevious` is the number of rows still on the old key; `unreadable` must be 0 (a row no key opens is a lost credential: stop and read "If something is unreadable").
5. `POST /api/v1/operator/token-key/rotate` with `{ "batch": 500 }`, repeatedly, until the answer has `"complete": true`. If an answer has `"truncated": true`, call again with `{ "cursor": "<nextCursor>" }` to continue the walk; a pass that stops at its budget never reports complete.
6. Confirm with `GET .../token-key/status`: **`complete: true`** (every row examined, none on the old key, none unreadable). Only that value permits step 7. `onPrevious: 0` alone is not enough: it is a count of one pass.
7. `npx wrangler secret delete TOKEN_ENC_KEY_PREVIOUS`, redeploy, and run verify-prod again. Send one message from an own-number workspace and confirm it reaches Meta.
8. Destroy the old key everywhere it was kept (the password manager entry, any terminal history). Record the date here: ______

## If something is unreadable
`unreadable > 0` means a ciphertext opens under neither key: a restore from a backup older than a previous rotation, a damaged value, or a credential copied between workspaces (the workspace id is part of the encryption). Do NOT retire the old key. Find the rows (`wrangler d1 execute ebda-wa-platform --remote --command "SELECT waba_id, workspace_id FROM waba_credentials"` and compare with the status counts per pass), ask the merchant to reconnect that number (Embedded Signup writes a fresh credential), and run status again.

## If the old key was retired too early
Put it back: `npx wrangler secret put TOKEN_ENC_KEY_PREVIOUS` with the old value, redeploy, and every credential opens again. This is why step 8 comes last.

## Tests
`test/token-key-rotation.test.ts`: old-key credential opens with the previous key listed, is unreadable (never the platform token) without it, lazy re-encryption, workspace binding, proof links, the operator routes, and 5,001 rows with the last one on the old key reading NOT complete.
