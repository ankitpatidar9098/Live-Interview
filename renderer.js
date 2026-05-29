import AudioCaptureService from './audio-capture-service.js';

const audioService = new AudioCaptureService();
let socket = null;
let sessionId = null;
let token = null;
let currentSpeaker = 'candidate';
let sessionTimerInterval = null;
let sessionStartTime = null;

// Standalone Session Variables
let isStandaloneMode = false;
let standaloneMediaStream = null;
let standaloneMicStream = null;
let standaloneAudioContext = null;
let standaloneAudioProcessor = null;
let standaloneMicProcessor = null;
let isRecordingAudio = false;

// Pagination & Response Tracking
let sessionResponses = [];
let currentResponseIndex = -1;

// Hidden capture elements for screen vision analysis
let hiddenVideo = null;
let offscreenCanvas = null;
let offscreenContext = null;

// UI Elements setup
const overlayFrame = document.getElementById('overlay-frame');
const activeIndicator = document.getElementById('active-indicator');
const statusText = document.getElementById('status-text');
const toastBar = document.getElementById('toast-bar');
const toastText = document.getElementById('toast-text');

// Setup Panel & Tabs
const setupPanel = document.getElementById('setup-panel');
const tabButtons = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

// Overlay operational panel
const appOverlayPanel = document.getElementById('app-overlay-panel');
const backToSetupBtn = document.getElementById('back-to-setup-btn');
const sessionTimerText = document.getElementById('session-timer-text');
const transcriptsContainer = document.getElementById('transcripts-container');
const aiAnswerText = document.getElementById('ai-answer');
const copySolutionBtn = document.getElementById('copy-solution-btn');

// Pagination Panel
const paginationFooter = document.getElementById('pagination-footer');
const pagPrevBtn = document.getElementById('pag-prev-btn');
const pagNextBtn = document.getElementById('pag-next-btn');
const pagIndicatorText = document.getElementById('pag-indicator-text');

// Action Buttons
const startAudioBtn = document.getElementById('start-audio-btn');
const toggleSpeakerBtn = document.getElementById('toggle-speaker-btn');
const inputMessage = document.getElementById('input-message');
const sendMessageBtn = document.getElementById('send-message-btn');
const analyzeScreenBtn = document.getElementById('analyze-screen-btn');

// Prefs inputs
const opacityRange = document.getElementById('opacity-range');
const opacityLabel = document.getElementById('opacity-label');
const aotCheckbox = document.getElementById('aot-checkbox');
const clickthroughCheckbox = document.getElementById('clickthrough-checkbox');
const customPromptTextarea = document.getElementById('custom-prompt-textarea');

// Standalone Inputs
const geminiKeyInput = document.getElementById('gemini-key-input');
const groqKeyInput = document.getElementById('groq-key-input');
const profileInput = document.getElementById('profile-input');
const languageInput = document.getElementById('language-input');
const startStandaloneBtn = document.getElementById('start-standalone-btn');

// Sync inputs
const tokenInput = document.getElementById('token-input');
const sessionIdInput = document.getElementById('session-id-input');
const connectSyncBtn = document.getElementById('connect-sync-btn');

// Waveform Animation variables
let waveCanvas = document.getElementById('wave-canvas');
let waveCtx = waveCanvas.getContext('2d');
let waveAnimationId = null;

// =═══════════════════════════════════════════════
//  TABBED NAVIGATION
// =═══════════════════════════════════════════════
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('active'));
    tabPanes.forEach(p => p.classList.remove('active'));

    btn.classList.add('active');
    const paneId = btn.getAttribute('data-tab');
    document.getElementById(paneId).classList.add('active');
  });
});

