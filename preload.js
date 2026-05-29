const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window Movement
  moveWindow: (direction) => ipcRenderer.send('move-window', direction),
  
  // Click Through Actions
  setClickThrough: (value) => ipcRenderer.send('set-click-through', value),
  onClickThroughToggled: (callback) => ipcRenderer.on('click-through-toggled', (event, value) => callback(value)),

  // Capture screen resources (for screen analyze)
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),

  // Platform specific configurations
  getPlatform: () => process.platform,

  // Direct Standalone BYOK handlers
  initializeStandaloneBYOK: (args) => ipcRenderer.invoke('initialize-standalone-byok', args),
  sendPCMAudioChunk: (base64PCM) => ipcRenderer.invoke('send-pcm-audio-chunk', base64PCM),
  sendImageToGeminiHttp: (args) => ipcRenderer.invoke('send-image-to-gemini-http', args),
  sendTextToGeminiHttp: (args) => ipcRenderer.invoke('send-text-to-gemini-http', args),
  closeStandaloneSession: () => ipcRenderer.invoke('close-standalone-session'),
  setCurrentSpeaker: (speaker) => ipcRenderer.send('set-current-speaker', speaker),

  // Subscribing to IPC streaming events from Main Process
  onIpcEvent: (channel, callback) => {
    const validChannels = [
      'new-response', 
      'update-response', 
      'update-status', 
      'global-shortcut-analyze-screen', 
      'append-transcript-text'
    ];
    if (validChannels.includes(channel)) {
      const listener = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  }
});
