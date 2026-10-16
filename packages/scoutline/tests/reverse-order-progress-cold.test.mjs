import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
for (const mode of ["unchanged", "revise"]) {
  test(`no eligible field terminates boundedly under frozen clock: ${mode}`, async () => {
    const child = spawn(
      process.execPath,
      [new URL("./reverse-order-progress-child.mjs", import.meta.url).pathname, mode],
      { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      error = "",
      killed = false;
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (error += x));
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, 1000);
    const exit = await new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal })),
    );
    clearTimeout(timer);
    assert(
      !killed,
      `no-eligible re-entry cannot continue synchronously without state or budget progress: ${error}`,
    );
    assert.equal(exit.code, 0, error);
    const r = JSON.parse(output);
    assert(!("license" in r.data));
    assert(!("csv" in r.data));
    if (mode === "revise") assert(!("version" in r.data));
  });
}
