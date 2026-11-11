export const SPEED = { min: 0.5, max: 1.5, step: 0.05, default: 0.85 };
export function validSpeed(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= SPEED.min && value <= SPEED.max && Math.abs(value * 20 - Math.round(value * 20)) < 1e-7;
}
export const formatSpeed = value => value.toFixed(2).replace(/0$/, '') + '×';

// Only the server acknowledgement changes the applied value. Output may still
// be playing after response.done, so both generation and playback must be idle.
export function createSpeechSpeed({ initial = SPEED.default, send, changed = () => {}, applied: onApplied = () => {}, failed = () => {}, timeoutMs = 8000 }) {
  let applied = initial, desired = initial, flight = null, available = false, busy = true, disposed = false;
  const sent = new Set();
  const state = () => ({ applied, desired, pending: Boolean(flight) || desired !== applied });
  const publish = () => changed(state());
  function reject(message) {
    const previous = flight;
    if (!previous) return;
    clearTimeout(previous.timer); flight = null;
    if (desired === previous.value) desired = applied;
    publish(); failed(message); flush();
  }
  function flush() {
    if (disposed || !available || busy || flight || desired === applied) return;
    const eventId = 'speech-speed-' + crypto.randomUUID();
    flight = { value: desired, eventId, timer: setTimeout(() => reject('속도 변경을 확인하지 못했어요. 다시 시도해 주세요.'), timeoutMs) };
    sent.add(eventId);
    publish();
    try { send({ event_id: eventId, type: 'session.update', session: { type: 'realtime', audio: { output: { speed: desired } } } }); }
    catch { reject('속도를 변경하지 못했어요. 연결을 확인하고 다시 시도해 주세요.'); }
  }
  return {
    get state() { return state(); },
    request(value) {
      if (disposed || !validSpeed(value)) return false;
      desired = value; publish(); flush(); return true;
    },
    availability(connected, activeResponse) { available = connected; busy = activeResponse; flush(); },
    event(event) {
      if (event.type === 'error' && sent.has(event.error?.event_id)) {
        if (event.error.event_id === flight?.eventId) reject('속도를 변경하지 못했어요. 다시 시도해 주세요.');
        return true; // A settings failure is never a transcription failure.
      }
      if (disposed) return false;
      const value = event.session?.audio?.output?.speed;
      if (event.type === 'session.updated' && validSpeed(value)) {
        if (flight && value === flight.value) {
          clearTimeout(flight.timer); flight = null; applied = value;
          onApplied(value); publish(); flush();
        } else if (!flight && desired === applied && value !== applied) {
          // A late acknowledgement after timeout still describes actual audio.
          applied = desired = value; onApplied(value); publish();
        }
      }
      return false;
    },
    dispose() { disposed = true; clearTimeout(flight?.timer); flight = null; },
  };
}
