# Ruling WA-WS-MEDIA-1 (audit 2026-11-12, WA-5 + WA-6; foundation PR #28 live-state-beats-token-claims)

- **WA-5** The Meta bearer token is attached only to an https URL on a Meta media host (`fbsbx.com`, `fbcdn.net`, `whatsapp.net`, `facebook.com`, no port, no userinfo); otherwise `downloadToR2` throws before any request. Cost if wrong: a new Meta CDN host makes inbound downloads fail loudly (retried, alerted) until added to `META_MEDIA_HOST`.
- **WA-6** Socket lifetime is capped at 600 s, the upgrade is session-checked, and a 60 s `ws_sweep` closes revoked sessions and removed members (4403). Ruling: a sweep whose Store/accounts check is `unavailable` keeps the socket (the cap bounds it) rather than mass-closing on a blip. Cost if wrong: a removed member could keep a stream up to 10 min during a Store outage.
- **WA-3 Chat half** skipped: ebda-store PR #640 states the Store has no caller verification yet, so a signed call has nothing to be checked against.
