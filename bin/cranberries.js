#!/usr/bin/env node
// The library ships TypeScript, so its command runs through tsx.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
