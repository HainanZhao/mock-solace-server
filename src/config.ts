export interface CredentialCheck {
  username?: string;
  password?: string;
  vpnName: string;
  clientName: string;
}

export interface MockSolaceServerOptions {
  /** WebSocket (SMF) listen port. Default 0 = ephemeral. Solace's default is 8008. */
  smfWsPort?: number;
  /** SEMP v2 HTTP listen port. Default 0 = ephemeral; false disables SEMP. */
  sempPort?: number | false;
  /** Bind host. Default '127.0.0.1'. */
  host?: string;
  /** Message VPNs that exist at startup. Default ['default']. */
  vpns?: string[];
  /** Create VPNs on first login instead of rejecting. Default true. */
  autoCreateVpns?: boolean;
  /**
   * Optional credential validator. Return true to accept; false or a
   * {code, text} object to reject the login.
   */
  validateCredentials?: (creds: CredentialCheck) => boolean | { code: number; text: string };
  /** Keepalive interval advertised to clients, seconds. Default 3. */
  keepAliveIntervalSec?: number;
  /**
   * Disconnect clients that send nothing for this long. Default 0 = disabled
   * (avoids flakes when test processes pause on breakpoints).
   */
  clientLivenessTimeoutMs?: number;
  /** Per-subscriber send buffer ceiling; direct messages drop beyond it. */
  maxBufferedBytes?: number;
  /** Capture published messages for inspection. Default true. */
  captureMessages?: boolean;
  /** Ring buffer size for captured messages. Default 1000. */
  maxCapturedMessages?: number;
  /** Router name reported to clients. Default 'mock-solace'. */
  routerName?: string;
}

export interface ResolvedOptions {
  smfWsPort: number;
  sempPort: number | false;
  host: string;
  vpns: string[];
  autoCreateVpns: boolean;
  validateCredentials?: (creds: CredentialCheck) => boolean | { code: number; text: string };
  keepAliveIntervalSec: number;
  clientLivenessTimeoutMs: number;
  maxBufferedBytes: number;
  captureMessages: boolean;
  maxCapturedMessages: number;
  routerName: string;
}

export function resolveOptions(opts: MockSolaceServerOptions = {}): ResolvedOptions {
  return {
    smfWsPort: opts.smfWsPort ?? 0,
    sempPort: opts.sempPort ?? 0,
    host: opts.host ?? '127.0.0.1',
    vpns: opts.vpns ?? ['default'],
    autoCreateVpns: opts.autoCreateVpns ?? true,
    validateCredentials: opts.validateCredentials,
    keepAliveIntervalSec: opts.keepAliveIntervalSec ?? 3,
    clientLivenessTimeoutMs: opts.clientLivenessTimeoutMs ?? 0,
    maxBufferedBytes: opts.maxBufferedBytes ?? 8 * 1024 * 1024,
    captureMessages: opts.captureMessages ?? true,
    maxCapturedMessages: opts.maxCapturedMessages ?? 1000,
    routerName: opts.routerName ?? 'mock-solace',
  };
}
