<?php
/**
 * live.php — "Share live to my link" (video + the changed voice).
 *
 * The phone app uploads the latest output frame as a JPEG a few times a second
 * (action=frame) and, while the voice changer is on, the changed-voice audio in
 * short chunks (action=audio). Anyone who opens the watch page (/live.php?s=…)
 * sees and hears it in their browser — an open watch page, nothing is injected
 * into any other app. Each customer has one stable, unguessable token.
 *
 * App (needs login):
 *   POST ?action=start               begin a share; returns { token, url }
 *   POST ?action=frame   (raw JPEG)  store the latest frame; returns { viewers }
 *   POST ?action=audio   (raw PCM)   store a chunk of 24 kHz s16le mono audio
 *   POST ?action=stop                end the share
 *   GET  ?action=link                the watch link without starting
 * Public (no login):
 *   GET  ?action=poll&s=&v=          { live, viewers, name, audioSeq }
 *   GET  ?action=view&s=&v=          the latest JPEG (204 if offline)
 *   GET  ?action=audiopoll&s=&after= the next audio chunk after seq (204 if none)
 */
require_once __DIR__ . '/config.php';

$action   = $_GET['action'] ?? '';
$LIVE_DIR = DATA_DIR . '/live';
if (!is_dir($LIVE_DIR)) @mkdir($LIVE_DIR, 0775, true);

const LIVE_STALE  = 12;    // seconds without a new frame = offline
const VIEW_WINDOW = 10;    // seconds a viewer counts as present
const AUDIO_KEEP  = 60;    // how many recent audio chunks to keep
const AUDIO_RATE  = 24000; // the app sends 24 kHz mono

function live_secret() {
    global $LIVE_DIR;
    $f = $LIVE_DIR . '/secret';
    $s = @file_get_contents($f);
    if (!$s) { $s = bin2hex(random_bytes(32)); @file_put_contents($f, $s); @chmod($f, 0600); }
    return $s;
}
function live_token($userId) { return substr(hash_hmac('sha256', (string)$userId, live_secret()), 0, 20); }
function live_path($token, $ext) {
    global $LIVE_DIR;
    if (!preg_match('/^[a-f0-9]{20}$/', (string)$token)) return null;
    return "$LIVE_DIR/$token.$ext";
}
function live_url($token) {
    $base = rtrim((string)(function_exists('cfg') ? cfg('siteUrl') : ''), '/');
    if ($base === '') {
        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $base = $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'eclipselivecam.online');
    }
    return $base . '/live.php?s=' . $token;
}
function live_viewers($token, $vid = '') {
    $file = live_path($token, 'viewers');
    if (!$file) return 0;
    $v = json_decode((string)@file_get_contents($file), true) ?: [];
    $now = time();
    foreach ($v as $k => $t) if ($now - (int)$t > VIEW_WINDOW) unset($v[$k]);
    if ($vid !== '') $v[$vid] = $now;
    @file_put_contents($file, json_encode($v));
    return count($v);
}
function live_audio_seq($token) { return (int)@file_get_contents(live_path($token, 'aud')); }
function live_clear_audio($token) {
    global $LIVE_DIR;
    foreach ((array)@glob("$LIVE_DIR/$token.a[0-9]*") as $f) @unlink($f);
    @unlink(live_path($token, 'aud'));
}