// =═══════════════════════════════════════════════
//  PREFERENCES HANDLING & LOCAL STORAGE
// =═══════════════════════════════════════════════
function loadSettings() {
  geminiKeyInput.value = localStorage.getItem('gemini_api_key') || '';
  groqKeyInput.value = localStorage.getItem('groq_api_key') || '';
  profileInput.value = localStorage.getItem('selected_profile') || 'interview';
  languageInput.value = localStorage.getItem('selected_language') || 'en-US';

  tokenInput.value = localStorage.getItem('sync_jwt_token') || '';
  sessionIdInput.value = localStorage.getItem('sync_session_id') || '';

  const opacity = localStorage.getItem('pref_opacity') || '0.85';
  opacityRange.value = opacity;
  opacityLabel.innerText = Math.round(parseFloat(opacity) * 100) + '%';
  applyOpacity(opacity);

  const aot = localStorage.getItem('pref_aot') !== 'false'; // default true
  aotCheckbox.checked = aot;

  const clickthrough = localStorage.getItem('pref_clickthrough') === 'true'; // default false
  clickthroughCheckbox.checked = clickthrough;
  applyClickThrough(clickthrough);

  customPromptTextarea.value = localStorage.getItem('pref_custom_prompt') || '';
}

function savePreferences() {
  localStorage.setItem('pref_opacity', opacityRange.value);
  localStorage.setItem('pref_aot', aotCheckbox.checked);
  localStorage.setItem('pref_clickthrough', clickthroughCheckbox.checked);
  localStorage.setItem('pref_custom_prompt', customPromptTextarea.value);
  
  applyOpacity(opacityRange.value);
  applyClickThrough(clickthroughCheckbox.checked);
  showToast('Preferences saved successfully!', 'rgba(16, 185, 129, 0.95)');
}

function applyOpacity(val) {
  overlayFrame.style.backgroundColor = `rgba(10, 12, 22, ${val})`;
}

function applyClickThrough(val) {
  window.electronAPI.setClickThrough(val);
}

opacityRange.addEventListener('input', (e) => {
  opacityLabel.innerText = Math.round(parseFloat(e.target.value) * 100) + '%';
  applyOpacity(e.target.value);
});

document.getElementById('save-prefs-btn').addEventListener('click', savePreferences);

// Load settings on boot
loadSettings();

// =═══════════════════════════════════════════════
//  KEYBOARD SHORTCUTS inside overlay
// =═══════════════════════════════════════════════
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey) {
    if (e.key === 'ArrowLeft') window.electronAPI.moveWindow('left');
    if (e.key === 'ArrowRight') window.electronAPI.moveWindow('right');
    if (e.key === 'ArrowUp') window.electronAPI.moveWindow('up');
    if (e.key === 'ArrowDown') window.electronAPI.moveWindow('down');
  }
});

// Click-through state tracking from Global hotkey Ctrl+M
window.electronAPI.onClickThroughToggled((value) => {
  clickthroughCheckbox.checked = value;
  if (value) {
    document.body.classList.add('click-through');
    statusText.innerText = "Click-Through: ON";
  } else {
    document.body.classList.remove('click-through');
    statusText.innerText = isStandaloneMode ? "Standalone Session" : "Connected & Draggable";
  }
});

// Global Hotkey Ctrl+Enter listener to trigger screenshot visual analysis
window.electronAPI.onIpcEvent('global-shortcut-analyze-screen', () => {
  if (appOverlayPanel.style.display === 'flex') {
    triggerScreenVisionAnalysis();
  }
});

// =═══════════════════════════════════════════════
//  TOAST ALERT ALERTS
// =═══════════════════════════════════════════════
function showToast(message, bgColor = 'rgba(239, 68, 68, 0.95)') {
  toastText.innerText = message;
  toastBar.style.backgroundColor = bgColor;
  toastBar.style.display = 'flex';
  setTimeout(() => {
    toastBar.style.display = 'none';
  }, 6000);
}

// =═══════════════════════════════════════════════
//  TIMER
// =═══════════════════════════════════════════════
function startSessionTimer() {
  stopSessionTimer();
  sessionStartTime = Date.now();
  sessionTimerInterval = setInterval(() => {
    const elapsedSecs = Math.floor((Date.now() - sessionStartTime) / 1000);
    const mm = String(Math.floor(elapsedSecs / 60)).padStart(2, '0');
    const ss = String(elapsedSecs % 60).padStart(2, '0');
    sessionTimerText.innerText = `${mm}:${ss}`;
  }, 1000);
}

