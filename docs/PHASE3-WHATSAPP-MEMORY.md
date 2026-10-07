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

## Reference repositories: what they actually are

| Repo | What it demonstrates | What was reused |
|---|---|---|
| samirsalman/whatsvector | One iOS-only bracket format, 2-digit year, 24h. Multi-line messages are dropped. One Qdrant vector per message, an agent with a search tool. No zip, no memories, no review, one user. | The idea of embedding "who / when / what" together and merging messages into larger chunks (its own TODO). |
| AkhshanAchu/Whatsapp-RAG-v2 | Streamlit app for one iOS format; local pandas, sentence-transformers, TF-IDF and pickle caches; local Ollama. One chat, no database, no auth. | Media/call-line classification, and the keyword plus semantic hybrid idea. Nothing else (pickle caches are unsafe for user uploads). |
| visheshkhurana/chatvault-ai | Closest to our stack: Supabase, pgvector, Android and iOS regexes, contact memory table with confidence. But contacts are created from display names, message ids can collide, dates are assumed day-first, tenant isolation relies on passing `p_user_id` to functions through the service role, and memories have no review status. | The table/function shape for pgvector search and the idea of a per-contact memory table. The isolation, matching and review model here is different on purpose. |
| AtharvaMaik/COPYHERR | Persona fine-tuning: a pronoun/keyword regex picks "lore" lines from an Android export. Not a memory system. | Nothing. Cloning someone's personality from their messages is not what this feature does, and a keyword regex is the "every sentence is a fact" mistake this design avoids. |

None of them is a production implementation for Emysa.

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

See the final report in the pull request / chat; the important ones: timestamps are
the export's local time stored as UTC, group chats analyse only the two chosen people,
media is counted but never read, WhatsApp `@lid` caller ids carry no number and cannot
be matched, matching needs full international numbers, and live-call retrieval of
history snippets is available through the endpoint but is not yet a mid-call tool.
