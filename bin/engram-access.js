#!/usr/bin/env node

import("../dist/access-cli.js")
  .then(({ runCli }) => runCli(process.argv.slice(2)))
  .catch((error) => {
    const message = error instanceof Error ? error.name : "Error";
    console.error(`access-cli failed (${message})`);
    process.exit(1);
  });
