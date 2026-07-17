#!/usr/bin/env node

import("../dist/index.js")
  .then(async ({ main }) => {
    const { createNodeCommandInvocationAdapter } =
      await import("../dist/node-command-invocation-adapter.js");
    const adapter = createNodeCommandInvocationAdapter();
    const status = await main(process.argv.slice(2), {
      invocation: adapter,
      env: process.env,
    });
    adapter.setExitCode(status);
  })
  .catch(async (err) => {
    try {
      const { formatLoadFailure } = await import(
        "../dist/node-command-invocation-adapter.js"
      );
      console.error(formatLoadFailure(err));
    } catch {
      // If the dist module is unavailable for any reason, fall back to a
      // best-effort envelope. We do not let a missing helper hide the
      // original load error from the user.
      console.error(
        JSON.stringify(
          {
            success: false,
            error: err && err.message ? err.message : String(err),
            code: "LOAD_ERROR",
            help: 'Make sure to run "npm run build" before running scoutline',
          },
          null,
          2,
        ),
      );
    }
    process.exit(1);
  });