function stopSessionTimer() {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
  sessionTimerText.innerText = '00:00';
}

// =═══════════════════════════════════════════════
//  PAGINATION ACTIONS
// =═══════════════════════════════════════════════
function updatePagination() {
  if (sessionResponses.length <= 1) {
    paginationFooter.style.display = 'none';
    return;
  }

  paginationFooter.style.display = 'flex';
  pagIndicatorText.innerText = `${currentResponseIndex + 1} of ${sessionResponses.length}`;
  pagPrevBtn.disabled = currentResponseIndex <= 0;
  pagNextBtn.disabled = currentResponseIndex >= sessionResponses.length - 1;
}

function renderActiveResponse() {
  if (currentResponseIndex >= 0 && currentResponseIndex < sessionResponses.length) {
    const rawContent = sessionResponses[currentResponseIndex];
    if (window.marked) {
      try {
        aiAnswerText.innerHTML = window.marked.parse(rawContent);
      } catch (err) {
        aiAnswerText.innerText = rawContent;
      }
    } else {
      aiAnswerText.innerText = rawContent;
    }
  } else {
    aiAnswerText.innerText = "Waiting for interviewer questions...";
  }
  updatePagination();
}

pagPrevBtn.addEventListener('click', () => {
  if (currentResponseIndex > 0) {
    currentResponseIndex--;
    renderActiveResponse();
  }
});

pagNextBtn.addEventListener('click', () => {
  if (currentResponseIndex < sessionResponses.length - 1) {
    currentResponseIndex++;
    renderActiveResponse();
  }
});

// Copy code solution button
copySolutionBtn.addEventListener('click', () => {
  const codeBlocks = aiAnswerText.querySelectorAll('pre code');
  let copyText = "";
  if (codeBlocks.length > 0) {
    codeBlocks.forEach(block => {
      copyText += block.innerText + "\n\n";
    });
  } else {
    copyText = aiAnswerText.innerText;
  }

  navigator.clipboard.writeText(copyText.trim()).then(() => {
    const originalText = copySolutionBtn.innerText;
    copySolutionBtn.innerText = "Copied!";
    setTimeout(() => {
      copySolutionBtn.innerText = originalText;
    }, 2000);
  });
});

// =═══════════════════════════════════════════════
//  MESSAGING INTERFACE
// =═══════════════════════════════════════════════
function appendTranscriptBubble(text, speaker = 'candidate') {
  const bubble = document.createElement('div');
  bubble.style.padding = "8px 12px";
  bubble.style.borderRadius = "12px";
  bubble.style.fontSize = "13px";
  bubble.style.marginBottom = "8px";
  bubble.style.maxWidth = "85%";
  bubble.style.lineHeight = "1.4";

  if (speaker === 'candidate') {
    bubble.style.backgroundColor = "rgba(139, 92, 246, 0.15)";
    bubble.style.border = "1px solid rgba(139, 92, 246, 0.2)";
    bubble.style.alignSelf = "flex-end";
    bubble.style.color = "#f8fafc";
  } else {
    bubble.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
    bubble.style.border = "1px solid rgba(255, 255, 255, 0.08)";
    bubble.style.alignSelf = "flex-start";
    bubble.style.color = "var(--accent-teal)";
  }

  bubble.innerText = text;
  transcriptsContainer.appendChild(bubble);
  transcriptsContainer.scrollTop = transcriptsContainer.scrollHeight;
}

// IPC listening events from direct Standalone mode
window.electronAPI.onIpcEvent('new-response', (content) => {
  sessionResponses.push(content);
  currentResponseIndex = sessionResponses.length - 1;
  renderActiveResponse();
});

window.electronAPI.onIpcEvent('update-response', (content) => {
  if (sessionResponses.length > 0) {
    sessionResponses[currentResponseIndex] = content;
  } else {
    sessionResponses.push(content);
    currentResponseIndex = 0;
  }
  renderActiveResponse();
});

