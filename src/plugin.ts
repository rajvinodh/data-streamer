import { BasePlugin } from '@appium/base-plugin';
import { logger } from '@appium/support';
import { TextCollector } from './text-collector.js';
import { getUIA2ServerInfo, findElementDirect } from './uia2-direct-client.js';
import type {
  StartTextCollectionParams,
  StopTextCollectionParams,
  TextCollectionResult,
} from './types.js';

const log = logger.getLogger('DataStreamer');

interface PluginConfig {
  defaultIntervalMs: number;
  maxDurationMs: number;
}

const DEFAULT_CONFIG: PluginConfig = {
  defaultIntervalMs: 500,
  maxDurationMs: 300_000,
};

class DataStreamerPlugin extends BasePlugin {
  private collectors = new Map<string, TextCollector>();
  private config: PluginConfig;

  static executeMethodMap = {
    'dataStreamer: startTextCollection': {
      command: 'startTextCollection',
      params: { required: ['name'], optional: ['elementId', 'locator', 'intervalMs'] },
    },
    'dataStreamer: stopTextCollection': {
      command: 'stopTextCollection',
      params: { required: ['name'] },
    },
    'dataStreamer: directStartTextCollection': {
      command: 'directStartTextCollection',
      params: { required: ['name'], optional: ['elementId', 'locator', 'intervalMs'] },
    },
    'dataStreamer: directStopTextCollection': {
      command: 'directStopTextCollection',
      params: { required: ['name'] },
    },
    'dataStreamer: clickAndWaitForText': {
      command: 'clickAndWaitForText',
      params: { required: ['elementIdToClick', 'locator', 'timeoutMs'] },
    },
  } as const;

  constructor(pluginName: string, cliArgs?: Record<string, unknown>) {
    super(pluginName, cliArgs);
    const args = (cliArgs ?? {}) as Record<string, unknown>;
    this.config = {
      defaultIntervalMs: (args['default-interval-ms'] as number) ?? DEFAULT_CONFIG.defaultIntervalMs,
      maxDurationMs: (args['max-duration-ms'] as number) ?? DEFAULT_CONFIG.maxDurationMs,
    };
    log.info('[data-streamer] Plugin initialized', this.config);
  }

  private getCollector(driver: any): TextCollector {
    const sessionId = driver.sessionId;
    if (!sessionId) {
      throw new Error('No session ID available');
    }
    if (!this.collectors.has(sessionId)) {
      this.collectors.set(sessionId, new TextCollector());
    }
    return this.collectors.get(sessionId)!;
  }

  async startTextCollection(
    next: () => Promise<any>,
    driver: any,
    name: string,
    elementId?: string,
    locator?: { using: string; value: string },
    intervalMs?: number,
  ): Promise<{ name: string; elementId: string; intervalMs: number; startedAt: number }> {
    if (!name || typeof name !== 'string') {
      throw new Error('Parameter "name" is required and must be a non-empty string');
    }

    let resolvedElementId: string;

    // Prefer elementId if provided; otherwise find element via locator
    if (elementId) {
      if (typeof elementId !== 'string' || !elementId.trim()) {
        throw new Error('Parameter "elementId" must be a non-empty string');
      }
      resolvedElementId = elementId;
    } else if (locator) {
      if (!locator.using || !locator.value) {
        throw new Error('Parameter "locator" must have "using" and "value" fields');
      }
      // Resolve the element via the driver
      const el = await driver.findElement(locator.using, locator.value);
      resolvedElementId = el.ELEMENT ?? el['element-6066-11e4-a52e-4f735466cecf'];
      if (!resolvedElementId) {
        throw new Error('Could not resolve element from locator');
      }
    } else {
      throw new Error('Either "elementId" or "locator" must be provided');
    }

    const collector = this.getCollector(driver);
    const interval = Math.max(50, intervalMs ?? this.config.defaultIntervalMs);

    await collector.start(name, resolvedElementId, interval, driver, this.config.maxDurationMs);

    return {
      name,
      elementId: resolvedElementId,
      intervalMs: interval,
      startedAt: Date.now(),
    };
  }

