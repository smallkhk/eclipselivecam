<?php
/**
 * activate.php — iOS app activation keys.
 *
 * Keys are stored in DATA_DIR/activation_keys.json as:
 *   { "ECLPS-XXXXX-XXXXX-XXXXX": { "used": false, "device_token": "", "created": 0, "activated": 0 } }
 *
 * App (no login required):
 *   POST ?action=validate   { key, device_token }  → { device_token }   accept a key & bind a device token
 *   POST ?action=verify     { device_token }        → { ok }             confirm an already-bound token
 *
 * Admin (requires X-Admin-Token header matching cfg('adminToken') or ADMIN_TOKEN env):
 *   POST ?action=generate   { count? }              → { keys: [...] }    make 1-20 new keys
 *   GET  ?action=list                               → { keys: [...] }    all keys + status
 *   POST ?action=revoke     { key }                 → { ok }             revoke a key
 */

require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
session_write_close();

$KEYS_FILE = DATA_DIR . '/activation_keys.json';
$action    = $_GET['action'] ?? '';

// ── helpers ─────────────────────────────────────────────────────────────────

function load_keys(string $file): array {
    if (!is_file($file)) return [];
    $d = @json_decode(@file_get_contents($file), true);
    return is_array($d) ? $d : [];
}

function save_keys(string $file, array $keys): void {
    $tmp = $file . '.tmp.' . getmypid();
    file_put_contents($tmp, json_encode($keys, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    rename($tmp, $file);
}

function rand_seg(): string {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/I/1 to avoid confusion
    $s = '';
    for ($i = 0; $i < 5; $i++) $s .= $chars[random_int(0, strlen($chars) - 1)];
    return $s;
}

function new_key(): string {
    return 'ECLPS-' . rand_seg() . '-' . rand_seg() . '-' . rand_seg();
}

function new_device_token(): string {
    return bin2hex(random_bytes(32));
}

function admin_token(): string {
    // set cfg('adminToken') in config.php, or ADMIN_TOKEN env var
    $t = function_exists('cfg') ? (cfg('adminToken') ?? '') : '';
    if ($t === '') $t = (string)getenv('ADMIN_TOKEN');
    return $t;
}

function require_admin(): void {
    $tok = admin_token();
    if ($tok === '') json_err('Admin token not configured', 500);
    $h = $_SERVER['HTTP_X_ADMIN_TOKEN'] ?? '';
    if (!hash_equals($tok, $h)) json_err('Unauthorized', 401);
}

// ── routes ───────────────────────────────────────────────────────────────────

switch ($action) {

    // ── validate: the app sends the key the user typed + its device token ───
    case 'validate': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err('Method not allowed', 405);
        $body = (array)@json_decode(file_get_contents('php://input'), true);
        $key  = strtoupper(trim((string)($body['key'] ?? '')));
        $dev  = trim((string)($body['device_token'] ?? ''));

        if (!preg_match('/^ECLPS-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/', $key))
            json_err('Invalid activation key format.', 400);

        $keys = load_keys($KEYS_FILE);
        if (!isset($keys[$key])) json_err('Activation key not found.', 404);
        if ($keys[$key]['used'] && $keys[$key]['device_token'] !== $dev)
            json_err('This key is already used on another device.', 409);

        // bind (or re-bind same device)
        $token = $dev ?: new_device_token();
        $keys[$key]['used']         = true;
        $keys[$key]['device_token'] = $token;
        $keys[$key]['activated']    = time();
        save_keys($KEYS_FILE, $keys);

        json_out(['ok' => true, 'device_token' => $token]);
        break;
    }

    // ── verify: app calls this on every launch to check the token is still good
    case 'verify': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err('Method not allowed', 405);
        $body = (array)@json_decode(file_get_contents('php://input'), true);
        $dev  = trim((string)($body['device_token'] ?? ''));
        if ($dev === '') json_err('Missing device_token', 400);

        $keys = load_keys($KEYS_FILE);
        foreach ($keys as $entry) {
            if (($entry['device_token'] ?? '') === $dev) {
                json_out(['ok' => true]);
            }
        }
        json_err('Device token not recognised.', 401);
        break;
    }

    // ── generate (admin): create 1–20 new keys ───────────────────────────────
    case 'generate': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err('Method not allowed', 405);
        require_admin();
        $body  = (array)@json_decode(file_get_contents('php://input'), true);
        $count = max(1, min(20, (int)($body['count'] ?? 1)));

        $keys = load_keys($KEYS_FILE);
        $made = [];
        for ($i = 0; $i < $count; $i++) {
            do { $k = new_key(); } while (isset($keys[$k]));
            $keys[$k] = ['used' => false, 'device_token' => '', 'created' => time(), 'activated' => 0];
            $made[] = $k;
        }
        save_keys($KEYS_FILE, $keys);
        json_out(['ok' => true, 'keys' => $made]);
        break;
    }

    // ── list (admin) ─────────────────────────────────────────────────────────
    case 'list': {
        require_admin();
        $keys = load_keys($KEYS_FILE);
        $out  = [];
        foreach ($keys as $k => $v) {
            $out[] = ['key' => $k, 'used' => $v['used'],
                      'created'   => date('Y-m-d H:i', $v['created']),
                      'activated' => $v['activated'] ? date('Y-m-d H:i', $v['activated']) : '—'];
        }
        json_out(['ok' => true, 'keys' => $out]);
        break;
    }

    // ── revoke (admin) ───────────────────────────────────────────────────────
    case 'revoke': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err('Method not allowed', 405);
        require_admin();
        $body = (array)@json_decode(file_get_contents('php://input'), true);
        $key  = strtoupper(trim((string)($body['key'] ?? '')));
        $keys = load_keys($KEYS_FILE);
        if (!isset($keys[$key])) json_err('Key not found', 404);
        unset($keys[$key]);
        save_keys($KEYS_FILE, $keys);
        json_out(['ok' => true]);
        break;
    }

    default:
        json_err('Unknown action', 404);
}
