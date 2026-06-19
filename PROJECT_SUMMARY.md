# ANKIT Interview Companion — Project Summary

## Overview

**ANKIT Interview Companion** is a real-time, always-on-top AI-powered desktop overlay assistant built with **Electron**. It sits transparently over any application during a job interview and provides live AI-generated hints, answers, and code solutions by listening to audio and/or analyzing the screen.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop Shell | Electron 28 |
| UI Renderer | Vanilla HTML/CSS/JS (ES Modules) |
| AI — Live Audio | Google Gemini 2.5 Flash Live (WebSocket) |
| AI — Text/Vision | Google Gemini 2.5 Flash (HTTP streaming) |
| AI — Fast Fallback | Groq API (Llama 3.3 70B, streaming) |
| Audio Capture | Web Audio API + Chromium DesktopCapturer |
| Markdown Rendering | marked.js (CDN) |
| Build/Packaging | electron-builder |

---

## Project Structure

```
next_offer_ai/
├── main.js                  # Electron main process — window, shortcuts, IPC
├── preload.js               # Context bridge — exposes safe APIs to renderer
├── renderer.js              # UI logic — all frontend interactions
├── overlay.html             # Single-page overlay UI (HTML + CSS)
├── gemini-service.js        # AI backend — Gemini Live, Flash, Groq, Vision
├── audio-capture-service.js # Audio capture helper (mic + system loopback)
└── package.json             # App metadata and dependencies
```

---

## File-by-File Breakdown

### `main.js` — Electron Main Process
- Creates a **frameless, transparent, always-on-top** `BrowserWindow` (380×600px) docked to the right side of the screen.
- Registers **global keyboard shortcuts**:
  - `Ctrl+M` — Toggle click-through mode (overlay becomes mouse-transparent)
  - `Ctrl+\` — Close the overlay
  - `Ctrl+Enter` — Trigger screen vision analysis
- Sets up a `displayMediaRequestHandler` to auto-select the primary screen for WebRTC capture (no picker dialog).
- Exposes IPC handlers for window movement (`move-window`) and screen source listing (`get-screen-sources`).

---

### `preload.js` — Context Bridge
Safely exposes a set of `electronAPI` methods to the renderer via `contextBridge`:
- `moveWindow(direction)` — Move overlay with arrow keys
- `setClickThrough(value)` — Toggle mouse passthrough
- `getScreenSources()` — List available screen capture sources
- `initializeStandaloneBYOK(args)` — Start a Gemini Live session
- `sendPCMAudioChunk(base64PCM)` — Stream raw audio to Gemini
- `sendImageToGeminiHttp(args)` — Send a screenshot for vision analysis
- `sendTextToGeminiHttp(args)` — Send a typed text prompt
- `closeStandaloneSession()` — Tear down the live session
- `onIpcEvent(channel, callback)` — Subscribe to streaming events from main process

---

### `overlay.html` — UI Shell
A single-page dark-themed overlay with three main views:

1. **Setup Panel (Tabbed)**
   - **BYOK Mode tab** — Enter Gemini API key, optional Groq key, select interview profile (Coding / HR / General), and spoken language.
   - **Sync Portal tab** — Enter a JWT token and Session ID to connect to a Rails WebSocket backend.
   - **Preferences tab** — Adjust overlay opacity, always-on-top, click-through toggle, and a custom system prompt override.

2. **Live Session Panel**
   - Live transcript bubbles (candidate vs. interviewer, color-coded)
   - AI response area with Markdown rendering
   - Pagination to browse through multiple AI responses
   - Copy button to extract code blocks
   - Session timer

3. **Bottom Control Bar**
   - Start/Stop audio capture button
   - Speaker toggle (Candidate ↔ Interviewer)
   - Text input for manual prompt override
   - **Vision button** — captures a screenshot and sends it to Gemini for analysis

---

### `renderer.js` — Frontend Logic
The main UI controller. Key responsibilities:

- **Settings persistence** via `localStorage` (API keys, preferences, opacity, etc.)
- **Keyboard shortcuts** inside the overlay (`Ctrl+Arrow` to move the window)
- **Mode 1 — SaaS Sync**: Connects to a Rails Action Cable WebSocket (`ws://localhost:3000/cable`). Receives `transcript_update` and `ai_response` messages and renders them with STAR/code formatting.
- **Mode 2 — Standalone BYOK**: Directly calls Gemini Live via IPC. Captures mic + system audio using the Web Audio API, converts Float32 PCM → Int16, encodes to Base64, and streams chunks to the main process at 24 kHz.
- **Vision Analysis**: Captures a video frame from the screen using a hidden `<video>` element and an offscreen `<canvas>`, converts it to a JPEG blob, and sends it to Gemini via IPC.
- **Waveform Visualizer**: Canvas-based animated sine wave shown on the Vision button while analysis is in progress.
- **Pagination**: Stores all AI responses in an array and lets the user navigate between them.

