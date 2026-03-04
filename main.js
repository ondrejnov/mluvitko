const path = require('path')
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config({ path: path.join(process.cwd(), '.env') })
}

const { app, globalShortcut, Tray, BrowserWindow, ipcMain, clipboard, screen, nativeImage, dialog, systemPreferences, shell } = require('electron')
//const { autoUpdater } = require('electron-updater')
const screenshot = require('screenshot-desktop')
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args))
const fs = require('fs')
const loudness = require('loudness')
//const { loginWithGoogle } = require('./auth')
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
let config = { deviceId: null, openAtLogin: false, duckingVolume: 5, language: 'cs', shortcut: 'Ctrl+Win', apiKey: '', llmUrl: 'http://10.0.0.232:1234', screenshotEnabled: true, fixedPrompt: '', customWords: '', llmPrompt: 'Extrahuj z obrázku klíčové slova, názvy proměnných a důležité termíny. Bude to krátký kontext pro speak-to-text model. Max 350 tokenů.' }
let savedVolume = null
let currentPromptPromise = null
let isShuttingDown = false

function configureRuntimePaths() {
  try {
    const cachePath = path.join(app.getPath('temp'), 'mluvitko-cache')
    const sessionDataPath = path.join(cachePath, 'session-data')

    fs.mkdirSync(cachePath, { recursive: true })
    fs.mkdirSync(sessionDataPath, { recursive: true })

    app.setPath('cache', cachePath)
    app.setPath('sessionData', sessionDataPath)
  } catch (e) {
    console.warn('Nepodařilo se nastavit sessionData path:', e.message)
  }

  app.commandLine.appendSwitch('disk-cache-dir', path.join(app.getPath('temp'), 'mluvitko-cache'))
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
  app.commandLine.appendSwitch('disable-http-cache')
}

configureRuntimePaths()

const SUPPORTED_SHORTCUTS = process.platform === 'darwin'
  ? ['Ctrl+Win', 'Alt+Space', 'Shift+Space', 'F8', 'F9', 'F10', 'F12']
  : ['Ctrl+Win', 'Ctrl+Space', 'Ctrl+M', 'Alt+Space', 'Shift+Space', 'F8', 'F9', 'F10', 'F12']

function getDefaultShortcut() {
  return 'Ctrl+Win'
}

function getEffectiveShortcut(shortcut = config.shortcut) {
  if (SUPPORTED_SHORTCUTS.includes(shortcut)) return shortcut
  return getDefaultShortcut()
}

// Uloží aktuální hlasitost a sníží na nastavenou hodnotu
async function volGetAndSetDucking() {
  try {
    const v = await loudness.getVolume()
    const targetVol = config.duckingVolume !== undefined ? config.duckingVolume : 5
    await loudness.setVolume(targetVol)
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
async function openMacAccessibilitySettings() {
  if (process.platform !== 'darwin') return

  const targets = [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    'x-apple.systempreferences:com.apple.preference.security'
  ]

  for (const target of targets) {
    try {
      await shell.openExternal(target)
      return
    } catch (e) {
      console.warn(`Nepodařilo se otevřít ${target}:`, e.message)
    }
  }

  try {
    const openPathError = await shell.openPath('/System/Library/PreferencePanes/Security.prefPane')
    if (!openPathError) return
    console.warn('shell.openPath vrátil chybu:', openPathError)
  } catch (e) {
    console.warn('Nepodařilo se otevřít Security.prefPane:', e.message)
  }

  dialog.showErrorBox(
    'Nelze otevřít nastavení',
    'Nastavení se nepodařilo otevřít automaticky. Otevřete ručně: Nastavení systému -> Soukromí a zabezpečení -> Zpřístupnění.'
  )
}

function checkMacAccessibility(manual = false) {
  if (process.platform === 'darwin') {
    const isTrusted = systemPreferences.isTrustedAccessibilityClient(false)
    if (!isTrusted) {
      console.log('Vyžadováno oprávnění pro usnadnění (Accessibility).')
      dialog.showMessageBox({
        type: 'warning',
        title: 'Oprávnění pro usnadnění',
        message: 'Mluvítko potřebuje oprávnění pro usnadnění (Accessibility), aby mohlo reagovat na globální klávesové zkratky.\n\nPokud jste oprávnění již udělili a stále to nefunguje, odeberte Mluvítko ze seznamu (tlačítkem mínus) a přidejte jej znovu. Poté aplikaci restartujte.',
        buttons: ['Otevřít nastavení', 'Zrušit']
      }).then(({ response }) => {
        if (response === 0) {
          void openMacAccessibilitySettings()
        }
      })
    } else if (manual) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Oprávnění pro usnadnění',
        message: 'Systém hlásí, že oprávnění je uděleno. Pokud klávesy přesto nefungují, je to pravděpodobně způsobeno aktualizací aplikace (změna podpisu).\n\nŘešení: Otevřete Nastavení systému -> Soukromí a zabezpečení -> Zpřístupnění, odeberte Mluvítko ze seznamu (tlačítkem mínus) a přidejte jej znovu. Poté aplikaci restartujte.',
        buttons: ['Otevřít nastavení', 'OK']
      }).then(({ response }) => {
        if (response === 0) {
          void openMacAccessibilitySettings()
        }
      })
    }
    return isTrusted
  }
  return true
}

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
  config.shortcut = getEffectiveShortcut(config.shortcut)
  applyLoginSettings()
}

