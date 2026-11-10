# Voice turn-taking: evidence before choosing a delay

Research date: 2026-11-10. Status: research and proposed evaluation only; no product or model setting changed. Scope: an English voice companion used by Korean learners; reported symptom is the AI taking the floor while the learner is still thinking. This is a targeted primary-source review, not a systematic review. Searches covered L2 pausing, conversational floor transfers, endpoint detection, fixed thresholds, and explicit floor control. Full methods were inspected for sources 2–5; source 1 is limited to the publisher's abstract. No target-user observations or participant results were collected for this project.

## Decision supported now

There is evidence to treat silence as ambiguous and to measure interruption and waiting separately. There is **no evidence here that 2,000 ms is an optimal learner delay**, that every L2 learner needs the same delay, or that OpenAI semantic VAD improves Korean learners' comfort or learning. Context-sensitive endpointing and an explicit way to retain/yield the floor are reasonable prototype candidates, with different tradeoffs. Neither is a validated replacement default.

First diagnose the reported event. A mid-utterance word-search pause, silence before the learner's first word, and a completed clause followed by an intended continuation are different cases. A speech-stop delay only addresses an acoustic endpoint; it cannot directly observe whether someone has finished thinking. Count an audible takeover as an error only after reviewing the turn and the learner's intended continuation; overlap alone is insufficient.

## Evidence ledger

### 1. L2 pauses can occur inside a message

