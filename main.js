const { app, globalShortcut, Tray, BrowserWindow, ipcMain, clipboard, screen, nativeImage, dialog } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args))
const fs = require('fs')
const loudness = require('loudness')
const screenshot = require('screenshot-desktop')
const { loginWithGoogle } = require('./auth')
const { OpenAI } = require('openai')

// Fix for OpenAI file uploads in older Node/Electron versions
if (!globalThis.File) {
  globalThis.File = require('buffer').File
}

let tray = null
let overlayWindow = null
let mediaRecorder = null
let audioChunks = []
let recorderWindow = null
let settingsWindow = null
let isRecording = false
let config = { deviceId: null, openAtLogin: false, language: 'cs', shortcut: 'Ctrl+Win', apiKey: '' }
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
function applyLoginSettings() {
  app.setLoginItemSettings({
    openAtLogin: !!config.openAtLogin,
    path: app.getPath('exe'),
    mac: {
      openAsHidden: true
    }
  })
}

function loadConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json')
  try {
    if (fs.existsSync(configPath)) config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  } catch (e) { /* ignore */ }
  applyLoginSettings()
}

function saveConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

// ─── App ready ───────────────────────────────────────────────────────────────
let isManualUpdateCheck = false

app.whenReady().then(() => {
  loadConfig()
  createTray()
  createOverlay()
  createRecorderWindow()

  // Počkej až jsou okna ready, pak registruj hotkey
  setTimeout(() => registerHotkey(), 1000)

  // Zkontroluj aktualizace
  autoUpdater.checkForUpdatesAndNotify()
})

// ─── Auto Updater Události ───────────────────────────────────────────────────
autoUpdater.on('update-available', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Aktualizace k dispozici',
    message: 'Nová verze aplikace je k dispozici. Stahuje se na pozadí...'
  })
})

autoUpdater.on('update-not-available', () => {
  if (isManualUpdateCheck) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Žádné aktualizace',
      message: 'Máte nejnovější verzi aplikace.'
    })
    isManualUpdateCheck = false
  }
})

autoUpdater.on('update-downloaded', () => {
  dialog.showMessageBox({
    type: 'info',
    title: 'Aktualizace připravena',
    message: 'Aktualizace byla stažena. Aplikace se nyní restartuje a nainstaluje novou verzi.',
    buttons: ['Restartovat']
  }).then(() => {
    autoUpdater.quitAndInstall()
  })
})

autoUpdater.on('error', (err) => {
  console.error('Chyba při aktualizaci:', err)
  if (isManualUpdateCheck) {
    dialog.showErrorBox('Chyba aktualizace', 'Nepodařilo se zkontrolovat aktualizace. Zkontrolujte připojení k internetu.')
    isManualUpdateCheck = false
  }
})

app.on('window-all-closed', (e) => e.preventDefault()) // Tray app – nezavírat
app.on('will-quit', () => globalShortcut.unregisterAll())

