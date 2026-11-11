const ratings = { hard: '어려움', assisted: '도움이 필요함', independent: '스스로 말해봄' };
const modes = { repetition: '예문 반복 근거', after_hint: '힌트 뒤 사용 근거', new_context: '새 상황의 사용 근거', undetermined: '사용 맥락 판단 불가' };
const reasons = { delayed_recall: '내가 예약한 회상 시점이 됐어요.', selected_goal: '내가 저장한 연습 목표가 있는 표현이에요.', repeated_source: '유효한 여러 통화 출처에서 확인한 표현이에요.', recent_source: '최근 통화에서 선택한 표현이에요.' };
const empty = () => ({ reviews: [], schedules: [], recalls: [], usage: [], weekly_goals: [], imports: [], personalized_item_ids: [], recommendation_reasons: {} });
const stamp = value => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' KST' : '시각 확인 필요';

// A cue is a labelled source or suggestion, never a fabricated translation of
// the learner's intent. Reject exact target copies (including punctuation/case
// variants) so a saved goal cannot accidentally reveal the answer.
const cueKey = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
export function practiceCue(item, goal = '') {
  const target = cueKey(item.expression);
  const safe = value => { const key = cueKey(value); return key && target && !key.includes(target); };
  const choices = [
    { kind: 'goal', label: '내가 정한 연습 목표', value: goal },
    { kind: 'source', label: '지난 통화에서 말한 내용 · 자동 전사', value: item.original },
    { kind: 'scenario', label: '다음에 이야기할 상황 · 제안', value: item.next_scenario }
  ];
  return choices.find(cue => safe(cue.value)) || { kind: 'choice', label: '내가 정하는 연습 상황', value: '이 표현을 쓰고 싶었던 상황을 떠올려 보세요. 뜻이 기억나지 않으면 표현을 다시 봐도 괜찮아요.' };
}

