'use strict';
/* Headless UI screenshot: electron tests/ui-shot.js -> /tmp/dshift-ui.png */
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 760, frame: false, transparent: false, show: false, webPreferences: { preload: path.join(__dirname, 'ui-shot-preload.js'), contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  await new Promise(r => setTimeout(r, 900));
  const img = await win.capturePage();
  require('fs').writeFileSync(process.env.SHOT_OUT || '/tmp/dshift-ui.png', img.toPNG());
  app.quit();
});