window.electronAPI.onIpcEvent('update-status', (status) => {
  statusText.innerText = status;
});

window.electronAPI.onIpcEvent('append-transcript-text', (transcription) => {
  // Try extracting speaker label from text
  const match = transcription.match(/^\[(Interviewer|Candidate)\]:\s*([\s\S]*)$/i);
  if (match) {
    appendTranscriptBubble(match[2].trim(), match[1].toLowerCase());
  } else {
    appendTranscriptBubble(transcription, 'interviewer');
  }
});

// =═══════════════════════════════════════════════
//  MODE 1: SAAS PORTAL SYNC ACTIONS
// =═══════════════════════════════════════════════
function connectWebSocketSync() {
  isStandaloneMode = false;
  sessionId = sessionIdInput.value.trim();
  token = tokenInput.value.trim();

  if (!sessionId || !token) {
    showToast("Session ID and Auth JWT Token are required for portal sync.");
    return;
  }

  localStorage.setItem('sync_jwt_token', token);
  localStorage.setItem('sync_session_id', sessionId);

  statusText.innerText = "Connecting...";
  
  socket = new WebSocket(`ws://localhost:3000/cable?token=${token}`);

  socket.onopen = () => {
    statusText.innerText = "Connected to Server";
    activeIndicator.className = "status-dot active";
    
    // Subscribe to SessionChannel
    const identifier = JSON.stringify({ channel: 'SessionChannel', session_id: sessionId });
    socket.send(JSON.stringify({
      command: 'subscribe',
      identifier: identifier
    }));

    setupPanel.style.display = 'none';
    appOverlayPanel.style.display = 'flex';
    
    // Reset pagination
    sessionResponses = [];
    currentResponseIndex = -1;
    renderActiveResponse();
    startSessionTimer();
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    // Ignore ping/welcome handshakes
    if (data.type === 'ping' || data.type === 'welcome' || data.type === 'confirm_subscription') return;

    const msg = data.message;
    if (!msg) return;

    switch (msg.type) {
      case 'transcript_update':
        appendTranscriptBubble(msg.transcript.text, msg.transcript.speaker);
        break;
      case 'ai_response':
        // Generate formatting structure manually from JSON payload
        const res = msg.response;
        let md = `### ${res.direct_answer || 'Generating suggestion...'}\n\n`;
        if (res.short_explanation) md += `${res.short_explanation}\n\n`;
        
        if (res.code_solution) {
          md += `**Optimized Solution Code:**\n\`\`\`javascript\n${res.code_solution}\n\`\`\`\n\n`;
        }
        
        if (res.complexity_analysis && (res.complexity_analysis.time || res.complexity_analysis.space)) {
          md += `*   **Time Complexity:** ${res.complexity_analysis.time || 'O(1)'}\n`;
          md += `*   **Space Complexity:** ${res.complexity_analysis.space || 'O(1)'}\n\n`;
        }

        if (res.star_response && res.star_response.situation) {
          md += `#### STAR Response Checklist:\n`;
          md += `*   **S:** ${res.star_response.situation}\n`;
          md += `*   **T:** ${res.star_response.task}\n`;
          md += `*   **A:** ${res.star_response.action}\n`;
          md += `*   **R:** ${res.star_response.result}\n\n`;
        }

        if (res.suggested_keywords && res.suggested_keywords.length > 0) {
          md += `**Keywords:** *${res.suggested_keywords.join(', ')}*\n`;
        }

        sessionResponses.push(md);
        currentResponseIndex = sessionResponses.length - 1;
        renderActiveResponse();
        break;
      case 'session_completed':
        statusText.innerText = "Completed";
        stopSyncCapture();
        break;
    }
  };

  socket.onerror = (err) => {
    console.error("Socket error:", err);
    showToast("Connection to Rails backend failed. Verify localhost:3000.");
    activeIndicator.className = "status-dot";
  };

  socket.onclose = () => {
    statusText.innerText = "Offline";
    activeIndicator.className = "status-dot";
    stopSessionTimer();
  };
}