// ── Public watch endpoints (no login) ───────────────────────────────────────
if ($action === 'poll' || $action === 'view' || $action === 'audiopoll') {
    $token = (string)($_GET['s'] ?? '');
    $meta  = live_path($token, 'json');
    if (!$meta || !is_file($meta)) { http_response_code(404); exit; }
    $vid = substr(preg_replace('/[^a-zA-Z0-9]/', '', (string)($_GET['v'] ?? '')), 0, 32);
    $jpg = live_path($token, 'jpg');
    $live = is_file($jpg) && (time() - (int)@filemtime($jpg) <= LIVE_STALE);

    if ($action === 'poll') {
        $info = json_decode((string)@file_get_contents($meta), true) ?: [];
        header('Content-Type: application/json');
        header('Cache-Control: no-store');
        echo json_encode(['ok' => true, 'live' => $live, 'viewers' => live_viewers($token, $vid),
                          'name' => $info['name'] ?? 'EclipseLiveCam', 'audioSeq' => live_audio_seq($token)]);
        exit;
    }

    if ($action === 'audiopoll') {
        $after = max(0, (int)($_GET['after'] ?? 0));
        $cur   = live_audio_seq($token);
        if ($cur <= 0) { http_response_code(204); exit; }
        $lo = max($after + 1, $cur - AUDIO_KEEP + 1, 1);
        for ($n = $lo; $n <= $cur; $n++) {
            $f = live_path($token, 'a' . $n);
            if ($f && is_file($f)) {
                header('Content-Type: application/octet-stream');
                header('Cache-Control: no-store');
                header('X-Seq: ' . $n);
                header('X-Rate: ' . AUDIO_RATE);
                readfile($f);
                exit;
            }
        }
        http_response_code(204); exit;
    }

    // action=view: the latest frame. Viewer counting happens in poll (every few
    // seconds), never here — this runs many times a second and must stay light.
    if (!$live) { http_response_code(204); exit; }
    header('Content-Type: image/jpeg');
    header('Cache-Control: no-store');
    header('Content-Length: ' . (int)filesize($jpg));
    readfile($jpg);
    exit;
}

// ── App endpoints (need login) ──────────────────────────────────────────────
$user  = require_login();
$token = live_token($user['id']);
// Frames/audio arrive many times a second; don't hold the session lock (billing beats share it).
@session_write_close();

switch ($action) {

case 'link':
    json_out(['ok' => true, 'token' => $token, 'url' => live_url($token)]);

case 'start': {
    $name = trim((string)($_POST['name'] ?? ($user['name'] ?? $user['username'] ?? 'EclipseLiveCam')));
    if ($name === '') $name = 'EclipseLiveCam';
    @file_put_contents(live_path($token, 'json'), json_encode(['userId' => $user['id'], 'name' => mb_substr($name, 0, 40), 'startedAt' => time()]));
    @unlink(live_path($token, 'jpg'));
    live_clear_audio($token);
    json_out(['ok' => true, 'token' => $token, 'url' => live_url($token)]);
}

case 'frame': {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err('Method not allowed', 405);
    if (!is_file(live_path($token, 'json'))) json_err('Start the share first.', 409);
    $data = file_get_contents('php://input');
    $len = strlen($data);
    if ($len < 100 || $len > 600000) json_err('Bad frame size.', 400);
    if (substr($data, 0, 2) !== "\xFF\xD8") json_err('Not a JPEG.', 400);
    $tmp = live_path($token, 'jpg') . '.tmp';
    @file_put_contents($tmp, $data);
    @rename($tmp, live_path($token, 'jpg'));   // atomic swap: viewers never read a half-written file
    json_out(['ok' => true, 'viewers' => live_viewers($token)]);
}

case 'audio': {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err('Method not allowed', 405);
    if (!is_file(live_path($token, 'json'))) json_err('Start the share first.', 409);
    $data = file_get_contents('php://input');
    $len = strlen($data);
    if ($len < 2 || $len > 500000 || $len % 2) json_err('Bad audio chunk.', 400);
    $seq = live_audio_seq($token) + 1;
    @file_put_contents(live_path($token, 'a' . $seq), $data);
    @file_put_contents(live_path($token, 'aud'), $seq);
    $old = live_path($token, 'a' . ($seq - AUDIO_KEEP));
    if ($old) @unlink($old);
    json_out(['ok' => true, 'seq' => $seq]);
}

case 'stop':
    @unlink(live_path($token, 'jpg'));
    live_clear_audio($token);
    json_out(['ok' => true]);

default:
    json_err('Unknown action', 404);
}
