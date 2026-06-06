/**
 * FeishuAdapter: Feishu (Lark) channel adapter — Darwin's "continuous-run" carrier.
 *
 * v2 design (PR 12b): plain-object factory, IAdapter-shaped. init() pulls config
 * via ConfigResolver (A-4: NEVER process.env). start() opens a Node http server
 * for the Feishu webhook: url_verification → echo challenge; event.message →
 * verify (mocked) → emit ADAPTER_FEISHU_MESSAGE_IN. Subscribes to
 * ADAPTER_FEISHU_MESSAGE_OUT → sendTextMessage via fetch (mocked in tests);
 * fetch failure → emit ADAPTER_FEISHU_ERROR, never throw. stop()/destroy()
 * are idempotent; destroy() removes bus subscriptions.
 *
 * Mocked here (Darwin self-evolves the real impl later): Feishu open-api
 * message send (real endpoint / token exchange), signature verification, event
 * encryption. v1 lesson (A-3): keep one IAdapter shape; same shape for
 * slack/discord/webhook later. Hygiene: no real app_id / app_secret / token.
 */
import { createServer } from 'node:http';
import { ErrorHandler } from '../core/error-handler.js';
import { EVENTS } from '../core/events.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const DEFAULT_PATH = '/webhook/feishu';
const DEFAULT_WEBHOOK_URL = `http://${DEFAULT_HOST}:${DEFAULT_PORT}${DEFAULT_PATH}`;
const FEISHU_SEND_MSG_PATH = '/open-apis/im/v1/messages';

/** Parse a webhook URL into {host, port, path}. Defensive — never throws. */
function parseWebhookUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT, path: DEFAULT_PATH };
  }
  const m = url.match(/^https?:\/\/([^:/]+)(?::(\d+))?(\/.*)?$/);
  if (!m) {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT, path: DEFAULT_PATH };
  }
  return {
    host: m[1] || DEFAULT_HOST,
    port: m[2] ? parseInt(m[2], 10) : DEFAULT_PORT,
    path: m[3] || DEFAULT_PATH,
  };
}

/** Read a JSON body from an http.IncomingMessage. Resolves with parsed value or null. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
    req.on('aborted', () => resolve(null));
  });
}

/** Mock signature verification. Real impl lives in Darwin. */
function verifySignature(_token, _body) {
  return true;
}

