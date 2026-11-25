#!/usr/bin/env node
/**
 * Cuthol CLI entry point (`cuthol`, `cuthol-mcp`). The dispatcher lives in `cli_main.ts`.
 */
import { runCliMain } from "./cli_main.js";

void runCliMain();