// This controller only presents server-confirmed extension state. All mutations
// use the existing account-partitioned durable queue and compare-and-swap path.
export function createLearningEnhancements(host) {
  let data = empty(), unavailable = false;
  const drafts = new Map(), requests = new Set();
  const { text, button, status } = host;
  const detail = label => { const node = document.createElement('details'); node.className = 'feedback-context'; node.append(text('summary', label)); return node; };
  const scheduleFor = id => data.schedules.find(row => row.item_id === id);
  const pending = item => host.pending(item.id).length > 0 || unavailable;
  const act = (rpc, item, args) => host.submit(rpc, item, args);
  function input(label, key, value, multiline = false, limit = 500) {
    const field = document.createElement('label');
    field.append(text('span', label));
    const control = document.createElement(multiline ? 'textarea' : 'input');
    control.maxLength = limit; control.value = drafts.get(key) ?? value ?? '';
    control.dataset.action = key; control.oninput = () => drafts.set(key, control.value);
    field.append(control); return { field, control };
  }
  function action(label, actionName, item, rpc, args) {
    const node = button(label, () => act(rpc, item, args)); node.dataset.action = actionName; node.disabled = pending(item); return node;
  }
  function renderReview(article, item, attribution) {
    const review = data.reviews.filter(row => row.item_id === item.id).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    if (!review && item.status !== 'held' && !item.quality_hold && item.has_valid_source !== false) return;
    if (item.status === 'excluded' || host.pending(item.id).some(row => ['exclude', 'known'].includes(row.body?.p_action))) return;
    const section = detail('의도 보충·교정 재검토');
    section.append(text('p', '추가 설명은 내 의도에 대한 보충이며, 저장된 원래 녹취를 바꾸지 않아요. 제안을 직접 수락하기 전에는 보류된 교정을 다시 추천하지 않아요.', 'help'));
    if (review) {
      section.dataset.reviewId = review.id;
      section.append(text('small', '내가 추가한 의도 설명'), text('p', review.explanation));
      if (review.source_current === false) section.append(status('원래 발화나 피드백이 바뀌어 지금은 재검토를 계속할 수 없어요. 최신 피드백을 확인해 주세요. 보충 설명은 보관돼요.'));
      else if (review.status === 'pending') {
        section.append(status('의도 설명 서버 저장 확인 · 재검토 제안은 아직 확인되지 않았어요.'));
        const reconsider = button(requests.has(review.id) ? '재검토 준비 중…' : '이 설명으로 재검토', async () => {
          if (requests.has(review.id)) return;
          const scope = host.token(); requests.add(review.id); host.render();
          try {
            await host.edge('reconsider', { requestId: review.id });
            if (host.same(scope)) { await host.refresh(scope); host.notify('재검토 상태를 확인했어요. 제안을 확인하고 직접 선택해 주세요.'); }
          } finally { requests.delete(review.id); if (host.same(scope)) host.render(); }
        }); reconsider.dataset.action = 'reconsider'; reconsider.disabled = pending(item) || requests.has(review.id); section.append(reconsider);
      } else if (review.status === 'proposed' && review.proposal) {
        section.append(text('small', '서버의 재검토 제안 · 원래 녹취와 구분'), text('p', review.proposal.expression || review.proposal.improved, 'improved'), text('p', review.proposal.reason));
        host.appendEvidence(section, review.proposal.evidence_ids, review.source_session_id);
        section.append(action('이 제안을 복습에 포함', 'accept-reconsideration', item, 'learning_review_decide', { p_review_id: review.id, p_expected_revision: review.revision, p_decision: 'accept' }), action('제안 닫고 보류 유지', 'dismiss-reconsideration', item, 'learning_review_decide', { p_review_id: review.id, p_expected_revision: review.revision, p_decision: 'dismiss' }));
      } else section.append(status(review.status === 'accepted' ? '제안 수락을 서버에 저장했어요. 유효한 출처와 추천 한도 안에서 복습에 포함돼요.' : '제안 닫기를 서버에 저장했어요. 원래 보류는 유지돼요.'));
    }
    if (!review || ['dismissed', 'accepted'].includes(review.status)) {
      const source = attribution?.analysisId || item.sources?.find(row => !row.valid)?.analysis_id || item.source_analysis_id;
      const explanation = input('내가 말하려던 뜻', `intent-${item.id}`, '', true, 1500);
      explanation.control.dataset.intentExplanation = '';
      const save = button('의도 설명 저장', async () => {
        const value = explanation.control.value.trim();
        if (!value) { host.notify('말하려던 뜻을 짧게 적어 주세요.'); explanation.control.focus(); return; }
        await act('learning_review_submit', item, { p_item_id: item.id, p_expected_revision: item.revision, p_source_analysis_id: source, p_explanation: value });
      }); save.dataset.action = 'submit-intent'; save.disabled = pending(item) || !source;
      if (!source) section.append(text('p', '현재 유효한 원본 피드백을 확인한 뒤 의도 설명을 보낼 수 있어요.', 'help'));
      section.append(explanation.field, save);
    }
    article.append(section);
  }
  function renderSchedule(article, item) {
    if (host.suppressed(item) || !item.enrolled || item.status === 'candidate') return;
    const schedule = scheduleFor(item.id), recalls = data.recalls.filter(row => row.item_id === item.id);
    const section = detail('시간 두고 회상 · 선택');
    section.append(text('p', '원할 때 1·3·7일 뒤 가리고 회상을 선택해요. 즉시 따라 말하기와 별도로 자기보고를 저장하며 자동 숙달 평가를 하지 않아요.', 'help'));
    if (schedule?.enabled) section.append(status(`${schedule.days}일 간격 · 다음 회상 ${stamp(schedule.due_at)} · 서버 확인`));
    else section.append(text('p', '시간을 둔 회상은 아직 켜지 않았어요.', 'help'));
    const goal = input('이 표현으로 연습할 목표 · 선택', `goal-${item.id}`, schedule?.goal || '', false, 240);
    section.append(goal.field);
    const actions = document.createElement('div'); actions.className = 'learning-actions';
    for (const days of [1, 3, 7]) {
      const choose = button(`${days}일 뒤 회상`, () => act('learning_schedule_config', item, { p_item_id: item.id, p_expected_revision: schedule?.revision || 0, p_days: days, p_goal: goal.control.value.trim() }));
      choose.dataset.action = `recall-${days}-days`; choose.disabled = pending(item); actions.append(choose);
    }
    if (schedule?.enabled) {
      const due = Number.isFinite(Date.parse(schedule.due_at)) && Date.parse(schedule.due_at) <= Date.now();
      const recall = button(due ? '가리고 회상하기' : '회상 예정 · 시간이 되면 열려요', () => host.startRecall(item.id, recall));
      recall.dataset.action = 'start-delayed-recall'; recall.disabled = pending(item) || !due;
      if (!article.querySelector('[data-action="start-delayed-recall"]')) actions.append(recall);
      actions.append(action('예약 끄기', 'disable-recall', item, 'learning_schedule_config', { p_item_id: item.id, p_expected_revision: schedule.revision, p_days: null, p_goal: schedule.goal || '' }));
    }
    section.append(actions);
    if (recalls.length) {
      section.append(text('small', `시간을 둔 회상 자기보고 ${recalls.length}회 · 즉시 연습과 별도`));
      for (const recall of recalls.slice().sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at))).slice(0, 3)) section.append(text('p', `${stamp(recall.occurred_at)} · ${ratings[recall.rating] || '기록 확인 필요'}`, 'help'));
    }
    article.append(section);
  }
  function renderImports(article, item) {
    const rows = (data.imports || []).filter(row => row.item_id === item.id);
    if (!rows.length) return;
    const section = detail('복원한 이전 이력 · 재검증 전');
    section.append(text('p', '백업의 설명·자기보고·선택을 보관했어요. 현재 발화 근거와 재검토 제안은 다시 확인하며, 복원 기록으로 추천 포함이나 숙달을 판정하지 않아요.', 'help'));
    for (const row of rows) {
      const value = row.payload || {};
      const labels = { reviews: '의도 보충 설명', schedules: '선택한 회상 예약', recalls: '시간을 둔 회상 자기보고', usage: '활용 관찰 이력', weekly_goals: '선택했던 주간 목표' };
      section.append(text('small', `${labels[row.kind] || '이전 이력'} · 복원 파일 기록`));
      const description = value.explanation || value.goal || (value.rating ? ratings[value.rating] : value.days ? `${value.days}일 간격` : value.review_status ? ({ confirmed: '내가 근거를 확인했음', rejected: '내가 근거와 다르다고 표시했음', unreviewed: '내 확인 전' })[value.review_status] : '이전 선택을 보관했어요.');
      section.append(text('p', description));
    }
    article.append(section);
  }
  function renderUsage(target, sessionId = null) {
    const rows = data.usage.filter(row => (!sessionId || row.session_id === sessionId) && host.itemOf(row.item_id) && !host.suppressed(host.itemOf(row.item_id)));
    if (!rows.length) return;
    const section = detail('다음 대화의 실제 발화 · 관찰용');
    section.append(text('p', '표현이 나타난 발화를 확인하는 관찰 기록이에요. 사람의 표본 검토 전이며 사용할 기회와 학습 성과는 아직 판단하지 않았어요. 성공·실패나 숙달을 뜻하지 않아요.', 'help'));
    for (const row of rows.slice(0, 12)) {
      const item = host.itemOf(row.item_id), card = text('article', '', 'feedback-item'); card.dataset.usageId = row.id; card.dataset.itemId = item.id;
      card.append(text('p', item.expression, 'improved'));
      const quotes = (row.evidence || []).filter(event => event.speaker === 'user' && row.evidence_ids?.includes(event.id));
      if (row.kind === 'observed' && quotes.length) {
        card.append(text('small', '실제 사용자 발화'), text('blockquote', quotes.map(event => event.text).join(' / ')));
        card.append(text('p', modes[row.mode] || modes.undetermined, 'help'));
        if (row.mode !== 'undetermined' && row.mode_evidence_ids?.length) {
          const evidence = detail('사용 맥락의 근거');
          for (const event of row.mode_evidence || (row.evidence || []).filter(event => row.mode_evidence_ids.includes(event.id))) evidence.append(text('blockquote', `${event.speaker === 'user' ? '나' : '상대'}: ${event.text}`));
          card.append(evidence);
        }
      } else card.append(text('p', '현재 확인 가능한 발화 근거가 부족해 판단 불가예요.', 'help'));
      card.append(status(({ unreviewed: '내 확인 전', confirmed: '내가 근거를 확인함 · 자기 확인', rejected: '내가 근거와 맞지 않음을 표시함' })[row.review_status] || '내 확인 전'));
      card.append(action('근거가 맞아요', 'confirm-usage', item, 'learning_usage_review', { p_usage_id: row.id, p_expected_revision: row.revision, p_status: 'confirmed' }), action('근거와 달라요', 'reject-usage', item, 'learning_usage_review', { p_usage_id: row.id, p_expected_revision: row.revision, p_status: 'rejected' }));
      section.append(card);
    }
    target.append(section);
  }
  function renderWeekly(target, analysis) {
    if (!analysis?.id || !analysis.content?.learning_plan) return;
    const scope = analysis.content.scope || {};
    const section = detail('이번 주 한 가지 행동 선택'); section.dataset.weeklyAnalysisId = analysis.id;
    section.append(text('p', `${stamp(scope.period_start)} ~ ${stamp(scope.period_end)} · 직전 168시간`, 'help'), text('p', `생성 ${stamp(analysis.generated_at || analysis.created_at)} · 이후 통화는 이 결과에 자동 포함되지 않아요.`, 'help'));
    section.append(text('p', '시간을 둔 회상 자기보고와 확인한 발화 근거를 참고한 제안이에요. 다음 대화에서 해볼 목표를 직접 선택해 주세요.', 'help'));
    const selected = data.weekly_goals.slice().sort((a, b) => String(b.selected_at).localeCompare(String(a.selected_at)))[0];
    for (const [kind, title] of [['keep', '계속 연습할 한 가지'], ['try', '다음 주 시도할 한 가지']]) {
      const proposal = analysis.content.learning_plan[kind], item = host.itemOf(proposal?.item_id);
      if (!proposal?.goal || !item || host.suppressed(item)) continue;
      const card = text('article', '', 'feedback-item'); card.dataset.itemId = item.id;
      card.append(text('h4', title), text('p', proposal.goal), text('p', item.expression, 'improved'));
      const chosen = selected?.analysis_id === analysis.id && selected?.kind === kind;
      if (chosen) {
        card.append(status('선택한 목표 · 서버 확인'));
        const prepare = button('이 목표로 다음 통화 준비', () => host.prepare(item.id)); prepare.dataset.action = 'prepare-weekly-goal'; prepare.disabled = pending(item); card.append(prepare);
        if (selected.call_session_id) card.append(text('p', '이 목표를 준비한 후의 통화 기록이 연결됐어요. 활용·숙달을 뜻하지 않아요.', 'help'));
        if (selected.recall_id) card.append(text('p', '이 목표의 시간을 둔 회상 자기보고가 연결됐어요.', 'help'));
      } else card.append(action('이 목표 선택', `choose-weekly-${kind}`, item, 'learning_weekly_goal_select', { p_analysis_id: analysis.id, p_kind: kind, p_expected_revision: selected?.revision || 0 }));
      section.append(card);
    }
    target.append(section);
  }
  function buildRecall(item, handlers) {
    const schedule = scheduleFor(item.id), cue = practiceCue(item, schedule?.goal);
    const box = text('section', '', 'learning-practice'); box.dataset.itemId = item.id; box.dataset.practiceKind = 'delayed';
    const cueValue = text('p', cue.value, cue.kind === 'source' ? 'original' : 'help'); cueValue.dataset.practiceCue = cue.kind;
    const expression = text('p', item.expression, 'improved'); expression.hidden = true; expression.dataset.practiceExpression = '';
    const state = status(''); state.dataset.practiceStatus = '';
    const intro = text('p', '같은 뜻을 영어로 말해보고, 어땠는지 선택해요.', 'help');
    const note = text('p', '혼자 소리 내어 연습해요 · 녹음·자동 채점 없음', 'help');
    const finish = document.createElement('div'), actions = text('div', '', 'learning-actions');
    const gradeButtons = [];
    let revealed = false, submitting = false;
    const available = () => handlers.current() && !handlers.saved() && !host.suppressed(host.itemOf(item.id)) && !pending(item);
    const reveal = button('표현 다시 보기 · 도움 받기', () => {
      if (!available() || submitting) return;
      revealed = true; expression.hidden = false; reveal.setAttribute('aria-expanded', 'true');
      gradeButtons.find(node => node.dataset.action === 'recall-independent').disabled = true;
      state.textContent = '표현을 확인했어요. 같은 뜻을 내 말로 해보고, 도움이 필요했는지 기록해요.';
    }); reveal.dataset.action = 'reveal-delayed-expression'; reveal.setAttribute('aria-expanded', 'false');
    const save = button('어려움', () => {}); // Stable control for shared pending-state and focus handling.
    for (const [rating, label] of Object.entries(ratings)) {
      const node = rating === 'hard' ? save : button(label, () => {}); node.textContent = label; node.dataset.action = `recall-${rating}`;
      node.onclick = async () => {
        if (node.disabled || !available() || submitting || rating === 'independent' && revealed) return;
        submitting = true; reveal.disabled = true;
        for (const grade of gradeButtons) grade.disabled = true;
        state.textContent = '기기 보관과 서버 저장을 확인하고 있어요.';
        try {
          const result = await host.submit('learning_recall', item, { p_item_id: item.id, p_expected_revision: schedule?.revision || 0, p_rating: rating }, { attemptId: handlers.attemptId });
          if (!handlers.current()) return;
          if (result?.outcome === 'applied') handlers.confirm(result);
          else state.textContent = host.pending(item.id).length ? '기기 보관 확인 · 회상 자기보고 서버 반영 대기' : '저장하지 못했어요. 다시 선택해 주세요.';
        } catch { if (handlers.current()) state.textContent = '서버 저장을 확인하지 못했어요. 동기화 안내에서 다시 확인해 주세요.'; }
        finally {
          submitting = false;
          if (available()) {
            reveal.disabled = false;
            for (const grade of gradeButtons) grade.disabled = grade.dataset.action === 'recall-independent' && revealed;
          }
        }
      };
      gradeButtons.push(node); actions.append(node);
    }
    const close = button('연습 닫기', handlers.close); close.dataset.action = 'close-practice';
    const heading=text('h3','지난 표현, 다시 말해보기'); heading.tabIndex=-1; heading.dataset.action='practice-start';
    box.append(heading, intro, text('small', cue.label), cueValue, expression, reveal, note, actions, state, close, finish);
    return { box, heading, state, save, toggle: reveal, finish, gradeButtons };
  }
  return {
    clear() { data = empty(); unavailable = false; drafts.clear(); requests.clear(); },
    setSnapshot(value, failed = false) { data = value || empty(); unavailable = failed; },
    renderItem(article, item, attribution) { if (unavailable) { article.append(text('p', '회상·재검토 상태를 확인하지 못했어요. 최신 상태를 다시 확인해 주세요.', 'help')); return; } renderReview(article, item, attribution); renderSchedule(article, item); renderImports(article, item); },
    renderUsage, renderWeekly, buildRecall, scheduleFor,
    isDue(id) { const row = scheduleFor(id); return !unavailable && Boolean(row?.enabled && row.due_at && Date.parse(row.due_at) <= Date.now()); },
    acceptedProjection(item, analysis) { return data.reviews.filter(row => row.status === 'accepted' && row.accepted_item_id === item.id && row.source_analysis_id === analysis.id && row.source_current !== false).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]?.proposal || null; },
    reason(item) { const value = data.recommendation_reasons?.[item.id]; return reasons[value] || (typeof value === 'string' ? value : ''); },
    recommendedIds(fallback) { return unavailable ? fallback : data.personalized_item_ids?.length ? data.personalized_item_ids : fallback; },
    exportData() { return data; },
    rebase(rpc, args, item) {
      let revision = item.revision;
      if (rpc === 'learning_review_decide') revision = data.reviews.find(row => row.id === args.p_review_id)?.revision;
      if (['learning_schedule_config', 'learning_recall'].includes(rpc)) revision = scheduleFor(item.id)?.revision || 0;
      if (rpc === 'learning_usage_review') revision = data.usage.find(row => row.id === args.p_usage_id)?.revision;
      if (rpc === 'learning_weekly_goal_select') revision = data.weekly_goals.slice().sort((a, b) => String(b.selected_at).localeCompare(String(a.selected_at)))[0]?.revision || 0;
      return { ...args, p_expected_revision: revision ?? args.p_expected_revision };
    }
  };
}
