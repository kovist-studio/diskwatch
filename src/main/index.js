'use strict';

const { app, BrowserWindow, shell, session, nativeTheme } = require('electron');
const path = require('node:path');
const { registerIpcHandlers } = require('./ipc');
const surface = require('./surface');

const isDev = process.argv.includes('--dev');

let mainWindow = null;

function createWindow() {
  const requested = surface.chooseSurface();

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 580,
    show: false,
    ...surface.windowOptions(requested),
    // Hidden inset title bar on macOS; leave default chrome elsewhere.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
    },
  });

  // Confirm the material actually took, stepping down if it didn't.
  surface.confirm(mainWindow, requested);

  // Show only once painted — avoids the white flash on launch.
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Block all in-app navigation. Hand https off to the user's browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url.startsWith('https:')) {
      shell.openExternal(url);
    }
  });

  // Never open new windows inside the app; https goes to the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // DiskWatch has one palette and it is dark. Pinning the appearance keeps the
  // vibrancy material dark too: under a light system appearance macOS would
  // hand back a LIGHT blur, and this app's dim secondary text measures 1.2:1
  // against that — illegible. A dark material keeps it at 4.7:1 or better.
  nativeTheme.themeSource = 'dark';

  // No remote content is ever loaded, so no permission request can be
  // legitimate. Deny every one.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  registerIpcHandlers();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