---

### `gemini-service.js` — AI Backend (Main Process)
Handles all AI communication from the Electron main process:

- **`initializeGeminiSession()`** — Opens a persistent WebSocket to `gemini-2.5-flash-native-audio-preview` using the `@google/genai` SDK. Configures:
  - Speaker diarization (2 speakers: candidate + interviewer)
  - Input/output audio transcription
  - Google Search grounding tool
  - Custom system instruction based on selected profile
- **`sendToGeminiFlash()`** — HTTP streaming call to `gemini-2.5-flash` for text responses. Maintains a rolling conversation history.
- **`sendToGroq()`** — HTTP streaming call to Groq's OpenAI-compatible endpoint (`llama-3.3-70b-versatile`) as a faster fallback. Strips `<think>` tags from DeepSeek-style reasoning output.
- **`sendImageToGeminiHttp()`** — Sends a Base64 JPEG screenshot to `gemini-2.5-flash` for visual problem solving.
- **`getSystemPrompt()`** — Builds a dynamic system prompt based on the selected profile (`coding`, `hr`, or `interview`), plus any custom user instructions.
- **IPC Handlers**: Wires up all `ipcMain.handle` calls so the renderer can trigger AI operations securely.

---

### `audio-capture-service.js` — Audio Capture Helper
A reusable class used in the SaaS Sync mode:

- Captures **microphone** via `getUserMedia`.
- Captures **system audio loopback** via Chromium's `chromeMediaSource: 'desktop'` API.
- Mixes both streams using the Web Audio API with gain nodes (mic at 1.0×, system at 1.5× to boost the interviewer's voice).
- Records in **2-second rolling segments** using `MediaRecorder`, converts each segment to a Base64 WebM blob, and fires a callback.
- Provides OS-specific fallback instructions (PulseAudio/PipeWire on Linux, BlackHole on macOS, WASAPI on Windows) when system audio capture fails.

---

## Two Operating Modes

### Mode 1: Standalone BYOK (Bring Your Own Key)
```
User provides Gemini API Key (+ optional Groq key)
        ↓
Gemini Live WebSocket opens (audio streaming)
        ↓
Mic + System audio captured → PCM chunks → IPC → Gemini Live
        ↓
Transcription received → Groq or Gemini Flash generates answer
        ↓
Streamed response rendered in overlay with Markdown
```

### Mode 2: SaaS Portal Sync
```
User provides JWT Token + Session ID
        ↓
WebSocket connects to Rails backend (localhost:3000)
        ↓
Backend pushes transcript_update / ai_response messages
        ↓
Overlay renders formatted STAR / code responses
```

---

## Key Features

- **Always-on-top transparent overlay** — sits over any video call or browser window
- **Click-through mode** (`Ctrl+M`) — overlay becomes invisible to mouse clicks
- **Real-time audio transcription** with speaker diarization (candidate vs. interviewer)
- **Screen Vision Analysis** (`Ctrl+Enter` or Vision button) — solves coding problems visible on screen
- **Dual AI backend** — Gemini Flash for quality, Groq for speed
- **Profile-aware prompts** — Coding, HR/Behavioral, or General interview modes
- **Paginated response history** — browse all AI answers during a session
- **Markdown rendering** — code blocks, bullet points, STAR responses
- **Cross-platform packaging** — builds for Windows (NSIS), macOS (DMG), and Linux (deb/rpm/AppImage)

---

## Running the App

```bash
# Install dependencies
npm install

# Start in development
npm start

# Build distributable
npm run dist
```

---

## Dependencies

| Package | Purpose |
|---|---|
| `electron` ^28 | Desktop app shell |
| `@google/genai` ^1.2 | Gemini Live + Flash API client |
| `ws` ^8.14 | WebSocket support |
| `electron-builder` ^24 | Cross-platform packaging |
