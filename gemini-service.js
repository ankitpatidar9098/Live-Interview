const { GoogleGenAI, Modality } = require('@google/genai');
const { ipcMain, BrowserWindow } = require('electron');

let activeSession = null;
let currentTranscription = '';
let conversationHistory = [];
let currentSystemPrompt = '';
let groqHistory = [];
let isInitializing = false;

// Helper to broadcast streaming updates to the renderer window
function sendToRenderer(channel, data) {
  const windows = BrowserWindow.getAllWindows();
  if (windows.length > 0) {
    windows[0].webContents.send(channel, data);
  }
}

// Strip DeepSeek's <think> tags for clean display
function stripThinkingTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// Generate the customized system instruction based on profiles
function getSystemPrompt(profile, customPrompt, webSearch) {
  let basePrompt = `You are a real-time conversational AI interviewer assistant. Your goal is to provide brief, actionable hints and precise answers to help the candidate. 
Keep your responses formatting clean, using bold text for key words. Do NOT use lengthy introductions. 
Formatting guidelines:
- If a coding question is asked: provide a brief 2-bullet conceptual approach, then write the optimized code inside a standard markdown code block. Include Time and Space complexities.
- If a behavioral question is asked: format your response using a precise STAR method (Situation, Task, Action, Result) in structured bullet points.
- If it is a general knowledge question: give a concise 2-sentence direct answer.
`;
  
  if (profile === 'coding') {
    basePrompt += `\nFocus heavily on data structures, algorithmic complexity, edge cases, and high-performance clean code. Always provide the best time-complexity solution.`;
  } else if (profile === 'hr') {
    basePrompt += `\nFocus heavily on leadership principles, communication style, cultural alignment, and emotional intelligence. Always utilize the STAR method explicitly.`;
  }
  
  if (customPrompt && customPrompt.trim()) {
    basePrompt += `\nAdditional user guidelines: ${customPrompt}`;
  }
  
  return basePrompt;
}

// Direct Call to Groq (DeepSeek-R1 Distilled / Llama 3.3) for fast responses
async function sendToGroq(transcription, groqKey) {
  if (!groqKey || !transcription || transcription.trim() === '') return;

  const modelToUse = 'llama-3.3-70b-versatile';
  console.log(`[Groq] Sending transcription to ${modelToUse}...`);

  groqHistory.push({ role: 'user', content: transcription.trim() });
  if (groqHistory.length > 16) {
    groqHistory = groqHistory.slice(-16);
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: modelToUse,
        messages: [
          { role: 'system', content: currentSystemPrompt || 'You are a helpful assistant.' },
          ...groqHistory
        ],
        stream: true,
        temperature: 0.6,
        max_tokens: 1024
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Groq] API Error:', response.status, errorText);
      sendToRenderer('update-status', `Groq Error: ${response.status}`);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let isFirst = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim() !== '');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const json = JSON.parse(data);
            const token = json.choices?.[0]?.delta?.content || '';
            if (token) {
              fullText += token;
              const displayText = stripThinkingTags(fullText);
              if (displayText) {
                sendToRenderer(isFirst ? 'new-response' : 'update-response', displayText);
                isFirst = false;
              }
            }
          } catch (parseError) {
            // Ignore parse errors on incomplete chunk boundaries
          }
        }
      }
    }

    const cleanedResponse = stripThinkingTags(fullText);
    if (cleanedResponse) {
      groqHistory.push({ role: 'assistant', content: cleanedResponse });
      // Save turn
      conversationHistory.push({
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: cleanedResponse
      });
    }

    sendToRenderer('update-status', 'Listening...');
  } catch (error) {
    console.error('[Groq] Failed calling API:', error);
    sendToRenderer('update-status', 'Groq Call Error: ' + error.message);
  }
}

