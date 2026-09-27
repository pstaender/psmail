"use strict";

const { app, BrowserWindow, Menu, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const { getConfigDir, getSettingsPath, readServerAddress, browsableHost } = require("./config");

/** The compiled sidecar binary (see ../scripts/build-sidecar.ts): under build/ next to the source
 * while developing, or bundled as an extraResource once packaged (see build/electron-builder.yml). */
function sidecarPath() {
  const exeSuffix = process.platform === "win32" ? ".exe" : "";
  const name = `psmail-server${exeSuffix}`;
  return app.isPackaged ? path.join(process.resourcesPath, name) : path.join(__dirname, "..", "build", name);
}

let sidecar = null;

function startSidecar() {
  sidecar = spawn(sidecarPath(), [], { stdio: ["ignore", "pipe", "pipe"] });
  sidecar.stdout.on("data", chunk => process.stdout.write(`[psmail-server] ${chunk}`));
  sidecar.stderr.on("data", chunk => process.stderr.write(`[psmail-server] ${chunk}`));
  sidecar.on("error", err => console.error("Could not start psmail-server:", err));
}

function stopSidecar() {
  if (sidecar && !sidecar.killed) sidecar.kill();
  sidecar = null;
}

/** Polls until something is listening on host:port, or gives up after `timeoutMs`. */
function waitForServer(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    (function attempt() {
      const socket = net.connect({ host, port }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 150);
      });
    })();
  });
}

function openSettingsFile() {
  shell.openPath(getSettingsPath()).then(err => {
    if (err) console.error("Could not open settings.json:", err);
  });
}

function openSettingsFolder() {
  shell.openPath(getConfigDir()).then(err => {
    if (err) console.error("Could not open the settings folder:", err);
  });
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    {
      label: isMac ? app.name : "File",
      submenu: [
        ...(isMac ? [{ role: "about" }, { type: "separator" }] : []),
        { label: "Open Settings", click: openSettingsFile },
        { label: "Open Settings Folder", click: openSettingsFolder },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** A link clicked anywhere in the app — most commonly inside a message's rendered HTML, which
 * src/lib/sanitizeHtml.ts always marks target="_blank" — opens in the OS's default browser/mail/
 * phone app instead of this app's own window trying to navigate or pop up a second window there. */
function interceptExternalLinks(webContents) {
  webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  webContents.on("will-navigate", (event, url) => {
    const current = webContents.getURL();
    if (current && new URL(url).origin !== new URL(current).origin) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}

async function createWindow() {
  const { hostname, port } = readServerAddress();
  const host = browsableHost(hostname);

  const ready = await waitForServer(host, port, 20_000);
  if (!ready) {
    dialog.showErrorBox("P.S.Mail", `The psmail server never answered on ${host}:${port}.`);
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    title: "P.S.Mail",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  interceptExternalLinks(win.webContents);
  win.loadURL(`http://${host}:${port}`);
}

app.whenReady().then(() => {
  startSidecar();
  buildMenu();
  createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", stopSidecar);
