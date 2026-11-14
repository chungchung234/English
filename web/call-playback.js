// A rejected play() needs a new user gesture. Keep the same stream and floor's
// mute state; a gesture retries playback rather than starting another call.
export function createCallPlayback({ element, eventTarget = globalThis.document,
  isCurrent = () => true, onBlocked = () => {}, onRecovered = () => {} } = {}) {
  let stream = null, disposed = false, blocked = false, pending = false, revision = 0;
  const valid = version => !disposed && revision === version && isCurrent();
  async function play() {
    if (disposed || pending || !stream || !isCurrent()) return false;
    const version = revision; pending = true;
    try {
      await element.play();
      if (!valid(version)) return false;
      const recovered = blocked; blocked = false;
      if (recovered) onRecovered();
      return true;
    } catch (error) {
      if (!valid(version)) return false;
      if (!blocked) { blocked = true; onBlocked(error); }
      return false;
    } finally { if (valid(version)) pending = false; }
  }
  const gesture = event => {
    if (event?.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    if (blocked) void play();
  };
  eventTarget?.addEventListener?.('pointerdown', gesture);
  eventTarget?.addEventListener?.('keydown', gesture);
  return {
    attach(value) {
      if (disposed || !value || !isCurrent() || stream === value) return;
      stream = value; revision++; pending = false; blocked = false;
      element.srcObject = value; void play();
    },
    retry: play,
    get blocked() { return blocked; },
    dispose() {
      if (disposed) return;
      disposed = true; revision++; pending = false; blocked = false; stream = null;
      eventTarget?.removeEventListener?.('pointerdown', gesture);
      eventTarget?.removeEventListener?.('keydown', gesture);
    },
  };
}
