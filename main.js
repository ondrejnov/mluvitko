const { app, globalShortcut, Tray, BrowserWindow, ipcMain, clipboard, screen, nativeImage } = require('electron')
const path = require('path')
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args))
const fs = require('fs')
const loudness = require('loudness')

let tray = null
let overlayWindow = null
let mediaRecorder = null
let audioChunks = []
let recorderWindow = null
let settingsWindow = null
let isRecording = false
let config = { deviceId: null }
let savedVolume = null

// Uloží aktuální hlasitost a sníží na 5 %
async function volGetAndSet5() {
  try {
    const v = await loudness.getVolume()
    await loudness.setVolume(10)
    return v
  } catch (e) {
    console.error('Hlasitost – chyba při čtení/nastavení:', e.message)
    return null
  }
}

// Obnoví dříve uloženou hlasitost
async function volRestore() {
  if (savedVolume === null) return
  const level = savedVolume
  savedVolume = null
  try {
    await loudness.setVolume(level)
  } catch (e) {
    console.error('Hlasitost – chyba při obnovení:', e.message)
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────
function loadConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json')
  try {
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (e) { /* ignore */ }
}

function saveConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

// ─── App ready ───────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadConfig()
  createTray()
  createOverlay()
  createRecorderWindow()

  // Počkej až jsou okna ready, pak registruj hotkey
  setTimeout(() => registerHotkey(), 1000)
})

app.on('window-all-closed', (e) => e.preventDefault()) // Tray app – nezavírat
app.on('will-quit', () => globalShortcut.unregisterAll())

// ─── Tray ────────────────────────────────────────────────────────────────────
function createTray() {
  const idleIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-idle.png'))
  tray = new Tray(idleIcon)
  tray.setToolTip('Mluvítko – drž Ctrl+Win pro nahrávání')

  const { Menu } = require('electron')
  const menu = Menu.buildFromTemplate([
    { label: 'Mluvítko', enabled: false },
    { type: 'separator' },
    { label: 'Hotkey: Ctrl+Win (držet)', enabled: false },
    { type: 'separator' },
    { label: 'Nastavení mikrofonu...', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Ukončit', click: () => app.exit(0) }
  ])
  tray.setContextMenu(menu)
}

function setTrayActive(active) {
  const icon = active ? 'tray-active.png' : 'tray-idle.png'
  tray.setImage(nativeImage.createFromPath(path.join(__dirname, 'assets', icon)))
  tray.setToolTip(active ? '🔴 Nahrávám...' : 'Mluvítko – drž Ctrl+Win pro nahrávání')
}

// ─── Overlay okno ────────────────────────────────────────────────────────────
function createOverlay() {
  overlayWindow = new BrowserWindow({
    width: 70,
    height: 70,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  overlayWindow.loadFile('overlay.html')

  // Pozice: pravý dolní roh nad systray
  overlayWindow.on('ready-to-show', () => {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    overlayWindow.setPosition(width - 90, height - 90)
  })
}

// ─── Recorder okno (skrytý renderer pro Web Audio API) ───────────────────────
function createRecorderWindow() {
  recorderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  recorderWindow.loadFile('recorder.html')
  recorderWindow.webContents.once('did-finish-load', () => {
    recorderWindow.webContents.send('set-device', config.deviceId)
  })
}

// ─── Settings okno ───────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 430,
    height: 250,
    title: 'Nastavení – Mluvítko',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  settingsWindow.setMenu(null)
  settingsWindow.loadFile('settings.html')
}

// ─── Hotkey ──────────────────────────────────────────────────────────────────
function registerHotkey() {
  const { uIOhook, UiohookKey } = require('uiohook-napi')

  let ctrlDown = false
  let winDown = false

  uIOhook.on('keydown', (e) => {
    if (e.keycode === UiohookKey.Ctrl) ctrlDown = true
    if (e.keycode === UiohookKey.Meta) winDown = true
    if (ctrlDown && winDown && !isRecording) {
      isRecording = true
      startRecording()
    }
  })

  uIOhook.on('keyup', (e) => {
    if (e.keycode === UiohookKey.Ctrl) ctrlDown = false
    if (e.keycode === UiohookKey.Meta) winDown = false
    if (!ctrlDown || !winDown) {
      if (isRecording) {
        isRecording = false
        stopAndSend()
      }
    }
  })

  uIOhook.start()
  console.log('Hotkey Ctrl+Win registrován (push-to-talk)')
}

// ─── Nahrávání ───────────────────────────────────────────────────────────────
async function startRecording() {
  console.log('▶ Start nahrávání')
  savedVolume = await volGetAndSet5()  // Sníž hlasitost PC na 5 %
  setTrayActive(true)
  overlayWindow.show()
  overlayWindow.webContents.send('recording-start')
  recorderWindow.webContents.send('start-recording')
}

async function stopAndSend() {
  console.log('⏹ Stop nahrávání')
  await volRestore()  // Obnov hlasitost hned po zastavení nahrávání
  setTrayActive(false)
  overlayWindow.webContents.send('recording-stop')

  // Počkej na audio data z renderer procesu
  recorderWindow.webContents.send('stop-recording')
}

// ─── IPC: nastavení ─────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => config)
ipcMain.handle('save-settings', (event, newConfig) => {
  config = { ...config, ...newConfig }
  saveConfig()
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send('set-device', config.deviceId)
  }
})

// ─── IPC: přijmi audio z recorder.html ───────────────────────────────────────
const robot = require('@jitsi/robotjs')

ipcMain.on('audio-data', async (event, arrayBuffer) => {
  // Přepni overlay do stavu "zpracovávám" – neztrácíme focus na inputu
  overlayWindow.webContents.send('transcribing')

  const tempPath = path.join(app.getPath('temp'), 'voice-input.webm')
  fs.writeFileSync(tempPath, Buffer.from(arrayBuffer))

  console.log(`Audio uloženo: ${tempPath} (${Buffer.from(arrayBuffer).length} bytes)`)

  try {
    const audioBase64 = Buffer.from(arrayBuffer).toString('base64')

    const res = await fetch('http://10.0.0.205:5173/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'aiagent.transcript',
        params: { audio_data: audioBase64, mime_type: 'audio/webm' },
        id: 1
      })
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Backend error ${res.status}: ${err}`)
    }

    const json = await res.json()
    if (json.error) throw new Error(json.error.message)
    const { text } = json.result
    console.log('Transkripce:', text)

    if (text && text.trim()) {
      // Skryj overlay těsně před vložením, aby focus zůstal na inputu
      overlayWindow.hide()

      // Krátká pauza – systém musí přepnout focus zpět na okno pod overlay
      await new Promise(resolve => setTimeout(resolve, 80))

      // Vlož text přes schránku + Ctrl+V
      const prevClipboard = clipboard.readText()
      clipboard.writeText(text.trim())
      robot.keyTap('v', process.platform === 'darwin' ? ['command'] : ['control'])

      // Obnov původní obsah schránky po malém zpoždění
      setTimeout(() => clipboard.writeText(prevClipboard), 500)
    } else {
      overlayWindow.hide()
    }

  } catch (err) {
    overlayWindow.hide()
    console.error('Chyba při transkripci:', err.message)
    // Zobraz chybu v tray tooltipu na 3s
    tray.setToolTip(`❌ Chyba: ${err.message}`)
    setTimeout(() => tray.setToolTip('Mluvítko – drž Ctrl+Win pro nahrávání'), 3000)
  }
})
