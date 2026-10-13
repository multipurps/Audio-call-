# Admin-controlled AI behavior and shared knowledge

Admin tab: **AI behavior** (`admin/aiBehavior.js`, API in `lib/aiBehaviorAdmin.js`, routed from `api/admin.js` as `?action=ai-*`).
Setup: run `sql/041_ai_behavior.sql` once in the Supabase SQL editor.

## What this is, and is not
This is versioned prompt configuration plus retrieval of approved knowledge. It does **not** train or fine-tune
GPT-Live (`gpt-live-1`) or Luna (`gpt-6-luna`), and adding an example never changes model weights. Fine-tuning
support for these specific models has not been verified; treat it as unavailable.

## One source of truth
`ai_config_versions` (one published version at a time, atomic publish and rollback), `ai_knowledge` (+ `ai_knowledge_history`),
`ai_audit_log`. All are service-role only. Runtimes call the single SQL function `ai_global_context(model, mode, query)`,
which renders the published behavior plus the few most relevant published entries (size-capped) as plain text.
Per-user memories (`memories`, contact memory) are untouched and never read by this system.

## Where it is applied
| Path | Model | File |
| --- | --- | --- |
| In-app and phone and social calls, default voices | GPT-Live | `pipecat-service/app/live.py` via `conversation.py` |
| Custom-voice and test-voice calls | Luna | `pipecat-service/app/pipeline.py` via `conversation.py` |
| Classic Node relay | Luna | `server/relay.js` |
| In-app text assistant | Luna | `api/assistant.js` |

Not covered: `server/patter-relay.js` (legacy Twilio Patter path) and `server-social/` (no prompt of its own; its calls run through the pipecat service).

## When changes take effect
- New calls: the next call after a publish (about 30 seconds of caching at most).
- Calls in progress: keep what they started with. GPT-Live locks session instructions by design (`live.py::lock_live_instructions`).
- Failure: if the fetch fails or nothing is published, calls use the built-in rules unchanged.
- Needs a redeploy: changes to the built-in rules in `conversation_policy.py`, or to how guidance is injected.

## Testing
The Test tab compares the published config with the proposed one on sample lines. Both models are tested as text
through Luna; this checks wording and rule-following, not audio, interruptions or GPT-Live voice latency.

## Model safety
The OpenAI Sol models (gpt-6-sol, gpt-6.1-sol) are hard-blocked. `lib/modelGuard.js` and `pipecat-service/app/config.py` swap any model name containing the token "sol" for the safe default before a request is built, whatever an env var or caller passes. Only gpt-6-luna and gpt-live-1 are used for conversation.

## Call Emysa (training call)
Admin tab **Call Emysa** starts a live call with the raw Emysa users will get, with the same call audio and a live transcript.
- Runs on the latest **draft** guidance and draft knowledge (`sql/042_ai_trainer.sql`, `p_use_draft`), so changes can be heard before publishing.
- Raw: no user memory, profile, contacts or saved voice settings. Not billed, no summary or push (platform `app`).
- Engine pick: GPT-Live (default voice) or Luna (classic path, default voice).
- Auth: `?action=ai-train-call-start` (admin only) signs a token under the `trainercall:` prefix; the voice service only treats a session as a trainer call after verifying it (`app/app_call.py::verify_any_app_call_token`).
- Teaching: mark an Emysa line Wrong or Good; it becomes a draft correction or example. Nothing is promoted automatically. Publish it in the Knowledge tab, or use "Save and publish".
- The call row is kept under the admin's own account as "Emysa training" so the transcript can be reviewed.