function stopSyncCapture() {
  audioService.stopCapture();
  startAudioBtn.innerText = "Start Capturing";
  startAudioBtn.className = "btn audio-btn idle";
  activeIndicator.className = "status-dot active";
}

connectSyncBtn.addEventListener('click', connectWebSocketSync);

// =═══════════════════════════════════════════════
//  MODE 2: DIRECT STANDALONE BYOK ACTIONS
// =═══════════════════════════════════════════════
async function startStandaloneBYOKSession() {
  isStandaloneMode = true;
  const apiKey = geminiKeyInput.value.trim();
  const groqKey = groqKeyInput.value.trim();
  const profile = profileInput.value;
  const language = languageInput.value;

  if (!apiKey) {
    showToast("Google Gemini API Key is required to run in Standalone mode.");
    return;
  }

  localStorage.setItem('gemini_api_key', apiKey);
  localStorage.setItem('groq_api_key', groqKey);
  localStorage.setItem('selected_profile', profile);
  localStorage.setItem('selected_language', language);

  const customPrompt = localStorage.getItem('pref_custom_prompt') || '';

  const initResult = await window.electronAPI.initializeStandaloneBYOK({
    apiKey,
    groqKey,
    customPrompt,
    profile,
    language
  });

  if (initResult.success) {
    statusText.innerText = "Live Session Connected";
    activeIndicator.className = "status-dot active";

    setupPanel.style.display = 'none';
    appOverlayPanel.style.display = 'flex';

    // Clear data
    sessionResponses = [];
    currentResponseIndex = -1;
    renderActiveResponse();
    
    // Clear transcripts Timeline UI
    transcriptsContainer.innerHTML = '';

    // Synchronize initial speaker state
    window.electronAPI.setCurrentSpeaker(currentSpeaker);

    startSessionTimer();
  } else {
    showToast(`Initialization failed: ${initResult.error || 'Check API Key validity'}`);
  }
}

async function stopStandaloneSession() {
  stopStandaloneAudioProcessing();
  await window.electronAPI.closeStandaloneSession();
  
  if (standaloneMediaStream) {
    standaloneMediaStream.getTracks().forEach(track => track.stop());
    standaloneMediaStream = null;
  }
  if (standaloneMicStream) {
    standaloneMicStream.getTracks().forEach(track => track.stop());
    standaloneMicStream = null;
  }

  hiddenVideo = null;
  offscreenCanvas = null;
  offscreenContext = null;

  activeIndicator.className = "status-dot";
  statusText.innerText = "Disconnected";
}

startStandaloneBtn.addEventListener('click', startStandaloneBYOKSession);

