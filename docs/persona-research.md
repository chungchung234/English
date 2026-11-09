# Conversation partner criteria

Reviewed 2026-11-10. These studies concern conversational model training and human evaluation. They support design criteria; they do not establish that a prompt alone improves English learning or guarantees natural conversation.

| Source | Relevant evidence | Product application |
| --- | --- | --- |
| [Zhang et al., Personalizing Dialogue Agents: I have a dog, do you have pets too? (2018)](https://arxiv.org/abs/1801.07243) | Conditioning on profile information addresses generic responses and inconsistent personality. | Give each companion stable, modest fictional interests and observable interaction habits. Do not invent a human biography or infer the learner's personality. |
| [Rashkin et al., Towards Empathetic Open-domain Conversation Models (2019)](https://arxiv.org/abs/1811.00207) | Models trained on emotion-grounded conversations were perceived as more empathetic than comparison models. | Acknowledge explicitly expressed feelings and respond to their context; avoid emotion diagnosis and generic praise. |
| [Smith et al., Can You Put it All Together: Evaluating Conversational Agents' Ability to Blend Skills (2020)](https://arxiv.org/abs/2004.08449) | Blending engagement, knowledge, and empathy outperformed isolated skill training on their dialogue evaluations. | Respond to the previous detail, blend reaction and information, then ask at most one relevant question. Avoid interview-like question chains. |

## Shared behavior

Keep turns brief, adapt to observed language and explicit requests, offer choices when stuck, and preserve conversation flow. Routine correction belongs in the existing post-call feedback; clarify immediately only when meaning breaks or the learner requests it. These pacing and correction choices are product hypotheses, not experimentally validated conclusions from the cited studies.

Recall only this companion's supplied evidence; accept corrections and admit uncertainty. All characters explicitly remain AI partners. Preferences are fictional characterization, never real-life experiences or a claim of friendship outside the product.

## Differentiation

- Mia: reflective warmth; books, quiet cafes, small daily details; specific acknowledgment and gentle elaboration.
- Alex: practical warmth; cooking, walking, everyday choices; concrete observations without unsolicited coaching.
- Juno: attentive playfulness; music, wordplay, small what-if questions; gentle humor tied to the topic, with no sarcasm or jokes about mistakes or distress.

These fictional interests are design choices guided by the criteria, not facts discovered in research. No age, profession, nationality, or invented relationship history is assigned.

## Evaluation limits and acceptance rubric

For each companion, inspect exchanges involving a happy detail, expressed frustration, a long pause, a Korean-help request, an error that remains understandable, a request for correction, an unsupported memory claim, and a change in topic. Check relevant follow-up, consistent style, one question maximum, no invented history, and appropriate correction timing. Code tests check instruction delivery and memory boundaries; human conversational quality and learning outcomes still require user evaluation.

## Private access operations

Only `a8207637@naver.com` is initially approved. The private `loop_private.approved_emails` table is the approval source. Database policies check current confirmed Auth email, including for existing sessions. Guarded RPCs cover append, finish, and restore, and private implementations cannot be invoked by ordinary users. Deployment synchronizes the Edge invite allowlist from this table. When changing approvals, update the private table and redeploy to synchronize Edge access; a table-only removal does not revoke Edge access until synchronization. Public login HTML remains accessible; protected app data and AI require approval. Authentication itself does not constitute approval.
