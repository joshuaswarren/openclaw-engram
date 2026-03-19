#!/usr/bin/env node

import("../dist/access-cli.js")
  .then(({ runCli }) => runCli(process.argv.slice(2)))
  .catch((error) => {
    const message = error instanceof Error ? error.message : "unknown load error";
    console.error(`access-cli failed to load dist/access-cli.js: ${message}`);
    process.exit(1);
  });
