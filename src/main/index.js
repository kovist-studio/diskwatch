'use strict';

const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');

const isDev = process.argv.includes('--dev');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: '#12161F',
    show: false,
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
  // No remote content is ever loaded, so no permission request can be
  // legitimate. Deny every one.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

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
