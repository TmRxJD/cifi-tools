#!/usr/bin/env node
import { runCliMain } from '../cli-main.mjs'

try {
  await runCliMain()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`CIFI Bridge failed to start: ${message}`)
  process.exit(1)
}

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
