<?php
/**
 * voice_clone.php — "Train & save a voice" (ElevenLabs Instant Voice Cloning).
 *
 * The app records or uploads an audio sample; the server sends it to ElevenLabs
 * with the account key (never exposed to the browser), which clones the voice,
 * saves it to the account, and returns a voice_id. After that the voice appears
 * in /api/voice.php?action=voices and can be selected like any other.
 *
 * App (needs login):
 *   POST ?action=clone   (multipart: name, sample[, sample2…])  → { voice_id, name }
 *   POST ?action=delete  { voice_id }                            → { ok }
 *
 * Note: cloned voices share the account's ElevenLabs voice library and count
 * against the plan's custom-voice limit. Instant Voice Cloning needs a paid
 * ElevenLabs plan (Starter or above).
 */

require_once __DIR__ . '/config.php';

header('Content-Type: application/json; charset=utf-8');
session_write_close();

$user   = require_login();
$action = $_GET['action'] ?? '';

// ── find the ElevenLabs key the rest of the app already uses ──────────────────
function eleven_key(): string {
    foreach (['elevenApiKey', 'elevenlabsApiKey', 'elevenLabsApiKey', 'xiApiKey', 'voiceApiKey'] as $n) {
        if (function_exists('cfg')) { $v = cfg($n); if (is_string($v) && $v !== '') return $v; }
    }
    // fall back: scan settings.json for any non-empty key that looks like it
    $sf = DATA_DIR . '/settings.json';
    if (is_file($sf)) {
        $s = json_decode(@file_get_contents($sf), true);
        if (is_array($s)) foreach ($s as $k => $v) {
            if (is_string($v) && $v !== '' && preg_match('/eleven|xi.?api/i', $k)) return $v;
        }
    }
    $env = (string)getenv('ELEVENLABS_API_KEY');
    return $env;
}

switch ($action) {

    case 'clone': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err('Method not allowed', 405);
        $key = eleven_key();
        if ($key === '') json_err('Voice training is not configured on the server.', 500);

        $name = trim((string)($_POST['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 60) json_err('Give the voice a name (up to 60 characters).', 400);

        // collect every uploaded sample (sample, sample2, … or sample[])
        $files = [];
        foreach ($_FILES as $f) {
            $names = (array)$f['name']; $tmps = (array)$f['tmp_name']; $errs = (array)$f['error'];
            foreach ($tmps as $i => $tmp) {
                if (($errs[$i] ?? 1) !== UPLOAD_ERR_OK || !is_uploaded_file($tmp)) continue;
                $size = filesize($tmp);
                if ($size < 2000) continue;                       // too short to clone
                if ($size > 10 * 1024 * 1024) json_err('Each sample must be under 10 MB.', 400);
                $files[] = ['tmp' => $tmp, 'name' => (string)($names[$i] ?? 'sample.webm')];
            }
        }
        if (!$files) json_err('Record or choose an audio sample first (a few seconds of clear speech).', 400);
        if (count($files) > 5) $files = array_slice($files, 0, 5);

        // build the multipart body for ElevenLabs
        $post = ['name' => $name, 'remove_background_noise' => 'true'];
        foreach ($files as $i => $f) {
            $mime = mime_content_type($f['tmp']) ?: 'application/octet-stream';
            $post["files[$i]"] = new CURLFile($f['tmp'], $mime, $f['name']);
        }

        $ch = curl_init('https://api.elevenlabs.io/v1/voices/add');
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $post,
            CURLOPT_HTTPHEADER     => ['xi-api-key: ' . $key, 'Accept: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 120,
        ]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $cerr = curl_error($ch);
        curl_close($ch);

        if ($resp === false) json_err('Could not reach the voice service: ' . $cerr, 502);
        $data = json_decode($resp, true);
        if ($code < 200 || $code >= 300) {
            $msg = $data['detail']['message'] ?? ($data['detail'] ?? 'Voice training failed.');
            if (is_array($msg)) $msg = 'Voice training failed.';
            json_err($msg, $code === 401 ? 500 : 400);
        }
        $vid = $data['voice_id'] ?? '';
        if ($vid === '') json_err('The voice service did not return a voice.', 502);

        json_out(['ok' => true, 'voice_id' => $vid, 'name' => $name]);
        break;
    }

    case 'delete': {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') json_err('Method not allowed', 405);
        $key = eleven_key();
        if ($key === '') json_err('Voice training is not configured on the server.', 500);
        $body = (array)json_decode(file_get_contents('php://input'), true);
        $vid  = trim((string)($body['voice_id'] ?? ''));
        if ($vid === '') json_err('Which voice?', 400);

        $ch = curl_init('https://api.elevenlabs.io/v1/voices/' . rawurlencode($vid));
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST  => 'DELETE',
            CURLOPT_HTTPHEADER     => ['xi-api-key: ' . $key],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 30,
        ]);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($code < 200 || $code >= 300) json_err('Could not delete the voice.', 400);
        json_out(['ok' => true]);
        break;
    }

    default:
        json_err('Unknown action', 404);
}
