#!/usr/bin/env bun
import { runCli } from "./cli/run.ts";

process.exit(runCli(Bun.argv.slice(2)));
