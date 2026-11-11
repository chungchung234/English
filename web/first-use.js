// Optional guidance is scoped to an authenticated account in this browser.
// Reading or skipping a guide never starts a call or requests microphone access.
export function createFirstUse({ document, storage = globalThis.localStorage, getScope, isBusy, home }) {
  const $ = id => document.getElementById(id);
  const dialog = $('usage-guide');
  const steps = [
    { target: 'companion-selector', title: '친구를 골라볼까요?', copy: '이름을 누르거나 좌우로 넘겨 보세요. 친구마다 대화와 기억이 따로 이어져요.' },
    { target: 'start-call', title: '준비되면 통화를 눌러요', copy: '마이크를 허용하면 AI가 먼저 인사해요. 막히면 힌트, 빠르면 속도를 바꿔 보세요.' }
  ];
  let owner = null, state = {}, step = 0, returnFocus = null, frame = 0;
  function save() { if (owner) try { storage.setItem('loop.first-use:v1:' + owner, JSON.stringify(state)); } catch { /* Guidance also works without storage. */ } }
  function paint() {
    $('first-use-intro').hidden = !owner || Boolean(state.connected || state.introDismissed || state.guide);
    $('first-use-dismiss').hidden = $('first-use-intro').hidden;
    $('first-note-guide').hidden = !owner || Boolean(state.noteRead);
  }
  function position() {
    if (!dialog.open) return;
    const target = $(steps[step].target), rect = target.getBoundingClientRect();
    const bubble = $('guide-bubble'), spot = $('guide-spotlight');
    const viewport = globalThis.visualViewport;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    const offsetTop = viewport?.offsetTop || 0, offsetLeft = viewport?.offsetLeft || 0;
    bubble.style.width = Math.min(360, width - 32) + 'px';
    bubble.style.maxHeight = Math.max(120, height - 32) + 'px';
    const bubbleHeight = bubble.getBoundingClientRect().height;
    let top = rect.bottom + 14;
    if (top + bubbleHeight > offsetTop + height - 16) top = rect.top - bubbleHeight - 14;
    top = Math.max(offsetTop + 16, Math.min(top, offsetTop + height - bubbleHeight - 16));
    bubble.style.left = Math.max(offsetLeft + 16, Math.min(rect.left, offsetLeft + width - bubble.offsetWidth - 16)) + 'px';
    bubble.style.top = top + 'px';
    Object.assign(spot.style, { left: rect.left - 5 + 'px', top: rect.top - 5 + 'px', width: rect.width + 10 + 'px', height: rect.height + 10 + 'px' });
  }
  function schedulePosition() { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); }
  function renderStep() {
    $('guide-step').textContent = `${step + 1} / ${steps.length}`;
    $('guide-title').textContent = steps[step].title;
    $('guide-copy').textContent = steps[step].copy;
    $('guide-previous').hidden = step === 0;
    $('guide-next').textContent = step === steps.length - 1 ? '준비됐어요' : '다음';
    $(steps[step].target).scrollIntoView({ block: 'nearest', behavior: 'instant' });
    position(); $('guide-title').focus({ preventScroll: true }); schedulePosition();
  }
  function close(result) {
    if (!dialog.open) return;
    if (result && owner === getScope()) { state.guide = result; save(); }
    dialog.close(); cancelAnimationFrame(frame); paint();
    const focus=returnFocus?.isConnected&&returnFocus.getClientRects().length?returnFocus:$('usage-guide-open');
    if(focus.getClientRects().length)focus.focus({preventScroll:true});
  }
  function open() {
    if (!owner || owner !== getScope() || isBusy() || dialog.open) return;
    returnFocus = document.activeElement;
    document.querySelectorAll('dialog[open]').forEach(node => node.close());
    home(); step = 0; dialog.showModal(); renderStep();
  }
  $('usage-guide-open').onclick = $('usage-guide-replay').onclick = open;
  $('guide-next').onclick = () => { if (step === steps.length - 1) close('completed'); else { step++; renderStep(); } };
  $('guide-previous').onclick = () => { step = Math.max(0, step - 1); renderStep(); };
  $('guide-skip').onclick = $('guide-close').onclick = () => close('skipped');
  dialog.addEventListener('cancel', event => { event.preventDefault(); close('skipped'); });
  $('first-use-dismiss').onclick = () => { state.introDismissed = true; save(); paint(); };
  $('first-note-dismiss').onclick = () => { state.noteRead = true; save(); paint(); };
  addEventListener('resize', schedulePosition);
  addEventListener('scroll', schedulePosition, { passive: true });
  globalThis.visualViewport?.addEventListener('resize', schedulePosition);
  globalThis.visualViewport?.addEventListener('scroll', schedulePosition);
  return {
    bind() {
      const next = getScope(); if (next === owner) return;
      close(); owner = next; state = {};
      if (owner) try { const value = JSON.parse(storage.getItem('loop.first-use:v1:' + owner) || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) state = value; } catch { /* Optional preferences. */ }
      paint();
    },
    connected() { if (owner && owner === getScope()) { state.connected = true; save(); paint(); } },
    noteOpened() { paint(); },
    close: () => close(),
    reset() { close(); owner = null; state = {}; paint(); }
  };
}

// Keep previously rendered data during refresh; only a first load needs placeholders.
export function createContentLoading({ root, skeleton, status, retry }) {
  let revision = 0, timer;
  function reset() {
    revision++; clearTimeout(timer); root.setAttribute('aria-busy', 'false');
    root.dataset.initialLoading = 'false'; skeleton.hidden = status.hidden = true;
    if (retry) retry.hidden = true;
  }
  function begin() {
    const request = ++revision, initial = !root.childElementCount;
    let settled = false; clearTimeout(timer);
    root.setAttribute('aria-busy', 'true'); root.dataset.initialLoading = String(initial);
    skeleton.hidden = status.hidden = true; if (retry) retry.hidden = true;
    timer = setTimeout(() => {
      if (request !== revision) return;
      skeleton.hidden = !initial; status.hidden = false;
      status.textContent = initial ? '불러오고 있어요.' : '최신 내용을 확인하고 있어요.';
    }, 250);
    return error => {
      if (settled || request !== revision) return;
      settled = true; clearTimeout(timer); root.setAttribute('aria-busy', 'false');
      root.dataset.initialLoading = 'false'; skeleton.hidden = true;
      status.hidden = !error; status.textContent = error ? '불러오지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.' : '';
      if (retry) retry.hidden = !error;
    };
  }
  return { begin, reset };
}

export function microphoneHelp(error) {
  const messages = {
    NotAllowedError: ['마이크 사용을 허용해 주세요', '브라우저의 사이트 설정에서 마이크를 허용한 뒤 다시 시도해 주세요.'],
    SecurityError: ['마이크 사용을 허용해 주세요', '브라우저의 사이트 설정에서 마이크 권한과 보안 연결을 확인해 주세요.'],
    NotFoundError: ['마이크를 찾지 못했어요', '마이크가 연결되어 있는지 확인한 뒤 다시 시도해 주세요.'],
    NotReadableError: ['마이크를 사용할 수 없어요', '다른 앱에서 마이크를 사용 중인지 확인하고 다시 시도해 주세요.'],
    OverconstrainedError: ['마이크 설정을 확인해 주세요', '사용할 수 있는 마이크를 선택한 뒤 다시 시도해 주세요.']
  };
  return messages[error?.name] || null;
}
