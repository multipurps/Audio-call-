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
Admin tab **Call Emysa** opens the normal Emysa call screen in training mode (`/?trainer=1`). It is the same screen, mic, audio and live transcript users get.
- Runs the raw Emysa on the latest **draft** guidance and draft knowledge (`sql/042_ai_trainer.sql`). No user memory, profile, contacts or saved voice settings.
- **She learns by herself.** While the call runs (every 15 s) and once more when it ends, the app calls `ai-train-learn`. The server reads the new transcript lines and asks Luna for the lasting lessons the trainer taught. Each one is saved as a **draft** note tagged `from-training-call`. Existing drafts are updated instead of duplicated, a lesson that would change a published note becomes a new draft that says what it replaces, and anything that looks like a secret is dropped.
- New memories are used from the **next** training call (instructions are fixed when a call starts).
- Review: the tab lists what she learned; edit, delete, publish one, or publish all. The Knowledge tab shows the same notes. Users only get a memory after it is published.
- Not billed (`sql/043_training_calls_free.sql`: the minutes trigger skips `to_number = 'Emysa training'`), no call summary (platform `app` calls are skipped by the summary code), never treated as a briefing.
- Auth: `ai-train-call-start` and `ai-train-learn` are admin only. The start action signs a `trainercall:` token; the voice service only treats a call as training after verifying it.
- Engine: GPT-Live by default; the Advanced link runs the Luna (custom-voice) path. Both read the same memories.
