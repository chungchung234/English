# 영어 회화 학습: 상호작용·발화·과제·반복 연구 검토

검토일: 2026-11-10 UTC. 대상: 한국인 성인이 AI와 영어로 음성 대화하는 현재 서비스. 문헌 검색과 원문·출판사 초록 검토이며, 이 서비스의 사용자 실험은 아니다. 아래 결론은 기존 [답변 길이 검토](voice-response-length.md)에 학습 과정과 반복 연습 근거를 추가한다. 모든 문헌을 망라한 체계적 문헌고찰이라고 주장하지 않는다.

## 결론

이 서비스의 학습 방침은 **의미 있는 말을 사용자가 직접 만들고, 막힌 부분에 필요한 도움을 받은 뒤, 다시 표현해 보는 대화**로 정하는 것이 타당하다. AI의 영어 설명량, 빠른 턴 전환, 총 대화 시간이 학습의 대리 목표가 되어서는 안 된다. 이는 여러 상호작용 연구를 종합한 설계 판단이며, 아래 논문 중 어느 하나가 이 앱 전체를 검증한 것은 아니다.

구체적으로는 자유 대화를 유지하면서, 사용자가 원할 때 실제 목적이 있는 작은 과제와 재말하기를 제공한다. `오늘 있었던 일을 전하기`, `두 식당 중 한 곳 정하기`, `약속 시간 바꾸기`처럼 전달하거나 결정할 내용이 있어야 한다. 매 턴 영어 문법을 시험하는 방식, 사용자의 문장을 AI가 곧바로 완성하는 방식, 모든 응답에 새 질문을 붙이는 방식은 이 근거에서 나오지 않는다.

## 근거를 읽는 기준

- **과정의 직접성:** 사람의 L2 구어 상호작용·발화 실험은 관련성이 높다. 읽기·컴퓨터 재구성·교실 전체 프로그램은 해당 요소의 간접 근거다.
- **환경의 차이:** 이 표의 연구는 현재 Realtime 모델, 한국어·영어 혼합 음성, 한국 성인의 친교형 AI 통화에 대한 직접 검증이 아니다.
- **결과의 차이:** 이해 점수, 학습한 표현의 생산, 같은 과제의 유창성, 새 과제 전이, 장기 유지, 만족도는 서로 다른 결과다.
- **문헌의 독립성:** 리뷰가 인용한 1차 연구를 다시 별도 효과처럼 합산하지 않는다. 메타분석 간 표본 중복도 확인 없이 합산하지 않는다. 표의 문헌 수는 독립 실험 수나 참가자 수가 아니다.

## 확인한 핵심 자료 11편

