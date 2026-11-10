# AI 영어 대화 학습과 언어 정책: 확장 문헌 검토

검토일: 2026-11-10 UTC. 범위: AI 대화 연습의 실제 언어 성과, 한국인 학습자에게의 적용 가능성, 영어 전용 연습과 모국어 지원의 관계. 기존 [언어 정책·ASR 검토](voice-language-and-asr.md)를 보완한다. 제품 코드·프롬프트·배포는 변경하지 않았다.

## 결론과 제품 결정

**AI 음성 대화는 영어 말하기 연습 기회를 넓히는 수단으로 채택할 근거가 있다. 다만 학습의 설계 단위는 “AI와 대화한 시간”보다 “학습자가 의도를 전달하고, 이해되지 않은 부분을 해결하고, 다시 표현한 경험”으로 잡는 것이 타당하다.** 말하기 특화 메타분석과 한국인 비교 연구가 긍정적인 방향을 보이지만 모든 말하기 하위 능력에서 같은 이득이 나오지는 않는다(A01, A05, A06). 이 결론은 해당 연구들을 종합한 제품 설계 판단이며 이 앱의 효과가 입증됐다는 뜻은 아니다.

현재 사용자 요구에는 **영어로 말하는 상대를 유지하면서 한국어 입력을 받아 주는 방식**이 맞는다. 한국어 질문을 영어로 짧게 풀어 주고, 말문이 막혔을 때 필요한 영어 표현을 건네면 된다. 학습자가 한국어를 썼다는 이유로 꾸짖거나 문법 오류를 부여할 이유는 없다. 사후 설명·복습의 한국어 지원과 통화 중 영어 출력 정책은 구분한다. 최신 언어교육 메타분석은 모국어 활용의 유용성을 지지하므로 “한국어를 완전히 차단할수록 더 잘 배운다”는 설명은 사용하지 않는다(A09–A10).

| 결정 | 채택할 구조 | 연구와의 연결 및 경계 |
| --- | --- | --- |
| 대화의 목적 | 자유 대화를 유지하되 원하는 경우 약속 정하기·경험 설명·의견 비교처럼 작은 의사소통 목표를 제공 | AI 대화의 긍정적 평균 효과는 연습 도구를 지지한다. 목표 지향 시스템의 하위집단 결과는 유망한 설계 단서이며, 자유대화보다 인과적으로 우월하다는 실험은 아니다(A01). |
| 상대의 역할 | 요청에 필요한 영어 답변을 제공하고 학습자에게 다음 발언권을 돌려준다. 의미를 모르겠으면 짧게 확인한다 | 낮은 부담의 연습 가능성은 지지된다. 짧기만 한 무의미한 응답도 실패한다. 특정 단어 수·초 단위 최적값은 이 자료에서 나오지 않는다(A05–A08). |
| 한국어 입력 | 입력 언어를 오류로 취급하지 않고 의도를 이해한 뒤 영어 표현·쉬운 영어 설명·짧은 확인 중 필요한 도움을 선택 | 모국어 자원을 쓰는 학습을 부정하지 않으면서 사용자가 선택한 영어 음성 정책을 지킬 수 있다. 이 혼합 구조 자체의 비교 효과는 아직 미측정이다(A09–A10). |
| 막혔을 때의 지원 | 힌트, 반복, 쉬운 재설명, 원하면 문장 시작 부분을 제공. 도움을 거절하면 대화를 계속 | 기술적 오해가 반복되면 사용을 포기할 수 있다. 편하게 느꼈다는 설문과 실제 지속 사용을 별도로 확인해야 한다(A07). |
| 화면 지원 | 전사·필요한 표현을 사용자가 확인할 수 있게 하고 음성만으로 이해를 강제하지 않는다 | 혼합 방식의 유망한 결과는 선택적 지원의 근거다. 항상 자막을 켜는 방식이나 통화 직후 특정 화면의 학습효과까지 입증하지 않는다(A01). |
| 성과 판단 | 의사소통 과제 수행, 독립 평가자의 말하기 평가, 대화 중 회복 능력, 지연 재사용을 측정 | 만족도·불안·WTC(말하려는 의향)·사용량은 각각 별도 결과다. 총점 상승을 유창성·발음·장기 전이의 향상으로 확대하지 않는다(A03, A05, A07–A08). |

## 확인한 핵심 자료 10편

