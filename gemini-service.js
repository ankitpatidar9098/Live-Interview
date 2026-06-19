const { ipcMain, BrowserWindow } = require('electron');
const https = require('https');

// ─── State ────────────────────────────────────────────────────────────────────
let activeSession      = null;
let currentTranscription = '';
let conversationHistory  = [];
let currentSystemPrompt  = '';
let groqHistory          = [];
let isInitializing       = false;
let currentSpeakerState  = 'candidate';   // toggled by renderer via IPC

// gemini-3.1-flash-live-preview is the current Live API model (as of June 2026)
// Replaces all gemini-2.0-flash-live-* and gemini-2.5-flash-native-audio-preview-* models
const LIVE_MODEL   = 'gemini-3.1-flash-live-preview';
const API_VERSION  = 'v1beta';   // SDK default

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendToRenderer(channel, data) {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) wins[0].webContents.send(channel, data);
}

function stripThinkingTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function getSystemPrompt(profile, customPrompt) {
  let base = `You are a real-time AI interview assistant. Provide brief, actionable hints and precise answers.
Keep formatting clean with bold key words. No lengthy introductions.
- Coding question  → 2-bullet approach + optimized code block + Time/Space complexity
- Behavioral question → STAR method in structured bullet points
- General question → 2-sentence direct answer`;

  if (profile === 'coding') {
    base += '\nFocus on data structures, algorithmic complexity, edge cases, and clean high-performance code.';
  } else if (profile === 'hr') {
    base += '\nFocus on leadership principles, communication, cultural alignment, and emotional intelligence. Always use STAR explicitly.';
  }

  if (customPrompt && customPrompt.trim()) {
    base += `\nAdditional instructions: ${customPrompt.trim()}`;
  }
  return base;
}

// ─── Native HTTPS POST (bypasses Chromium network service entirely) ─────────
function nodeHttpsPost(hostname, path, extraHeaders, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const req = https.request(
      {
        hostname,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          ...extraHeaders
        }
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { reject(new Error('JSON parse failed: ' + data.slice(0, 300))); }
        });
      }
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── Groq Whisper — multipart/form-data transcription (native https) ────────
function buildMultipartBody(boundary, fields, fileField, filename, mimeType, fileBuffer) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ));
  }
  const fileHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
  );
  const fileFooter = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([...parts, fileHeader, fileBuffer, fileFooter]);
}

async function transcribeWithGroqWhisper(audioBuffer, groqKey) {
  const boundary = 'WhisperBoundary' + Date.now() + Math.random().toString(36).slice(2);
  const body = buildMultipartBody(
    boundary,
    { model: 'whisper-large-v3', language: 'en' },
    'file', 'audio.webm', 'audio/webm',
    audioBuffer
  );

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.groq.com',
        path: '/openai/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length
        }
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          console.log('[Whisper] HTTP status:', res.statusCode);
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch (e) { reject(new Error('Whisper parse failed: ' + data.slice(0, 300))); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── Groq (native https, non-streaming) ───────────────────────────────────────
async function sendToGroq(transcription, groqKey) {
  if (!groqKey || !transcription.trim()) return;

  groqHistory.push({ role: 'user', content: transcription.trim() });
  if (groqHistory.length > 16) groqHistory = groqHistory.slice(-16);

  console.log('[Groq] Sending via native https...');
  try {
    const { status, body } = await nodeHttpsPost(
      'api.groq.com',
      '/openai/v1/chat/completions',
      { 'Authorization': `Bearer ${groqKey}` },
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
          ...groqHistory
        ],
        stream: false,
        temperature: 0.6,
        max_tokens: 1024
      }
    );
    if (status !== 200) {
      console.error('[Groq] API Error:', status);
      sendToRenderer('update-status', `Groq Error: ${status}`);
      return;
    }
    const fullText = body.choices?.[0]?.message?.content || '';
    console.log('[Groq] Response length:', fullText.length);
    const clean = stripThinkingTags(fullText);
    if (clean) {
      sendToRenderer('new-response', clean);
      groqHistory.push({ role: 'assistant', content: clean });
      conversationHistory.push({ timestamp: Date.now(), transcription: transcription.trim(), ai_response: clean });
    }
    sendToRenderer('update-status', 'Listening...');
  } catch (err) {
    console.error('[Groq] Error:', err.message);
    sendToRenderer('update-status', 'Groq Error: ' + err.message);
  }
}