/** FeishuAdapter factory. Returns a fresh IAdapter-shaped plain object. */
export function FeishuAdapter() {
  const a = {
    name: 'feishu',
    version: '1.0.0',
    capabilities: ['message:in', 'message:out', 'webhook', 'event'],
    _bus: null,
    _config: null,
    _server: null,
    _subs: [],
    _resolvedConfig: null,

    /**
     * Init: pull config from ConfigResolver, subscribe to bus outbound events.
     * @param {object} ctx - { eventBus, config (ConfigResolver instance) }
     */
    init(ctx) {
      return ErrorHandler.wrap(() => {
        if (!ctx || !ctx.eventBus || !ctx.config) {
          throw new TypeError('[FeishuAdapter] init: ctx.eventBus and ctx.config are required');
        }
        this._bus = ctx.eventBus;
        this._config = ctx.config;
        // A-4: ALL config goes through ConfigResolver. Never read process.env directly.
        this._resolvedConfig = ctx.config.get('adapter-feishu');
        // Keep a reference to the EXACT handler so destroy() can off it.
        // (EventBus.on returns `this` for sync handlers, so we can't rely on its return.)
        const handler = (payload) => {
          this.sendTextMessage(payload?.text, payload?.userId).then((r) => {
            if (r && r.ok === false) {
              ctx.eventBus.emit(EVENTS.ADAPTER_FEISHU_ERROR, {
                message: r.error?.message || 'send failed',
                context: 'adapter.feishu.sendTextMessage',
              });
            }
          });
        };
        ctx.eventBus.on(EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, handler);
        this._subs.push({ event: EVENTS.ADAPTER_FEISHU_MESSAGE_OUT, handler });
      })();
    },

    /**
     * Start: open http server on the configured webhook URL. Idempotent.
     * Returns a Promise that resolves once the server is listening.
     */
    async start() {
      return ErrorHandler.wrapAsync(
        async () => {
          if (this._server) {
            return;
          }
          const cfg = this._resolvedConfig || {};
          const portOverride = Number.isFinite(cfg.webhookPort) ? cfg.webhookPort : null;
          const parsed = parseWebhookUrl(cfg.webhook_url || DEFAULT_WEBHOOK_URL);
          const port = portOverride !== null ? portOverride : parsed.port;
          const srv = createServer((req, res) => this._handleRequest(req, res));
          await new Promise((resolve, reject) => {
            srv.once('error', reject);
            srv.listen(port, parsed.host, () => {
              srv.off('error', reject);
              resolve();
            });
          });
          this._server = srv;
        },
        { context: 'adapter.feishu.start' },
      )();
    },

    /** Stop: close the http server. Idempotent. */
    async stop() {
      return ErrorHandler.wrapAsync(
        async () => {
          if (!this._server) {
            return;
          }
          const srv = this._server;
          this._server = null;
          await new Promise((resolve) => {
            srv.close(() => resolve());
            if (typeof srv.closeAllConnections === 'function') {
              srv.closeAllConnections();
            }
          });
        },
        { context: 'adapter.feishu.stop' },
      )();
    },

    /** Destroy: unsubscribe all bus listeners. Idempotent. */
    async destroy() {
      return ErrorHandler.wrapAsync(
        async () => {
          if (this._bus) {
            for (const { event, handler } of this._subs) {
              this._bus.off(event, handler);
            }
          }
          this._subs = [];
        },
        { context: 'adapter.feishu.destroy' },
      )();
    },

    /** handleEvent: forward bus events to sendTextMessage. */
    handleEvent(event) {
      return ErrorHandler.wrap(() => {
        if (event && event.text && event.userId) {
          return this.sendTextMessage(event.text, event.userId);
        }
        return undefined;
      })();
    },

    /**
     * Send a text message to a Feishu user. Uses globalThis.fetch (tests spy on it).
     * Returns a Promise<entry> where entry.ok === false on failure.
     * @param {string} text
     * @param {string} userId
     */
    sendTextMessage(text, userId) {
      return ErrorHandler.wrapAsync(
        async () => {
          if (typeof text !== 'string' || typeof userId !== 'string' || userId.length === 0) {
            throw new TypeError('[FeishuAdapter] sendTextMessage: text and userId are required');
          }
          // Real impl: POST to FEISHU_SEND_MSG_PATH with a tenant_access_token.
          // Darwin self-evolves the token-exchange + retry policy later.
          const body = { receive_id: userId, msg_type: 'text', content: JSON.stringify({ text }) };
          const res = await globalThis.fetch(`https://open.feishu.cn${FEISHU_SEND_MSG_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            throw new Error(`[FeishuAdapter] send failed: HTTP ${res.status}`);
          }
          return { ok: true };
        },
        { context: 'adapter.feishu.sendTextMessage' },
      )();
    },

    // ─── private ─────────────────────────────────────
    _handleUrlVerification(body, res) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Connection', 'close');
      res.end(body.challenge);
    },
    _handleEventMessage(body, res) {
      const token = body.token || '';
      if (!verifySignature(token, body)) {
        res.statusCode = 401;
        res.setHeader('Connection', 'close');
        res.end();
        return;
      }
      const m = body.event.message || {};
      const s = body.event.sender || {};
      const user =
        s.sender_id?.open_id || s.sender_id?.user_id || s.sender_id?.union_id || 'unknown';
      this._bus?.emit(EVENTS.ADAPTER_FEISHU_MESSAGE_IN, {
        user,
        text: m.content?.text || '',
        messageId: m.message_id || '',
      });
      res.statusCode = 200;
      res.setHeader('Connection', 'close');
      res.end();
    },
    _acceptOk(res) {
      res.statusCode = 200;
      res.setHeader('Connection', 'close');
      res.end();
    },
    async _handleRequest(req, res) {
      if (req.method !== 'POST') {
        res.statusCode = 405;
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      if (body && body.type === 'url_verification' && typeof body.challenge === 'string') {
        return this._handleUrlVerification(body, res);
      }
      if (body && body.type === 'event' && body.event && body.event.type === 'message') {
        return this._handleEventMessage(body, res);
      }
      return this._acceptOk(res);
    },
  };
  return a;
}
