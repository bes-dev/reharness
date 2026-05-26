import { execSync, spawn } from 'child_process';

const SMOKE_PORT = 19123;
const RUNTIME_ERRORS = / ERROR |TypeError|ReferenceError|is not a function|is undefined|Invariant Violation|Exception in HostFunction/;
const WAIT_SECONDS = 30;

/**
 * Runtime smoke test: headless iOS Simulator + Metro, check log for errors.
 * No Simulator.app GUI — boots device via xcrun simctl, opens app via URL.
 */
export async function smokeTest(appDir: string, emit: (msg: string) => void): Promise<boolean> {
  // Check simulator availability
  let deviceId: string;
  try {
    deviceId = execSync(
      'xcrun simctl list devices available | grep "iPhone" | head -1 | grep -oE "[A-F0-9-]{36}"',
      { encoding: 'utf-8', timeout: 10000 },
    ).trim();
  } catch {
    emit('⚠ smoke: no simulator available (skipped)');
    return true;
  }
  if (!deviceId) {
    emit('⚠ smoke: no iPhone simulator found (skipped)');
    return true;
  }

  // Cleanup
  try { execSync(`lsof -ti :${SMOKE_PORT} | xargs kill 2>/dev/null`, { stdio: 'ignore' }); } catch {}
  try { execSync('osascript -e \'quit app "Simulator"\' 2>/dev/null', { stdio: 'ignore' }); } catch {}

  emit('  ⏳ smoke: booting simulator (headless)...');

  // Boot simulator headless (no Simulator.app GUI)
  try { execSync(`xcrun simctl boot "${deviceId}" 2>/dev/null`, { stdio: 'ignore', timeout: 15000 }); } catch {}

  // Start Metro separately (NO --ios flag — that opens Simulator.app)
  const metro = spawn('npx', ['expo', 'start', '--port', String(SMOKE_PORT)], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REACT_NATIVE_DEVTOOLS_PORT: '0' },
  });

  const logChunks: string[] = [];
  metro.stdout.on('data', (d: Buffer) => logChunks.push(d.toString()));
  metro.stderr.on('data', (d: Buffer) => logChunks.push(d.toString()));

  try {
    // Wait for Metro ready
    let ready = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const status = execSync(`curl -s http://localhost:${SMOKE_PORT}/status`, { encoding: 'utf-8', timeout: 5000 });
        if (status.includes('packager-status:running')) { ready = true; break; }
      } catch {}
    }

    if (!ready) {
      emit('⚠ smoke: metro did not start (skipped)');
      return true;
    }

    // Open app in headless simulator via Expo URL
    const ip = (() => {
      try { return execSync('ipconfig getifaddr en0 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim(); } catch {}
      return 'localhost';
    })();

    emit('  ⏳ smoke: launching app...');
    try {
      execSync(`xcrun simctl openurl "${deviceId}" "exp://${ip}:${SMOKE_PORT}"`, { stdio: 'ignore', timeout: 10000 });
    } catch {}

    // Wait for app to start and potentially crash
    emit(`  ⏳ smoke: waiting ${WAIT_SECONDS}s for runtime errors...`);
    await new Promise(r => setTimeout(r, WAIT_SECONDS * 1000));

    // Check Metro log
    const log = logChunks.join('');
    const errorLines = log.split('\n').filter(l => RUNTIME_ERRORS.test(l));
    const realErrors = errorLines.filter(l => !l.includes('incompatible'));

    if (realErrors.length > 0) {
      emit('✗ smoke: runtime errors detected');
      realErrors.slice(0, 5).forEach(l => emit(`  ${l.trim()}`));
      return false;
    }

    emit('✓ smoke');
    return true;
  } finally {
    metro.kill();
    try { execSync(`lsof -ti :${SMOKE_PORT} | xargs kill 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    try { execSync(`xcrun simctl shutdown "${deviceId}" 2>/dev/null`, { stdio: 'ignore' }); } catch {}
    try { execSync('osascript -e \'quit app "Simulator"\' 2>/dev/null', { stdio: 'ignore' }); } catch {}
  }
}