// =═══════════════════════════════════════════════
//  STANDALONE VOICE PROCESSING (Float32 to Int16)
// =═══════════════════════════════════════════════
function convertFloat32ToInt16(float32Array) {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16Array;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function startStandaloneAudioProcessing() {
  const SAMPLE_RATE = 24000;
  const AUDIO_CHUNK_DURATION = 0.1; 
  const BUFFER_SIZE = 4096;

  try {
    // 1. Microphone track
    standaloneMicStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // 2. System Audio track from screen capturer loopback
    let sourceId = null;
    try {
      const sources = await window.electronAPI.getScreenSources();
      const screenSource = sources.find(s => s.id.startsWith('screen')) || sources[0];
      if (screenSource) {
        sourceId = screenSource.id;
      }
    } catch (e) {
      console.warn("Screen capturer access restricted.", e);
    }

    if (sourceId) {
      try {
        standaloneMediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId
            }
          },
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxFrameRate: 1,
              maxWidth: 1280,
              maxHeight: 720
            }
          }
        });
      } catch (err) {
        console.warn("No system loopback loop available. Capturing mic only.", err);
      }
    }

    // Set up Web Audio API nodes
    standaloneAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (standaloneAudioContext.state === 'suspended') {
      await standaloneAudioContext.resume();
    }
    
    // Create a single processor for the mixed stream
    standaloneMicProcessor = standaloneAudioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
    
    // Process Microphone channel
    const micSource = standaloneAudioContext.createMediaStreamSource(standaloneMicStream);
    const micGain = standaloneAudioContext.createGain();
    micGain.gain.value = 1.0;
    micSource.connect(micGain);
    micGain.connect(standaloneMicProcessor);

    // Process System audio channel if captured
    if (standaloneMediaStream && standaloneMediaStream.getAudioTracks().length > 0) {
      const sysSource = standaloneAudioContext.createMediaStreamSource(standaloneMediaStream);
      const sysGain = standaloneAudioContext.createGain();
      sysGain.gain.value = 1.5; // Boost interviewer's voice
      sysSource.connect(sysGain);
      sysGain.connect(standaloneMicProcessor);
    }

    standaloneMicProcessor.connect(standaloneAudioContext.destination);

    let micBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    standaloneMicProcessor.onaudioprocess = async e => {
      const inputData = e.inputBuffer.getChannelData(0);
      micBuffer.push(...inputData);

      while (micBuffer.length >= samplesPerChunk) {
        const chunk = micBuffer.splice(0, samplesPerChunk);
        const pcm16 = convertFloat32ToInt16(chunk);
        const base64PCM = arrayBufferToBase64(pcm16.buffer);
        
        // Push raw PCM base64 data to main process
        await window.electronAPI.sendPCMAudioChunk(base64PCM);
      }
    };

    isRecordingAudio = true;
    startAudioBtn.innerText = "Capturing Direct...";
    startAudioBtn.className = "btn audio-btn active-record";
    activeIndicator.className = "status-dot live-recording";
  } catch (error) {
    console.error("Standalone Audio capturing error:", error);
    showToast("Standalone Audio initialization failed. check audio permissions.");
  }
}

function stopStandaloneAudioProcessing() {
  isRecordingAudio = false;
  
  if (standaloneMicProcessor) {
    standaloneMicProcessor.disconnect();
    standaloneMicProcessor = null;
  }
  if (standaloneAudioProcessor) {
    standaloneAudioProcessor.disconnect();
    standaloneAudioProcessor = null;
  }
  if (standaloneAudioContext) {
    standaloneAudioContext.close();
    standaloneAudioContext = null;
  }

  startAudioBtn.innerText = "Start Capturing";
  startAudioBtn.className = "btn audio-btn idle";
  activeIndicator.className = "status-dot active";
}

// =═══════════════════════════════════════════════
//  VISION SCREEN ANALYZER
// =═══════════════════════════════════════════════
function startVisionPulseVisualizer() {
  stopVisionPulseVisualizer();
  const dangerColor = '#06b6d4';
  const startTime = performance.now();
  const w = waveCanvas.width = 60;
  const h = waveCanvas.height = 32;
  const midY = h / 2;

  function draw(now) {
    const elapsed = (now - startTime) / 1000;
    waveCtx.clearRect(0, 0, w, h);
    waveCtx.beginPath();
    waveCtx.strokeStyle = dangerColor;
    waveCtx.globalAlpha = 0.8;
    waveCtx.lineWidth = 2;
    waveCtx.lineCap = 'round';

    for (let x = 0; x <= w; x++) {
      const norm = x / w;
      const envelope = Math.sin(norm * Math.PI);
      const y = midY + Math.sin(norm * Math.PI * 4 + elapsed * 8) * (midY * 0.4) * envelope;
      if (x === 0) waveCtx.moveTo(x, y);
      else waveCtx.lineTo(x, y);
    }
    waveCtx.stroke();
    waveAnimationId = requestAnimationFrame(draw);
  }
  waveAnimationId = requestAnimationFrame(draw);
}

function stopVisionPulseVisualizer() {
  if (waveAnimationId) {
    cancelAnimationFrame(waveAnimationId);
    waveAnimationId = null;
  }
  waveCtx.clearRect(0, 0, waveCanvas.width, waveCanvas.height);
}

