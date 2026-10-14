# EclipseLiveCam Desktop

A Windows desktop app for EclipseLiveCam with its **own virtual camera** built in.
Start a live AI stream, then pick **EclipseLiveCam** as your camera in Zoom,
Google Meet, Teams, Discord, OBS and so on. You don't need OBS.

## How it works

- **Pages are built in.** Every screen (Studio, Create, Top up, Login …) is in
  `src/web` and ships inside the app. The app doesn't load the website.
- **The account API is still online.** Login, credits, payments and AI tokens
  still go to `https://eclipselivecam.com/api/…` on your cPanel server, because
  that's where the Decart API key and customer balances live. Keep the `api/`
  and `data/` folders on the server. You can remove the website pages if you like.
- **Virtual camera.** The camera is [softcam](https://github.com/tshino/softcam)
  (MIT licence), a DirectShow camera driver renamed to "EclipseLiveCam". The
  installer registers it once. While the app runs, a small helper
  (`eclipse-vcam.exe`) receives the AI output frames and shows them in the
  camera. When nothing is streaming, the camera shows a standby screen, so it
  can stay selected in Zoom between sessions.

```
Studio (AI output video)
   │  each frame, letterboxed to 1280×720
   ▼
Electron main process ──stdin──► eclipse-vcam.exe ──► softcam.dll ──► "EclipseLiveCam" in Zoom / Meet / Discord / OBS
```

- **Activation keys.** On first launch the app asks for an `ECLPS-XXXXX-XXXXX-XXXXX`
  key, the same keys you generate in the admin panel. The device token is
  stored encrypted and rechecked with the server on every launch, so revoking
  a key in the admin panel locks that PC again. If the server can't be reached,
  an already-activated PC is let in.
- **Title bar and settings.** The app has its own dark title bar (camera
  status, settings, minimise/maximise/close). Settings covers zoom, start
  maximised, always on top, reload, clear cache (you stay logged in) and
  reinstalling the camera.

Notes:
- The camera is video only. People keep their normal microphone in the call app.
- Most apps see DirectShow cameras (Zoom, Teams, Discord, OBS, Chrome/Edge/Meet).
  A few apps that only support newer Windows 11 cameras, such as the built-in
  Windows Camera app, may not list it.

## Building the installer

GitHub builds it for you: push to `main` or `desktop-virtual-cam`, or run the
**Build EclipseLiveCam (Windows)** workflow from the Actions tab. When it
finishes, download **EclipseLiveCam-Windows-Installer** from the run page. The
workflow builds the camera DLLs and the helper with Visual Studio, then packages
everything with electron-builder.

The installer asks for admin rights, because registering a camera needs them.

## Project layout

```
src/main/main.js       app window; serves src/web and forwards /api to the server
src/main/shell.html    title bar + settings screen (shell.js, shell-preload.js)
src/main/activation.js stores / re-verifies the device activation token
src/main/vcam.js       starts the camera helper and streams frames to it
src/main/preload.js    bridge the pages use to reach the camera
src/main/splash.html   startup splash
src/web/               the app's pages (copied from the website)
src/web/assets/js/desktop.js   captures the AI output and feeds the camera
native/eclipse-vcam.cpp        helper: stdin RGBA frames → softcam
native/patch-softcam.mjs       renames softcam to "EclipseLiveCam" before building
build/installer.nsh    registers / removes the camera on install / uninstall
```

## Running from source (for development)

```
npm install
npm start
```

On Mac or Linux the app runs, but the virtual camera is Windows only.
For local testing against another API server, set `ECLIPSE_API_ORIGIN`
(for example `http://127.0.0.1:8080`).
