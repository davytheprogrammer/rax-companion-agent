'use strict';
// Windows Administrator elevation helper.
// Required for low-level OS automation (Hands, UI Automation, synthetic mouse/keys)
// so User Interface Privilege Isolation (UIPI) does not block actions on elevated windows.

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

function isAdmin() {
  if (process.platform !== 'win32') return true;
  try {
    execSync('fsutil dirty query %systemdrive%', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * If on Windows and not running as Administrator, prompt the user via UAC
 * to relaunch the app with Administrator privileges.
 * @param {object} opts
 * @param {string[]} [opts.argv]
 * @param {boolean} [opts.force]
 * @param {(msg: string) => void} [opts.log]
 * @returns {boolean} True if already admin, false if relaunching as elevated
 */
function ensureAdmin({ argv = process.argv, force = false, log = () => {} } = {}) {
  if (process.platform !== 'win32') return true;
  if (argv.includes('--no-elevate') || argv.includes('--smoke')) return true;
  if (isAdmin()) return true;

  log('[elevate] Not running as administrator. Requesting UAC elevation...');

  const exe = process.execPath;
  const rawArgs = argv.slice(1);

  // 1. Try bundled elevate.exe if available in resourcesPath
  const bundledElevate = process.resourcesPath ? path.join(process.resourcesPath, 'elevate.exe') : null;
  if (bundledElevate && fs.existsSync(bundledElevate)) {
    try {
      const child = spawn(bundledElevate, [exe, ...rawArgs], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
      return false; // Tells caller to exit non-elevated process
    } catch (e) {
      log('[elevate] elevate.exe failed, falling back to powershell: ' + e.message);
    }
  }

  // 2. PowerShell Start-Process -Verb runAs
  try {
    const argList = rawArgs.length
      ? ` -ArgumentList '${rawArgs.map((a) => `"${a.replace(/'/g, "''").replace(/"/g, '`"')}"`).join(', ')}'`
      : '';
    const psCmd = `Start-Process -FilePath "${exe}"${argList} -Verb runAs`;
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return false; // Tells caller to exit non-elevated process
  } catch (e) {
    log('[elevate] Failed to request elevation: ' + e.message);
    return true; // Fall back to continuing without elevation
  }
}

module.exports = { isAdmin, ensureAdmin };