// ─── Gemini Flash (native https, non-streaming) ───────────────────────────────
async function sendToGeminiFlash(transcription, apiKey) {
  if (!apiKey || !transcription.trim()) return;

  console.log('[Gemini Flash] Sending via native https...');
  try {
    const history = conversationHistory.flatMap(t => [
      { role: 'user',  parts: [{ text: t.transcription }] },
      { role: 'model', parts: [{ text: t.ai_response   }] }
    ]);
    history.push({ role: 'user', parts: [{ text: transcription.trim() }] });

    const { status, body } = await nodeHttpsPost(
      'generativelanguage.googleapis.com',
      `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {},
      {
        contents: history,
        systemInstruction: { parts: [{ text: currentSystemPrompt }] }
      }
    );

    if (status !== 200) {
      console.error('[Gemini Flash] API Error:', status, JSON.stringify(body).slice(0, 300));
      sendToRenderer('update-status', 'Gemini Error: ' + (body?.error?.message || status));
      return;
    }

    const fullText = (body.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    console.log('[Gemini Flash] Response length:', fullText.length);

    if (fullText.trim()) {
      sendToRenderer('new-response', fullText.trim());
      conversationHistory.push({ timestamp: Date.now(), transcription: transcription.trim(), ai_response: fullText.trim() });
    } else {
      console.warn('[Gemini Flash] Empty response from API');
    }
    sendToRenderer('update-status', 'Listening...');
  } catch (err) {
    console.error('[Gemini Flash] Error:', err.message);
    sendToRenderer('update-status', 'Gemini Error: ' + err.message);
  }
}

// ─── Dispatch transcription to whichever AI is configured ────────────────────
function dispatchToAI(transcription, apiKey, groqKey) {
  if (!transcription.trim()) return;
  sendToRenderer('append-transcript-text', transcription.trim());
  sendToRenderer('update-status', 'Thinking...');
  if (groqKey && groqKey.trim()) {
    sendToGroq(transcription, groqKey);
  } else {
    sendToGeminiFlash(transcription, apiKey);
  }
}

// ─── Gemini Live session ──────────────────────────────────────────────────────
async function initializeGeminiSession(apiKey, groqKey, customPrompt, profile, language) {
  if (isInitializing) return false;
  isInitializing = true;

  // Close any stale session first
  if (activeSession) {
    try { await activeSession.close(); } catch (_) {}
    activeSession = null;
  }

  sendToRenderer('update-status', 'Connecting...');

  currentSystemPrompt  = getSystemPrompt(profile, customPrompt);
  currentTranscription = '';
  conversationHistory  = [];
  groqHistory          = [];
  currentSpeakerState  = 'candidate';

  // On Windows the Gemini Live WebSocket causes continuous chunked-pipe errors (-2).
  // We skip the Live connection entirely and use Web Speech API + gemini-2.0-flash instead.
  // Mark session as ready without a real Live connection.
  activeSession = null;   // no live session needed
  isInitializing = false;
  console.log('[Live] Skipping Gemini Live WebSocket — using Web Speech + Flash HTTP mode');
  sendToRenderer('update-status', 'Listening...');
  return true;
}

// ─── Vision (native https) ────────────────────────────────────────────────────
async function sendImageToGeminiHttp(apiKey, base64JPEG, prompt) {
  if (!apiKey) return { success: false, error: 'Gemini API Key missing' };
  try {
    const { status, body } = await nodeHttpsPost(
      'generativelanguage.googleapis.com',
      `/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {},
      {
        contents: [{ parts: [
          { inlineData: { mimeType: 'image/jpeg', data: base64JPEG } },
          { text: prompt }
        ]}],
        systemInstruction: { parts: [{ text: currentSystemPrompt || 'You are an advanced visual assistant.' }] }
      }
    );
    if (status !== 200) return { success: false, error: body?.error?.message || `HTTP ${status}` };
    const fullText = (body.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (fullText.trim()) {
      sendToRenderer('new-response', fullText.trim());
      conversationHistory.push({ timestamp: Date.now(), transcription: '[Screen Capture]', ai_response: fullText.trim() });
    }
    return { success: true, text: fullText };
  } catch (err) {
    console.error('[Vision] Error:', err.message);
    return { success: false, error: err.message };
  }
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────
function setupGeminiIpcHandlers() {

  ipcMain.on('set-current-speaker', (_, speaker) => {
    currentSpeakerState = speaker;
    console.log('[Speaker] Now:', speaker);
  });

  ipcMain.handle('initialize-standalone-byok', async (_, { apiKey, groqKey, customPrompt, profile, language }) => {
    try {
      const success = await initializeGeminiSession(apiKey, groqKey, customPrompt, profile, language);
      return { success };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // PCM chunks not used — Web Speech API handles transcription
  ipcMain.handle('send-pcm-audio-chunk', async () => {
    return { success: true };
  });

  ipcMain.handle('send-image-to-gemini-http', async (_, { apiKey, base64JPEG, prompt }) => {
    try { return await sendImageToGeminiHttp(apiKey, base64JPEG, prompt); }
    catch (err) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('transcribe-audio-chunk', async (_, { base64Audio, mimeType, groqKey, apiKey }) => {
    if (!groqKey) {
      console.warn('[Whisper] No Groq key — skipping transcription');
      return { success: false, error: 'No Groq key' };
    }
    try {
      const audioBuffer = Buffer.from(base64Audio, 'base64');
      console.log('[Whisper] Transcribing', audioBuffer.length, 'bytes via Groq Whisper...');
      const { status, body } = await transcribeWithGroqWhisper(audioBuffer, groqKey);
      if (status !== 200) {
        const msg = body?.error?.message || JSON.stringify(body);
        console.error('[Whisper] API error:', status, msg);
        return { success: false, error: msg };
      }
      const rawText = body?.text?.trim() || '';
      // Filter common Whisper hallucinations on silence/noise
      const HALLUCINATIONS = [
        /^(thank you\.?|thanks\.?|hello\.?|bye\.?|goodbye\.?|okay\.?|ok\.?|um+\.?|uh+\.?|hmm+\.?|mm+\.?)$/i,
        /^(hello everyone[,.]?|welcome to my channel[.!]?|subscribe[.!]?)$/i,
        /^[^\x00-\x7F]{1,6}$/,  // pure non-ASCII (foreign hallucination)
      ];
      const isHallucination = rawText.length < 3 ||
        HALLUCINATIONS.some(re => re.test(rawText));
      const text = isHallucination ? '' : rawText;
      if (isHallucination) {
        console.log('[Whisper] Filtered hallucination:', rawText);
      } else {
        console.log('[Whisper] Transcript:', text);
      }
      return { success: true, text };
    } catch (err) {
      console.error('[Whisper] Error:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('send-text-to-gemini-http', async (_, { apiKey, groqKey, text }) => {
    if (!text?.trim()) return { success: false, error: 'Empty text' };
    try {
      // Tag with the current speaker so transcript bubbles render correctly
      const speaker = currentSpeakerState === 'interviewer' ? 'Interviewer' : 'Candidate';
      const tagged  = `[${speaker}]: ${text.trim()}`;
      // dispatchToAI shows the transcript bubble AND triggers the AI pipeline
      dispatchToAI(tagged, apiKey, groqKey);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('close-standalone-session', async () => {
    try {
      if (activeSession) {
        await activeSession.close();
        activeSession = null;
      }
      currentTranscription = '';
      conversationHistory  = [];
      groqHistory          = [];
      sendToRenderer('update-status', 'Disconnected');
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });
}

module.exports = { setupGeminiIpcHandlers };
