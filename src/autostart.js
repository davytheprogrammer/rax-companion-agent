// Start with Windows: one login item that runs this exe with --autostart.
//
// Windows keeps a login item under a name. Electron's default name is the
// app's AppUserModelID, which changes when app.setAppUserModelId runs. Until
// 0.1.29 the Companion wrote the item at startup before setting that id
// ("electron.app.Nus Companion") and again from the Knot's "yes" after it
// ("com.nus.companion"), so anyone who said yes ended up with two items.
// Windows then started Nus twice at sign-in; the second copy handed over to the
// first, which opened the dashboard and counted the day as engaged.
//
// So: the item is written under one fixed name, the old default name is
// removed at each start, and a second copy that Windows started at sign-in is
// ignored (isLoginLaunch).
//
// Electron-free on purpose so it runs under node --test: the host passes app.

const ENTRY = 'com.nus.companion';   // the build's appId
const ARG = '--autostart';

function legacyEntry(appName) { return 'electron.app.' + String(appName || ''); }

/**
 * @param {object} o
 * @param {object} o.app              Electron's app (isPackaged, getName, setLoginItemSettings)
 * @param {string} [o.platform]
 * @param {string} [o.execPath]
 * @param {(m: string) => void} [o.log]
 */
function createAutostart(o) {
  const app = o.app;
  const platform = o.platform || process.platform;
  const execPath = o.execPath || process.execPath;
  const log = o.log || (() => {});
  // Only a packaged Windows build registers anything; a dev run would register electron.exe.
  const live = () => !!app.isPackaged && platform === 'win32';
  function set(name, on) { app.setLoginItemSettings({ openAtLogin: !!on, name, path: execPath, args: [ARG] }); }
  // The item Electron's default name left behind. Safe to run at every start.
  function cleanup() {
    if (!live()) return false;
    try { set(legacyEntry(app.getName()), false); return true; } catch (e) { log('[autostart] ' + e.message); return false; }
  }
  function apply(on) {
    if (!live()) return false;
    try { set(ENTRY, on); } catch (e) { log('[autostart] ' + e.message); return false; }
    cleanup();
    return true;
  }
  return { apply, cleanup };
}

// The arguments of a copy that Windows started at sign-in.
function isLoginLaunch(argv) { return Array.isArray(argv) && argv.includes(ARG); }

module.exports = { createAutostart, isLoginLaunch, legacyEntry, ENTRY, ARG };
