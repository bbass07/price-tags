// fullscreen.js — best-effort fullscreen, for browsers that bother to implement it.
//
// Bluefy has a fullscreen mode of its own but forgets it between launches, so
// the app asks for fullscreen itself. The Fullscreen API needs a user gesture
// and is not implemented by every iOS shell, hence the feature reporting: it
// is better to say "this browser cannot" than to leave a toggle that silently
// does nothing.

const el = () => document.documentElement;

const request = (node) =>
  node.requestFullscreen || node.webkitRequestFullscreen || node.webkitRequestFullScreen || node.mozRequestFullScreen || null;

export function isSupported() {
  if (!request(el())) return false;
  // Chrome exposes the method but reports false when a permissions policy
  // forbids it; treat undefined as "no opinion" rather than "no".
  return document.fullscreenEnabled !== false && document.webkitFullscreenEnabled !== false;
}

export function isActive() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

/**
 * Ask for fullscreen and confirm it actually happened.
 *
 * iOS shells are the reason for the second half: WebKit on iPhone exposes no
 * element fullscreen at all, and a shell can expose the method while ignoring
 * the call. A promise that resolves is not evidence, so check the result.
 */
export async function enter() {
  const node = el();
  const fn = request(node);
  if (!fn) throw new Error('this browser has no fullscreen mode for web pages');
  await fn.call(node);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (!isActive()) throw new Error('the browser accepted the request and then ignored it');
}

/**
 * Enter fullscreen on the first tap after load, once, if `enabled()` says so.
 * The gesture requirement means this cannot happen automatically on load.
 */
export function armOnFirstGesture(enabled, onResult) {
  if (!isSupported()) return;
  const go = async () => {
    document.removeEventListener('pointerup', go, true);
    if (!enabled() || isActive()) return;
    try {
      await enter();
      if (onResult) onResult(true);
    } catch (err) {
      if (onResult) onResult(false, err);
    }
  };
  document.addEventListener('pointerup', go, true);
}
