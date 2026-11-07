#!/usr/bin/env bun
import { main } from "./components/cli/main.ts";

process.exit(
  await main(Bun.argv.slice(2), {
    env: process.env,
    io: {
      out: (message) => console.log(message),
      err: (message) => console.error(message),
    },
  }),
);