function saveConfig() {
  const configPath = path.join(app.getPath('userData'), 'config.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
}

// ─── App ready ───────────────────────────────────────────────────────────────
let isManualUpdateCheck = false

app.whenReady().then(() => {
  if (process.platform === 'darwin' && !app.isPackaged) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')))
    } catch (e) {
      console.error('Chyba při nastavení dock ikony:', e)
    }
  }
  loadConfig()
  createTray()
  createOverlay()
  createRecorderWindow()

  // Počkej až jsou okna ready, pak registruj hotkey
  setTimeout(() => {
    const accessibilityOk = checkMacAccessibility()
    if (accessibilityOk) {
      registerHotkey()
    } else {
      console.warn('Hotkey neregistrován: chybí oprávnění Accessibility.')
    }
  }, 1000)

  // Zkontroluj aktualizace
  //autoUpdater.checkForUpdatesAndNotify()
})

// ─── Auto Updater Události ───────────────────────────────────────────────────
// autoUpdater.on('update-available', () => {
//   dialog.showMessageBox({
//     type: 'info',
//     title: 'Aktualizace k dispozici',
//     message: 'Nová verze aplikace je k dispozici. Stahuje se na pozadí...'
//   })
// })

// autoUpdater.on('update-not-available', () => {
//   if (isManualUpdateCheck) {
//     dialog.showMessageBox({
//       type: 'info',
//       title: 'Žádné aktualizace',
//       message: 'Máte nejnovější verzi aplikace.'
//     })
//     isManualUpdateCheck = false
//   }
// })

// autoUpdater.on('update-downloaded', () => {
//   dialog.showMessageBox({
//     type: 'info',
//     title: 'Aktualizace připravena',
//     message: 'Aktualizace byla stažena. Aplikace se nyní restartuje a nainstaluje novou verzi.',
//     buttons: ['Restartovat']
//   }).then(() => {
//     autoUpdater.quitAndInstall()
//   })
// })

// autoUpdater.on('error', (err) => {
//   console.error('Chyba při aktualizaci:', err)
//   if (isManualUpdateCheck) {
//     dialog.showErrorBox('Chyba aktualizace', 'Nepodařilo se zkontrolovat aktualizace. Zkontrolujte připojení k internetu.')
//     isManualUpdateCheck = false
//   }
// })

app.on('window-all-closed', (e) => e.preventDefault()) // Tray app – nezavírat
app.on('will-quit', () => {
  isShuttingDown = true
  globalShortcut.unregisterAll()
})

process.on('uncaughtException', (err) => {
  console.error('Neodchycená chyba v hlavním procesu:', err)
})

process.on('unhandledRejection', (reason) => {
  console.error('Neodchycený promise reject v hlavním procesu:', reason)
})

app.on('render-process-gone', (_event, webContents, details) => {
  console.error('Renderer process gone:', details.reason, 'exitCode:', details.exitCode, 'url:', webContents.getURL())
})

app.on('child-process-gone', (_event, details) => {
  console.error('Child process gone:', details.type, details.reason, 'exitCode:', details.exitCode)
})

// ─── Tray ────────────────────────────────────────────────────────────────────
function getShortcutLabel() {
  const shortcut = getEffectiveShortcut()
  if (process.platform === 'darwin') {
    if (shortcut === 'Ctrl+Win') return 'Ctrl+Cmd'
    if (shortcut === 'Alt+Space') return 'Option+Mezerník'
  }
  return shortcut
}