// ─── Tray ────────────────────────────────────────────────────────────────────
function updateTrayMenu() {
  const shortcut = config.shortcut || 'Ctrl+Win'
  tray.setToolTip(`Mluvítko – drž ${shortcut} pro nahrávání`)

  const { Menu } = require('electron')
  const menuTemplate = [
    { label: 'Mluvítko', enabled: false },
    { type: 'separator' },
    { label: `Hotkey: ${shortcut} (držet)`, enabled: false },
    { type: 'separator' }
  ]

  // if (config.user) {
  //   menuTemplate.push({ label: `Můj účet (${config.user.email || 'Přihlášen'})`, click: () => openAccount() })
  // } else {
  //   menuTemplate.push({ label: 'Přihlásit se', click: () => handleLogin() })
  // }

  menuTemplate.push(
    { type: 'separator' },
    { label: 'Zkontrolovat aktualizace', click: () => {
        isManualUpdateCheck = true
        autoUpdater.checkForUpdatesAndNotify()
      }
    },
    { label: 'Nastavení...', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Ukončit', click: () => app.exit(0) }
  )

  const menu = Menu.buildFromTemplate(menuTemplate)
  tray.setContextMenu(menu)
}

function createTray() {
  const idleIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-idle.png'))
  if (process.platform === 'darwin') idleIcon.setTemplateImage(true)
  tray = new Tray(idleIcon)
  updateTrayMenu()
}

function setTrayActive(active) {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', active ? 'tray-active.png' : 'tray-idle.png'))
  if (process.platform === 'darwin') icon.setTemplateImage(!active) // active = barevná, idle = template
  const shortcut = config.shortcut || 'Ctrl+Win'
  tray.setImage(icon)
  tray.setToolTip(active ? '🔴 Nahrávám...' : `Mluvítko – drž ${shortcut} pro nahrávání`)
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
    width: 450,
    height: 520,
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

// ─── Account okno ────────────────────────────────────────────────────────────
let accountWindow = null
function openAccount() {
  if (accountWindow && !accountWindow.isDestroyed()) {
    accountWindow.focus()
    return
  }
  accountWindow = new BrowserWindow({
    width: 400,
    height: 530,
    title: 'Můj účet – Mluvítko',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  accountWindow.setMenu(null)
  accountWindow.loadFile('account.html')
}

// ─── Auth ────────────────────────────────────────────────────────────────────
async function handleLogin() {
  try {
    const tokenData = await loginWithGoogle()
    if (tokenData.id_token) {
      await authenticateWithBackend(tokenData.id_token)
    }
  } catch (err) {
    console.error('Chyba přihlášení:', err)
    tray.setToolTip(`❌ Chyba přihlášení: ${err.message}`)
    setTimeout(() => updateTrayMenu(), 3000)
  }
}

async function authenticateWithBackend(idToken) {
  try {
    // Zde pošleme id_token na backend a získáme profil a kredity
    // Prozatím simulujeme odpověď backendu, protože neznáme přesnou strukturu
    const res = await fetch('http://10.0.0.205:5173/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'aiagent.login',
        params: { id_token: idToken },
        id: 1
      })
    })

    if (!res.ok) throw new Error(`Backend error ${res.status}`)
    const json = await res.json()

    // Pokud backend vrátí chybu (např. metoda neexistuje), použijeme fallback pro ukázku
    if (json.error) {
      console.warn('Backend vrátil chybu, používám fallback data:', json.error)
      // Fallback: dekódujeme id_token (JWT) pro získání profilu
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString())
      config.user = {
        id_token: idToken,
        name: payload.name || 'Uživatel',
        email: payload.email || '',
        picture: payload.picture || '',
        credits: 100, // Zástupná hodnota
        subscription: 'Free' // Zástupná hodnota
      }
    } else {
      // Předpokládáme, že backend vrátí profil a kredity v result
      config.user = {
        id_token: idToken,
        ...json.result
      }
    }

    saveConfig()
    updateTrayMenu()
    if (accountWindow && !accountWindow.isDestroyed()) {
      accountWindow.webContents.send('user-updated', config.user)
    }
  } catch (err) {
    console.error('Chyba ověření vůči backendu:', err)
    throw err
  }
}

function handleLogout() {
  delete config.user
  saveConfig()
  updateTrayMenu()
  if (accountWindow && !accountWindow.isDestroyed()) {
    accountWindow.close()
  }
}

// ─── Hotkey ──────────────────────────────────────────────────────────────────
let activeKeys = new Set()

function getTargetKeys() {
  const { UiohookKey } = require('uiohook-napi')
  const map = {
    'Ctrl+Win': [UiohookKey.Ctrl, UiohookKey.Meta],
    'Ctrl+Space': [UiohookKey.Ctrl, UiohookKey.Space],
    'Alt+Space': [UiohookKey.Alt, UiohookKey.Space],
    'Shift+Space': [UiohookKey.Shift, UiohookKey.Space],
    'F8': [UiohookKey.F8],
    'F9': [UiohookKey.F9],
    'F10': [UiohookKey.F10],
    'F12': [UiohookKey.F12]
  }
  return map[config.shortcut] || map['Ctrl+Win']
}