// Direct Call to Gemini Flash for standard standalone responses
async function sendToGeminiFlash(transcription, apiKey) {
  if (!apiKey || !transcription || transcription.trim() === '') return;

  console.log('[Gemini] Sending transcription to gemini-2.5-flash...');

  try {
    const ai = new GoogleGenAI({ apiKey });
    
    const messages = conversationHistory.map(turn => [
      { role: 'user', parts: [{ text: turn.transcription }] },
      { role: 'model', parts: [{ text: turn.ai_response }] }
    ]).flat();

    messages.push({ role: 'user', parts: [{ text: transcription.trim() }] });

    const responseStream = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: messages,
      config: {
        systemInstruction: { parts: [{ text: currentSystemPrompt }] }
      }
    });

    let fullText = '';
    let isFirst = true;

    for await (const chunk of responseStream) {
      const chunkText = chunk.text;
      if (chunkText) {
        fullText += chunkText;
        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        isFirst = false;
      }
    }

    if (fullText.trim()) {
      conversationHistory.push({
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: fullText.trim()
      });
    }

    sendToRenderer('update-status', 'Listening...');
  } catch (error) {
    console.error('[Gemini] Standalone generation error:', error);
    sendToRenderer('update-status', 'Gemini Call Error: ' + error.message);
  }
}

// Initialize direct Gemini 2.5 Flash Live Websocket connection
async function initializeGeminiSession(apiKey, groqKey, customPrompt, profile, language) {
  if (isInitializing) return false;
  isInitializing = true;

  sendToRenderer('update-status', 'Initializing live socket...');

  const client = new GoogleGenAI({
    vertexai: false,
    apiKey: apiKey,
    httpOptions: { apiVersion: 'v1alpha' }
  });

  const systemPrompt = getSystemPrompt(profile, customPrompt, true);
  currentSystemPrompt = systemPrompt;

  // Reset conversation histories
  currentTranscription = '';
  conversationHistory = [];
  groqHistory = [];

  try {
    const session = await client.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      callbacks: {
        onopen: function() {
          sendToRenderer('update-status', 'Live session connected');
          console.log('[Gemini Live] Websocket connection open.');
        },
        onmessage: function(message) {
          // Track speech transcription from candidate or interviewer
          if (message.serverContent?.inputTranscription?.results) {
            const results = message.serverContent.inputTranscription.results;
            for (const res of results) {
              if (res.transcript) {
                const label = res.speakerId === 1 ? 'Interviewer' : 'Candidate';
                currentTranscription += `[${label}]: ${res.transcript}\n`;
              }
            }
          } else if (message.serverContent?.inputTranscription?.text) {
            const text = message.serverContent.inputTranscription.text;
            if (text.trim()) {
              currentTranscription += `[Interviewer]: ${text}\n`;
            }
          }

          // When the interviewer has finished speaking (turn is complete), trigger faster model
          if (message.serverContent?.generationComplete) {
            if (currentTranscription.trim()) {
              sendToRenderer('append-transcript-text', currentTranscription.trim());
              
              if (groqKey && groqKey.trim()) {
                sendToGroq(currentTranscription, groqKey);
              } else {
                sendToGeminiFlash(currentTranscription, apiKey);
              }
              currentTranscription = '';
            }
          }

          if (message.serverContent?.turnComplete) {
            sendToRenderer('update-status', 'Listening...');
          }
        },
        onerror: function(err) {
          console.error('[Gemini Live] Session error:', err.message);
          sendToRenderer('update-status', 'Live Error: ' + err.message);
        },
        onclose: function(e) {
          console.log('[Gemini Live] Session closed:', e.reason);
          sendToRenderer('update-status', 'Live Session Offline');
        }
      },
      config: {
        responseModalities: [Modality.AUDIO],
        proactivity: { proactiveAudio: true },
        outputAudioTranscription: {},
        tools: [{ googleSearch: {} }],
        inputAudioTranscription: {
          enableSpeakerDiarization: true,
          minSpeakerCount: 2,
          maxSpeakerCount: 2
        },
        speechConfig: { languageCode: language },
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        }
      }
    });

    activeSession = session;
    isInitializing = false;
    return true;
  } catch (error) {
    console.error('[Gemini Live] Direct initialization failed:', error);
    isInitializing = false;
    sendToRenderer('update-status', 'Connection Failed');
    return false;
  }
}

