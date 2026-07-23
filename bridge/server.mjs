import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { WebSocketServer } from 'ws'
import { probeHostAdbStatus } from './adb-status.mjs'
import {
  AdbNotFoundError,
  normalizeAdbExecError,
  requireAdbExecutable,
} from './adb-resolve.mjs'
import { handlePrivateNetworkHttp } from './http-handlers.mjs'
import { BridgePullConsole } from './bridge-console.mjs'
import {
  BridgeNoDeviceError,
  BridgeSaveNotFoundError,
  isPhysicalAppSavePath,
  pullCifiSave,
} from './pull-save.mjs'

const execFileAsync = promisify(execFile)

// Different port than tracker-bridge's 43781 so both bridges can run side by side.
export const DEFAULT_PORT = 43791
export const DEFAULT_HOST = '127.0.0.1'
export const BRIDGE_VERSION = '1.0.0'

function resolvePort() {
  const raw = process.env.LOCAL_ADB_BRIDGE_PORT
  if (!raw) return DEFAULT_PORT
  const port = Number.parseInt(raw, 10)
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}

async function runAdb(args, timeoutMs = 120_000) {
  const adb = await requireAdbExecutable()
  try {
    const { stdout, stderr } = await execFileAsync(adb, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return `${stdout || ''}${stderr || ''}`.trim()
  } catch (error) {
    throw normalizeAdbExecError(error)
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload))
  }
}

function attachWebSocketHandlers(wss) {
  wss.on('headers', (headers, req) => {
    const origin = req.headers?.origin
    if (typeof origin === 'string' && origin.length > 0) {
      headers.push(`Access-Control-Allow-Origin: ${origin}`)
    }
    headers.push('Access-Control-Allow-Private-Network: true')
  })

  wss.on('connection', ws => {
    sendJson(ws, { type: 'HELLO', version: BRIDGE_VERSION, port: wss.options.server?.address()?.port })

    ws.on('message', async raw => {
      let message
      try {
        message = JSON.parse(String(raw))
      } catch {
        sendJson(ws, { type: 'ERROR', code: 'bad-request', message: 'Invalid JSON message.' })
        return
      }

      if (message?.type === 'PING') {
        sendJson(ws, { type: 'PONG', version: BRIDGE_VERSION })
        return
      }

      if (message?.type === 'CHECK_ADB') {
        try {
          const status = await probeHostAdbStatus(runAdb)
          sendJson(ws, { type: 'ADB_STATUS', ...status })
        } catch (error) {
          const normalized = normalizeAdbExecError(error)
          const msg = normalized instanceof Error ? normalized.message : String(normalized)
          const code =
            normalized instanceof AdbNotFoundError || normalized?.code === 'adb-not-found'
              ? 'adb-not-found'
              : 'status-failed'
          sendJson(ws, { type: 'ERROR', code, message: msg })
        }
        return
      }

      if (message?.type === 'PULL_SAVE') {
        const customPort =
          message?.customPort != null ? String(message.customPort).trim() : undefined
        const preferPhysicalDevice = Boolean(message?.preferPhysicalDevice)
        const consoleUi = new BridgePullConsole({ physical: preferPhysicalDevice })
        try {
          const result = await pullCifiSave({
            customPort,
            preferPhysicalDevice,
            console: consoleUi,
          })
          if (
            preferPhysicalDevice
            && result?.remotePath
            && !isPhysicalAppSavePath(result.remotePath)
          ) {
            throw new BridgeSaveNotFoundError(
              `USB import refused a non-app save path (${result.remotePath}). Stop the bridge and run: npx cifi-bridge`,
              result.deviceSerial,
            )
          }
          sendJson(ws, {
            type: 'SUCCESS',
            data: result.base64,
            remotePath: result.remotePath,
            deviceSerial: result.deviceSerial,
            deviceLabel: result.deviceLabel ?? null,
            byteLength: result.byteLength,
          })
        } catch (error) {
          const normalized = normalizeAdbExecError(error)
          const msg = normalized instanceof Error ? normalized.message : String(normalized)
          consoleUi.logError(
            preferPhysicalDevice
              ? `USB pull failed: ${msg}`
              : `ADB pull failed: ${msg}`,
          )
          let code =
            normalized instanceof AdbNotFoundError || normalized?.code === 'adb-not-found'
              ? 'adb-not-found'
              : 'pull-failed'
          let deviceSerial
          if (error instanceof BridgeSaveNotFoundError) {
            code = 'save-not-found'
            deviceSerial = error.deviceSerial
          } else if (error instanceof BridgeNoDeviceError) {
            code = 'no-device'
          }
          sendJson(ws, { type: 'ERROR', code, message: msg, deviceSerial })
        }
        return
      }

      sendJson(ws, {
        type: 'ERROR',
        code: 'unknown-type',
        message: `Unknown message type: ${message?.type ?? '(missing)'}`,
      })
    })
  })
}

export function startLocalAdbBridge(options = {}) {
  const host = options.host ?? DEFAULT_HOST
  const port = options.port ?? resolvePort()

  const server = http.createServer((req, res) => {
    if (handlePrivateNetworkHttp(req, res, { version: BRIDGE_VERSION })) {
      return
    }
    res.writeHead(404)
    res.end()
  })

  const wss = new WebSocketServer({ server })
  attachWebSocketHandlers(wss)

  server.listen(port, host, () => {
    console.log(`CIFI Bridge listening on http://${host}:${port} and ws://${host}:${port}`)
    console.log(
      'When using the HunterSim tool, click Allow if Chrome asks for local network access.',
    )
    if (options.backgroundCapable) {
      console.log('Tip: restart with --daemon to run in the background and close this terminal.')
    } else {
      console.log('Leave this terminal open while importing from the HunterSim website.')
    }
  })

  server.on('error', error => {
    console.error('CIFI Bridge server error:', error)
    process.exitCode = 1
  })

  return { server, wss }
}
