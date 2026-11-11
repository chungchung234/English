const text = (tag, value, className) => {
  const node = document.createElement(tag); node.textContent = value || '';
  if (className) node.className = className;
  return node;
};
const expressionKey = value => String(value || '').toLowerCase().replace(/[\p{P}]/gu, ' ').replace(/\s+/g, ' ').trim();
const validId = value => typeof value === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
const renders = new WeakMap();

function preserveReadingPosition(root, update) {
  const bounds = root.getBoundingClientRect();
  const visible = root.isConnected && root.getClientRects().length && bounds.bottom > 0 && bounds.top < window.innerHeight;
  if (!visible) { update(); return; }
  const top = window.scrollY;
  const header = document.getElementById('session-review-header')?.getBoundingClientRect();
  const readingTop = Math.max(0, Math.min(header?.bottom || 0, window.innerHeight / 2));
  // Anchor the content currently being read, including a source link in a
  // partially visible card. The card's own top may stay still when a quote is
  // inserted above that link, so it is not a sufficient anchor on its own.
  const anchor = top > 0 ? [...root.querySelectorAll('h2, .feedback-sentence, .feedback-reason, .feedback-source-quote p, [data-feedback-source], summary')].find(node => {
    const rect = node.getBoundingClientRect();
    return rect.height > 0 && rect.width > 0 && rect.bottom > readingTop && rect.top < window.innerHeight;
  }) : null;
  const before = anchor?.getBoundingClientRect().top;
  update();
  if (top === 0) window.scrollTo({ top: 0, behavior: 'instant' });
  else if (anchor?.isConnected) {
    const movement = anchor.getBoundingClientRect().top - before;
    if (movement) window.scrollBy({ top: movement, behavior: 'instant' });
  }
}

// Session feedback is a reading surface. It does not enroll, defer or mark a
// practice attempt when the learner reads it or leaves the page.
export function renderSessionFeedback(target, analysis, { getRows = () => [], onSource = () => {}, excludedExpressions = [] } = {}) {
  if (!target || !analysis?.session_id || !analysis.content) return null;
  const excluded = new Set(excludedExpressions.map(expressionKey));
  const signature = JSON.stringify([analysis.id, analysis.session_id, analysis.content, [...excluded].sort()]);
  const previous = renders.get(target);
  if (previous?.signature === signature && previous.root.parentNode === target) return previous.root;
  const root = text('div', '', 'session-feedback'); root.dataset.sessionFeedback = ''; root.dataset.analysisId = analysis.id || '';
  const record = { signature, root }; renders.set(target, record);
  const content = analysis.content;
  const isCurrent = () => renders.get(target) === record && root.parentNode === target;
  const evidence = (card, ids, quoted = false) => {
    const allowed = [...new Set((ids || []).filter(validId))];
    if (!allowed.length) return;
    if (quoted) {
      const quote = text('blockquote', '', 'feedback-source-quote'); quote.dataset.sourceQuote = '';
      quote.hidden = true; card.append(quote);
      Promise.resolve().then(() => getRows(allowed)).then(rows => {
        if (!isCurrent()) return;
        const source = (Array.isArray(rows) ? rows : []).filter(row => row.speaker === 'user' && (!row.session_id || row.session_id === analysis.session_id) && allowed.includes(row.id));
        if (!source.length) return;
        preserveReadingPosition(root, () => {
          let remaining = 240, partial = false;
          for (const row of source) {
            const characters = Array.from(row.text || '');
            if (!remaining) { partial = true; break; }
            const shown = characters.slice(0, remaining).join('');
            const clipped = characters.length > remaining;
            quote.append(text('p', shown + (clipped ? '…' : '')));
            remaining -= Math.min(characters.length, remaining); partial ||= clipped;
          }
          if (partial) quote.prepend(text('small', '대화 일부', 'feedback-source-excerpt'));
          quote.hidden = false;
        });
      }).catch(() => { /* The source link remains usable if quotes are unavailable. */ });
    }
    const source = text('button', '원문에서 보기', 'text-button link-button feedback-source-link'); source.type = 'button';
    source.dataset.feedbackSource = ''; source.dataset.evidenceIds = allowed.join(' ');
    source.onclick = () => onSource(allowed, source); card.append(source);
  };
  for (const item of content.strengths || []) {
    if (!item?.text || !item.evidence_ids?.some(validId)) continue;
    const card = text('section', '', 'session-feedback-card'); card.dataset.feedbackKind = 'strength'; card.dataset.feedbackCore = '';
    card.append(text('h2', item.text)); evidence(card, item.evidence_ids, true); root.append(card);
  }
  for (const item of content.corrections || []) {
    if (!item?.improved || excluded.has(expressionKey(item.improved)) || !item.evidence_ids?.some(validId)) continue;
    const card = text('section', '', 'session-feedback-card'); card.dataset.feedbackKind = 'correction'; card.dataset.correctionExpression = item.improved;
    if (item.reconsidered) card.append(text('small', '내 설명을 반영한 표현', 'feedback-reconsidered'));
    const conciseReason = typeof item.reason === 'string' && item.reason.length <= 90 ? item.reason : '';
    card.append(text('h2', conciseReason || (item.category === 'error' ? '이렇게 말하면 더 정확해요' : '이렇게도 말할 수 있어요')));
    const original = text('div', '', 'feedback-sentence'); original.append(text('span', '원문', 'feedback-sentence-label'), text('p', item.original, 'original'));
    const improved = text('div', '', 'feedback-sentence feedback-sentence-improved'); improved.append(text('span', item.category === 'error' ? '수정' : '대안', 'feedback-sentence-label'), text('p', item.improved, 'improved'));
    card.append(original, improved);
    if (item.reason && !conciseReason) card.append(text('p', item.reason, 'feedback-reason'));
    evidence(card, item.evidence_ids); root.append(card);
  }
  const expressions = (content.practice || []).filter(item => (item?.expression || item?.text) && !excluded.has(expressionKey(item.expression || item.text)) && item.evidence_ids?.some(validId));
  if (expressions.length) {
    const details = document.createElement('details'); details.className = 'feedback-reusable'; details.dataset.reusableExpressions = '';
    const summary = text('summary', '');
    summary.append(text('span', '다시 쓸 표현'));
    // A preview explains what is behind the disclosure; the complete list is
    // retained below and is never limited to a fixed learning quota.
    summary.append(text('span', expressions.slice(0, 2).map(item => item.expression || item.text).join(' · '), 'feedback-reusable-preview'));
    details.append(summary);
    for (const item of expressions) {
      const card = text('section', '', 'session-feedback-expression'); card.dataset.feedbackKind = 'expression'; card.dataset.correctionExpression = item.expression || item.text;
      card.append(text('p', item.expression || item.text)); evidence(card, item.evidence_ids); details.append(card);
    }
    root.append(details);
  }
  if (!root.childElementCount) root.append(text('p', '이번 기록에서 학습 노트로 정리할 내용은 없어요. 대화 원문은 그대로 볼 수 있어요.', 'help'));
  // Exposure observes a real, visible first card, not an off-screen whole page.
  if (!root.querySelector('[data-feedback-core]')) root.firstElementChild.dataset.feedbackCore = '';
  target.replaceChildren(root); return root;
}
