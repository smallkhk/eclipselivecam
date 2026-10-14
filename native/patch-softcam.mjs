// Rebrands a softcam checkout so the virtual camera shows up as "EclipseLiveCam"
// and cannot collide with any other app that also ships softcam.
//
// Usage: node native/patch-softcam.mjs <path-to-softcam-checkout>
//
// Every replacement must match exactly once. If softcam is ever bumped to a
// version where a line moved, this fails the build loudly instead of quietly
// producing a camera named "DirectShow Softcam".
import fs from 'node:fs';
import path from 'node:path';

// Must match CAMERA_CLSID in src/main/vcam.js and build/installer.nsh.
// {4C23FA8E-932C-4342-92E8-7F3EDA72F4BA}
const GUID_DEFINE = '0x4c23fa8e, 0x932c, 0x4342, 0x92, 0xe8, 0x7f, 0x3e, 0xda, 0x72, 0xf4, 0xba';
const CAMERA_NAME = 'EclipseLiveCam';

const root = process.argv[2];
if (!root) {
  console.error('usage: node patch-softcam.mjs <softcam dir>');
  process.exit(1);
}

const edits = [
  ['src/softcam/softcam.cpp', [
    ['0xaef3b972, 0x5fa5, 0x4647, 0x95, 0x71, 0x35, 0x8e, 0xb4, 0x72, 0xbc, 0x9e', GUID_DEFINE],
    ['L"DirectShow Softcam"', `L"${CAMERA_NAME}"`],
  ]],
  ['src/softcamcore/DShowSoftcam.cpp', [
    ['NAME("DirectShow Softcam")', `NAME("${CAMERA_NAME}")`],
    ['L"DirectShow Softcam Stream"', `L"${CAMERA_NAME} Stream"`],
    ['NAME("DirectShow Softcam Stream")', `NAME("${CAMERA_NAME} Stream")`],
  ]],
  ['src/softcamcore/FrameBuffer.cpp', [
    ['"DirectShow Softcam/NamedMutex"', `"${CAMERA_NAME}/NamedMutex"`],
    ['"DirectShow Softcam/SharedMemory"', `"${CAMERA_NAME}/SharedMemory"`],
  ]],
];

for (const [rel, pairs] of edits) {
  const file = path.join(root, rel);
  let text = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    const count = text.split(from).length - 1;
    if (count !== 1) {
      console.error(`${rel}: expected exactly 1 match for ${from}, found ${count}`);
      process.exit(1);
    }
    text = text.replace(from, to);
  }
  fs.writeFileSync(file, text);
  console.log(`patched ${rel}`);
}
