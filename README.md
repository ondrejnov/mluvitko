# 🎙 Mluvítko

Push-to-talk hlasový vstup s AI transkripcí. Drž **Ctrl+Win**, mluv, pusť – text se vloží do aktivního pole.

---

## Rychlý start

### 1. Požadavky

- **Node.js** 18+ → https://nodejs.org
- **Visual Studio Build Tools** (pro kompilaci nativních modulů)
  ```
  winget install Microsoft.VisualStudio.2022.BuildTools
  ```
  Nebo stáhni z: https://visualstudio.microsoft.com/cs/downloads/ → "Build Tools for Visual Studio"

---

### 2. Electron aplikace

```bash
# V kořenovém adresáři projektu:
npm install
npm start
```

Při prvním `npm install` se zkompilují nativní moduly (`uiohook-napi`, `robotjs`).
Pokud selže → ověř, že máš nainstalované Visual Studio Build Tools.

---

### 3. Použití

1. Spusť aplikaci (`npm start`)
2. V systray (vedle hodin) uvidíš ikonu 🎙
3. **Drž Ctrl+Win** → červená tečka = nahrávám
4. **Pusť Ctrl+Win** → modrý spinner = přepisuji, pak se text vloží do pole, kde byl kurzor

> **Změna mikrofonu:** Klikni pravým na ikonu v systray → *Nastavení mikrofonu...*

---

## Build (vytvoření .exe instalátoru)

```bash
npm run build       # NSIS instalátor → dist/Voice Input Setup 1.0.0.exe
npm run build:dir   # Rychlejší, bez instalátoru (rozbalená složka)
```

---

### Změna hotkey

V `main.js` najdi `UiohookKey.` a změň na jiný klíč.
Seznam kódů: https://github.com/FZKiritsugu/uiohook-napi#key-codes

---

## Struktura projektu

```
voice-input/
├── main.js          ← Electron hlavní proces, hotkey, tray, IPC
├── overlay.html     ← Floating indikátor (červená tečka → modrý spinner)
├── recorder.html    ← Skrytý renderer pro Web Audio API
├── settings.html    ← Výběr mikrofonu
├── package.json
├── assets/
│   ├── tray-idle.png    ← Ikona v klidu
│   ├── tray-active.png  ← Ikona při nahrávání (červená)
│   └── icon.ico         ← Ikona aplikace
```

---

## Řešení problémů

**`npm install` selže na robotjs/uiohook:**
→ Nainstaluj Visual Studio Build Tools

**Mikrofon nefunguje:**
→ Zkontroluj oprávnění mikrofonu: Nastavení Windows → Soukromí → Mikrofon

**Text se nevkládá:**
→ Ujisti se, že kurzor je v textovém poli před stiskem Ctrl+Win

**Backend není dostupný:**
→ Aplikace se připojuje na vzdálený backend (hardcoded adresa v `main.js`). Zkontroluj, že je server dostupný, nebo uprav URL přímo v `main.js`.