  async stopTextCollection(
    next: () => Promise<any>,
    driver: any,
    name: string,
  ): Promise<TextCollectionResult> {
    if (!name || typeof name !== 'string') {
      throw new Error('Parameter "name" is required and must be a non-empty string');
    }

    const collector = this.getCollector(driver);
    return await collector.stop(name);
  }

  // ---- Direct commands (bypass UIA driver, talk to UIA2 server directly) ----

  async directStartTextCollection(
    next: () => Promise<any>,
    driver: any,
    name: string,
    elementId?: string,
    locator?: { using: string; value: string },
    intervalMs?: number,
  ): Promise<{ name: string; elementId: string; intervalMs: number; startedAt: number }> {
    if (!name || typeof name !== 'string') {
      throw new Error('Parameter "name" is required and must be a non-empty string');
    }

    let resolvedElementId: string;

    // Prefer elementId if provided; otherwise find element via locator
    if (elementId) {
      if (typeof elementId !== 'string' || !elementId.trim()) {
        throw new Error('Parameter "elementId" must be a non-empty string');
      }
      resolvedElementId = elementId;
    } else if (locator) {
      if (!locator.using || !locator.value) {
        throw new Error('Parameter "locator" must have "using" and "value" fields');
      }
      // Resolve element directly via UIA2 server HTTP API (no driver command chain)
      const serverInfo = getUIA2ServerInfo(driver);
      resolvedElementId = await findElementDirect(serverInfo, locator.using, locator.value);
    } else {
      throw new Error('Either "elementId" or "locator" must be provided');
    }

    const collector = this.getCollector(driver);
    const interval = Math.max(50, intervalMs ?? this.config.defaultIntervalMs);

    await collector.startDirect(name, resolvedElementId, interval, driver, this.config.maxDurationMs);

    return {
      name,
      elementId: resolvedElementId,
      intervalMs: interval,
      startedAt: Date.now(),
    };
  }

  async directStopTextCollection(
    next: () => Promise<any>,
    driver: any,
    name: string,
  ): Promise<TextCollectionResult> {
    if (!name || typeof name !== 'string') {
      throw new Error('Parameter "name" is required and must be a non-empty string');
    }

    const collector = this.getCollector(driver);
    return await collector.stop(name);
  }

  /**
   * Click `elementIdToClick`, then poll for `locator` until its text is available (or
   * `timeoutMs` elapses). Direct-to-UIA2 only — no driver command chain involved.
   */
  async clickAndWaitForText(
    next: () => Promise<any>,
    driver: any,
    elementIdToClick: string,
    locator: { using: string; value: string },
    timeoutMs: number,
  ): Promise<{ elementId: string; text: string; elapsedMs: number }> {
    if (!elementIdToClick || typeof elementIdToClick !== 'string') {
      throw new Error('Parameter "elementIdToClick" is required and must be a non-empty string');
    }
    if (!locator || !locator.using || !locator.value) {
      throw new Error('Parameter "locator" must have "using" and "value" fields');
    }
    if (!timeoutMs || typeof timeoutMs !== 'number' || timeoutMs <= 0) {
      throw new Error('Parameter "timeoutMs" is required and must be a positive number');
    }

    const collector = this.getCollector(driver);
    return await collector.clickAndWaitForText(elementIdToClick, locator, timeoutMs, driver);
  }

  async execute(next: () => Promise<any>, driver: any, script: string, args: any[]): Promise<any> {
    return await this.executeMethod(next, driver, script, args);
  }

  async deleteSession(next: () => Promise<any>, driver: any, ..._args: any[]): Promise<any> {
    const sessionId = driver.sessionId;
    if (sessionId && this.collectors.has(sessionId)) {
      await this.collectors.get(sessionId)!.stopAll(driver);
      this.collectors.delete(sessionId);
      log.info(`[data-streamer] Cleaned up session ${sessionId}`);
    }
    return await next();
  }

  async onUnexpectedShutdown(driver: any): Promise<void> {
    const sessionId = driver.sessionId;
    if (sessionId && this.collectors.has(sessionId)) {
      await this.collectors.get(sessionId)!.stopAll(driver);
      this.collectors.delete(sessionId);
      log.info(`[data-streamer] Cleaned up after unexpected shutdown for session ${sessionId}`);
    }
  }
}

export { DataStreamerPlugin };
export default DataStreamerPlugin;
