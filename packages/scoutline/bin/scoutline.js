#!/usr/bin/env node

import("../dist/index.js").catch((err) => {
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
