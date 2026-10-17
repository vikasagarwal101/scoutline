import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const mode of ['frozen', 'real-clock', 'unknown', 'uncancelled', 'owned-timer']) {
  test(`L2 cancellation exits independently of acquisition/projection progress: ${mode}`, async () => {
    // Keep configured offline isolation and refusal preload without forwarding unrelated env.
    const childEnv = Object.fromEntries([
      'PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
      'SCOUTLINE_CONFIG_DIR', 'SCOUTLINE_ARTIFACTS_DIR', 'SCOUTLINE_WATCH_DIR', 'NODE_OPTIONS',
    ].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    // A subprocess wall is required: node:test timeouts cannot interrupt a synchronous spin.
    const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/lean-l2-cancel-child.mjs', import.meta.url)), mode], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '', killed = false;
    child.stdout.on('data', x => output += x);
    child.stderr.on('data', x => error += x);
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 4000);
    const exit = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
    clearTimeout(timer);
    assert.match(output, /"marker":"candidate-return"/, `target not reached: ${output} ${error}`);
    assert.equal(killed, false, `scheduler must exit after the candidate return: ${output} ${error}`);
    assert.equal(exit.code, 0, error);
    const r = JSON.parse(output.trim().split('\n').at(-1)).result;
    if (mode === 'uncancelled') {
      assert.equal(r.status, 'complete');
      assert.equal(r.data.version, '2.4');
    } else {
      assert.equal(r.status, 'partial');
      assert.deepEqual(r.data, {});
      assert.equal(r.requirements.version.reason, mode === 'owned-timer' ? 'deadline' : 'cancelled');
      assert(r.requirements.version.attemptedRecords.some(a => a.metadata?.kind === 'candidate-judgment'), 'settled audit survives');
    }
  });
}