메타분석 6편과 1차 연구 4편을 아래에 구분했다. 메타분석끼리는 포함 연구가 겹칠 수 있으므로 연구 수·참여자 수를 합산하지 않았다. `g`, `d`, `ES`는 논문이 제시한 표준화 효과크기이며 향상률(%)이 아니다. 서로 다른 구성·비교집단·측정값을 가진 숫자를 순위로 읽지 않는다. 하위집단 조절효과도 해당 기능을 무작위 배정한 결과와 다르다.

### A01. 말하기에 가장 가까운 연구 종합

Hou, Z., & Min, S. **Dialogue-based computer-assisted language learning systems for second language speaking development: A three-level meta-analysis.** 온라인 2025 / ReCALL 38(1), 2026. [DOI·전문](https://doi.org/10.1017/S0958344025100268).

- 전문 방법·결과·한계 확인. 16개 연구의 89개 효과크기를 3수준 모형으로 종합. 말하기 전체 효과 `g=.61`, 95% CI `[.34,.89]`.
- 중요한 날짜 차이: **검색 종료는 2023년 5월**이다. 최신 Realtime 모델의 평가가 아니다. 다양한 대화 시스템·설계·음성/혼합 방식이 들어 있다.
- 16편 중 15편이 60명 미만이며, 분석 전제·집단 동질성·반복 측정 처리의 보고 부족을 논문이 지적한다. 체계적 이질성이 높고 출판편향 가능성도 다룬다.
- 목표 지향·혼합 방식이 유망했지만 연구 간 비교이다. 문법 정확성은 불확정이고 상호작용 능력은 연구가 부족했다. 대화 도구 채택의 근거로 쓰되 특정 UI·프롬프트가 더 좋다는 확정 근거로 쓰지 않는다.

### A02. 챗봇 전체 효과와 설계 의존성

Wang, F., Cheung, A. C. K., Neitzel, A. J., & Chai, C. S. **Does Chatting with Chatbots Improve Language Learning Performance? A Meta-Analysis of Chatbot-Assisted Language Learning.** 온라인 2024 / Review of Educational Research 95(4), 2025. [DOI·초록](https://doi.org/10.3102/00346543241255621).

- 출판사 초록·서지 확인; 본문은 접근 제한. 28개 연구, 70개 효과크기, robust variance estimation. 비챗봇 조건 대비 전체 `g=.484`.
- 교육 단계·언어 수준·인터페이스·상호작용 능력이 관련 조절변수였다. 여러 언어 기술을 함께 다루므로 이 값을 말하기만의 효과로 표기하지 않는다.
- 초록에 ChatGPT가 언급된다고 포함 연구 전부가 생성형 음성 모델인 것은 아니다. 세부 위험도·지연검사 비율은 초록으로 확인되지 않아 인용하지 않는다.

### A03. “잘 배웠다”와 “편했다”를 혼합하면 안 되는 이유

Lyu, B., Lai, C., & Guo, J. **Effectiveness of Chatbots in Improving Language Learning: A Meta-Analysis of Comparative Studies.** 온라인 2024 / International Journal of Applied Linguistics 35(2), 2025. [DOI·전문](https://doi.org/10.1111/ijal.12668).

- 전문 방법·결과 확인. 비챗봇 비교조건이 있는 31개 연구, 41개 효과크기, 전체 `g=.608`. 한국에서 수행된 연구가 8편 포함된다.
- **정의적 결과와 수행 결과를 모두 종합**하며 첫 사후검사를 추출했다. 따라서 전체 수치를 독립적인 말하기 숙달도나 장기 유지 효과로 바꿔 적으면 안 된다.
- 접근성·모달리티·생성형 여부·비교집단에 따라 효과가 달랐다. 기존 강의와 비교한 결과, 다른 기술 도구와 비교한 결과는 같은 질문이 아니다. 정확한 설정의 원인 효과를 분리하려면 동일한 연습량·과제에서 비교해야 한다.

### A04. 생성형 AI에 한정한 추가 종합

Li, M., Wang, Y., & Yang, X. **Can Generative AI Chatbots Promote Second Language Acquisition? A Meta-Analysis.** Journal of Computer Assisted Learning 41(4), 2025. [DOI·초록](https://doi.org/10.1111/jcal.70060).

- 출판사 초록 확인. 2023년 이후 실험·준실험 41편, 48개 독립 효과크기, 참여자 3,515명. 전체 `ES=.576`, 95% CI `[.385,.768]`.
- 생성형 AI의 유망성을 보강한다. 그러나 여러 언어·어휘·쓰기 등 결과를 섞은 SLA 종합이며 실제 음성 통화만의 결과가 아니다.
- 초록의 짧은 처치기간·언어별 하위집단 차이로 “일주일이 최적” 또는 특정 국적에 대한 고정 처방을 하지 않는다. 본문·부록의 위험도 분석을 확인하지 못했으므로 이 논문은 보강 근거로만 사용한다.

### A05. 한국인·최근 ChatGPT 비교 연구에서도 하위 능력의 결과는 다르다

Kang, E. Y. **Enhancing L2 Learners’ Affective Outcomes and Oral Proficiency Through AI-Chatbot Interaction.** Korean Journal of English Language and Linguistics 25, 2025, 1299–1314. [DOI](https://doi.org/10.15738/kjell.25..202509.1299), [KCI 초록](https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART003274714).

- 학술지 등록 초록 확인; 본문 미확인. 한국인 EFL 48명, ChatGPT-4o 모바일 대화 과제 24명과 대면 또래 대화 24명 비교.
- 불안·WTC·말하기 수행에서 챗봇 집단에 유리한 결과를 보고한다. 문법·어휘·과제 수행은 이점이 있었으나 **유창성·발음은 집단 간 유의한 차이가 없었다**.
- 무작위 배정 여부·처치기간·장기 유지·평가자 눈가림은 초록에서 확인되지 않는다. 유의하지 않다는 결과가 동등성 증명은 아니다. 모델·과제·세션 방식은 우리 앱과 다르다.

### A06. 한국인 음성 ChatGPT 무작위 비교의 유망성과 범위

Kim, S., & Lee, J. **The Effect of Voice-enabled ChatGPT on Speaking Proficiency, Affective and Metacognitive Domains of Korean EFL Learners.** Journal of Research in Curriculum Instruction 27(4), 2023, 344–359. [DOI·KCI 초록](https://doi.org/10.24231/rici.2023.27.4.344).

- 공식 초록 확인. 한국 중학교 1학년 33명을 음성 지원 ChatGPT와 또래 연습에 무작위 배정했다. 전체 말하기와 어휘, 정의적·메타인지 영역에서 챗봇 집단의 더 큰 개선을 보고한다.
- 모든 하위 능력이 동일하게 개선됐다는 결과가 아니다. 소표본·청소년·수업 상황·2023년 구현을 성인 자유 통화에 그대로 옮길 수 없다.
- 전사/음성 합성/모델 설정·장기 추적·평가자 눈가림은 이 초록으로 확인되지 않는다. 한국인 대상 직접성이 있는 보강 근거로 사용한다.

### A07. 긍정적인 설문이 자발적 사용을 보장하지 않는다

Dizon, G., & Tang, D. **Intelligent personal assistants for autonomous second language learning: An investigation of Alexa.** The JALT CALL Journal 16(2), 2020, 107–120. [DOI](https://doi.org/10.29140/jaltcall.v16n2.273), [전문 PDF](https://www.castledown.com/journals/jaltcall/article/download/jaltcall.v16n2.273/788).

- 전문 확인. 일본 대학생 20명 모집, 5명 미사용·1명 기록 삭제로 사용 기록 14명 분석, 설문 응답은 9명. 가정에서 2개월 사용한 관찰 연구다.
- 설문은 대체로 긍정적이었지만 사용량이 제한적이었다. 의사소통 실패 139회 중 약 63%에서 해당 시도를 포기했다.
- 사라진 비사용자를 분모에서 지워 성공률을 만들지 않아야 한다. 오래된 Alexa의 오류율은 현재 모델로 이전할 수 없고, 이 연구는 학습효과의 인과 실험도 아니다. 오해 회복·실제 사용·이탈을 함께 보는 설계에 유용하다.

### A08. 한국인 장기 사례에서 대화량과 능력 변화는 분리된다

Seon, H. M. **A study on the development of English learning through synchronous digital discourse with an A.I. Chatbot: A case study of a Korean EFL learner.** Modern English Education 25, 2024, 115–127. [학술지 원문 페이지](https://journal.kci.go.kr/meeso/archive/articleView?artiId=ART003083721), [전문 PDF](https://journal.kci.go.kr/meeso/archive/articlePdf?artiId=ART003083721).

- 전문 확인. 숙달도가 높은 한국인 성인 **1명**이 약 4개월간 진행한 **문자 채팅** 사례다. 대화량은 증가했지만 분석한 정확성·문장 길이·어휘 다양성의 뚜렷한 향상을 확인하지 못했다.
- 통제집단이 없고 과제·주제·기존 수준의 영향을 분리하지 못한다. AI 전체가 무효라는 증거도, 음성 통화의 실패율도 아니다. 생성형 Realtime 모델과 동일한 기술로 취급하지 않는다.
- 통화 시간·단어 수만을 영어 실력 향상으로 표시하지 말아야 한다는 측정상 경계 사례로 사용한다.

### A09. 영어만 써야 가장 잘 배운다는 주장에 대한 비교 근거

Zhang, M., & Brown, A. **The Effectiveness of Multilingual Versus Monolingual Approaches to L2 Teaching and Learning: A Meta-Analysis of Learning Outcomes.** Language Teaching Research, 온라인 2026-07-25. [DOI·초록](https://doi.org/10.1177/13621688261455050).

- 출판사 초록 확인. 24개 연구, 30개 표본, 2,138명. 다언어 접근이 단일 목표언어 접근보다 유리한 **집단 간** 가중 효과 `d=.49`를 보고한다.
- 논문에 나오는 집단 내 `d=1.63`은 별도의 추정량이다. 두 값을 섞거나 더 큰 값을 정책 근거로 선택하지 않는다. 기술·교수법이 다양한 교실 비교이며 우리 앱의 영어 음성 정책 자체를 시험하지 않았다.
- “L1 활용은 언제나 해롭다”는 주장을 지지하지 않는다. 반대로 이 결과로 사용자가 원하지 않는 한국어 음성 응답을 강제할 이유도 없다. 본문 위험도·장기 유지 분석은 미확인이다.

### A10. 다언어 지원의 긍정적 효과와 장기 근거의 부족

Wang, X., & Zhang, L. J. **A multilevel Bayesian meta-analysis of the effects of translanguaging pedagogy on L2 achievement.** Language Teaching, 온라인 2026-06-16. [DOI·전문](https://doi.org/10.1017/S0261444826101335).

- 전문 방법·결과·한계 확인. 40개 연구, 108개 효과크기, 3,145명. 전체 `g=1.014`, 95% Bayesian credible interval `[.748,1.291]`.
- 영문·중문 연구와 회색문헌을 포함하며 집단·과제·지원 방식이 이질적이다. Egger 검정의 비대칭이 있어 선택편향 가능성을 남기고, 저자들의 민감도 검토도 함께 읽었다. A09와의 중복 여부는 전수 대조하지 않았으므로 독립 증거 두 배로 세지 않는다.
- **40편 중 지연 사후검사는 3편**뿐이며 기술별 효과를 비교할 자료도 부족했다. 모국어를 학습 자원으로 인정할 근거는 되지만 한국어 자동응답의 장기 효과·이상적 사용 비율을 정하지는 못한다.

## 영어 음성 정책을 실제 대화로 옮기는 방법

아래는 연구에서 복사한 실험 자극이 아니라 사용자 요구와 문헌을 바탕으로 작성한 **설계 예시**다. 문장 길이·도움의 순서는 검증된 최적값이 아니다.

| 상황 | 권장 반응 예시 | 목적 |
| --- | --- | --- |
| “퇴근하고 바로 집에 갔어를 영어로?” | “I went straight home after work.” | 요청한 표현을 주고 설명을 덧붙이지 않아도 되는 상황에서는 멈춤 |
| “그 단어 무슨 뜻이야?” — 문맥에 `exhausted` | “It means very tired.” | 한국어 의미 질문을 이해하고 쉬운 영어로 해결 |
| “I went to the… 병원 yesterday.” | “The hospital. Are you feeling better now?” | 말하려는 의미를 받아 주고 원래 대화 주제로 연결 |
| 뜻이 불확실함 | “Do you mean you missed the bus?” | 아는 척하거나 자동 교정하기 전에 의도 확인 |
| “I don't know how to start.” | “You could start with ‘Yesterday, I…’” | 완성 답안을 대신 말하기보다 발화 시작 지원 |
| “한국어로 설명해 줘.” — 현재 영어 연습 정책 | “Let me say it more simply.” 뒤에 쉬운 영어 설명 | 정책을 길게 해설하거나 한국어를 혼내지 않고 이해 가능한 도움 제공 |
| “설명 말고 그냥 대화하자.” | “Sure. What happened next?” | 도움이 필요하지 않을 때 학습자의 선택을 존중 |

이 구조가 영어 출력 준수, 의미 보존, 부담 감소를 동시에 만족하는지는 실제 음성으로 확인한다. 한국어 질문을 입력했다는 사실과 영어 출력 실패는 구분하고, 고유명사·지명·사용자 원문 인용을 언어 전환으로 잘못 세지 않도록 기준을 사전에 정한다. ASR의 언어 힌트와 원문 보존은 [별도 검토](voice-language-and-asr.md)의 독립 문제다.

## 채택할 것과 아직 수치를 정할 수 없는 것

지금 설계에 채택할 근거가 있는 것은 **대화 연습 기회 확대, 의미 있는 과제 선택지, 오해 회복 지원, 학습자 발화 기회, 필요할 때 접근할 수 있는 언어 지원, 실제 수행과 만족도의 분리 측정**이다. 각 기능이 우리 앱에서 만드는 효과크기까지 확정한 것은 아니다.

이 자료로 결정할 수 없는 것은 **2초가 최적인지, 10–25단어가 최적인지, 질문을 매번 하나 해야 하는지, 영어/한국어의 최적 사용 비율, 음성만과 상시 자막 중 어느 쪽이 좋은지**다. 설계 원칙은 정할 수 있고 수치는 그 원칙의 달성 여부를 확인하면서 조정해야 한다. 참여자가 아직 없다는 이유로 원칙까지 미정으로 둘 필요는 없다. 반대로 문헌의 평균 효과를 우리 앱의 검증 결과로 사용해서도 안 된다.

## 검색·선정 기록

이 검토는 등록된 체계적 문헌고찰이 아닌 **범위를 명시한 확장 검토**다. 웹 검색으로 후보를 찾고 DOI·출판사·학술지/KCI 공식 페이지·공개 원문을 직접 열었다. 검색 결과에 포함된 서지와 초록을 다시 확인했으며 실제 읽은 접근 범위를 각 항목에 표시했다. 공개 문헌 전체를 빠짐없이 찾았다고 주장하지 않는다.

- 검색일·포함 마감: 2026-11-10. 최신 2026년 연구까지 검토하되 온라인 출판일과 권호 연도를 구분했다.
- 주요 검색어: `meta analysis AI chatbots second language learning speaking anxiety 2024 2025 voice conversational agents`; `systematic review speech chatbots language learning speaking 2025 meta analysis`; `2024 2025 meta analysis pedagogical translanguaging English foreign language learning L1 L2`; `Korean EFL voice chatbot speaking proficiency randomized control anxiety 2024 2025 study`; `Korean university learners chatbot speaking anxiety human partner experimental 2023 Kang`; `chatbot speaking no significant Korean 2024 2025`.
- 추적 검색: A04·A06의 정확한 제목, `Chatbots for oral proficiency in English language learning 100346`, Dizon의 제목, `Exploring the impact of AI-powered speaking tasks 105391`. A06·A08의 서지·원문을 대조했다.
- 선정: 대조조건이 있는 연구 종합, 음성 말하기 결과가 있는 연구, 한국인 표본, 무효·혼합 결과, 실제 자발적 사용을 살핀 반례를 우선했다. 최신성만으로 선정하지 않았다.
- 핵심 결론에 넣지 않은 후보: 2026년 *Chatbots for oral proficiency in English language learning* ([DOI](https://doi.org/10.1016/j.teler.2026.100346))와 2025년 *Exploring the impact of AI-powered speaking tasks…* ([DOI](https://doi.org/10.1016/j.actpsy.2025.105391))는 이번 경로에서 원문 열기가 403/접근 실패했고 검색 발췌만으로 세부 결과를 확정하지 않았다. 참여자 19명의 단일집단 신형 챗봇 연구는 비교설계 근거를 우선하기 위해 핵심 표에서 제외했다. 한국어가 **목표언어**인 연구는 한국인의 **영어** 학습 연구로 오인하지 않았다.
- 공식 ACTFL·CEFR 자료는 교육 지침·평가 틀이며 독립 효과 실험으로 세지 않는다. 관련 내용은 [기준·성과 검토](standards-outcomes-review.md)에 모았다.
- 접근 상태: 전문 핵심 절 확인 A01·A03·A07·A08·A10. 공식 초록 확인 A02·A04·A05·A06·A09. 새로운 학습자 실험·모델 호출·외부 연락·실제 통화 데이터 수집은 없다.