// Vision screen capture analyzer
async function sendImageToGeminiHttp(apiKey, base64JPEG, prompt) {
  if (!apiKey) {
    return { success: false, error: 'Gemini API Key missing' };
  }

  console.log('[Gemini Vision] Analyzing screen frame using gemini-2.5-flash...');

  try {
    const ai = new GoogleGenAI({ apiKey });
    
    const contents = [
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: base64JPEG
        }
      },
      { text: prompt }
    ];

    const responseStream = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents: contents,
      config: {
        systemInstruction: { parts: [{ text: currentSystemPrompt || 'You are an advanced screen solving visual assistant.' }] }
      }
    });

    let fullText = '';
    let isFirst = true;

    for await (const chunk of responseStream) {
      const chunkText = chunk.text;
      if (chunkText) {
        fullText += chunkText;
        sendToRenderer(isFirst ? 'new-response' : 'update-response', fullText);
        isFirst = false;
      }
    }

    // Save vision turn
    conversationHistory.push({
      timestamp: Date.now(),
      transcription: '[Analyze Screen Captured]',
      ai_response: fullText.trim()
    });

    return { success: true, text: fullText };
  } catch (error) {
    console.error('[Gemini Vision] Image analysis failed:', error);
    return { success: false, error: error.message };
  }
}

function setupGeminiIpcHandlers() {
  // Start Standalone BYOK session
  ipcMain.handle('initialize-standalone-byok', async (event, { apiKey, groqKey, customPrompt, profile, language }) => {
    try {
      const success = await initializeGeminiSession(apiKey, groqKey, customPrompt, profile, language);
      return { success };
    } catch (error) {
      console.error('[IPC] Init standalone failed:', error);
      return { success: false, error: error.message };
    }
  });

  // Stream raw pcm audio buffers into the Gemini Live Session
  ipcMain.handle('send-pcm-audio-chunk', async (event, base64PCM) => {
    if (!activeSession) return { success: false, error: 'No active Live session' };
    try {
      await activeSession.sendRealtimeInput({
        audio: {
          data: base64PCM,
          mimeType: 'audio/pcm;rate=24000'
        }
      });
      return { success: true };
    } catch (error) {
      console.error('[IPC] Send audio error:', error);
      return { success: false, error: error.message };
    }
  });

  // Process Vision Screen Analysis
  ipcMain.handle('send-image-to-gemini-http', async (event, { apiKey, base64JPEG, prompt }) => {
    try {
      const result = await sendImageToGeminiHttp(apiKey, base64JPEG, prompt);
      return result;
    } catch (error) {
      console.error('[IPC] Vision request error:', error);
      return { success: false, error: error.message };
    }
  });

  // Direct manual text input
  ipcMain.handle('send-text-to-gemini-http', async (event, { apiKey, groqKey, text }) => {
    if (!text || text.trim() === '') return { success: false, error: 'Empty text' };
    try {
      if (groqKey && groqKey.trim()) {
        await sendToGroq(text, groqKey);
      } else {
        await sendToGeminiFlash(text, apiKey);
      }
      return { success: true };
    } catch (error) {
      console.error('[IPC] Text generation error:', error);
      return { success: false, error: error.message };
    }
  });

  // Close direct standalone sessions
  ipcMain.handle('close-standalone-session', async () => {
    try {
      if (activeSession) {
        await activeSession.close();
        activeSession = null;
      }
      currentTranscription = '';
      conversationHistory = [];
      groqHistory = [];
      sendToRenderer('update-status', 'Disconnected');
      return { success: true };
    } catch (error) {
      console.error('[IPC] Close session error:', error);
      return { success: false, error: error.message };
    }
  });
}

module.exports = {
  setupGeminiIpcHandlers
};