function updateTrayMenu() {
  const shortcut = getShortcutLabel()
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
    // { label: 'Zkontrolovat aktualizace', click: () => {
    //     isManualUpdateCheck = true
    //     autoUpdater.checkForUpdatesAndNotify()
    //   }
    // },
    ...(process.platform === 'darwin' ? [{ label: 'Opravit oprávnění kláves (Mac)', click: () => checkMacAccessibility(true) }] : []),
    { label: 'Nastavení...', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Ukončit', click: () => app.exit(0) }
  )

  const menu = Menu.buildFromTemplate(menuTemplate)
  tray.setContextMenu(menu)
}

function createTray() {
  let idleIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-idle.png'))
  tray = new Tray(idleIcon)
  updateTrayMenu()
}

function setTrayActive(active) {
  let icon = nativeImage.createFromPath(path.join(__dirname, 'assets', active ? 'tray-active.png' : 'tray-idle.png'))
  const shortcut = getShortcutLabel()
  tray.setImage(icon)
  tray.setToolTip(active ? '🔴 Nahrávám...' : `Mluvítko – drž ${shortcut} pro nahrávání`)
}

function isWindowUsable(win) {
  return !!(win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed())
}

function safeSendToWindow(win, channel, ...args) {
  try {
    if (!isWindowUsable(win)) return false
    win.webContents.send(channel, ...args)
    return true
  } catch (e) {
    console.error(`IPC send selhal (${channel}):`, e.message)
    return false
  }
}

function hideOverlayIfVisible() {
  if (!isWindowUsable(overlayWindow)) return
  try {
    overlayWindow.hide()
  } catch (e) {
    console.error('Chyba při skrývání overlay:', e.message)
  }
}

function ensureOverlayWindow() {
  if (isWindowUsable(overlayWindow)) return overlayWindow
  createOverlay()
  return overlayWindow
}

function ensureRecorderWindow() {
  if (isWindowUsable(recorderWindow)) return recorderWindow
  createRecorderWindow()
  return recorderWindow
}

// ─── Overlay okno ────────────────────────────────────────────────────────────
function createOverlay() {
  if (isWindowUsable(overlayWindow)) return

  overlayWindow = new BrowserWindow({
    width: 70,
    height: 70,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false  // Renderer nesmí být uspán, jinak se IPC zpráva zpracuje pozdě
    }
  })

  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'))

  // Pokud renderer crashne nebo je okno zavřeno, vytvoř ho znovu
  overlayWindow.on('closed', () => { overlayWindow = null })
  overlayWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Overlay renderer zhasnul:', details.reason)
    overlayWindow = null
    if (!isShuttingDown) setTimeout(() => createOverlay(), 300)
  })
}

// ─── Recorder okno (skrytý renderer pro Web Audio API) ───────────────────────
function createRecorderWindow() {
  if (isWindowUsable(recorderWindow)) return

  recorderWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  recorderWindow.loadFile('recorder.html')
  recorderWindow.webContents.once('did-finish-load', () => {
    safeSendToWindow(recorderWindow, 'set-device', config.deviceId)
  })

  recorderWindow.on('closed', () => {
    console.warn('Recorder window zavřeno, obnovuji...')
    recorderWindow = null
    if (!isShuttingDown) setTimeout(() => createRecorderWindow(), 300)
  })

  recorderWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Recorder renderer zhasnul:', details.reason)
    recorderWindow = null
    if (!isShuttingDown) setTimeout(() => createRecorderWindow(), 300)
  })
}

// ─── Settings okno ───────────────────────────────────────────────────────────
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 500,
    height: 700,
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
      safeSendToWindow(accountWindow, 'user-updated', config.user)
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
    'Ctrl+M': [UiohookKey.Ctrl, UiohookKey.M],
    'Cmd+M': [UiohookKey.Meta, UiohookKey.M],
    'Alt+Space': [UiohookKey.Alt, UiohookKey.Space],
    'Shift+Space': [UiohookKey.Shift, UiohookKey.Space],
    'F8': [UiohookKey.F8],
    'F9': [UiohookKey.F9],
    'F10': [UiohookKey.F10],
    'F12': [UiohookKey.F12]
  }
  const shortcut = getEffectiveShortcut()
  return map[shortcut] || map[getDefaultShortcut()]
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
  try {
    const { uIOhook } = require('uiohook-napi')

    uIOhook.on('keydown',  (e) => {
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
        activeKeys.clear() // Reset – předchází zaseknutí po zmeškaném keyup eventu
        stopAndSend()
      }
    })

    uIOhook.start()
    console.log('Hotkey registrován (push-to-talk)')
  } catch (e) {
    console.error('Chyba při registraci hotkey (uiohook-napi):', e)
    dialog.showErrorBox(
      'Chyba klávesové zkratky',
      `Nepodařilo se načíst modul pro globální zkratky.\n\n${e.message}\n\nZkuste přeinstalovat aplikaci nebo restartovat Mac.`
    )
  }
}

