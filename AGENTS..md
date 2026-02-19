# Voice Input – Copilot Instructions

Push-to-talk Electron app (Windows-only) that records audio via Web Audio API, transcribes it through a remote JSON-RPC backend, and injects the text into the active window using `Ctrl+V` simulation.

## Commands

```powershell
npm start          # Run in development (Electron directly)
npm run build      # Build NSIS installer → dist/Voice Input Setup 1.0.0.exe
npm run build:dir  # Build unpacked dir (faster, no installer)
```

> First `npm install` compiles native modules (`uiohook-napi`, `@jitsi/robotjs`). Requires **Visual Studio Build Tools** and **Python 3.x** in PATH.

## Architecture

```
main.js              ← Main process: hotkey, tray, IPC hub, volume duck, text injection
overlay.html         ← Floating 70×70 indicator (red dot → blue spinner)
recorder.html        ← Hidden renderer: getUserMedia + MediaRecorder (Web Audio API)
settings.html        ← Mic device picker (reads/writes config.json via IPC)
assets/              ← tray-idle.png, tray-active.png, icon.ico
```

### Process / Window boundaries

| Window | Visible | Role |
|---|---|---|
| `recorderWindow` | Never | Needs renderer context to call `navigator.mediaDevices.getUserMedia` |
| `overlayWindow` | During recording/transcribing only | Visual feedback |
| `settingsWindow` | On demand | Settings UI |

All windows use `nodeIntegration: true` + `contextIsolation: false` — intentional for a local-only trusted app.

### IPC channels

**main → renderer:**
| Channel | Target | Trigger |
|---|---|---|
| `start-recording` | recorderWindow | Hotkey down |
| `stop-recording` | recorderWindow | Hotkey up |
| `set-device` | recorderWindow | Settings save |
| `recording-start` | overlayWindow | Hotkey down |
| `recording-stop` | overlayWindow | Hotkey up |
| `transcribing` | overlayWindow | Audio received, awaiting backend |

**renderer → main:**
| Channel | Sender | Payload |
|---|---|---|
| `audio-data` | recorderWindow | `ArrayBuffer` of recorded WebM audio |
| `get-config` | settingsWindow | (empty) |
| `save-settings` | settingsWindow | `{ deviceId: string }` |

## Key Details

### Hotkey
Global hook via `uiohook-napi` (not Electron `globalShortcut`). Push-to-talk = **Ctrl + Win held simultaneously**. Hook starts after 1 s delay (`setTimeout`) to let windows initialise.

### Audio recording
`MediaRecorder` with 100 ms timeslices. Mime-type negotiation: `audio/webm;codecs=opus` → `audio/webm` → default. Stream is cached and reused; only recreated on device change.

### Transcription backend
**Hardcoded** at `http://10.0.0.205:5173/api` — JSON-RPC 2.0, method `aiagent.transcript`, payload `{ audio_data: <base64>, mime_type: 'audio/webm' }`. No local backend. Debug audio written to `%TEMP%\voice-input.webm`.

### Text injection
1. Hide overlay (returns OS focus to target window)
2. Wait 80 ms for focus transfer
3. Save clipboard → write transcribed text → `robot.keyTap('v', ['control'])`
4. Restore clipboard after 500 ms

### Volume ducking
System volume is lowered to 10% during recording to prevent mic feedback. Restored on `stop-recording`.

### Config
`%APPDATA%\voice-input\config.json` — schema: `{ deviceId: string | null }`. Loaded at startup, written on settings save.

## Known Issues / Gotchas

- `settings.html` is **missing from `build.files`** in `package.json` — it won't be included in packaged builds.
- `audioChunks` and `mediaRecorder` variables in `main.js` are dead code (recording was moved to renderer).
- Backend URL is hardcoded — change `http://10.0.0.205:5173/api` in `main.js` if the server moves.
- If `getUserMedia` is denied, the overlay gets stuck in "transcribing" state (no error handling in recorder).
- Clipboard restore is 500 ms: anything the user copies in that window gets overwritten.

