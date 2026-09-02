const { app, BrowserWindow } = require('electron');
const path = require('path');

/* Explicit .cjs so this file is CommonJS regardless of the "type":"module"
   in package.json - Electron's main process is most reliable with plain
   require(), and this keeps it isolated from the Vite/React app's own
   ESM world entirely. */

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    // Matches the app's --ground CSS token, so there's no white flash
    // before the page paints on launch.
    backgroundColor: '#B3966B',
    title: 'SporeDesk',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true, // no File/Edit/View bar cluttering a single-purpose app; Alt reveals it if ever needed
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    // `npm run electron:dev` starts the Vite dev server and waits for it
    // before launching this, same as the browser workflow but in a window.
    win.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  // F12 toggles dev tools even in the packaged build - autoHideMenuBar
  // hides the menu (and its built-in devtools shortcut) so this is the
  // only way to get a console in an installed copy for debugging.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
