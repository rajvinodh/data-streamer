# `data-streamer` — Appium Plugin Guide

Companion plugin to the WebSocket streaming feature in
`appium-uiautomator2-server` (endpoint `/ws/stream`) and the driver-side
`mobile: forwardWsStreamPort` command in `appium-uiautomator2-driver`.

The plugin exposes user-facing `mobile:` commands that take a locator strategy +
value, resolve the element via the driver, open a WebSocket to the device-side
stream server, and collect `getText` samples for a caller-specified duration.

Follows the same conventions as
[`uiwatchers`](https://github.com/rajvinodh/uiwatchers): `@appium/base-plugin`,
`@appium/support` logger, per-session state, `execute()` dispatch on `mobile: *`.

## Repo layout (mirrors `uiwatchers`)

```
data-streamer/
├── package.json
├── tsconfig.json
├── eslint.config.js
├── .mocharc.json
├── src/
│   ├── plugin.ts                # DataStreamerPlugin (BasePlugin subclass)
│   ├── config.ts                # PluginConfig + DefaultPluginConfig
│   ├── types.ts                 # Locator, StreamRequest, StreamResult, ...
│   ├── validators.ts
│   ├── utils.ts                 # extractElementId, jitter helpers
│   ├── ws-client.ts             # thin WS wrapper (subscribe/unsubscribe/close)
│   ├── stream-session.ts        # per-Appium-session state (WS + subs)
│   └── commands/
│       ├── stream-text.ts       # mobile: streamElementText
│       ├── stream-start.ts      # mobile: startElementTextStream
│       ├── stream-stop.ts       # mobile: stopElementTextStream
│       └── stream-status.ts     # mobile: getStreamStatus
├── test/
│   └── unit/…
└── README.md
```

## `package.json` skeleton

```json
{
  "name": "appium-data-streamer",
  "version": "0.1.0",
  "type": "module",
  "main": "./lib/plugin.js",
  "types": "./lib/plugin.d.ts",
  "files": ["lib"],
  "peerDependencies": { "appium": "^3.1.2" },
  "dependencies": {
    "@appium/base-plugin": "^3.0.5",
    "@appium/support": "^7.0.4",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.13",
    "typescript": "^5.9.3"
  },
  "appium": {
    "pluginName": "data-streamer",
    "mainClass": "DataStreamerPlugin",
    "schema": {
      "$schema": "http://json-schema.org/draft-07/schema",
      "type": "object",
      "properties": {
        "default-interval-ms": {"type": "integer", "minimum": 50, "maximum": 60000, "default": 100},
        "max-duration-ms":     {"type": "integer", "minimum": 100, "maximum": 3600000, "default": 60000},
        "max-samples":         {"type": "integer", "minimum": 1, "maximum": 1000000, "default": 100000}
      }
    }
  },
  "scripts": {
    "build": "tsc",
    "install:local": "npm run build && appium plugin install --source=local ."
  }
}
```

## Config (`src/config.ts`)

```ts
export interface PluginConfig {
  defaultIntervalMs?: number;
  maxDurationMs?: number;
  maxSamples?: number;
}

export const DefaultPluginConfig: Required<PluginConfig> = {
  defaultIntervalMs: 100,
  maxDurationMs: 60_000,
  maxSamples: 100_000,
};
```

## Types (`src/types.ts`)

```ts
export interface Locator {
  using: string; // 'id' | 'xpath' | 'accessibility id' | ...
  value: string;
}

export interface StreamElementTextParams {
  locator: Locator;
  intervalMs?: number;   // default from config; server enforces ≥ 50
  durationMs: number;    // capped by config.maxDurationMs
}

export interface StreamSample {
  t: number;             // epoch ms
  text: string;
  skipped?: number;
}

export interface StreamResult {
  subscriptionId: string;
  elementId: string;
  samples: StreamSample[];
  totalSkipped: number;
  durationMs: number;
}

export interface StartStreamResult {
  subscriptionId: string;
  elementId: string;
}

export interface StopStreamResult {
  subscriptionId: string;
  samples: StreamSample[];
  totalSkipped: number;
}
```

## WS client (`src/ws-client.ts`)

```ts
import WebSocket from 'ws';

type Frame = Record<string, unknown>;

export class StreamWsClient {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (f: Frame) => void>();
  private eventHandlers = new Map<string, (f: Frame) => void>();

  async connect(url: string): Promise<void> {
    this.ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ws.on('message', (buf) => {
      const msg = JSON.parse(buf.toString()) as Frame;
      if (msg.method === 'stream.event') {
        const sub = (msg.params as any).subscriptionId as string;
        this.eventHandlers.get(sub)?.(msg);
        return;
      }
      if (typeof msg.id === 'number') {
        this.pending.get(msg.id)?.(msg);
        this.pending.delete(msg.id);
      }
    });
  }

  async request(method: string, params: Frame): Promise<Frame> {
    const id = this.nextId++;
    return await new Promise((resolve, reject) => {
      this.pending.set(id, (f) => (f.error ? reject(f.error) : resolve(f)));
      this.ws.send(JSON.stringify({id, method, params}));
    });
  }

  onEvent(subscriptionId: string, handler: (f: Frame) => void) {
    this.eventHandlers.set(subscriptionId, handler);
  }

  offEvent(subscriptionId: string) {
    this.eventHandlers.delete(subscriptionId);
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
```

## Per-session state (`src/stream-session.ts`)

```ts
import {StreamWsClient} from './ws-client.js';
import type {StreamSample} from './types.js';

export interface ActiveSubscription {
  subscriptionId: string;
  elementId: string;
  samples: StreamSample[];
  totalSkipped: number;
  startedAt: number;
  stop?: () => void;
}

export class StreamSession {
  ws?: StreamWsClient;
  wsUrl?: string;
  bound = false;
  subs = new Map<string, ActiveSubscription>();
  subCounter = 0;

  nextSubscriptionId(): string {
    return `sub-${Date.now()}-${++this.subCounter}`;
  }
}
```

## Plugin entry (`src/plugin.ts`)

```ts
import {BasePlugin} from '@appium/base-plugin';
import {logger} from '@appium/support';
import {DefaultPluginConfig, type PluginConfig} from './config.js';
import {StreamSession} from './stream-session.js';
import {streamElementText} from './commands/stream-text.js';
import {startElementTextStream} from './commands/stream-start.js';
import {stopElementTextStream} from './commands/stream-stop.js';
import {getStreamStatus} from './commands/stream-status.js';

const log = logger.getLogger('DataStreamer');

class DataStreamerPlugin extends BasePlugin {
  private sessions = new Map<string, StreamSession>();
  private config: Required<PluginConfig>;

  constructor(pluginName: string, cliArgs?: Record<string, unknown>) {
    super(pluginName, cliArgs);
    this.config = Object.assign({}, DefaultPluginConfig, cliArgs as PluginConfig);
    log.info('[data-streamer] initialized', this.config);
  }

  private getState(driver: any): StreamSession {
    const sid = driver.sessionId;
    if (!sid) throw new Error('No session id');
    let s = this.sessions.get(sid);
    if (!s) { s = new StreamSession(); this.sessions.set(sid, s); }
    return s;
  }

  async execute(next: () => Promise<any>, driver: any, script: string, args: any[]): Promise<any> {
    const params = args?.[0] ?? {};
    const state = this.getState(driver);
    switch (script) {
      case 'mobile: streamElementText':
        return streamElementText(driver, state, this.config, params);
      case 'mobile: startElementTextStream':
        return startElementTextStream(driver, state, this.config, params);
      case 'mobile: stopElementTextStream':
        return stopElementTextStream(state, params);
      case 'mobile: getStreamStatus':
        return getStreamStatus(state);
      default:
        return await next();
    }
  }

  async deleteSession(next: () => Promise<any>, driver: any, ..._args: any[]): Promise<any> {
    const sid = driver.sessionId;
    const state = sid ? this.sessions.get(sid) : undefined;
    if (state) {
      for (const sub of state.subs.values()) sub.stop?.();
      state.ws?.close();
      this.sessions.delete(sid!);
    }
    return await next();
  }

  async onUnexpectedShutdown(driver: any): Promise<void> {
    const sid = driver.sessionId;
    const state = sid ? this.sessions.get(sid) : undefined;
    if (state) {
      for (const sub of state.subs.values()) sub.stop?.();
      state.ws?.close();
      this.sessions.delete(sid!);
    }
  }
}

export {DataStreamerPlugin};
export default DataStreamerPlugin;
```

## Command: `mobile: streamElementText` (blocking, one-shot)

`src/commands/stream-text.ts`:

```ts
import {logger} from '@appium/support';
import {StreamWsClient} from '../ws-client.js';
import type {StreamSession} from '../stream-session.js';
import type {PluginConfig} from '../config.js';
import type {
  StreamElementTextParams, StreamResult, StreamSample,
} from '../types.js';

const log = logger.getLogger('DataStreamer');

async function ensureWs(driver: any, state: StreamSession): Promise<void> {
  if (state.ws) return;

  // Ask the driver to adb-forward the on-device WS port. Option A:
  const info = await driver.executeMethod('mobile: forwardWsStreamPort', [{}]);
  state.wsUrl = info.wsUrl as string;

  const client = new StreamWsClient();
  await client.connect(state.wsUrl!);
  state.ws = client;
  log.info(`[data-streamer] connected to ${state.wsUrl}`);
}

export async function streamElementText(
  driver: any,
  state: StreamSession,
  cfg: Required<PluginConfig>,
  params: StreamElementTextParams,
): Promise<StreamResult> {
  const {locator, durationMs} = params;
  const intervalMs = Math.max(50, params.intervalMs ?? cfg.defaultIntervalMs);
  const duration = Math.min(durationMs, cfg.maxDurationMs);

  // 1. Resolve locator via the driver (produces an Appium element).
  const el = await driver.findElement(locator.using, locator.value);
  const elementId = el.ELEMENT ?? el['element-6066-11e4-a52e-4f735466cecf'];
  if (!elementId) throw new Error('Could not extract elementId');

  // 2. Ensure WS is connected.
  await ensureWs(driver, state);

  // 3. Subscribe.
  const subscriptionId = state.nextSubscriptionId();
  const samples: StreamSample[] = [];
  let totalSkipped = 0;

  state.ws!.onEvent(subscriptionId, (frame) => {
    const p = (frame as any).params;
    samples.push({t: Date.now(), text: p.data.text, skipped: p.skipped});
    if (typeof p.skipped === 'number') totalSkipped += p.skipped;
  });

  await state.ws!.request('stream.subscribe', {
    sessionId: state.bound ? undefined : driver.sessionId,
    type: 'element.text',
    elementId,
    intervalMs,
    subscriptionId,
  });
  state.bound = true;

  // 4. Wait for the duration.
  await new Promise((r) => setTimeout(r, duration));

  // 5. Unsubscribe.
  await state.ws!.request('stream.unsubscribe', {subscriptionId});
  state.ws!.offEvent(subscriptionId);

  const capped = samples.slice(0, cfg.maxSamples);
  return {subscriptionId, elementId, samples: capped, totalSkipped, durationMs: duration};
}
```

## Command: `mobile: startElementTextStream` / `stopElementTextStream`

Non-blocking variant — returns a `subscriptionId` immediately and buffers
samples in `state.subs`. `stopElementTextStream({subscriptionId})` returns the
accumulated samples and cleans up. Same helpers as above.

## Command: `mobile: getStreamStatus`

Returns `{connected, wsUrl, subscriptions: [{subscriptionId, elementId, sampleCount, startedAt}]}`.

## Client usage example (WebdriverIO)

```ts
const result = await driver.executeScript('mobile: streamElementText', [{
  locator: {using: 'id', value: 'com.myapp:id/tick'},
  intervalMs: 100,
  durationMs: 5000,
}]);
console.log(result.samples.length, 'samples');
```

## Fallback (Option B): plugin does the `adb forward` itself

If the driver hasn't added `mobile: forwardWsStreamPort` yet, replace `ensureWs`
with a version that:

1. Reads `driver.opts.wsStreamServerPort` (or defaults to `6791`).
2. Uses `driver.adb.forwardPort(localPort, devicePort)` — the driver already
   exposes `adb` on its instance.

```ts
async function ensureWs(driver: any, state: StreamSession): Promise<void> {
  if (state.ws) return;
  const devicePort = driver.opts?.wsStreamServerPort ?? 6791;
  const {default: getPort} = await import('get-port');
  const localPort = await getPort({port: getPort.makeRange(9000, 9999)});
  await driver.adb.forwardPort(localPort, devicePort);
  const client = new StreamWsClient();
  await client.connect(`ws://127.0.0.1:${localPort}/ws/stream`);
  state.ws = client;
  state.wsUrl = `ws://127.0.0.1:${localPort}/ws/stream`;
}
```

Everything else stays identical.

## Testing checklist

1. `npm run install:local` inside `data-streamer/`.
2. Start Appium with `--use-plugins=data-streamer`.
3. Create UIA2 session with `appium:wsStreamServerPort: 6791` (optional; matches default).
4. Call `mobile: streamElementText` with a live locator; assert `samples.length > 0`.
5. Delete the session; verify no lingering WS or forwarded port
   (`adb forward --list`).

## Extending to other kinds

The server protocol reserves `stream.*`. To stream a different property, add a
new server-side `StreamCommandHandler` (e.g. `element.attribute`) and a new
plugin command (`mobile: streamElementAttribute`) that sends
`type: "element.attribute"` — the WS client and session code stay unchanged.