function normalizeKey(keycode) {
  const { UiohookKey } = require('uiohook-napi')
  if (keycode === UiohookKey.CtrlRight) return UiohookKey.Ctrl
  if (keycode === UiohookKey.MetaRight) return UiohookKey.Meta
  if (keycode === UiohookKey.AltRight) return UiohookKey.Alt
  if (keycode === UiohookKey.ShiftRight) return UiohookKey.Shift
  return keycode
}

function registerHotkey() {
  const { uIOhook } = require('uiohook-napi')

  uIOhook.on('keydown', (e) => {
    activeKeys.add(normalizeKey(e.keycode))
    const targetKeys = getTargetKeys()

    if (targetKeys.every(k => activeKeys.has(k)) && !isRecording) {
      isRecording = true
      startRecording()
    }
  })

  uIOhook.on('keyup', (e) => {
    activeKeys.delete(normalizeKey(e.keycode))
    const targetKeys = getTargetKeys()

    if (!targetKeys.every(k => activeKeys.has(k)) && isRecording) {
      isRecording = false
      stopAndSend()
    }
  })

  uIOhook.start()
  console.log('Hotkey registrován (push-to-talk)')
}

// ─── Nahrávání ───────────────────────────────────────────────────────────────
async function startRecording() {
  console.log('▶ Start nahrávání')
  savedVolume = await volGetAndSet5()  // Sníž hlasitost PC na 5 %
  setTrayActive(true)
  overlayWindow.show()
  overlayWindow.webContents.send('recording-start')
  recorderWindow.webContents.send('start-recording')

  // Pořiď screenshot
  try {
    const screenshotPath = path.join(app.getPath('temp'), 'voice-input-screenshot.png')
    await screenshot({ filename: screenshotPath })
    console.log(`Screenshot uložen: ${screenshotPath}`)
  } catch (err) {
    console.error('Chyba při pořizování screenshotu:', err)
  }
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
  applyLoginSettings()
  updateTrayMenu()
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    recorderWindow.webContents.send('set-device', config.deviceId)
  }
})

// ─── IPC: účet ──────────────────────────────────────────────────────────────
ipcMain.handle('get-user', () => config.user)
ipcMain.handle('login', () => handleLogin())
ipcMain.handle('logout', () => handleLogout())

// ─── IPC: přijmi audio z recorder.html ───────────────────────────────────────
const robot = require('@jitsi/robotjs')

ipcMain.on('audio-data', async (event, arrayBuffer) => {
  // Přepni overlay do stavu "zpracovávám" – neztrácíme focus na inputu
  overlayWindow.webContents.send('transcribing')

  const rand = Math.round(Date.now())
  const tempPath = path.join(app.getPath('temp'), `audio_${rand}.webm`)
  fs.writeFileSync(tempPath, Buffer.from(arrayBuffer))

  console.log(`Audio uloženo: ${tempPath} (${Buffer.from(arrayBuffer).length} bytes)`)

  try {
    if (!config.apiKey) {
      throw new Error('Není nastaven OpenAI API klíč. Nastavte jej v nastavení.')
    }
    const openai = new OpenAI({ apiKey: config.apiKey })

    const transcription = await openai.audio.transcriptions.create({
      model: 'gpt-4o-transcribe',
      file: fs.createReadStream(tempPath),
      prompt: 'The following conversation is about frontend and backend programming.',
      language: config.language && config.language !== 'auto' ? config.language : undefined
    })

    const text = transcription.text
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
  } finally {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch (e) {
      console.error('Chyba při mazání dočasného souboru:', e.message)
    }
  }
})
