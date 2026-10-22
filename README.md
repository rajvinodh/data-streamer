# appium-data-streamer

Appium plugin that collects `getText` samples from an element over time via
`start`/`stop` commands. It talks to the WebSocket streaming endpoint
(`/ws/stream`) exposed by `appium-uiautomator2-server`, either through the
normal driver command chain or directly over HTTP+WS (bypassing the driver
for lower latency).

notes and [diagrams/](diagrams/) for sequence/latency diagrams.

## Installation

```bash
npm install
npm run build
appium plugin install --source=local .
```

Or in one step:

```bash
npm run install:local
```

Start Appium with the plugin enabled:

```bash
appium --use-plugins=data-streamer
```

## Configuration

Set via Appium server CLI args (`--plugin-args` / config file), under the
`data-streamer` plugin schema:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `default-interval-ms` | integer | `500` | Default polling interval when `intervalMs` is omitted (minimum enforced: 50ms) |
| `max-duration-ms` | integer | `300000` | Maximum duration a collection can run before auto-stopping |

## Commands

All commands are invoked via `driver.executeScript("dataStreamer: <command>", params)`
(`mobile: `-style `execute()` dispatch).

### `dataStreamer: startTextCollection`

Starts polling `getText` on an element, driver-mediated (uses
`driver.executeMethod('mobile: forwardWsStreamPort')` under the hood).

Params:
- `name` (string, required) — identifier used to stop/reference this collection
- `elementId` (string, optional) — existing element ID
- `locator` (`{using, value}`, optional) — resolved via `driver.findElement` if `elementId` not given
- `intervalMs` (number, optional) — poll interval, defaults to `default-interval-ms`

One of `elementId` or `locator` must be provided.

Returns `{ name, elementId, intervalMs, startedAt }`.

### `dataStreamer: stopTextCollection`

Params: `name` (string, required)

Returns:

```ts
{
  name: string;
  samples: { timestamp: number; text: string; elapsed: number }[];
  startedAt: number;
  stoppedAt: number;
  durationMs: number;
  sampleCount: number;
  totalSkipped: number;
}
```

### `dataStreamer: directStartTextCollection` / `dataStreamer: directStopTextCollection`

Same params/response shape as the pair above, but bypass the Appium driver
command chain entirely — element resolution and streaming go straight to the
UIA2 server's HTTP/WS API. Use these for lower-latency collection.

### `dataStreamer: clickAndWaitForText`

Direct-only, single-shot helper: clicks an element, then polls a locator
every 50ms until its text becomes available or `timeoutMs` elapses (throws on
timeout).

Params:
- `elementIdToClick` (string, required)
- `locator` (`{using, value}`, required)
- `timeoutMs` (number, required)

Returns `{ elementId, text, elapsedMs }`.

## Example (Java client)

See [examples/DataStreamerPluginTest.java](examples/DataStreamerPluginTest.java)
for a full JUnit example. Basic flow:

```java
Map<String, Object> startParams = new HashMap<>();
startParams.put("name", "price-monitor");
startParams.put("locator", Map.of("using", "id", "value", "com.example.myapp:id/price_label"));
startParams.put("intervalMs", 200);

Map<String, Object> startResult = (Map<String, Object>)
        driver.executeScript("dataStreamer: startTextCollection", startParams);

Thread.sleep(5000);

Map<String, Object> stopParams = new HashMap<>();
stopParams.put("name", "price-monitor");

Map<String, Object> stopResult = (Map<String, Object>)
        driver.executeScript("dataStreamer: stopTextCollection", stopParams);
```

## Project layout

```
src/
├── plugin.ts             # DataStreamerPlugin (BasePlugin subclass, executeMethodMap)
├── text-collector.ts     # per-session collection state, start/stop/clickAndWaitForText logic
├── ws-client.ts          # WebSocket client for the UIA2 server's /ws/stream endpoint
├── uia2-direct-client.ts # direct HTTP client (bypasses driver) for element resolution
└── types.ts              # shared request/response types
```

## Development

```bash
npm run build     # tsc
npm run watch      # tsc --watch
npm run lint       # eslint src
npm run clean      # remove lib/coverage
```
