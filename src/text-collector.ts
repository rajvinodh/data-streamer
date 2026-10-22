import { logger } from '@appium/support';
import { createServer } from 'node:net';
import { StreamWsClient } from './ws-client.js';
import { getUIA2ServerInfo } from './uia2-direct-client.js';
import type { ActiveCollection, TextSample, TextCollectionResult } from './types.js';

const log = logger.getLogger('DataStreamer');

const DEFAULT_WS_DEVICE_PORT = 6791;
const EPHEMERAL_PORT_START = 9000;
const EPHEMERAL_PORT_END = 9999;

function findFreePort(start: number, end: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    const tryPort = () => {
      const port = start + Math.floor(Math.random() * (end - start));
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          tryPort();
        } else {
          reject(err);
        }
      });
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port));
      });
    };
    tryPort();
  });
}

export class TextCollector {
  private collections = new Map<string, ActiveCollection>();
  private wsClient?: StreamWsClient;
  private wsUrl?: string;
  private boundSessionId?: string;
  private subCounter = 0;
  private forwardedLocalPort?: number;

  hasCollection(name: string): boolean {
    return this.collections.has(name);
  }

  /**
   * Ensure a WebSocket connection is open to the UIA2 server's /ws/stream endpoint.
   * Uses the driver's `mobile: forwardWsStreamPort` command to set up adb forward
   * and get the local wsUrl.
   */
  async ensureWsConnected(driver: any): Promise<void> {
    if (this.wsClient?.isConnected()) {
      return;
    }

    // Ask the driver to set up the adb port forward and return the ws URL
    const info = await driver.executeMethod('mobile: forwardWsStreamPort', [{}]);
    const url = info.wsUrl as string;

    const client = new StreamWsClient();
    await client.connect(url);

    this.wsClient = client;
    this.wsUrl = url;
    this.boundSessionId = undefined; // will bind on first subscribe
    log.info(`[data-streamer] WebSocket connected to ${url}`);
  }

  /**
   * Ensure a WebSocket connection is open — DIRECT mode.
   * Reads connection details from driver internals and does adb forward
   * directly, without invoking any driver commands.
   */
  async ensureWsConnectedDirect(driver: any): Promise<void> {
    if (this.wsClient?.isConnected()) {
      return;
    }

    const devicePort: number = driver.opts?.wsStreamServerPort ?? DEFAULT_WS_DEVICE_PORT;

    // Find a free port in the ephemeral range and forward via adb
    const localPort = await findFreePort(EPHEMERAL_PORT_START, EPHEMERAL_PORT_END);
    await driver.adb.forwardPort(localPort, devicePort);
    this.forwardedLocalPort = localPort;

    const url = `ws://127.0.0.1:${localPort}/ws/stream`;
    const client = new StreamWsClient();
    await client.connect(url);

    this.wsClient = client;
    this.wsUrl = url;
    this.boundSessionId = undefined;
    log.info(`[data-streamer:direct] WebSocket connected to ${url} (adb forward ${localPort} → ${devicePort})`);
  }

  async start(
    name: string,
    elementId: string,
    intervalMs: number,
    driver: any,
    maxDurationMs: number,
  ): Promise<void> {
    if (this.collections.has(name)) {
      throw new Error(`Text collection with name "${name}" is already running`);
    }

    await this.ensureWsConnected(driver);

    await this.subscribeAndBuffer(name, elementId, intervalMs, driver, maxDurationMs);
  }

  /**
   * Start collecting — DIRECT mode.
   * Uses direct adb forward and reads device session ID from driver internals.
   * No driver commands are invoked.
   */
  async startDirect(
    name: string,
    elementId: string,
    intervalMs: number,
    driver: any,
    maxDurationMs: number,
  ): Promise<void> {
    if (this.collections.has(name)) {
      throw new Error(`Text collection with name "${name}" is already running`);
    }

    await this.ensureWsConnectedDirect(driver);

    await this.subscribeAndBuffer(name, elementId, intervalMs, driver, maxDurationMs);
  }

  /**
   * Click `elementIdToClick`, then poll for `locator` until found (or `timeoutMs`
   * elapses), returning the matched element's text. Always direct-to-UIA2, single-shot.
   */
  async clickAndWaitForText(
    elementIdToClick: string,
    locator: { using: string; value: string },
    timeoutMs: number,
    driver: any,
  ): Promise<{ elementId: string; text: string; elapsedMs: number }> {
    await this.ensureWsConnectedDirect(driver);

    const subscriptionId = `sub-${Date.now()}-${++this.subCounter}`;
    const startedAt = Date.now();

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.wsClient!.offEvent(subscriptionId);
        this.wsClient!.offError(subscriptionId);
      };

      this.wsClient!.onEvent(subscriptionId, (event) => {
        if (event.data.found) {
          cleanup();
          resolve({
            elementId: (event.data.elementId as string) ?? '',
            text: (event.data.text as string) ?? '',
            elapsedMs: Date.now() - startedAt,
          });
        }
        // found === false is just a liveness sample; keep waiting.
      });