async function triggerScreenVisionAnalysis() {
  if (analyzeScreenBtn.classList.contains('loading')) return;

  const apiKey = geminiKeyInput.value.trim() || localStorage.getItem('gemini_api_key');
  if (isStandaloneMode && !apiKey) {
    showToast("Gemini API key required for screen vision analysis.");
    return;
  }

  analyzeScreenBtn.classList.add('loading');
  analyzeScreenBtn.innerHTML = `<canvas class="analyze-canvas-overlay" id="wave-canvas"></canvas>Solving...`;
  
  // Grab wave canvas reference inside updated button layout
  waveCanvas = document.getElementById('wave-canvas');
  waveCtx = waveCanvas.getContext('2d');
  startVisionPulseVisualizer();

  try {
    let captureStream = standaloneMediaStream;

    // Get capture stream if not already active
    if (!captureStream) {
      let sourceId = null;
      const sources = await window.electronAPI.getScreenSources();
      const screenSource = sources.find(s => s.id.startsWith('screen')) || sources[0];
      if (screenSource) {
        sourceId = screenSource.id;
      }
      
      if (sourceId) {
        captureStream = await navigator.mediaDevices.getUserMedia({
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxFrameRate: 1,
              maxWidth: 1280,
              maxHeight: 720
            }
          },
          audio: false
        });
      }
    }

    if (!captureStream) {
      throw new Error("No display capture sources found.");
    }

    // Lazy instantiate canvas elements
    if (!hiddenVideo) {
      hiddenVideo = document.createElement('video');
      hiddenVideo.srcObject = captureStream;
      hiddenVideo.muted = true;
      hiddenVideo.playsInline = true;
      await hiddenVideo.play();
      
      offscreenCanvas = document.createElement('canvas');
      offscreenCanvas.width = hiddenVideo.videoWidth || 1280;
      offscreenCanvas.height = hiddenVideo.videoHeight || 720;
      offscreenContext = offscreenCanvas.getContext('2d');
    }

    // Draw video frame
    offscreenContext.drawImage(hiddenVideo, 0, 0, offscreenCanvas.width, offscreenCanvas.height);

    // Convert to jpeg blob
    offscreenCanvas.toBlob(async blob => {
      if (!blob) {
        throw new Error("Failed to capture image frame.");
      }

      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        const base64JPEG = reader.result.split(',')[1];
        const visionPrompt = `Analyze the screen content. Solve the question/task on the screen. If it is a coding challenge, explain the conceptual approach briefly, then write the fully optimized code in a clean markdown code block. If it is an MCQ, state the correct option clearly.`;

        if (isStandaloneMode) {
          // Direct API call
          const result = await window.electronAPI.sendImageToGeminiHttp({
            apiKey,
            base64JPEG,
            prompt: visionPrompt
          });

          if (result.success) {
            console.log("Direct vision prompt completed.");
          } else {
            showToast(`Vision failed: ${result.error}`);
          }
        } else {
          // Sync Mode fallback - we can trigger text output locally or upload
          showToast("Vision Screen analysis is optimized for BYOK Direct Mode.", 'rgba(6, 182, 212, 0.95)');
          // Send manual query simulated
          if (socket && socket.readyState === WebSocket.OPEN) {
            const identifier = JSON.stringify({ channel: 'SessionChannel', session_id: sessionId });
            socket.send(JSON.stringify({
              command: 'message',
              identifier: identifier,
              data: JSON.stringify({
                action: 'send_message',
                text: "Interviewer is presenting a coding task. Please provide the optimized solution."
              })
            }));
          }
        }

        // Cleanup temp streams if they were just opened for screenshot
        if (!standaloneMediaStream && captureStream) {
          captureStream.getTracks().forEach(track => track.stop());
        }

        // Restore vision button
        stopVisionPulseVisualizer();
        analyzeScreenBtn.classList.remove('loading');
        analyzeScreenBtn.innerHTML = `<canvas class="analyze-canvas-overlay" id="wave-canvas"></canvas>Vision`;
      };
    }, 'image/jpeg', 0.7);

  } catch (error) {
    console.error("Vision Analysis failed:", error);
    showToast(`Vision capture failed: ${error.message}`);
    stopVisionPulseVisualizer();
    analyzeScreenBtn.classList.remove('loading');
    analyzeScreenBtn.innerHTML = `<canvas class="analyze-canvas-overlay" id="wave-canvas"></canvas>Vision`;
  }
}