| ID / 자료·접근 범위 | 방법과 확인된 결과 | 이 서비스에 내리는 판단·한계 |
| --- | --- | --- |
| L1. Loewen & Sato (2018), *Interaction and instructed second language acquisition*. [DOI](https://doi.org/10.1017/S0261444818000125), [원문 HTML](https://www.cambridge.org/core/journals/language-teaching/article/interaction-and-instructed-second-language-acquisition/78A156EE200F744F5978F99BFB073DBE). 관련 본문·결론 확인. | 교실·실험실 연구를 다루는 state-of-the-art review. 입력, 의미 협상, 출력, 주의, 상대·과제·환경 차이를 통합한다. 상호작용의 긍정적 근거와 조건별 차이를 함께 설명한다. 새 표본을 가진 실험이나 독립 효과크기 메타분석은 아니다. | AI의 설명만 제공하는 흐름보다 사용자의 확인·질문·수정 발화를 허용할 근거. 특히 이해 실패 때 짧은 확인과 재설명을 제공한다. 이론의 `pushed output`을 재촉·말 끊기·강제 재답변으로 해석하지 않는다. |
| L2. Mackey (1999), *Input, Interaction, and Second Language Development: An Empirical Study of Question Formation in ESL*. [DOI](https://doi.org/10.1017/S0272263199004027), [출판사 초록](https://www.cambridge.org/core/journals/studies-in-second-language-acquisition/article/abs/input-interaction-and-second-language-development/D09BD3D63DC401DC57FC3ABB4B332588). 초록 확인; 저장소 PDF 접근 실패. | 다양한 L1 배경의 성인 ESL **34명**, 실험 4집단·통제 1집단, 사전·사후 설계. 과제 상호작용과 의문문 발달의 관계, 능동적 참여 및 발달 수준을 조사했고 참여의 중요성을 지지했다. | 학습자가 질문도 하고 의미를 명료화하도록 설계한다. 소규모·특정 문법 연구다. 초록만으로 집단별 효과크기·장기 유지·AI 동등성을 추정하지 않는다. |
| L3. de la Fuente (2002), *Negotiation and Oral Acquisition of L2 Vocabulary: The Roles of Input and Output in the Receptive and Productive Acquisition of Words*. [DOI](https://doi.org/10.1017/S0272263102001043), [출판사 초록](https://www.cambridge.org/core/journals/studies-in-second-language-acquisition/article/abs/negotiation-and-oral-acquisition-of-l2-vocabulary/ADFAE8E63258736DA28C53666E86838E). | 미리 수정된 입력, 산출 요구 없는 협상, 산출이 포함된 협상의 세 조건. 협상+산출은 산출 없는 협상보다 생산적 어휘 습득에 유리했지만 수용적 습득에서 추가 이득은 확인되지 않았다. | `뜻을 들었다`와 `필요할 때 직접 말했다`를 구분한다. 표현을 제시한 뒤 본인 상황에 사용해 볼 선택지를 둔다. 접근한 초록에 표본·검사 간격·효과크기가 없어 미확인으로 남긴다. 일반 대화 능력 전체로 확대하지 않는다. |
| L4. Izumi (2002), *Output, Input Enhancement, and the Noticing Hypothesis: An Experimental Study on ESL Relativization*. [DOI](https://doi.org/10.1017/S0272263102004023), [출판사 발췌 초록](https://www.cambridge.org/core/journals/studies-in-second-language-acquisition/article/abs/output-input-enhancement-and-the-noticing-hypothesis/6A24AE05CFBBB36D88AB84E8672A5C43). | 성인 ESL의 관계절 학습에서 컴퓨터 재구성·읽기 과제의 산출과 시각적 강조를 조작. 산출-입력 활동군은 이해 목적으로 같은 입력을 본 집단보다 학습 이득이 컸다. 시각적 강조는 noticing에 도움이 되었지만 측정 가능한 학습 이득은 없었다. | 통화 내역의 색 강조나 교정문 열람을 곧바로 습득으로 표시하면 안 된다. 재표현의 근거를 보강하지만 음성 자유대화의 직접 실험은 아니다. 표본과 정확한 추적 간격은 접근 범위에서 미확인. |
| L5. Ziegler (2016; 온라인 2015), *Synchronous Computer-Mediated Communication and Interaction: A Meta-Analysis*. [DOI](https://doi.org/10.1017/S027226311500025X), [출판사 초록·참고문헌](https://www.cambridge.org/core/journals/studies-in-second-language-acquisition/article/abs/synchronous-computermediated-communication-and-interaction/F05E29E42457059532258158B93167D7). | 1990~2012년 연구 **14편**. 실시간 컴퓨터 매개 상호작용과 대면 상호작용 양쪽에서 L2 발달 효과; 매체 간 차이는 유의하지 않았다. 생산·쓰기 및 수용·말하기 지표에서 방향이 달랐다. | 화면/원격 대화도 학습 기회를 만들 수 있으나, 당시 인간 간 CMC 결과를 생성형 음성 AI의 효과로 사용하지 않는다. 유의하지 않은 차이는 동등성 입증도 아니다. |
| L6. Bryfonski & McKay (2019; 온라인 2017), *TBLT implementation and evaluation: A meta-analysis*. [DOI](https://doi.org/10.1177/1362168817744389), [출판사 초록](https://journals.sagepub.com/doi/10.1177/1362168817744389). | 전체 문헌 표본 **52편**을 대상으로 프로그램 수준의 학습 결과와 인식 검토. 초록은 전체 효과 **d=0.93**을 보고한다. | 과제의 교육적 가능성을 보여 주는 자료지만 아래 L7의 포함 기준·혼입·평가 도구 비판을 함께 읽어야 한다. **93% 향상, AI 자유대화의 효과크기, 과제만의 순수 인과효과로 변환하지 않는다.** |
| L7. Boers & Faez (2026호; 온라인 2023), *Meta-analysis to estimate the relative effectiveness of TBLT programs: Are we there yet?*. [DOI·원문](https://doi.org/10.1177/13621688231167573). 원문 방법론 논증 확인. | L6에 포함된 비교 연구 27편과 후속 재분석에 사용된 16편 등을 재검토. 과제의 정의, 비교군에 불리한 평가, 혼입 변수가 문제라고 지적한다. 재분석의 작은 효과도 같은 문제를 해결하지 못한다는 논증. | `과제 기반이 모든 학습법보다 우월하다`는 결론은 채택하지 않는다. 사용자의 실제 의사소통 목적을 정하고, 실제로 무엇을 했는지·어떤 비교를 했는지 기록한다. 이 논문도 반대 방향의 새 효과 실험은 아니다. |
| L8. de Jong & Perfetti (2011), *Fluency Training in the ESL Classroom: An Experimental Study of Fluency Development and Proceduralization*. [DOI](https://doi.org/10.1111/j.1467-9922.2010.00620.x), [저자 기관 PDF](https://sites.pitt.edu/~perfetti/PDF/de%20Jong%20Language%20Learning.pdf). 방법·결과 확인. | 미국 대학 중상급 ESL **47명 참여 동의 → 결석으로 완전 자료 24명 분석**. 3회 훈련에서 4·3·2분 발화를 같은/다른 주제로 수행. 훈련 중 양쪽 유창성이 개선됐으나 사후 유지 이득은 반복 조건에서 관찰. 다른 주제 검사도 실시했고 첫 반복 조건의 검사 시점은 훈련 후 약 **1·4주**였다. 늦게 시작한 반복 조건은 지연 검사가 없었다. | 선택적인 `같은 이야기를 다시 말하기` 근거. 작은 완전 사례 표본, 교실 동시 수업, 독백 과제라는 한계가 있다. 사용자 불만이 시간 압박인 현재 통화에 4/3/2나 강제 속도 경쟁을 그대로 도입하지 않는다. 연구도 유창성을 단순히 빨리 말하기로 가르치지 않았다. |
| L9. Suzuki & Hanzawa (2022; 온라인 2021), *Massed Task Repetition Is a Double-Edged Sword for Fluency Development: An EFL Classroom Study*. [DOI](https://doi.org/10.1017/S0272263121000358), [원문](https://www.cambridge.org/core/journals/studies-in-second-language-acquisition/article/massed-task-repetition-is-a-doubleedged-sword-for-fluency-development/D28EDD7E3D0FA15630165538D706E80F). 방법·결과 확인. | 일본 대학 1학년 **79명**, 기존 4개 반을 몰아서/짧은 간격/1주 간격/통제로 배정. 같은 그림 이야기 6회 반복. 몰아서 반복은 새 이야기 즉시 검사에서 휴지를 줄였지만 조음 속도와 반복 수정 측면은 악화. 새 이야기 1주 지연 검사에서 일정별 효과는 제한적. | 반복 횟수를 최대화하지 않는다. 같은 발화의 더 빠른 재생산과 새로운 상황에서의 유연한 말하기를 별도 평가한다. 반 단위 배정·독백이며 한국인 AI 대화에 그대로 적용할 수 없다. |
| L10. Rogers & Li (2025), *The time between tasks in task repetition research: A systematic review*. [DOI](https://doi.org/10.1177/13621688251323047), [기관 accepted manuscript](https://ira.lib.polyu.edu.hk/bitstream/10397/113277/1/Rogers_Time_Between_Tasks.pdf). 방법·논의 확인. | 1996~2023년 구어 과제 반복 **107편**의 방법을 검토. 반복 간격·횟수 근거와 보고의 불충분함을 확인. 최초 보고에서 간격 정보가 충분한 연구는 **68/107**; 이후 저자 확인으로 일부를 보완했다. 효과크기를 통합해 최적 간격을 판정한 메타분석은 아니다. | 즉시 재시도, 며칠 후 같은 과제, 다른 상황 전이를 구분해서 기록한다. 이 리뷰에서 1·3·7일이나 특정 반복 횟수의 최적성을 도출하지 않는다. |
| L11. Abdi Tabari, Zhuang & Farahanynia (2025), *Task repetition and L2 oral performance: A meta-analysis*. [DOI](https://doi.org/10.1016/j.system.2025.103868), [저자 기관 초록](https://hilpub.uni-hildesheim.de/entities/publication/c7f89e57-747e-4ca3-9cd9-a64c33cb4cf4). 출판사 원문 접근 실패; 기관 초록 확인. | 반복의 구문 복잡성·정확성 이득과 상대적으로 작은 유창성·어휘 복잡성 이득을 보고. 과제·반복 유형·학습 환경·간격에 따라 효과가 달랐다. | 반복을 우선 검토할 이유는 있지만 모든 지표의 향상 폭을 하나로 합치지 않는다. 접근한 초록에 연구 수·참가자 수·세부 효과·추적기간이 없어 수치를 채우지 않는다. 간격 조절변수의 연관을 특정 개인에게 필요한 인과적 최적 일정으로 해석하지 않는다. |

## 채택할 제품 원칙

다음은 연구가 지지하는 학습 과정과 사용자의 직접 요구를 연결한 설계 결론이다. 논문이 확인한 효과와 이 제품에서 선택하는 구현 세부를 구별한다.

1. **사용자가 말할 내용을 보존한다.** 생각 중인 사용자의 말을 AI가 선제적으로 완성하거나, 짧은 사용자 발화에 긴 이야기를 덧붙여 발언권을 가져가지 않는다. 학습에 필요한 산출 기회를 보존한다는 판단이다(L1~L3). 특정 말하기 비율·침묵 초 수를 논문에서 얻은 값으로 쓰지 않는다.
2. **대화 목적에 맞게 짧게 답한다.** 질문에 대답하고 대화에 필요한 만큼만 반응한다. 이해에 필요한 정보는 남기며, 사용자가 더 자세히 요청하면 확장한다. `매번 질문 하나`가 아니라 `필요할 때 관련된 질문`으로 설계한다. 말할 기회를 확보하는 것과 질문으로 계속 압박하는 것을 구별한다.
3. **막히면 단계적으로 돕는다.** 사용자가 어려움을 표시하면 필요한 부분을 확인하고, 쉬운 재표현·짧은 예·사용할 표현을 제공한다. 사용자가 직접 이어서 말할 기회를 남기되 재시도는 선택 가능하게 한다. 장문의 설명이나 사용자 답안 완성이 기본이 되지 않는다(L1, L3).
4. **일상 대화 안에 작은 의사소통 목적을 둔다.** 자유 대화 중에는 사용자가 꺼낸 이야기와 질문을 따른다. 연습을 원하면 정보 전달·결정·요청 같은 구체적 목표를 사용한다. 실제 의사소통 과제와 문법 빈칸 연습을 같은 것으로 표기하지 않는다(L6~L7). 과제 모드를 모든 통화에 강제하지 않는다.
5. **다시 말하기를 복습의 핵심 선택지로 둔다.** 기록을 본 뒤 자신의 말로 같은 생각을 다시 표현하고, 다음에는 다른 상황에 사용해 본다(L3~L4, L8~L11). `한 번 더 해보기`는 낮은 부담을 위한 제품 기본 제안이며 논문이 밝혀낸 최적 횟수가 아니다. 생략·중단을 허용한다.
6. **친교 통화와 유창성 훈련의 압박을 구분한다.** 통화 중에는 사용자의 속도를 보호한다. 시간 제한을 둔 말하기는 사용자가 명시적으로 선택한 별도 훈련에서만 검토한다. 휴지 감소 하나를 점수로 삼으면 서두르기·축어 반복을 보상할 수 있다(L8~L9).
7. **성공은 실제 전달과 재사용으로 확인한다.** 과제에서는 의도가 전달됐는지, 복습에서는 도움 없이 표현을 꺼낼 수 있는지, 전이에서는 다른 상황에도 맞게 사용할 수 있는지 구분한다. `교정문 열람`, `좋아요`, `말한 단어 수`, `동일 문장 따라하기`만으로 습득 완료를 표시하지 않는다(L3~L4, L9~L10).

## 구체적인 대화 예시

아래는 구현 방침을 명확하게 하기 위해 작성한 예시이며 실제 모델 출력·학습자 관찰 자료가 아니다.

| 상황 | 제안하는 AI 행동 | 보호하려는 학습 과정 |
| --- | --- | --- |
| 사용자가 “I wanted to… um…” 뒤 생각 중 | 발화 도중의 망설임을 새 질문으로 덮지 않고 발언권 유지. 도움 요청이 있을 때만 힌트. | 자기 표현을 조립할 기회. 구체적인 종료 판정 알고리즘은 별도 턴 전환 검토의 영역. |
| 사용자가 “What does ‘reschedule’ mean?” | “It means changing something to a different time.” 필요하면 짧은 예 추가. | 질문에 필요한 의미 제공. 매번 장문 수업을 시작하지 않음. |
| 사용자가 “I don’t understand. Easier, please.” | 같은 말을 더 어렵게 확장하지 않고 “Move it to another time.”처럼 다시 설명. | 이해 실패를 수리하는 상호작용. |
| 사용자가 약속 변경 연습을 선택 | “Let’s change our meeting time. What would you say?” 이후 사용자 표현을 듣고 실제 시간 합의로 진행. | 의미 있는 산출과 대화 결과. |
| 통화 후 사용자가 어려웠던 표현 선택 | 원래 뜻 확인 → 필요한 교정·표현 → 원하면 자신의 상황으로 재말하기 → 다음 연습에서 다른 상황 적용. | 읽기에서 생산·전이로 연결. 재시도 성공을 장기 습득으로 오인하지 않음. |

## 현재 확정할 수 있는 것과 후속 검증

**지금 확정할 기획:** 학습자의 발언권·자기 표현 우선, 이해 실패에 맞춘 도움, 목적이 있는 선택적 과제, 선택적 재말하기, 새 상황 전이의 별도 확인. 이 방향을 제품 설계 요구사항으로 삼을 근거는 있다.

**실행값·효과 확인:** AI가 실제로 이 원칙을 지키는지는 정확한 모델·실제 음성 출력에서 점검한다. 사용자에게 맞는 응답 길이·대기 시간·재시도 빈도는 문헌에 없는 값을 최적이라고 선언하지 않고, 의미 적합성·중단·부담·새 상황 표현을 함께 확인한다. 장기 학습 효과를 주장하려면 사전 상태와 지연 검사, 비교 조건이 필요하다. 기획 결정을 모두 미룰 이유는 아니며, 검증 범위에 맞춰 주장의 범위를 정한다.

## 검색 및 접근 기록

검색일 2026-11-10 UTC. 웹 검색으로 후보를 발견한 뒤 출판사·저자 기관 페이지를 열었다. 확인한 주요 검색어는 다음과 같다.

- `second language interaction meta analysis Keck Iberri-Shea Tracy-Ventura`
- `task based language teaching meta analysis oral production learning Bryfonski McKay 2019`
- `task repetition second language oral performance meta analysis 2024 2025`
- `Mackey 1999 input interaction second language development empirical study 34 adults question formation`
- `Izumi 2002 Output Input Enhancement`
- `de la Fuente 2002 negotiation oral acquisition L2 vocabulary`
- `de Jong Perfetti 2011 fluency training`
- `oral task repetition Rogers Li 2025 systematic review spacing`
- `Suzuki task repetition six fluency`
- `Ellis He 1999 Modified Output vocabulary acquisition`

실제 내용 확인에 사용한 자료는 위 L1~L11의 직접 링크이며 접근 범위는 각 행에 기재했다. 논문 소개 블로그·검색 요약만으로 수치나 효과 결론을 확정하지 않았다. 검색 결과에 표시되는 온라인 공개일과 권호 연도가 달라, 확인된 경우 함께 표기했다.

추가로 연 자료: [Keck et al. (2006) 출판사 서지](https://www.benjamins.com/catalog/lllt.13.08kec)는 저자·제목·DOI만 확인해 위 효과 근거에 추가하지 않았다. Ellis & He (1999)는 검색에서 관련 초록을 찾았으나 이번 11편 표에 중복 근거로 추가하지 않았다. ScienceDirect의 반복 메타분석 원문과 Lancaster의 Mackey PDF는 접근 실패했으므로 원문을 읽었다고 표현하지 않았다. 이러한 접근 제한 때문에 연구 수·표본·지연 간격이 미확인인 항목을 추측해 채우지 않았다.
