# Phase 3: imported WhatsApp history -> reviewed per-contact memory

The raw conversation is **never** put in a live call's prompt. A chat is mined for
candidate memories the user reviews; only approved ones reach the call.

```
WhatsApp export (.txt / .zip, with or without media)
  -> private storage (original kept as the source reference)
  -> parser (lib/whatsappParser.js)          participants, messages, dates
  -> contact identification                  phone number first, then exact name
  -> memory extraction (lib/contactMemory.js)  candidate memories, validated
  -> user review in the app                  approve / edit / reject / delete
  -> contact_memories (Supabase)             approved + edited are usable

Call:  caller id -> normalise number -> that user's contact -> approved memories
       (+ up to 3 short retrieved snippets when a query is given) -> GPT Live
```

## Setup

1. Run `sql/026_contact_memory.sql` in the Supabase SQL editor **before deploying**
   (it enables `pgvector`, adds the tables, RLS, functions and the private
   `whatsapp-imports` bucket; safe to re-run; needs Postgres 15+).
2. Optional env (Vercel): `CONTACT_MEMORY_MAX_WINDOWS` (default 12 chunks per run),
   `OPENAI_API_KEY` or `EMBEDDINGS_API_KEY` for semantic search
   (`CONTACT_HISTORY_EMBEDDINGS=off` disables it), and an LLM key already used by
   Emysa for extraction. Without an LLM key a small rule-based extractor runs instead.
3. For inbound WhatsApp calls the relay asks
   `GET /api/memories?scope=contact&action=contact-context&caller=<jid or number>&userId=<uid>[&query=...]`
   with header `x-internal-secret` (same secrets as the other relay callbacks).
   The Python call assistant also resolves it itself from the call row's number.

## Isolation

* Every row has `user_id`; RLS allows only `auth.uid() = user_id`.
* **Composite foreign keys** `(contact_id, user_id) -> contacts(id, user_id)` mean a
  row can never be attached to another user's contact, even by code using the
  service role (which bypasses RLS).
* Lookup functions take `user_id` and `contact_id`, pin `user_id` to the session user,
  and are not executable by `anon`.
* The API filters every query by the signed-in user; the Python call service pins
  every query to user and contact and re-checks each returned row.
* Tests: `tests/rls.test.mjs` runs the real migration on a real Postgres (needs `psql`;
  skipped when none is reachable), `tests/contact-memory.test.mjs` (API isolation),
  `pipecat-service/tests/test_contact_memory_context.py`.

## Limitations

Timestamps are the export's local time stored as UTC, group chats analyse only the two chosen people,
media is counted but never read, WhatsApp `@lid` caller ids carry no number and cannot
be matched, matching needs full international numbers, and live-call retrieval of
history snippets is available through the endpoint but is not yet a mid-call tool.