// ─── Nahrávání ───────────────────────────────────────────────────────────────
async function startRecording() {
  console.log('▶ Start nahrávání')

  // Okamžitě pošli signál k nahrávání, nečekej na změnu hlasitosti (na Macu to trvá i 500ms)
  const recorder = ensureRecorderWindow()
  if (!safeSendToWindow(recorder, 'start-recording')) {
    console.error('Start nahrávání selhal: recorder window není dostupné')
    isRecording = false
    activeKeys.clear()
    setTrayActive(false)
    return
  }

  // Hlasitost snižuj asynchronně
  volGetAndSetDucking().then(v => { savedVolume = v })

  setTrayActive(true)

  // Pokud bylo okno zničeno (crash rendereru), vytvoř ho znovu
  const overlay = ensureOverlayWindow()

  // Přepočítej pozici vždy před zobrazením (řeší produkční build, různé DPI, vzdálené plochy)
  if (isWindowUsable(overlay)) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    overlay.setPosition(width - 90, height - 90)
    overlay.showInactive() // showInactive() nekrade focus ani na macOS ani na Windows
    // Vynuť z-order po show() – na Windows občas nestačí jen konstruktor
    overlay.setAlwaysOnTop(true, 'pop-up-menu')
  }
  // Pošli IPC s malým zpožděním – pokud byl renderer throttled, potřebuje chvíli se probudit
  setTimeout(() => {
    safeSendToWindow(overlayWindow, 'recording-start')
  }, 50)

  // Nastav prompt – fixní nebo ze screenshotu asynchronně
  currentPromptPromise = (async () => {
    let basePrompt = config.fixedPrompt || ''
    if (config.screenshotEnabled !== false) {
      try {
        const screenshotPath = path.join(app.getPath('temp'), 'mluvitko-screenshot.png')
        await screenshot({ filename: screenshotPath })
        console.log(`Screenshot uložen: ${screenshotPath}`)
        if (fs.existsSync(screenshotPath)) {
          const imageBuffer = fs.readFileSync(screenshotPath)
          const base64Image = imageBuffer.toString('base64')

          console.log('Odesílám screenshot do LM Studio...')
          const llmAbort = new AbortController()
          const llmTimeout = setTimeout(() => llmAbort.abort(), 10000) // 10s timeout
          let llmRes
          try {
            llmRes = await fetch(`${config.llmUrl}/v1/chat/completions`, {
              method: 'POST',
              signal: llmAbort.signal,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'local-model',
                messages: [
                  {
                    role: 'user',
                    content: [
                      //{ type: 'text', text: 'Co je na tomto obrázku? Popiš nejdůležitější prvky, texty, názvy proměnných a jména. Bude to krátký kontext pro speak-to-text model. Max 350 tokenů.' },
                      { type: 'text', text: config.llmPrompt || 'Extrahuj z obrázku klíčové slova, názvy proměnných a důležité termíny. Bude to krátký kontext pro speak-to-text model. Max 350 tokenů.' },
                      { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
                    ]
                  }
                ],
                max_tokens: 350
              })
            })
          } finally {
            clearTimeout(llmTimeout)
          }

          if (llmRes.ok) {
            const llmData = await llmRes.json()
            if (llmData.choices && llmData.choices.length > 0) {
              const llmContent = llmData.choices[0].message.content
              const screenshotContext = `Na screenshotu je vidět: ${llmContent}`
              const finalPrompt = basePrompt ? `${basePrompt}\n\n${screenshotContext}` : screenshotContext
              //console.log('LLM Odpověď:', finalPrompt)
              return finalPrompt
            }
          } else {
            console.error('Chyba z LLM:', await llmRes.text())
          }
        }
      } catch (err) {
        console.error('Chyba při pořizování/zpracování screenshotu:', err)
      }
    } else {
      console.log('Screenshot vypnut, používám fixní prompt.')
    }
    return basePrompt
  })()
}

async function stopAndSend() {
  console.log('⏹ Stop nahrávání')

  // Okamžitě zastav nahrávání
  safeSendToWindow(recorderWindow, 'stop-recording')

  // Obnov hlasitost asynchronně
  volRestore()

  setTrayActive(false)
  safeSendToWindow(overlayWindow, 'recording-stop')
}

