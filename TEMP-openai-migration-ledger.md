# Model/caching/cost migration — 2026-11-10

Authorization: implement and apply full model review; reuse existing deployed OpenAI key (user confirmed). Work completed together without a further approval gate. No key was copied out of Supabase.

Baseline: synced to remote 73d5f34 before final implementation. An initial deployment used an older local checkout; restored latest remote function immediately on discovery, then reapplied all changes on current code. Final source retains OAuth, approval gates, memory management/revisions/exclusions, hybrid embeddings, checkpoint chains and chunked analysis continuations.

Delivered roles:
- Realtime 2.1 Mini, low reasoning, 512 response tokens; Realtime Whisper with GA WebRTC/server VAD. Whisper $0.017/min is higher than the deprecated Mini Transcribe's approximate $0.003/min, explicitly documented.
- Luna for correction and checkpoint, low reasoning, 6,000 total output/reasoning tokens.
- Sol for weekly analysis, medium reasoning, 12,000 total output/reasoning tokens.
- Existing text-embedding-3-small 512D retained, preserving stored index compatibility.

Caching: independent parent/part results include model, reasoning, output policy, schema, scenario/source and policy version identity. Checkpoint prefix fingerprints its inference policy and preserves revision/previous handoff. Embedding query/index identity remains model/dimensions/revision/source aware. Responses developer instructions have an explicit breakpoint; changing transcripts are not cache-written. No new cache keys or extended retention. No suitable prior response chain for cache comparison diagnostics on independent reviews, so omitted. Live sample had zero cached/write input tokens; no prompt-cache discount claimed. Duplicate result/query tests showed no extra usage reservation.

Cost: server-only model_spend records cached input, cache writes, output and reasoning tokens, policy and estimated USD. Reasoning is already included in output charges. Usage missing/transport unknown remains null; failed/incomplete calls retain reservations. $1/user/UTC day conservative reservation budget, serialized in SQL across parent/part/checkpoint/embedding kinds. Existing count limits remain. Not a total provider hard dollar cap; browser audio usage is untrusted and not persisted as billing evidence. Voice actual charges remain provider Usage; production frontend retains its existing20-minute call limit.

API review: direct HTTP Responses integration retained; Standard synchronous processing. 35s per text model call fits existing90s client timeout with max2 uncached parts/request; existing600s leases/continuations retained. Flex/Batch/Reserved/Priority not introduced. store:false preserved, no ZDR or residency claim. Structured Outputs, source validation and Korean feedback preserved. No server state chaining, multi-turn encrypted reasoning replay/phase changes, compaction, streaming UI or tool/search/parallel/programmatic-tool changes needed for these independent requests; checkpoint application-level state retained. No third-party framework limitations.

Deployment: immutable202611100010 migration plus011 extending budget support to newer job kinds. Latest coach ACTIVE via official HTTPS source deployment (runtime credential placeholders fail CLI token-format validation). Deployment preserves/synchronizes existing DB approval source; tests use only disposable example.invalid users and restricted temporary functions with same global secrets. Cleanup removes temporary approvals/functions/users.

Verification: latest complete84 unit/SQL/security tests pass; check/build pass; complete browser suite passes (OAuth/approval, memory controls, direct calling, terminal/retry states, offline sync, reload, mobile layout and CSP). Focused edge44 tests pass after35s timeout change. Existing mocked voice tests do not claim live audio validation.

Live same-source verification: correction+checkpoint+weekly+embedding index/query all pass; duplicate correction/query creates no additional spend. Latest sample: checkpoint Luna729 input/440 output including113 reasoning, $0.0002929; correction Luna863/393 $0.0002828; weekly Sol967/554 $0.007474; embedding index144 tokens $0.00000288, query4 tokens $0.00000008. No billed usage printed with personal text or credentials. All disposable data cleaned.

Actual WebRTC probe: server SDP exchange succeeds. Browser media/data channel failed: connection=failed, ICE=disconnected, no provider error event or transcript. Live voice playback/transcription remains unverified in this execution environment; no claim that a full call passed. No quality/latency comparison superiority is claimed for the new models.
