---
capabilities:
  - access.integrator-tokens@1
  - agent.connectors@1
---

# Connect Ebda Chat to your systems: the API and agent connectors

This guide is for a store owner who has a developer or a system (such as Odoo). Open **Connect systems** in the side rail (owner only). It has two parts: **Agent connectors**, which you set up there yourself, and **Call the API from your server**, which explains the permissions and takes you to your account settings where the token is made. Full technical detail is on the Ebda Chat developer pages (HTTP API, and Webhooks and connectors).

## 1. The API for your server
- Available on the Ebda Chat packages that include the API feature (today the **Pro** package). That is the name of an Ebda Chat package, not your store's plan in Ebda AI Studio: your store plan (for example "Business") shows in the wallet under its own name.
- It is not live for every store yet: it is switched on for your store before use. To ask for it, write to ahlan@ebda.app.
- Only the store owner creates an "API client" in the Ebda AI Studio account settings (the **Open account settings** button on the Connect systems screen takes you there) and picks its permissions (read conversations, send messages, read templates, read and change customer tags, read campaigns). Your server uses it to get a token, valid for 10 minutes, from accounts.ebda.app.
- The server follows new messages by polling for events; there is no permanent connection for this kind of token.
- Any route outside the token's permissions is refused (403). If you revoke the client in your account, it stops working within about 30 seconds. Ebda Chat never stores or shows a token: creating, rotating and revoking happen in your account.

## 2. Connect the AI agent to your system (a connector)
If you want the AI agent to answer from your system's data (bookings, for example), you connect it with a **webhook** or with **Odoo**. Steps: **Connect systems**, then **Add a connector**; choose the type, fill in the address and the secret, and for a webhook paste the tools as JSON. Before it saves, you are asked to confirm: the screen names the host and the tools the agent will be able to call. Use **Test the connection** to check it, and **Delete connector** to remove it (it asks first).
- You describe up to 10 tools for the agent, each with up to 10 inputs.
- The address must be https on port 443, and calls are signed with HMAC so you can verify them on your side. The secret is written once and never shown again; when you edit a saved connector, leave the secret empty to keep it, unless you change the address (then enter it again). The secret must be at least 16 characters for a webhook and 8 for Odoo. A platform admin who is a member of your store can see the status of your connectors but cannot add, change or test them.
- There is a connector test, once every 5 seconds.
- A customer who asked to be erased or who stopped messages (STOP) never triggers a call.
- Internal or unsafe addresses are refused.
- Only the store owner can change connectors.

Read the [AI agent guide](07-ai-agent.md) first to understand what the agent can say.

---
Last checked: 2026-11-14.
