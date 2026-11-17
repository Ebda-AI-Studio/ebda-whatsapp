# Ruling CHAT-AGENT-3

**Decision:** The agent knows the person. `getCustomerProfile` (proof-by-phone: the sender's verified number) gives first name, locale, default address and last 3 orders; it is rendered masked into the prompt, cached IN MEMORY for 15 min per workspace and customer (BOUNDED-stale: a name and a saved address change only when the customer or staff edit them), and dropped when an address is saved, an order is placed or the contact is erased. It is never written to `agent_state` (backed up, not swept per contact). Order status is never taken from it: the `order_status` tool reads the live order. The ordering flow offers "نفس العنوان بتاع المرة اللي فاتت؟" as two buttons when the default address is among the saved ones. Memory beyond 8 messages is ONE bounded extractive recap (<= 30 older rows, 100 chars each, 1200 in all, masked, inside the first customer turn's fence), with no extra model call.

**Evidence:** audit rows 9, 33-35; `test/chat-agent-context.test.ts` (customer memory: cache, drop, erasure, masking, failure), `test/chat-agent-address.test.ts`, recap tests.

**Cost if wrong:** a customer who changes their address outside the chat may be offered the old one for up to 15 min; an extractive recap can drop a fact in a very long chat (a model summary would cost a call per turn); the DO's in-memory cache is lost on eviction (one extra RPC).
