/**
 * SpeechRecognitionService — Gemini Live Transcription Bridge
 * ─────────────────────────────────────────────────────────────────────────────
 * Instead of using the Web Speech API (which fails with "network" errors in
 * Electron on Linux), this service hooks into the Gemini Live session that is
 * already running and transcribing audio via inputAudioTranscription.
 *
 * Flow:
 *   Mic/System audio → PCM → Gemini Live → inputTranscription IPC event
 *   → SpeechRecognitionService → onFinalTranscript(text) → prompt override
 *
 * The Gemini Live session fires 'interim-transcript' IPC events for each
 * transcription chunk, and the existing 'append-transcript-text' event fires
 * on turnComplete. We listen to both to drive the UI and auto-inject.
 *
 * Debounce + duplicate suppression are applied so rapid repeated phrases
 * don't spam the AI pipeline.
 */

const DEBOUNCE_MS      = 800;   // wait after last chunk before firing
const DUPLICATE_WINDOW = 8000;  // suppress identical text within this window (ms)
const MIN_WORDS        = 2;     // ignore single-word noise

export class SpeechRecognitionService {
  constructor() {
    this._running        = false;
    this._debounceTimer  = null;
    this._pendingText    = '';
    this._lastFiredText  = '';
    this._lastFiredAt    = 0;
    this._interimHandler = null;
    this._finalHandler   = null;

    // Callbacks — set by caller
    this.onFinalTranscript   = null;  // (text: string) => void
    this.onInterimTranscript = null;  // (text: string) => void
    this.onStatusChange      = null;  // (status: string, msg?) => void
  }

  get isRunning() { return this._running; }

  /**
   * Start listening to Gemini Live transcription events.
   * The lang parameter is accepted for API compatibility but not used here —
   * language is controlled by the Gemini Live session config.
   */
  start(lang = 'en-US') {
    if (this._running) return;
    this._running = true;
    this._pendingText = '';

    // ── Listen for interim transcription chunks from Gemini Live ─────────────
    this._interimHandler = (text, speaker) => {
      if (!this._running) return;

      // Show live partial text
      if (this.onInterimTranscript) {
        this.onInterimTranscript(text);
      }

      // Only accumulate interviewer speech for auto-inject
      if (speaker === 'interviewer') {
        this._pendingText += ' ' + text;
        this._scheduleFire();
      }
    };

    // ── Listen for finalized turn-complete transcriptions ─────────────────────
    // 'append-transcript-text' fires with "[Interviewer]: ..." or "[Candidate]: ..."
    this._finalHandler = (fullLine) => {
      if (!this._running) return;
      const match = fullLine.match(/^\[(Interviewer)\]:\s*([\s\S]+)$/i);
      if (match) {
        // Interviewer turn completed — fire immediately (don't wait for debounce)
        clearTimeout(this._debounceTimer);
        this._pendingText = '';
        this._fireText(match[2].trim());
      }
    };

    // Register IPC listeners via the electronAPI bridge
    window.electronAPI.onIpcEvent('interim-transcript', (data) => {
      this._interimHandler(data.text, data.speaker);
    });

    window.electronAPI.onIpcEvent('append-transcript-text', (line) => {
      this._finalHandler(line);
    });

    this._emit('listening');
  }

  stop() {
    this._running = false;
    clearTimeout(this._debounceTimer);
    this._pendingText   = '';
    this._lastFiredText = '';
    // IPC listeners are cleaned up by the existing onIpcEvent mechanism
    this._emit('stopped');
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _scheduleFire() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      const text = this._pendingText.trim();
      this._pendingText = '';
      this._fireText(text);
    }, DEBOUNCE_MS);
  }

  _fireText(text) {
    if (!text) return;

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount < MIN_WORDS) return;

    const now = Date.now();
    if (
      text.toLowerCase() === this._lastFiredText.toLowerCase() &&
      now - this._lastFiredAt < DUPLICATE_WINDOW
    ) {
      console.log('[STT] Suppressed duplicate:', text);
      return;
    }

    this._lastFiredText = text;
    this._lastFiredAt   = now;

    console.log('[STT] Auto-inject:', text);
    if (this.onFinalTranscript) {
      this.onFinalTranscript(text);
    }
  }

  _emit(status, msg) {
    if (this.onStatusChange) this.onStatusChange(status, msg);
  }
}
