const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, session } = require('electron');
const path = require('path');
const { setupGeminiIpcHandlers } = require('./gemini-service');

// ── Platform-specific GPU / rendering fixes ───────────────────────────────────
if (process.platform === 'linux') {
  // Forces X11 rendering so desktopCapturer works and Vulkan/PipeWire
  // don't crash the GPU process with SIGSEGV.
  process.env.ELECTRON_OZONE_PLATFORM_HINT = 'x11';
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');
// ─────────────────────────────────────────────────────────────────────────────

let overlayWindow = null;
let isClickThrough = false;

function createOverlayWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  // Initialize a sleek vertical floating rectangle overlay
  overlayWindow = new BrowserWindow({
    width: 380,
    height: 600,
    x: width - 400, // Docked on the right side of the screen
    y: 100,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    }
  });

  overlayWindow.loadFile('overlay.html');

  // Ensure click-through is OFF after page loads so buttons work immediately
  overlayWindow.webContents.on('did-finish-load', () => {
    overlayWindow.setIgnoreMouseEvents(false);
    isClickThrough = false;
    // Applied after render so window stays visible on screen but hidden from screenshots
    overlayWindow.setContentProtection(true);
  });

  // Magic Display Media handler for standard WebRTC getDisplayMedia to capture screen smoothly
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
        // Automatically select the primary monitor screen
        const primary = sources.find(s => s.name.toLowerCase().includes('screen') || s.id.startsWith('screen')) || sources[0];
        callback({ video: primary, audio: 'loopback' });
      });
    },
    { useSystemPicker: false } // Auto-selects screen so visual analysis is instantaneous
  );

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
}

// Global Hotkeys Registering
function registerGlobalShortcuts() {
  // Toggle Click-Through: Ctrl + M
  globalShortcut.register('CommandOrControl+M', () => {
    if (!overlayWindow) return;
    
    isClickThrough = !isClickThrough;
    overlayWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
    overlayWindow.webContents.send('click-through-toggled', isClickThrough);
  });

  // Close Overlay Window: Ctrl + \
  globalShortcut.register('CommandOrControl+\\', () => {
    if (overlayWindow) {
      overlayWindow.close();
    }
  });

  // Capture Screenshot & Analyze Screen: Ctrl + Enter
  globalShortcut.register('CommandOrControl+Enter', () => {
    if (!overlayWindow) return;
    overlayWindow.webContents.send('global-shortcut-analyze-screen');
  });
}

app.whenReady().then(() => {
  createOverlayWindow();
  registerGlobalShortcuts();
  setupGeminiIpcHandlers(); // Wire up our standalone Gemini Live / Vision handlers!

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlayWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// IPC Bridge handlers for manual screen source selections if wanted
ipcMain.handle('get-screen-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 150, height: 150 }
    });
    return sources.map(source => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL()
    }));
  } catch (err) {
    console.error('[DesktopCapturer] getSources failed:', err.message);
    // Return empty array — renderer will fall back to mic-only mode gracefully
    return [];
  }
});

// Window Movement IPCs (Ctrl + Arrow Keys helper)
ipcMain.on('move-window', (event, direction) => {
  if (!overlayWindow) return;
  const { x, y, width, height } = overlayWindow.getBounds();
  const step = 30; // moving step in pixels

  switch(direction) {
    case 'left':
      overlayWindow.setBounds({ x: x - step, y, width, height });
      break;
    case 'right':
      overlayWindow.setBounds({ x: x + step, y, width, height });
      break;
    case 'up':
      overlayWindow.setBounds({ x, y: y - step, width, height });
      break;
    case 'down':
      overlayWindow.setBounds({ x, y: y + step, width, height });
      break;
  }
});

// Toggle click through programmatically
ipcMain.on('set-click-through', (event, value) => {
  isClickThrough = value;
  overlayWindow.setIgnoreMouseEvents(isClickThrough, { forward: true });
});
