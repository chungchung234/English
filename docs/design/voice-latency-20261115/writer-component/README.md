# Observed writer cache layout result

The predeclared candidatefixture2 cache criterion passed. Actual cached input tokens: 1083; minimum1024. This mechanism observation does not alone establish a timing benefit or deployment decision.

| Fixture | Order | Baseline full completion | Candidate full completion | Candidate minus baseline |
| --- | --- | ---: | ---: | ---: |
| fixture_1 | baseline → candidate | 2817.9 ms | 1524.4 ms | -1293.5 ms |
| fixture_2 | candidate → baseline | 2014.8 ms | 2256.2 ms | 241.3 ms |

| Fixture / condition | Input | Cache read | Cache write | Output | Reasoning |
| --- | ---: | ---: | ---: | ---: | ---: |
| fixture_1 / baseline | 2825 | 0 | 2733 | 84 | 37 |
| fixture_1 / candidate | 2826 | 0 | 1083 | 50 | 0 |
| fixture_2 / candidate | 2906 | 1083 | 0 | 53 | 0 |
| fixture_2 / baseline | 2905 | 0 | 2733 | 46 | 0 |

All four actual writer calls completed; unknown generation upper bound0 and readers0. Instruction/request semantics were identical within each pair. The temporary function was deleted and the controller independently observed metadata absence. No DB, account, microphone or production coach/settings operation occurred in this experiment.

The blind judgment was saved before this unblind and pinned as ceb0183a63d857b791b9c291a965f2c935e72237f3e8bf37f4704722c7e2e35c. After root authorized unblinding, the label/mapping join confirmed24PASS,0CONCERN and0FAIL across four outputs and six dimensions, with no obvious regression. No generated text, hidden reasoning, private mapping or judgment quotations are exported here.

The result is eligible as a behavior-preserving cache-efficiency fix, alongside separately tested scoped RPC parallelism. Timing was mixed: the first candidate was faster without any cache read, while the second candidate was slower despite a cache hit. Reasoning/output token differences and provider variance remain confounders. This is not a demonstrated end-user latency solution; these calls did not benchmark RPC or a complete call.

AB/BA and four observations cannot remove shared cache/order/service/network variance or establish a user/full-call SLO. A cache hit and favorable timing are separate observations; baseline cache reads may make relative layout benefit inconclusive. Small-n blind review is not proof of broad quality equivalence. No additional request or retry was made. Original results, claims, generated text and private review remain unchanged.

observed-summary.json preserves all four timing/token/cache observations and limits. cleanup-verification.json uses existing journal/result evidence without a fresh API request. safe-result.json is an exact copy of the original experiment result, which predates later quality interpretation.
