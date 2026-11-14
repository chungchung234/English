# Observed paired prewarm reader result

The original six-generation run is preserved. Two fixed independent cases each
shared one canonical writer output between fresh reader WebSocket/session and
prewarmed reader arms. All six generations completed, all lexical/protocol/strong
output completion checks passed, and the temporary function was deleted with an
independent absence observation. No generation was repeated to obtain a win.

| Case | Fresh reader first nonzero | Prewarmed first nonzero | Observed difference |
| --- | ---: | ---: | ---: |
| Startup | 7706.3 ms | 7675.7 ms | 30.6 ms earlier |
| Reply | 7063.7 ms | 7052.5 ms | 11.2 ms earlier |

These tiny native differences do not demonstrate a meaningful conversational or
full-call latency improvement. Server verified clips were354.5/358.0ms earlier
and browser clip receipt719.9/1016.5ms earlier in the prewarmed arm, but those
intermediate marks cannot replace the first-nonzero endpoint. Prewarmed clip
receipt-to-admission took1117.5/1257.0ms versus466.1/247.9ms in the other arm.

Both arms ran concurrently in one browser process with two AudioContexts and
separate native post-gain observers. Main-thread processing, observer scheduling,
provider/network contention and different speech realizations can affect the
comparison. The marks reveal admission asymmetry, not a unique causal explanation.
There was no user utterance end, ASR, original application authentication/DB path
or physical listening in this experiment. Original hashes and cleanup witness
are in observed-summary.json and cleanup-verification.json; raw text/PCM/claims
remain private outside this safe folder.

A source audit also found that this original fixture decoded base64 with a
per-byte Uint8Array.from callback, while the product controller uses an indexed
loop. The fixture processing cost and dual-arm contention can obscure reader
transport gains. This is a method limitation, not proof of a unique cause. The
original controller, measurements and completion results remain unchanged.