analyzeScreenBtn.addEventListener('click', triggerScreenVisionAnalysis);

// =═══════════════════════════════════════════════
//  CONTROL BUTTONS & SESSION LIFECYCLE
// =═══════════════════════════════════════════════

// Start/Stop Capturing Audio
startAudioBtn.addEventListener('click', async () => {
  if (isStandaloneMode) {
    if (isRecordingAudio) {
      stopStandaloneAudioProcessing();
    } else {
      await startStandaloneAudioProcessing();
    }
  } else {
    // Sync mode
    if (audioService.isRecording) {
      stopSyncCapture();
    } else {
      startAudioBtn.innerText = "Initializing...";
      let sourceId = null;
      try {
        const sources = await window.electronAPI.getScreenSources();
        const screenSource = sources.find(s => s.id.startsWith('screen')) || sources[0];
        if (screenSource) sourceId = screenSource.id;
      } catch(e) {}

      const onChunk = (base64) => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        const identifier = JSON.stringify({ channel: 'SessionChannel', session_id: sessionId });
        socket.send(JSON.stringify({
          command: 'message',
          identifier: identifier,
          data: JSON.stringify({
            action: 'stream_audio',
            audio: base64,
            speaker: currentSpeaker
          })
        }));
      };

      const onFallback = (err) => {
        showToast(err);
      };

      const success = await audioService.startCapture(sourceId, onChunk, onFallback);
      if (success) {
        startAudioBtn.innerText = "Capturing Audio...";
        startAudioBtn.className = "btn audio-btn active-record";
        activeIndicator.className = "status-dot live-recording";
      } else {
        startAudioBtn.innerText = "Start Capturing";
        startAudioBtn.className = "btn audio-btn idle";
        activeIndicator.className = "status-dot active";
      }
    }
  }
});

// Toggle speaker (Interviewer vs Candidate)
toggleSpeakerBtn.addEventListener('click', () => {
  currentSpeaker = currentSpeaker === 'candidate' ? 'interviewer' : 'candidate';
  toggleSpeakerBtn.innerText = `Speaker: ${currentSpeaker.toUpperCase()}`;
  if (currentSpeaker === 'candidate') {
    toggleSpeakerBtn.className = "speaker-btn candidate";
  } else {
    toggleSpeakerBtn.className = "speaker-btn interviewer";
  }
  window.electronAPI.setCurrentSpeaker(currentSpeaker);
});

// Send manual text question overrides
async function sendManualMessageText() {
  const text = inputMessage.value.trim();
  if (!text) return;

  if (isStandaloneMode) {
    const apiKey = geminiKeyInput.value.trim() || localStorage.getItem('gemini_api_key');
    const groqKey = groqKeyInput.value.trim() || localStorage.getItem('groq_api_key');
    
    appendTranscriptBubble(text, 'interviewer');
    
    await window.electronAPI.sendTextToGeminiHttp({
      apiKey,
      groqKey,
      text
    });
  } else {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const identifier = JSON.stringify({ channel: 'SessionChannel', session_id: sessionId });
    socket.send(JSON.stringify({
      command: 'message',
      identifier: identifier,
      data: JSON.stringify({
        action: 'send_message',
        text
      })
    }));
  }

  inputMessage.value = '';
}

sendMessageBtn.addEventListener('click', sendManualMessageText);
inputMessage.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendManualMessageText();
});

// Return to Setup Panel (Disconnect Session)
backToSetupBtn.addEventListener('click', async () => {
  stopSessionTimer();
  
  if (isStandaloneMode) {
    await stopStandaloneSession();
  } else {
    if (socket) {
      socket.close();
      socket = null;
    }
    stopSyncCapture();
  }

  appOverlayPanel.style.display = 'none';
  setupPanel.style.display = 'flex';
});
