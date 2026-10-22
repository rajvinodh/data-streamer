import http from 'node:http';
import { logger } from '@appium/support';

const log = logger.getLogger('DataStreamer');

export interface UIA2ServerInfo {
  host: string;
  port: number;
  sessionId: string;
}

/**
 * Extracts UIA2 server connection details directly from the driver instance,
 * bypassing any driver command invocations.
 */
export function getUIA2ServerInfo(driver: any): UIA2ServerInfo {
  const jwproxy = driver.uiautomator2?.jwproxy;
  if (!jwproxy) {
    throw new Error(
      'Cannot access driver.uiautomator2.jwproxy — is this a UiAutomator2 session?'
    );
  }

  const sessionId = jwproxy.sessionId;
  if (!sessionId) {
    throw new Error('Device-side session ID not available on jwproxy');
  }

  return {
    host: jwproxy.server ?? '127.0.0.1',
    port: jwproxy.port ?? jwproxy.proxyPort,
    sessionId,
  };
}

/**
 * Finds an element by calling the UIA2 server's HTTP API directly,
 * skipping the Appium driver command chain entirely.
 *
 * POST http://{host}:{port}/session/{sessionId}/element
 * Body: {"strategy": using, "selector": value}
 */
export async function findElementDirect(
  serverInfo: UIA2ServerInfo,
  using: string,
  value: string,
): Promise<string> {
  const path = `/session/${serverInfo.sessionId}/element`;
  const body = JSON.stringify({ strategy: using, selector: value });

  log.info(`[data-streamer:direct] POST http://${serverInfo.host}:${serverInfo.port}${path}`);

  const result = await httpPost(serverInfo.host, serverInfo.port, path, body);

  // UIA2 server returns { sessionId, status, value: { ELEMENT: "..." } }
  const elementId =
    result?.value?.ELEMENT ??
    result?.value?.['element-6066-11e4-a52e-4f735466cecf'] ??
    result?.value?.element;

  if (!elementId) {
    throw new Error(
      `Could not extract elementId from UIA2 server response: ${JSON.stringify(result)}`
    );
  }

  log.info(`[data-streamer:direct] Resolved elementId: ${elementId}`);
  return elementId;
}

function httpPost(
  host: string,
  port: number,
  path: string,
  body: string,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: host,
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Invalid JSON from UIA2 server: ${raw}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('HTTP request to UIA2 server timed out'));
    });

    req.write(body);
    req.end();
  });
}
