// Device activation with the server's one-time keys (ECLPS-XXXXX-XXXXX-XXXXX).
//
// Redeeming a key on the server (api/activate.php?action=validate) returns a
// device token. We keep that token here, encrypted with the OS keychain when
// available, and re-check it (action=verify) on every launch so revoking a key
// in the admin panel locks the app again.
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const file = () => path.join(app.getPath('userData'), 'activation.json');

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (d.enc) return safeStorage.decryptString(Buffer.from(d.token, 'base64'));
    return d.token || null;
  } catch { return null; }
}

function save(token) {
  const enc = safeStorage.isEncryptionAvailable();
  const stored = enc ? safeStorage.encryptString(token).toString('base64') : token;
  fs.writeFileSync(file(), JSON.stringify({ enc, token: stored }));
}

function clear() {
  try { fs.unlinkSync(file()); } catch {}
}

// Asks the server whether a device token is still valid.
// Returns true / false, or null when the server could not be reached.
async function verify(ses, apiOrigin, token) {
  try {
    const res = await ses.fetch(`${apiOrigin}/api/activate.php?action=verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_token: token }),
      bypassCustomProtocolHandlers: true,
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.ok === true;
  } catch {
    return null;
  }
}

module.exports = { load, save, clear, verify };
