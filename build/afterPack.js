// electron-builder afterPack hook.
// Replaces the weak linker-generated ad-hoc signature with a full deep ad-hoc
// signature using the real bundle identifier, so the resulting dmg opens
// without the misleading "app is damaged" Gatekeeper error.
// Note: this is ad-hoc only (no Developer ID / notarization) — downloaded
// builds still require right-click → Open or "Open Anyway" once.

const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  const identifier = context.packager.appInfo.id; // com.ts.activity-keeper

  console.log(`[afterPack] deep ad-hoc signing ${appPath}`);

  try {
    execFileSync('codesign', ['--remove-signature', appPath], { stdio: 'ignore' });
  } catch {
    // no existing signature — fine
  }

  execFileSync(
    'codesign',
    ['--force', '--deep', '--identifier', identifier, '--sign', '-', appPath],
    { stdio: 'inherit' }
  );

  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', appPath],
    { stdio: 'inherit' }
  );

  console.log('[afterPack] ad-hoc signature applied and verified');
};
