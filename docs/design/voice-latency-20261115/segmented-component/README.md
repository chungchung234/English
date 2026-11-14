# Observed segmented speech result: negative

The fixed experiment did **not** demonstrate a first-audio improvement. The
segmented condition reached native postgain nonzero at3230.6ms; whole response
reached it at2714.9ms. Segmented was515.7ms slower. The frozen requirement was
at least500ms earlier, so adoption_supported is false. No retry was performed.

| Component observation | Segmented | Whole |
| --- | ---: | ---: |
| First native postgain nonzero | 3230.6ms | 2714.9ms |
| First verified part, server-relative | 2136.7ms | 1891.5ms |
| First part receipt, browser-relative | 3149.3ms | 2617.2ms |
| Transport EOF, browser-relative | 5538.1ms | 2602.0ms |
| Output tokens | 328 | 282 |
| Total source audio duration | 11972.5ms | 11794.5ms |

Incremental delivery worked: the first signal arrived while later parts and the
transport body were still pending. The second part reached the browser at4531.3ms,
after the3230.6ms first signal. Every next native part was ready before the prior
render end; no source starvation was observed.70.1/71.2ms native message boundary
gaps were recorded; they are not acoustic silence measurements or a gapless claim.

All unchanged189-byte text/part/PCM/usage/full-EOF/strong full-playback guards
passed. Four reader generations completed (three segmented, one whole), zero
writers were invoked, and unknown generation upper bound is0. One temporary
function was deleted and the controller independently observed metadata absence.
Each fresh browser used one real PCM AudioContext; connected native nodes never
exceeded two. Contexts/ports closed, connected nodes returned to0 and owned
reference tracks ended. No production coach/settings, DB, account or microphone
operation occurred in this experiment. Raw PCM, transcripts, claims and exact
original result remain private and unchanged. The previous six-run experiment
also remains unchanged.

This is one fixed canonical-ready synthesis/transport/playback comparison, in the
fixed order segmented then whole. Cold function/cache/order/provider/network
variance remain confounded; different speech realizations and the passive native
observer/transport tee can affect results. The server segmented text marker is
after reader READY plus a source fixture guard (1163.8ms); whole text is emitted
before its reader setup (8.4ms). Those text offsets describe different phases and
do not isolate a causal setup regression. Browser/server/audio clock domains are
kept separate. No raw provider-generation completion, full-call/ASR/user-latency,
perceptual quality or physical-hearing claim is supported. This result does not
support activating the candidate as a demonstrated speed improvement.

observed-summary.json preserves exact numeric values and method limits.
cleanup-verification.json uses existing controller/journal evidence, without a
fresh management/API request. original-artifact-hashes.json records the retained
originals; safe-result.json is an exact copy of the original safe result.
