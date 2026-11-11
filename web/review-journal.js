import { deviceTimeZone, sessionTimeZone } from './conversation-time.js';

const names = { alex: 'Alex', mia: 'Mia', juno: 'Juno' };
const kinds = { error: '교정', alternative: '대안', reusable: '활용 제안', positive: '잘 쓴 표현' };
const focuses = { lexical: '표현', grammar: '문법', pattern: '패턴', pragmatics: '상황 표현', interaction: '대화 표현', discourse: '말의 구성' };
const forms = { collocation: '연어', phrasal_verb: '구동사', idiom: '관용어', colloquial: '일상 구어', slang: '속어', reduction: '축약형' };
// One short public label; the richer learning classification stays in the data.
export const expressionType = item => ['error', 'alternative', 'positive'].includes(item.kind) ? kinds[item.kind] : forms[item.learning?.form] || focuses[item.learning?.focus] || '표현';
const natural = 'Natural English conversation about everyday life';
const node = (tag, value = '', className = '') => {
  const el = document.createElement(tag); el.textContent = value; el.className = className; return el;
};
// The hosting build embeds these supplied SVG assets in the shipped HTML.
// Clone those sources so runtime icons never point to an uncopied asset path.
const icon = name => document.querySelector(`[data-review-icon="${name}"]`).cloneNode();
const unwrap = result => Array.isArray(result) && result.length === 1 ? result[0] : result;
export function reviewDay(session, fallback = deviceTimeZone()) {
  const zone = sessionTimeZone(session, fallback).zone;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(session.created_at));
  return ['year', 'month', 'day'].map(key => parts.find(p => p.type === key).value).join('-');
}
export function reviewDayLabel(day) {
  const [year, month, date] = day.split('-').map(Number);
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date(Date.UTC(year, month - 1, date)));
}
export function reviewGroupLabel(day, year = day.slice(0, 4)) {
  return `${day.slice(0, 4) === year ? '' : `${day.slice(0, 4)}년 `}${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일`;
}
const timeLabel = session => new Intl.DateTimeFormat('ko-KR', { timeZone: sessionTimeZone(session).zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(session.created_at));
const meta = session => `${names[session.companion_id] || session.companion_id} · ${timeLabel(session)}`;

// Own-account, all-companion review navigation. No browser action here changes
// enrollment, practice, mastery, conversation memory, or automatic retry policy.
export function createReviewJournal({ root, context, rpc, edge, allRows, setMode, openView, notice }) {
  let identity = '', lifetime = 0, version = 0, navigation = 0, calls = [], next = null, loaded = false;
  let tab = 'dates', through = '', view = 'list', current = null, sourceIds = [], selectedKey = '';
  let listY = 0, noteY = 0, focusKey = '', noteFocusKey = '', busy = false, error = '', poll = null;
  const writes = new Set(), uncertain = new Set();
  const ownerToken = () => ({ scope: identity, lifetime });
  const valid = (owner, request) => owner.scope === identity && owner.scope === context()?.scope && owner.lifetime === lifetime && (request === undefined || request === version);
  const active = () => context()?.active === true;
  function clear() {
    identity = ''; lifetime++; version++; navigation++; calls = []; next = null; loaded = false;
    tab = 'dates'; through = ''; view = 'list'; current = null; selectedKey = ''; listY = noteY = 0; focusKey = noteFocusKey = ''; error = ''; busy = false;
    writes.clear(); uncertain.clear(); clearTimeout(poll); root.replaceChildren();
  }
  function own() { const scope = context()?.scope || ''; if (scope !== identity) { clear(); identity = scope; } return Boolean(scope); }
  function button(label, action, className = 'text-button') {
    const el = node('button', label, className); el.type = 'button';
    if (className.includes('forward-link')) { const arrow = icon('chevron'); arrow.className = 'action-arrow'; arrow.setAttribute('aria-hidden', 'true'); el.append(arrow); }
    el.onclick = async () => {
      if (el.disabled || context()?.busy) return;
      try { await action(el); } catch { if (identity === context()?.scope) notice('완료 여부를 확인하지 못했어요. 다시 확인해 주세요.'); }
    }; return el;
  }
  function restore(y, key = '', bookmarkKey = '', noteKey = '') {
    const owner = ownerToken(), nav = navigation;
    requestAnimationFrame(() => {
      if (!valid(owner) || nav !== navigation || !active()) return;
      window.scrollTo({ top: y, behavior: 'instant' });
      [...root.querySelectorAll('[data-expression-key]')].find(el => el.dataset.expressionKey === key)?.focus({ preventScroll: true });
      if (bookmarkKey) [...root.querySelectorAll('[data-bookmark-key]')].find(el => el.dataset.bookmarkKey === bookmarkKey)?.focus({ preventScroll: true });
      if (noteKey) [...root.querySelectorAll('[data-note-expression]')].find(el => el.dataset.noteExpression === noteKey)?.focus({ preventScroll: true });
    });
  }
  function schedule() {
    clearTimeout(poll);
    if (active() && view === 'list' && calls.some(call => call.status === 'pending')) poll = setTimeout(() => { if (active() && view === 'list') void load({ quiet: true }); }, 10000);
  }
  async function load({ append = false, quiet = false } = {}) {
    if (!own()) return;
    const owner = ownerToken(), request = ++version, cursor = append ? next : null;
    busy = true; error = ''; if (!quiet) render();
    try {
      const data = unwrap(await rpc('review_journal', { p_before: cursor?.before || null, p_before_id: cursor?.before_id || null, p_through: through || null, p_time_zone: deviceTimeZone(), p_saved: tab === 'saved', p_limit: 12 }));
      if (!valid(owner, request)) return;
      if (!Array.isArray(data?.calls)) throw Error('Invalid journal');
      const preservePages = quiet && tab !== 'saved' && data.next && data.calls.length;
      const overlaps = data.calls.some(fresh => calls.some(old => old.session.id === fresh.session.id));
      if (append || preservePages) {
        const boundary = data.next;
        // Refresh the authoritative first-page range, including removals. Keep
        // already loaded older pages only while the result is still paginated.
        const older = append ? calls : calls.filter(call => Date.parse(call.session.created_at) < Date.parse(boundary.before) || Date.parse(call.session.created_at) === Date.parse(boundary.before) && call.session.id < boundary.before_id);
        const merged = new Map(older.map(call => [call.session.id, call]));
        for (const call of data.calls) merged.set(call.session.id, call);
        calls = [...merged.values()].sort((a, b) => b.session.created_at.localeCompare(a.session.created_at) || b.session.id.localeCompare(a.session.id));
      } else calls = data.calls;
      if (!quiet || !loaded || !preservePages || !overlaps) next = data.next;
      loaded = true;
    } catch { if (valid(owner, request)) error = '복습 내용을 불러오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.'; }
    finally {
      if (valid(owner, request)) {
        busy = false; const y = window.scrollY, focused = root.contains(document.activeElement) ? document.activeElement.id : '';
        render(); if (quiet) restore(y);
        if (focused && active() && view === 'list') document.getElementById(focused)?.focus({ preventScroll: true });
        schedule();
      }
    }
  }
  function bookmark(call, item, full = false) {
    const writeKey = `${call.session.id}|${item.key}`;
    const el = button(full ? (item.saved ? '저장됨' : '표현 저장') : '', async clicked => {
      const owner = ownerToken(), nav = navigation;
      if (writes.has(writeKey)) return;
      writes.add(writeKey); clicked.disabled = true;
      const wanted = !item.saved;
      clicked.setAttribute('aria-label', '저장 확인 중');
      try {
        if (uncertain.has(writeKey)) {
          const fresh = unwrap(await rpc('review_note', { p_session_id: call.session.id }));
          if (!valid(owner)) return;
          if (fresh?.session?.id !== call.session.id || !Array.isArray(fresh.expressions)) throw Error('Unconfirmed bookmark');
          calls = calls.map(c => c.session.id === fresh.session.id ? fresh : c);
          if (current?.session.id === fresh.session.id) current = fresh;
          uncertain.delete(writeKey); notice('현재 저장 상태를 확인했어요.'); return;
        }
        const result = unwrap(await rpc('review_bookmark', { p_session_id: call.session.id, p_expression_key: item.key, p_saved: wanted, p_expected_revision: item.bookmark_revision }));
        if (!valid(owner)) return;
        if (result?.saved !== wanted || !Number.isInteger(result.revision)) throw Error('Unconfirmed bookmark');
        for (const c of [...calls, current].filter(Boolean)) if (c.session.id === call.session.id) {
          for (const entry of c.expressions) if (entry.key === item.key && entry.bookmark_revision <= result.revision) { entry.saved = result.saved; entry.bookmark_revision = result.revision; }
        }
        if (tab === 'saved' && !wanted) calls = calls.filter(c => c.expressions.some(entry => entry.saved));
        notice(wanted ? '표현을 저장했어요.' : '저장을 해제했어요.');
      } catch {
        if (valid(owner)) {
          notice('저장 상태를 확인하지 못했어요. 최신 상태를 다시 확인해 주세요.');
          // Do not invent an acknowledged save or silently replay stale intent.
          loaded = false;
          uncertain.add(writeKey);
        }
      } finally {
        if (valid(owner)) { writes.delete(writeKey); if (nav === navigation) { const y = window.scrollY; render(); restore(y, '', writeKey); } }
      }
    }, full ? 'primary-button journal-save' : 'journal-bookmark');
    el.prepend(icon('bookmark-simple'));
    el.dataset.saved = String(item.saved);
    el.dataset.bookmarkKey = writeKey;
    el.setAttribute('aria-pressed', String(item.saved));
    el.setAttribute('aria-label', `${uncertain.has(writeKey) ? '저장 상태 다시 확인' : item.saved ? '저장 해제' : '표현 저장'}: ${item.expression}`);
    if (uncertain.has(writeKey) && full) el.lastChild.textContent = '저장 상태 다시 확인';
    el.disabled = writes.has(writeKey);
    return el;
  }
  function mode(value) { setMode(value, { backLabel: value === 'journal-source' ? (selectedKey ? '표현 상세' : '학습 노트') : '복습 목록' }); }
  async function show() {
    if (!own()) return;
    navigation++; view = 'list'; current = null; mode('hub'); openView(); render(); restore(listY, focusKey);
    if (!focusKey) document.getElementById('review-title')?.focus({ preventScroll: true });
    await load({ quiet: loaded });
  }
  function back() {
    if (view === 'source') { navigation++; view = 'note'; mode('journal-note'); render(); restore(noteY, '', '', noteFocusKey); return; }
    navigation++; view = 'list'; current = null; mode('hub'); render(); restore(listY, focusKey); schedule();
    if (!loaded) void load({ quiet: true });
  }
  async function openNote(call, expressionKey = '', { retry = false } = {}) {
    if (!own() || context()?.busy) return;
    if (view === 'list') { listY = window.scrollY; focusKey = `${call.session.id}|${expressionKey}`; }
    const owner = ownerToken(), nav = ++navigation;
    view = 'note'; selectedKey = expressionKey; current = null; mode('journal-note'); render(); window.scrollTo({ top: 0, behavior: 'instant' });
    clearTimeout(poll);
    try {
      if (retry) await edge('review', { sessionId: call.session.id });
      const result = unwrap(await rpc('review_note', { p_session_id: call.session.id }));
      if (!valid(owner) || nav !== navigation || !active()) return;
      if (result?.session?.id !== call.session.id || !Array.isArray(result.expressions)) throw Error('Invalid note');
      current = result; calls = calls.map(c => c.session.id === result.session.id ? result : c); render();
      requestAnimationFrame(() => {
        if (!valid(owner) || nav !== navigation || !active()) return;
        // Replacing a long list can trigger browser scroll anchoring after the
        // request. Start the single-record page at its metadata and heading.
        window.scrollTo({ top: 0, behavior: 'instant' });
        const target = [...root.querySelectorAll('[data-note-expression]')].find(el => el.dataset.noteExpression === expressionKey);
        if (target) { target.focus({ preventScroll: true }); }
        else root.querySelector('h2')?.focus({ preventScroll: true });
      });
    } catch (failure) {
      if (!valid(owner) || nav !== navigation) return;
      current = { ...call, expressions: [], strengths: [], status: 'unavailable' };
      render();
      const waiting = failure?.code === 'ANALYSIS_RETRY_WAIT';
      // Retry deadlines remain server owned; show the concrete error when known.
      notice(waiting ? '학습 노트가 다시 준비될 때까지 잠시 기다려 주세요.' : '최신 학습 노트를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.');
    }
  }
  async function source(ids = []) {
    if (!current) return;
    noteY = window.scrollY; noteFocusKey = document.activeElement?.closest('[data-note-expression]')?.dataset.noteExpression || '';
    const call = current, owner = ownerToken(), nav = ++navigation;
    view = 'source'; sourceIds = ids; mode('journal-source'); root.replaceChildren(node('p', '대화 원문을 불러오고 있어요.', 'loading-copy'));
    try {
      const rows = await allRows('transcript_events', `session_id=eq.${call.session.id}&order=timestamp.asc,id.asc`);
      if (!valid(owner) || nav !== navigation || !active()) return;
      root.replaceChildren();
      root.append(node('h2', '대화 원문'), node('p', '음성을 글로 옮긴 기록이에요.', 'help'));
      let first;
      for (const row of rows.filter(row => row.session_id === call.session.id)) {
        const el = node('section', '', 'transcript-turn'); el.tabIndex = -1;
        el.append(node('p', row.speaker === 'user' ? '나' : names[call.session.companion_id], 'transcript-speaker'), node('p', row.text, 'transcript-text'));
        if (sourceIds.includes(row.id)) { el.dataset.sourceHighlight = ''; first ||= el; }
        root.append(el);
      }
      if (!rows.length) root.append(node('p', '저장된 발화가 없어요.', 'help'));
      if (first) { first.focus({ preventScroll: true }); first.scrollIntoView({ block: 'center', behavior: 'instant' }); }
      else window.scrollTo({ top: 0, behavior: 'instant' });
    } catch { if (valid(owner) && nav === navigation) { root.replaceChildren(node('p', '대화 원문을 불러오지 못했어요.', 'help'), button('다시 불러오기', () => source(ids))); } }
  }
  function renderList() {
    const tabs = node('div', '', 'journal-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '복습 보기');
    for (const [value, label] of [['dates', '날짜별'], ['saved', '저장한 표현']]) {
      const el = button(label, () => { version++; tab = value; loaded = false; calls = []; next = null; listY = 0; void load(); root.querySelector('[aria-selected=true]')?.focus({ preventScroll: true }); }, 'journal-tab');
      el.id = `journal-tab-${value}`; el.tabIndex = value === tab ? 0 : -1;
      el.setAttribute('role', 'tab'); el.setAttribute('aria-selected', String(value === tab)); el.setAttribute('aria-controls', 'journal-calls');
      el.onkeydown = event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const choices = [...tabs.children];
        const target = event.key === 'Home' ? choices[0] : event.key === 'End' ? choices.at(-1) : choices.find(other => other !== el);
        if (target !== el) target.click(); root.querySelector('[aria-selected=true]')?.focus();
      };
      tabs.append(el);
    }
    root.append(tabs);
    const months = node('div', '', 'journal-date-bar');
    const firstDay = through || (calls[0] ? reviewDay(calls[0].session) : reviewDay({ created_at: new Date().toISOString() }));
    months.append(node('strong', `${firstDay.slice(0, 4)}년 ${Number(firstDay.slice(5, 7))}월`));
    const picker = node('label', '', 'journal-date-picker'); picker.append(icon('calendar-blank'));
    const input = document.createElement('input'); input.id = 'journal-through'; input.type = 'date'; input.value = through; input.setAttribute('aria-label', '이 날짜까지의 복습 보기');
    input.onchange = () => { through = input.value; loaded = false; calls = []; next = null; listY = 0; void load(); }; picker.append(input); months.append(picker);
    if (through) months.append(button('최근 날짜', () => { through = ''; loaded = false; calls = []; next = null; void load(); }));
    root.append(months);
    const body = node('div', '', 'journal-calls'); body.id = 'journal-calls'; body.setAttribute('role', 'tabpanel'); body.setAttribute('aria-labelledby', `journal-tab-${tab}`);
    const groups = new Map();
    for (const call of calls) {
      const day = reviewDay(call.session); if (!groups.has(day)) groups.set(day, []); groups.get(day).push(call);
    }
    for (const [day, dayCalls] of [...groups].sort(([a], [b]) => b.localeCompare(a))) {
      const group = node('section', '', 'journal-day'); group.append(node('h2', reviewGroupLabel(day, firstDay.slice(0, 4))));
      for (const call of dayCalls) {
        const section = node('section', '', 'journal-call'); section.dataset.sessionId = call.session.id;
        const heading = node('h3', meta(call.session)); section.append(heading);
        const topic = call.session.scenario && call.session.scenario !== natural ? call.session.scenario : '';
        if (topic) heading.append(node('span', ` · ${topic}`, 'journal-topic-inline'));
        if (!call.session.time_zone) section.append(node('p', '현재 시간대 기준', 'journal-time-zone'));
        else if (sessionTimeZone(call.session).zone !== deviceTimeZone()) section.append(node('p', sessionTimeZone(call.session).zone, 'journal-time-zone'));
        const expressions = tab === 'saved' ? call.expressions.filter(item => item.saved) : call.expressions;
        for (const item of expressions) {
          const row = node('div', '', 'journal-expression');
          const open = button('', () => openNote(call, item.key), 'journal-expression-open');
          open.dataset.expressionKey = `${call.session.id}|${item.key}`;
          open.append(node('span', expressionType(item), 'journal-kind'));
          open.append(node('strong', item.expression, 'journal-english'));
          if (item.meaning) open.append(node('span', item.meaning, 'journal-meaning'));
          const chevron = icon('chevron'); chevron.className = 'journal-chevron'; chevron.setAttribute('aria-hidden', 'true'); open.append(chevron);
          row.append(open, bookmark(call, item));
          section.append(row);
        }
        if (!expressions.length) {
          const label = call.status === 'ready' ? (tab === 'saved' ? '저장한 표현의 최신 출처를 확인해 주세요.' : '이번 통화에서 정리할 표현은 없어요.') : call.status === 'pending' ? '학습 노트 준비 중이에요.' : call.status === 'partial' ? '일부만 남은 통화 기록이에요.' : call.status === 'empty' ? '확인된 내 발화가 없어요.' : '학습 노트를 다시 확인해 주세요.';
          section.append(node('p', label, 'help'), button('통화 학습 노트 보기', () => openNote(call), 'text-button link-button forward-link'));
        }
        group.append(section);
      }
      body.append(group);
    }
    if (busy) { const loading = node('p', '복습 내용을 불러오고 있어요.', 'loading-copy'); loading.setAttribute('role', 'status'); body.append(loading); }
    if (error) body.append(node('p', error, 'help'), button('다시 불러오기', () => load({ append: calls.length > 0 && next !== null })));
    else if (!busy && !calls.length) body.append(node('p', tab === 'saved' ? '저장한 표현이 아직 없어요. 날짜별 목록에서 책갈피를 눌러 보관해 보세요.' : through ? '이 날짜 이전의 통화가 없어요.' : '통화를 마치면 날짜별로 복습할 수 있어요.', 'empty-state'));
    if (next && !error) { const more = button('이전 기록 더 보기', () => load({ append: true })); more.disabled = busy; body.append(more); }
    root.append(body);
  }
  function renderNote() {
    if (!current) { root.append(node('p', '학습 노트를 불러오고 있어요.', 'loading-copy')); return; }
    const call = current;
    if (selectedKey) { renderExpression(call); return; }
    const title = node('h2', `${names[call.session.companion_id]}와의 학습 노트`, 'journal-note-title'); title.tabIndex = -1;
    root.append(title, node('p', `${reviewDayLabel(reviewDay(call.session))} · ${timeLabel(call.session)}`, 'journal-note-meta'));
    if (call.status !== 'ready') {
      const text = call.status === 'pending' ? '학습 노트를 준비하고 있어요.' : call.status === 'partial' ? '일부만 남은 기록이에요. 대화 원문에서 저장 상태를 확인해 주세요.' : call.status === 'empty' ? '확인된 내 발화가 없어 정리할 내용이 없어요.' : '최신 학습 노트를 확인하지 못했어요.';
      root.append(node('p', text, 'help'), button('상태 다시 확인', () => openNote(call)));
      if (call.status === 'unavailable') root.append(button('학습 노트 준비하기', () => openNote(call, '', { retry: true })));
    } else {
      if (call.strengths?.length) {
        const strengths = node('section', '', 'journal-strengths'); strengths.append(node('h3', '잘한 점'));
        for (const item of call.strengths) strengths.append(node('p', item.text), button('대화에서 보기', () => source(item.evidence_ids), 'text-button link-button forward-link'));
        root.append(strengths);
      }
      for (const item of call.expressions) {
        const section = node('section', '', 'journal-note-expression'); section.dataset.noteExpression = item.key; section.tabIndex = -1;
        section.append(node('span', kinds[item.kind] || kinds.alternative, 'journal-kind'));
        if (item.original) section.append(node('p', '내가 한 말 · 자동 전사', 'journal-label'), node('p', item.original, 'journal-original'));
        section.append(node('h3', item.expression, 'journal-note-english'));
        if (item.meaning) section.append(node('p', item.meaning, 'journal-meaning'));
        if (item.reason) section.append(node('p', item.reason, 'journal-reason'));
        const actions = node('div', '', 'journal-note-actions'); actions.append(bookmark(call, item, true), button('대화에서 보기', () => source(item.evidence_ids), 'text-button link-button forward-link'));
        section.append(actions); root.append(section);
      }
      if (!call.expressions.length) root.append(node('p', '이번 통화에서 정리할 표현은 없어요.', 'help'));
    }
    root.append(button('대화 원문 보기', () => source()));
  }
  function renderExpression(call) {
    root.append(node('p', `${names[call.session.companion_id]} · ${reviewGroupLabel(reviewDay(call.session), String(new Date().getFullYear()))} · ${timeLabel(call.session)}`, 'journal-expression-meta'));
    const item = call.status === 'ready' && call.expressions.find(entry => entry.key === selectedKey);
    if (!item) {
      const unavailable = call.status === 'ready';
      const title = node('h2', call.status === 'pending' ? '표현을 준비하고 있어요.' : '표현을 확인할 수 없어요.', 'journal-note-title'); title.tabIndex = -1;
      root.append(title, node('p', unavailable ? '원문이나 학습 노트가 바뀌었을 수 있어요. 목록에서 다시 확인해 주세요.' : call.status === 'pending' ? '학습 노트를 준비하고 있어요.' : '최신 표현을 불러오지 못했어요.', 'help'));
      root.append(button('상태 다시 확인', () => openNote(call, selectedKey)));
      return;
    }
    const section = node('section', '', 'journal-single-expression'); section.dataset.noteExpression = item.key; section.tabIndex = -1;
    section.append(node('h2', item.expression, 'journal-expression-title'), node('p', expressionType(item), 'journal-expression-type'));
    if (item.meaning) section.append(node('p', item.meaning, 'journal-expression-meaning'));
    const learning = item.learning || {}, quotation = item.kind === 'positive' ? item.original : learning.source_quote || item.original;
    if (quotation) {
      const quote = node('div', '', 'journal-expression-quote');
      quote.append(node('p', item.kind !== 'positive' && learning.source_is_question ? '내가 물어본 말' : '내가 한 말 · 자동 전사', 'journal-label'), node('p', quotation, 'journal-original'));
      section.append(quote);
    }
    const usage = learning.usage || item.reason;
    if (usage) {
      section.append(node('h3', item.kind === 'positive' ? '잘 쓴 점' : '사용 설명', 'journal-detail-heading'), node('p', usage, 'journal-detail-copy'));
      if (learning.usage && item.reason && item.reason.trim() !== learning.usage.trim() && ['error', 'alternative'].includes(item.kind)) section.append(node('p', item.reason, 'journal-detail-copy'));
    }
    const register = { informal: '편한 사이', formal: '격식을 갖춘 표현' }[learning.register];
    if (register) section.append(node('p', register, 'journal-register'));
    if (learning.example?.prompt && learning.example?.response) {
      section.append(node('h3', '사용 예', 'journal-detail-heading'));
      const example = node('div', '', 'journal-example');
      example.append(node('p', `A: ${learning.example.prompt}`), node('p', `B: ${learning.example.response}`)); section.append(example);
    }
    if (learning.alternative && learning.alternative !== item.expression) section.append(node('h3', '다른 표현', 'journal-detail-heading'), node('p', learning.alternative, 'journal-detail-alternative'));
    const actions = node('div', '', 'journal-note-actions'); actions.append(bookmark(call, item, true), button('대화에서 보기', () => source(item.evidence_ids), 'text-button link-button forward-link'));
    section.append(actions); root.append(section);
  }
  function render() {
    if (!identity || view === 'source') return;
    root.replaceChildren(); root.dataset.view = view;
    if (view === 'list') renderList(); else renderNote();
  }
  window.addEventListener('online', () => { if (active() && view === 'list') void load({ quiet: true }); });
  return { show, back, clear, load, isOpen: () => ['journal-note', 'journal-source'].includes(context()?.mode) };
}