      this.wsClient!.onError(subscriptionId, (err) => {
        cleanup();
        reject(new Error(`${err.code}: ${err.message}`));
      });

      const subscribeParams: Record<string, unknown> = {
        type: 'element.clickAndWaitForText',
        subscriptionId,
        intervalMs: 50,
        elementId: elementIdToClick,
        strategy: locator.using,
        selector: locator.value,
        timeoutMs,
      };
      if (!this.boundSessionId) {
        const deviceSessionId = driver.uiautomator2?.jwproxy?.sessionId ?? driver.sessionId;
        subscribeParams.sessionId = deviceSessionId;
        this.boundSessionId = deviceSessionId;
      }

      this.wsClient!.subscribe(subscribeParams as any).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  /**
   * Common subscribe + buffer logic used by both start() and startDirect().
   */
  private async subscribeAndBuffer(
    name: string,
    elementId: string,
    intervalMs: number,
    driver: any,
    maxDurationMs: number,
  ): Promise<void> {

    const subscriptionId = `sub-${Date.now()}-${++this.subCounter}`;

    const collection: ActiveCollection = {
      name,
      elementId,
      subscriptionId,
      intervalMs,
      startedAt: Date.now(),
      samples: [],
      totalSkipped: 0,
      maxDurationTimer: null,
    };

    // Register event handler to buffer incoming samples
    this.wsClient!.onEvent(subscriptionId, (event) => {
      const now = Date.now();
      const sample: TextSample = {
        timestamp: now,
        text: (event.data.text as string) ?? '',
        elapsed: now - collection.startedAt,
      };
      collection.samples.push(sample);
      if (event.skipped) {
        collection.totalSkipped += event.skipped;
      }
    });

    // Subscribe via WebSocket to the server-side stream
    const subscribeParams: Record<string, unknown> = {
      type: 'element.text',
      elementId,
      intervalMs,
      subscriptionId,
    };
    // First subscribe on this WS must include the device-side session ID
    // (from the UIA2 server's JWProxy, NOT the Appium server session ID)
    if (!this.boundSessionId) {
      const deviceSessionId = driver.uiautomator2?.jwproxy?.sessionId ?? driver.sessionId;
      subscribeParams.sessionId = deviceSessionId;
      this.boundSessionId = deviceSessionId;
    }

    await this.wsClient!.subscribe(subscribeParams as any);

    // Auto-stop safety net
    collection.maxDurationTimer = setTimeout(() => {
      log.info(`[data-streamer] Auto-stopping "${name}" after max duration ${maxDurationMs}ms`);
      this.stopCollection(name).catch(() => {});
    }, maxDurationMs);

    this.collections.set(name, collection);
    log.info(`[data-streamer] Started text collection "${name}" (subscriptionId: ${subscriptionId}, interval: ${intervalMs}ms)`);
  }

  async stop(name: string): Promise<TextCollectionResult> {
    if (!this.collections.has(name)) {
      throw new Error(`No active text collection with name "${name}"`);
    }
    return this.stopCollection(name);
  }

  private async stopCollection(name: string): Promise<TextCollectionResult> {
    const collection = this.collections.get(name)!;
    const stoppedAt = Date.now();

    if (collection.maxDurationTimer) {
      clearTimeout(collection.maxDurationTimer);
      collection.maxDurationTimer = null;
    }

    // Unsubscribe from the server-side stream
    if (this.wsClient?.isConnected()) {
      try {
        await this.wsClient.unsubscribe(collection.subscriptionId);
      } catch (err: any) {
        log.warn(`[data-streamer] Unsubscribe failed for "${name}": ${err.message}`);
      }
      this.wsClient.offEvent(collection.subscriptionId);
    }

    this.collections.delete(name);

    const result: TextCollectionResult = {
      name,
      samples: collection.samples,
      startedAt: collection.startedAt,
      stoppedAt,
      durationMs: stoppedAt - collection.startedAt,
      sampleCount: collection.samples.length,
      totalSkipped: collection.totalSkipped,
    };

    log.info(`[data-streamer] Stopped "${name}" — collected ${result.sampleCount} samples over ${result.durationMs}ms (skipped: ${result.totalSkipped})`);
    return result;
  }

  async stopAll(driver?: any): Promise<void> {
    for (const name of [...this.collections.keys()]) {
      await this.stopCollection(name).catch(() => {});
    }
    this.wsClient?.close();
    this.wsClient = undefined;
    this.wsUrl = undefined;
    this.boundSessionId = undefined;

    // Clean up adb forward if we set it up directly
    if (this.forwardedLocalPort && driver?.adb) {
      try {
        await driver.adb.removePortForward(this.forwardedLocalPort);
        log.info(`[data-streamer:direct] Removed adb forward on port ${this.forwardedLocalPort}`);
      } catch (err: any) {
        log.warn(`[data-streamer:direct] Failed to remove adb forward: ${err.message}`);
      }
      this.forwardedLocalPort = undefined;
    }
  }

  getActiveNames(): string[] {
    return [...this.collections.keys()];
  }
}
