/* ── Eden Live (fal.ai) realtime sessions for the Studio ─────────────────────
 * VAST's Eden Live 14B on fal: camera in, transformed video out, over WebRTC.
 *
 * The fal key never reaches the browser. Every request fal's client makes goes
 * through /api/fal_proxy.php, which checks the customer is signed in and has a
 * paid-up hold (see session.php) before adding the key and forwarding it.
 *
 * fal's realtime client API is experimental (alpha); vendor/fal-client.js is
 * a bundle of @fal-ai/client 1.11.0-alpha.6.
 */
import { createFalClient, wma } from './vendor/fal-client.js';

// The model's input and output video contract.
export const EDEN_WIDTH = 832;
export const EDEN_HEIGHT = 480;
export const EDEN_FPS = 16;

const fal = createFalClient({ proxyUrl: '/api/fal_proxy.php' });

/** fal model ids look like "owner/name"; Decart ids don't. */
export function isFalModel(modelId) {
  return typeof modelId === 'string' && modelId.includes('/');
}

/**
 * The reference image has to travel as a data URI under ~45 KB, so shrink it
 * to a JPEG until it fits.
 */
export async function imageToSmallDataUri(file, maxBytes = 44000) {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  let side = 640;
  for (let attempt = 0; attempt < 8; attempt++) {
    const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.65, 0.5]) {
      const uri = canvas.toDataURL('image/jpeg', quality);
      if (uri.length <= maxBytes) { bitmap.close?.(); return uri; }
    }
    side = Math.round(side * 0.75);
  }
  bitmap.close?.();
  throw new Error('Could not shrink the reference image enough.');
}

/**
 * Opens an Eden Live session. Returns a small controller with the same verbs
 * the Studio uses for Decart: setPrompt, setImage, disconnect.
 */
export function openEden({ modelId, localStream, prompt, imageDataUri, onStream, onState, onError, onStats }) {
  let closed = false;
  const session = fal.realtime.open(wma(modelId), {
    localStream,
    receive: ['video'],
    onMedia: (stream) => onStream?.(stream),
    onState: (state) => { if (!closed) onState?.(state); },
    onError: (err) => { if (!closed) onError?.(err); },
    onData: (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'stats') onStats?.(msg);
      else if (msg.type === 'configured') onState?.('generating');
      else if (msg.type === 'error' && !closed) onError?.(new Error(msg.error || 'Eden Live reported an error.'));
      else if (msg.type === 'stream_exhausted' && !closed) onError?.(new Error('The AI stream ended. Start again to continue.'));
    },
  });

  session.send({
    type: 'configure',
    prompt: prompt || null,
    image_url: imageDataUri || null,
    enable_prompt_expansion: false,
  });

  return {
    ready: session.ready,
    setPrompt(text) {
      session.send({ type: 'prompt', prompt: String(text).slice(0, 2000) });
    },
    // A new reference image re-anchors the generation.
    setImage(dataUri) {
      session.send({ type: 'reset', image_url: dataUri || null });
    },
    disconnect() {
      if (closed) return;
      closed = true;
      try { session.send({ type: 'stop' }); } catch {}
      session.close().catch(() => {});
    },
  };
}
