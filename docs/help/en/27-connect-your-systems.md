---
capabilities:
  - access.integrator-tokens@1
  - agent.connectors@1
---

# Connect Ebda Chat to your systems: the API and agent connectors

This guide is for a store owner who has a developer or a system (such as Odoo). **Ebda Chat has no screen for either today**: a developer sets them up, and this guide gives the picture. Full technical detail is on the Ebda Chat developer pages (HTTP API, and Webhooks and connectors).

## 1. The API for your server
- Available on the **Pro** package (the API feature).
- It is not live for every store yet: it is switched on for your store before use. To ask for it, write to ahlan@ebda.app.
- Only the store owner creates an "API client" in the Ebda AI Studio account settings and picks its permissions (read conversations, send messages, read templates, read and change customer tags, read campaigns). Your server uses it to get a token, valid for 10 minutes, from accounts.ebda.app.
- The server follows new messages by polling for events; there is no permanent connection for this kind of token.
- Any route outside the token's permissions is refused (403). If you revoke the client in your account, it stops working within about 30 seconds.

## 2. Connect the AI agent to your system (a connector)
If you want the AI agent to answer from your system's data (bookings, for example), you connect it with a **webhook** or with **Odoo**:
- You describe up to 10 tools for the agent, each with up to 10 inputs.
- The address must be https on port 443, and calls are signed with HMAC so you can verify them on your side. The secret is written once and never shown again.
- There is a connector test, once every 5 seconds.
- A customer who asked to be erased or who stopped messages (STOP) never triggers a call.
- Internal or unsafe addresses are refused.
- Only the store owner can change connectors.

Read the [AI agent guide](07-ai-agent.md) first to understand what the agent can say.

---
Last checked: 2026-11-14.
