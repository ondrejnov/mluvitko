# 🎙 Mluvítko

Push-to-talk hlasový vstup s AI transkripcí. Tento nástroj umožňuje snadné zadávání textu hlasem. Stačí stisknout a držet klávesovou zkratku **Ctrl+Win** (na macOS **Ctrl+Cmd**), mluvit, a po uvolnění kláves se přepsaný text automaticky vloží do aktivního textového pole.

Tento projekt je self-hosted alternativa k online službě [WisprFlow](https://wisprflow.ai/), kterou se inspiroval. Nabízí podobnou funkcionalitu, ale běží lokálně na vašem zařízení, což zajišťuje větší kontrolu nad daty a soukromím. Je zcela zdarma, s výjimkou případného poplatku za využití OpenAI transkripčního modelu, pokud je použit.

## Uživatelské rozhraní

Aplikace poskytuje jednoduché a intuitivní uživatelské rozhraní:

1. **Ikona v systray:**
   - Po spuštění aplikace se v systémové liště (systray) objeví ikona 🎙.
   - Stav ikony:
     - **Šedá:** Aplikace je připravena.
     - **Červená:** Probíhá nahrávání.
     - **Modrý spinner:** Probíhá přepis.

2. **Plovoucí indikátor:**
   - Během nahrávání se na obrazovce zobrazí malý plovoucí indikátor:
     - **Červená tečka:** Signalizuje aktivní nahrávání.
     - **Modrý spinner:** Signalizuje probíhající přepis.

3. **Nastavení mikrofonu:**
   - Kliknutím pravým tlačítkem na ikonu v systray lze otevřít nabídku s možností změny mikrofonu.

4. **Automatické ztlumení zvuku:**
   - Během nahrávání se systémová hlasitost automaticky sníží na 5 %, aby se předešlo zpětné vazbě z mikrofonu. Po ukončení nahrávání se hlasitost obnoví na původní úroveň.

5. **👁️ Dejte své AI oči (Screenshot jako kontext):**
   - **Co to umí:** Tato funkce umožňuje aplikaci lépe pochopit, co právě děláte. Spolu s vaším hlasovým povelem dokáže aplikace pořídit snímek obrazovky a použít jej jako kontext pro lokální AI model. To znamená, že AI může lépe porozumět tomu, co máte otevřené, a přizpůsobit odpovědi vašemu aktuálnímu prostředí.
   - **Jak to funguje:** Během diktování se na pozadí bleskově a bezpečně vyfotí vaše aktuální obrazovka. Tento snímek se spojí s vaším hlasovým dotazem a odešle se do lokálního AI modelu, který jej využije jako doplňkový kontext. AI tak může lépe pochopit, co právě děláte, a nabídnout relevantní odpovědi.
   - **K čemu je to dobré (Příklady z praxe):**
     - 💻 *Vývojáři:* "Jaký je význam této chybové hlášky?" nebo "Jaký kód by odpovídal tomuto designu?"
     - 📊 *Analytici:* "Co znamenají tyto hodnoty v grafu?"
     - 🌍 *Každodenní práce:* "Jak odpovědět na tento e-mail?" nebo "Co znamená tento text na obrazovce?"
   - **Jak to nastavit:** V nastavení aplikace (Settings) jednoduše zaškrtněte volbu pro odesílání snímků obrazovky. Funkce je optimalizována pro lokální modely, které podporují zpracování vizuálního kontextu.


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
3. **Drž Ctrl+Win** (na macOS **Ctrl+Cmd**) → červená tečka = nahrávám
4. **Pusť zkratku** → modrý spinner = přepisuji, pak se text vloží do pole, kde byl kurzor

> **Změna mikrofonu:** Klikni pravým na ikonu v systray → *Nastavení mikrofonu...*

---

## Build (vytvoření .exe instalátoru)

```bash
npm run build       # NSIS instalátor
npm run build:dir   # Rychlejší, bez instalátoru (rozbalená složka)
```

---

### Změna hotkey

V aplikaci otevři **Nastavení → Klávesová zkratka**.

Podporované zkratky:

- **Windows / Linux:** `Ctrl+Win`, `Ctrl+Space`, `Ctrl+M`, `Alt+Space`, `Shift+Space`, `F8`, `F9`, `F10`, `F12`
- **macOS:** `Ctrl+Cmd`, `Option+Space`, `Shift+Space`, `F8`, `F9`, `F10`, `F12`

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

## Řešení problémů

**`npm install` selže na robotjs/uiohook:**
→ Nainstaluj Visual Studio Build Tools

**Mikrofon nefunguje:**
→ Zkontroluj oprávnění mikrofonu: Nastavení Windows → Soukromí → Mikrofon

**macOS build padá při nahrávání:**
→ Ujisti se, že build obsahuje `NSMicrophoneUsageDescription` v `Info.plist` (v tomto projektu je přes `build.mac.extendInfo` v `package.json`) a po změně proveď nový build (`npm run build:mac`).

**Text se nevkládá:**
→ Ujisti se, že kurzor je v textovém poli před stiskem zvolené zkratky

**OpenAI API klíč není nastaven:**
→ Otevři nastavení aplikace a zadej svůj OpenAI API klíč.

---