**Tavakoli (2011), “Pausing patterns: differences between L2 learners and native speakers.”** Peer-reviewed primary observational comparison, *ELT Journal* 65(1), 71–79. [DOI / publisher](https://doi.org/10.1093/elt/ccq020).

Method/sample: picture-story narration by 40 English L1 speakers and 40 English L2 learners; compared pause frequency and silence within versus at the ends of clauses. Finding: L2 speakers paused more and had more silence overall; frequent mid-clause pausing particularly distinguished them. Applicability: an unfinished learner message can contain a silent pause. Limitations: monologic narration, not human–AI conversation or a test of endpoint settings; only the publisher abstract was accessible in this review. It supplies neither the relevant pause-duration distribution for our users nor a safe cutoff.

### 2. Actual L2 conversation does not simply have longer gaps

**Sørensen, Fereczkowski & MacDonald (2021), “Effects of Noise and Second Language on Conversational Dynamics in Task Dialogue.”** Peer-reviewed primary repeated-measures experiment, *Trends in Hearing* 25, published 2021-06-30. [DOI](https://doi.org/10.1177/23312165211024482); [full text and methods](https://pmc.ncbi.nlm.nih.gov/articles/PMC8256248/).

Method/sample: 40 young Danish speakers in 20 familiar pairs completed spot-the-difference tasks in Danish/English and quiet/noise, with three repetitions per condition and mixed-effects analysis. All were comfortable in English and had taken a university class in it. Finding: English L2 speech was slower and task completion took longer, but median floor-transfer offsets decreased slightly; their variability increased slightly. Turns/interpausal units became longer. This is counterevidence to assuming “L2 means longer between-turn gaps.” Limitations: relatively proficient, familiar, young Danish pairs, constrained task, not Korean beginners or AI. Acoustic segmentation and floor transfer are not direct labels of interrupted thinking.

### 3. Fast L1 human exchange is a description, not a learner timeout

**Stivers et al. (2009), “Universals and cultural variation in turn-taking in conversation.”** Peer-reviewed primary cross-language corpus study, *PNAS* 106(26), 10587–10592, 2009-06-30. [DOI](https://doi.org/10.1073/pnas.0903616106); [paper PDF](https://cognitionandculture.net/wp-content/uploads/pnas.0903616106.pdf).

Method/sample: 101 natural conversations across 10 languages, including Korean; 350 consecutive questions were collected per language, with analysis restricted to functional yes/no questions. Responses could include gestures. Finding: modal transitions clustered within 0–200 ms; response function and nonverbal context also affected timing. Applicability: timing depends on conversational action and context. Limitations: human conversation, predominantly simple questions, visible cues and familiar social norms; not L2 English practice or an endpointing intervention. A modal **gap between completed turns** is not a maximum allowable **pause inside one turn**. Importing its 200 ms into VAD would confuse these quantities.

### 4. Feature-dependent endpointing has empirical support, with domain limits

**Raux & Eskenazi (2008), “Optimizing Endpointing Thresholds using Dialogue Features in a Spoken Dialogue System.”** Peer-reviewed primary system/corpus study, SIGDIAL, pp. 1–10, June 2008. [DOI](https://doi.org/10.3115/1622064.1622066); [paper and PDF](https://aclanthology.org/W08-0101/).

Method/sample: 1,326 real bus-information phone dialogues / 18,013 user turns; feature-dependent threshold trees evaluated with 10-fold cross-validation against fixed thresholds. Finding: up to 24% offline latency reduction at matched false-alarm conditions; semantics and timing were informative. A randomized live deployment also reduced median response latency, while open questions could receive longer waits. Limitations: constrained bus requests, old ASR/VAD, no L2 characterization; imperfect heuristic correction of interrupted turns, and latency does not establish user experience or learning. The live-evaluation participant/call count is not supplied in the inspected section. This supports testing contextual decisions and the cut-in/latency tradeoff; it does not validate OpenAI's classifier or a particular timeout.

### 5. Explicit floor control changes the interaction

**Fernández, Lucht, Rodríguez & Schlangen (2006), “Interaction in Task-Oriented Human–Human Dialogue: The Effects of Different Turn-Taking Policies.”** Peer-reviewed primary between-group experiment, IEEE/ACL Spoken Language Technology Workshop. [DOI](https://doi.org/10.1109/SLT.2006.326791); [author PDF](https://staff.fnwi.uva.nl/r.fernandezrovira/papers/P2T_SLT_final.pdf).

Method/sample: 20 German L1 adults, 10 pairs reconstructing a puzzle remotely; five pairs used open audio, five used half-duplex push-to-talk. Finding: push-to-talk produced fewer, longer turns and more silence, without a task-completion-time penalty in this small study. Limitations: different people in each condition, only five dialogues per condition, human German task dialogue; no L2 comfort or learning outcome. A hold/yield control offers deterministic agency, but this study cautions that imposing it can reduce interactivity. Offer it as a candidate option, not a universal requirement.

## Current OpenAI capability check — engineering evidence only

Official, mutable documentation checked 2026-11-10: [VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad) and [WebRTC create-call API reference](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create). These describe available behavior, not controlled human-effects evidence.

- `server_vad` uses silence; `silence_duration_ms` changes acoustic speech-stop detection. `threshold` changes activation sensitivity, not thinking time. `prefix_padding_ms` preserves preceding audio.
- `semantic_vad` estimates completion from audio/words and varies the wait. `eagerness: low|medium|high|auto` is available; `auto` equals `medium`. The reference gives maximum timeouts of 8/4/2 seconds for low/medium/high. These are **maximums, not guaranteed minimum thinking windows**; a high completion score can end a turn sooner.
- `create_response: false` disables automatic response at VAD stop. `interrupt_response` separately governs cancelling an existing response when speech starts. Null turn detection supports manual turn/response management. The client must manage the audio buffer and response trigger correctly.
- `idle_timeout_ms` can trigger a follow-up and is separate from endpointing. It must not silently defeat an explicit hold.

Generic API documentation does not prove this app's exact `gpt-realtime-2.1-mini`/WebRTC session behavior. Before using a candidate, verify the effective `session.updated` configuration, event sequence, audio retention, and interruption behavior in an isolated integration check. Selecting or deploying a replacement also requires a matched human-audio comparison on that exact model and transport; generic endpointing papers and developer fixtures cannot supply that result. This research made no authenticated API/model calls.

## What can be designed, and what remains gated

The existing [release note](../call-experience-improvements-20261110.md) documents `server_vad`, `threshold=0.5`, `prefix_padding_ms=300`, `silence_duration_ms=2000`, and automatic response/interruption enabled. This is the comparison baseline, not an empirically validated prescription. This review did not verify runtime configuration.

| Candidate | Rationale supported by evidence | Unvalidated decision |
| --- | --- | --- |
| Keep automatic listening, compare semantic completion | Pause duration alone loses context; feature-dependent endpointing can improve tradeoffs | Whether semantic VAD helps this model, accents, proficiency range and task; eagerness/default |
| Explicit “still thinking” / “your turn” control | Can represent floor intention directly rather than infer it from silence | Wording, discoverability, tap/hold mechanics, cognitive/motor burden, when to enable it |
| User-selectable waiting preference | People and tasks vary; allows a reported need to be expressed | Preset values, labels, persistence, preference stability and learning benefit |
| Repair and visible listening state | Makes a mistaken takeover recoverable and inspectable | Exact interaction, state accuracy and whether users understand it |

Supported next work is a reviewable prototype specification and event/measurement design. A prompt asking the AI to be patient cannot itself change VAD. No reviewed paper justifies a new numeric silence threshold, an adaptive threshold formula, a proficiency-based rule, an automatic “help” delay, or a universal default. Do not label any of them evidence-based until evaluated with the intended users.

## Executable comparison and stopping gates

**Present gate: target users are unavailable; efficacy and default selection remain blocked.** Documentation, event fixtures and interaction prototypes can be reviewed now. They cannot establish comfort, willingness to speak, or learning. Do not substitute developer roleplay or synthetic pauses for participant outcomes.

1. **Freeze the comparison.** Retain current fixed 2,000 ms as A; define B as semantic VAD with a declared eagerness; define C as explicit hold/yield with automatic response suppressed while held. Treat each added fixed threshold as a separate, preregistered candidate. Hold voice, model, question style, audio device and task constant. Record effective settings, not merely requested settings.
2. **Run engineering fixtures first.** Test mid-clause silence and filled pauses, complete-clause continuation, delayed first word, noise, rapid resumption, intentional barge-in, double yield, hold during pending response, reconnection and end-call. Assert no automatic assistant speech while hold is acknowledged; one deliberate yield triggers at most one response; speech and conversation context are retained; cancellation leaves playback and conversation state consistent. Passing is technical readiness only. Any lost speech, stuck hold, or speech during an acknowledged hold stops the candidate for repair.
3. **Recruit and counterbalance when available.** Use consenting Korean L2 English users across intended proficiency and comfort levels, including the original reporter if willing. Within-person, counterbalance A/B/C and task order using equivalent open-ended and short-answer topics. After practice, collect natural speech plus retrospective identification of moments the learner intended to continue. Predefine sample size from precision/power and feasible recruitment; do not invent a sufficient N.
4. **Measure the intended behavior.** Log monotonic timestamps for speech start/stop, response creation, first audible assistant audio, cancellation, hold/yield and recovery, joined by session/turn IDs. In an evaluation with appropriate consent, align audio with user-marked turn intent. Primary: premature takeovers / intended learner turns and false cut-ins / annotated within-turn pauses, plus turns abandoned after takeover. Secondary: pause length/location before takeover, false interruption/noise events, successful continuation/recovery, end-to-first-audio latency after an annotated true turn end (median and tail), audible overlap, intentional barge-in success and time until assistant audio stops, hold use/errors, and post-condition reports of time to think, pressure, control and preference. Report per-user distributions and proficiency/task slices; raw counts alone confound exposure. Provider `speech_stopped` is an endpointing decision, not the gold human turn end or a label of thought completion.
5. **Choose only against predeclared criteria.** Before recruitment, register the meaningful interruption reduction, acceptable latency/burden deterioration, uncertainty analysis and sample/precision stopping rule with the product owner; these values are currently **unset**, not research-derived. Continue only if the candidate meets those criteria, avoids unresolved qualitative failure cases, and preserves reliable turn control. If confidence is insufficient or gains rely on a problematic subgroup, retain the candidate as unvalidated and investigate. Preference without a learning test supports comfort claims only. Learning claims require a separate longitudinal study.

Research conclusion: enough evidence to reject the assertion that a universal 2-second pause is proven; enough to compare context-sensitive endpointing and optional explicit control. Insufficient evidence to select a replacement default or claim improved learning.