ipcMain.on('recording-error', (_event, err) => {
  console.error('Chyba mikrofonu:', err.code, err.message)
  isRecording = false
  activeKeys.clear()
  hideOverlayIfVisible()
  setTrayActive(false)
  tray.setToolTip(`❌ Mikrofon: ${err.message}`)
  setTimeout(() => tray.setToolTip(`Mluvítko – drž ${getShortcutLabel()} pro nahrávání`), 3000)
})

// ─── IPC: nastavení ─────────────────────────────────────────────────────────
ipcMain.handle('get-config', () => config)
ipcMain.handle('save-settings', (event, newConfig) => {
  config = { ...config, ...newConfig }
  config.shortcut = getEffectiveShortcut(config.shortcut)
  saveConfig()
  applyLoginSettings()
  updateTrayMenu()
  if (recorderWindow && !recorderWindow.isDestroyed()) {
    safeSendToWindow(recorderWindow, 'set-device', config.deviceId)
  }
})

// ─── IPC: účet ──────────────────────────────────────────────────────────────
ipcMain.handle('get-user', () => config.user)
//ipcMain.handle('login', () => handleLogin())
//ipcMain.handle('logout', () => handleLogout())
// ─── IPC: přijmi audio z recorder.html ───────────────────────────────────────

ipcMain.on('audio-data', async (event, arrayBuffer) => {
  // Přepni overlay do stavu "zpracovávám" – neztrácíme focus na inputu
  safeSendToWindow(overlayWindow, 'transcribing')

  const rand = Math.round(Date.now())
  const tempPath = path.join(app.getPath('temp'), `audio_${rand}.webm`)
  fs.writeFileSync(tempPath, Buffer.from(arrayBuffer))
  //const tempPath = "c:\\Users\\ondrej\\AppData\\Local\\Temp\\audio_1771668795598.webm"

  console.log(`Audio uloženo: ${tempPath} (${Buffer.from(arrayBuffer).length} bytes)`)

  let resolvedPrompt = ''
  if (currentPromptPromise) {
    try {
      resolvedPrompt = await currentPromptPromise
    } catch (e) {
      console.error('Chyba při získávání promptu:', e)
      resolvedPrompt = config.fixedPrompt || ''
    }
  }


  const apiKey = process.env.OPENAI_API_KEY || config.apiKey
  try {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('Není nastaven OpenAI API klíč. Nastavte OPENAI_API_KEY v .env nebo v nastavení aplikace.')
    }
    const openai = new OpenAI({ apiKey: apiKey.trim() })

    const finalPrompt = (resolvedPrompt + (config.customWords ? "\nspecifické slova: " + config.customWords : '')).trim()
    console.log(finalPrompt)

    const transcription = await openai.audio.transcriptions.create({
      model: 'gpt-4o-transcribe',
      file: fs.createReadStream(tempPath),
      prompt: finalPrompt || undefined,
      //language: config.language && config.language !== 'auto' ? config.language : undefined
    })

    //const transcription = {text: 'Simulovaná transkripce – nahrajte skutečný audio soubor a nastavte OpenAI API klíč pro získání reálné transkripce.'}
    const text = transcription.text
    console.log('Transkripce:', text)

    const finalText = text.trim()

    if (finalText) {
      // Skryj overlay těsně před vložením, aby focus zůstal na inputu
      hideOverlayIfVisible()

      // Krátká pauza – systém musí přepnout focus zpět na okno pod overlay
      await new Promise(resolve => setTimeout(resolve, 80))

      // Vlož text přes schránku + Ctrl+V
      const prevClipboard = clipboard.readText()
      clipboard.writeText(finalText)
      try {
        const robot = require('@jitsi/robotjs')
        robot.keyTap('v', process.platform === 'darwin' ? ['command'] : ['control'])
      } catch (e) {
        console.error('Chyba při vkládání textu (robotjs):', e)
      }

      // Obnov původní obsah schránky po malém zpoždění
      setTimeout(() => clipboard.writeText(prevClipboard), 500)
    } else {
      hideOverlayIfVisible()
    }

  } catch (err) {
    hideOverlayIfVisible()
    console.error('Chyba při transkripci:', err.message)
    // Zobraz chybu v tray tooltipu na 3s
    tray.setToolTip(`❌ Chyba: ${err.message}`)
    setTimeout(() => tray.setToolTip(`Mluvítko – drž ${getShortcutLabel()} pro nahrávání`), 3000)
  } finally {
    try {
      //if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    } catch (e) {
      console.error('Chyba při mazání dočasného souboru:', e.message)
    }
  }
})
