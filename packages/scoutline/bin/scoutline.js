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
  .catch((err) => {
    console.error(
      JSON.stringify(
        {
          success: false,
          error: err.message,
          code: "LOAD_ERROR",
          help: 'Make sure to run "npm run build" before running scoutline',
        },
        null,
        2,
      ),
    );
    process.exit(1);
  });
