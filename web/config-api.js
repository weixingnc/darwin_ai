/**
 * web/config-api.js -- V43: HTTP handlers for /api/config/*.
 *
 * Exposes CRUD on providers + a "test connection" probe +
 * the active-provider pointer. Used by the web UI to manage
 * LLM provider configs without dropping to the CLI.
 *
 * Endpoints (all require bearer auth, V33):
 *   GET    /api/config/schema              -> { vendors: [...] }
 *   GET    /api/config/providers           -> { providers: [...] } (redacted)
 *   POST   /api/config/providers           -> { id, ... }  add or overwrite
 *   PUT    /api/config/providers/<id>      -> { id, ... }  update
 *   DELETE /api/config/providers/<id>      -> { deleted: bool }
 *   POST   /api/config/providers/<id>/test -> { ok, status, latencyMs, hint? }
 *   GET    /api/config/active              -> { provider, model } | null
 *   PUT    /api/config/active              -> { provider, model }
 *
 * Test connection: GETs {base_url}/models with the provider's
 * Authorization header. For OpenAI-compatible this is the standard
 * "list models" endpoint. For Anthropic we use /v1/models (added
 * in 2024-05). Both vendors return 200 with a list of models on
 * success; 401/403 means the key is wrong; 404 means the path is
 * wrong. We never echo the key back.
 *
 * Why fetch instead of shelling out to the existing providers:
 *   - keeps the test cheap (no plugin init, no config-resolver
 *     cache invalidation, no event-bus startup)
 *   - works for any base_url the user has configured, including
 *     self-hosted proxies and OpenRouter-style aggregators
 *
 * LLM gate (ADR-009): no LLM calls in this file. We never use a
 * provider to generate a reply here; the "test connection" is
 * an HTTP probe, not an LLM round-trip.
 */

import { ConfigManager, VENDOR_SCHEMA } from './config-manager.js';

// V43: build a fresh manager for each request. We do not memoize
// because the user can be editing the yaml on disk in another
// tab (or via the CLI) and we want each request to see the
// latest view.
//
// DARWIN_USER_DIR lets the caller point at a tmp dir for tests
// without touching the real ~/.darwin. When unset (the common
// case) the manager uses homedir() + '.darwin' as before.
function makeManager(options = {}) {
  if (!options.userDir && process.env.DARWIN_USER_DIR) {
    options = { ...options, userDir: process.env.DARWIN_USER_DIR };
  }
  return new ConfigManager(options);
}

// V43: send a uniform JSON response.
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Darwin-Token');
  res.end(JSON.stringify(body));
}

// V43: read a JSON body with a 4 KiB cap. Returns null on bad JSON.
async function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let size = 0;
    const MAX = 4 * 1024;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX) {
        req.destroy();
        resolve(null);
        return;
      }
      body += c.toString('utf8');
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

// V43: GET /api/config/schema
function handleGetSchema(_req, res) {
  sendJson(res, 200, { vendors: VENDOR_SCHEMA });
}

// V43: GET /api/config/providers
function handleListProviders(_req, res, manager) {
  sendJson(res, 200, { providers: manager.listProviders() });
}

// V43: POST /api/config/providers  (add or overwrite)
async function handleAddProvider(req, res, manager) {
  const body = await readJsonBody(req);
  if (!body || typeof body.id !== 'string' || typeof body.data !== 'object') {
    sendJson(res, 400, { error: 'expected { id: string, data: object, reveal?: boolean }' });
    return;
  }
  let result;
  try {
    result = manager.upsertProvider(body.id, body.data, { reveal: !!body.reveal });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
    return;
  }
  sendJson(res, 200, { ok: true, ...result });
}

// V43: PUT /api/config/providers/<id>
async function handleUpdateProvider(req, res, manager, id) {
  const body = await readJsonBody(req);
  if (!body || typeof body.data !== 'object') {
    sendJson(res, 400, { error: 'expected { data: object, reveal?: boolean }' });
    return;
  }
  let result;
  try {
    result = manager.upsertProvider(id, body.data, { reveal: !!body.reveal });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
    return;
  }
  sendJson(res, 200, { ok: true, ...result });
}

// V43: DELETE /api/config/providers/<id>
function handleDeleteProvider(_req, res, manager, id) {
  try {
    const r = manager.deleteProvider(id);
    if (!r.deleted) {
      sendJson(res, 404, { error: r.reason || 'not found' });
      return;
    }
    sendJson(res, 200, { ok: true, deleted: true });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
}

// V43: POST /api/config/providers/<id>/test
async function handleTestProvider(_req, res, manager, id) {
  const cfg = manager.getProvider(id, { reveal: true });
  if (!cfg) {
    sendJson(res, 404, { error: 'provider not configured' });
    return;
  }
  const baseUrl = String(cfg.base_url || '').replace(/\/+$/, '');
  const apiKey = String(cfg.api_key || '');
  if (!baseUrl) {
    sendJson(res, 400, { error: 'provider has no base_url' });
    return;
  }
  const probeUrl = baseUrl + '/models';
  const start = Date.now();
  let r;
  try {
    r = await fetch(probeUrl, {
      method: 'GET',
      headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
    });
  } catch (e) {
    sendJson(res, 200, {
      ok: false,
      status: 0,
      latencyMs: Date.now() - start,
      hint: 'cannot reach ' + probeUrl + ': ' + e.message,
    });
    return;
  }
  const latencyMs = Date.now() - start;
  // 200 = ok. 401/403 = bad key. 404 = wrong path. 5xx = upstream issue.
  const ok = r.status === 200;
  sendJson(res, 200, {
    ok,
    status: r.status,
    latencyMs,
    hint: ok
      ? 'list-models endpoint reachable'
      : r.status === 401 || r.status === 403
        ? 'auth rejected -- check api_key'
        : r.status === 404
          ? 'no /models endpoint at ' + baseUrl + ' -- try a different vendor'
          : 'upstream error',
  });
}

// V43: GET /api/config/active
function handleGetActive(_req, res, manager) {
  sendJson(res, 200, manager.getActive() || { provider: null, model: null });
}

// V43: PUT /api/config/active
async function handleSetActive(req, res, manager) {
  const body = await readJsonBody(req);
  if (!body || typeof body.provider !== 'string') {
    sendJson(res, 400, { error: 'expected { provider: string, model?: string }' });
    return;
  }
  let r;
  try {
    r = manager.setActive(body.provider, body.model || null);
  } catch (e) {
    sendJson(res, 400, { error: e.message });
    return;
  }
  sendJson(res, 200, { ok: true, ...r });
}

// V43: dispatch helpers -- one per top-level subpath. Extracted
// from a single big switch so the top-level dispatchConfigRoute
// stays under the complexity limit. Each helper returns true if
// it handled the request, false otherwise.
async function dispatchSchema(method, req, res) {
  if (method === 'GET') {
    handleGetSchema(req, res);
    return true;
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

async function dispatchActive(method, req, res, manager) {
  if (method === 'GET') {
    handleGetActive(req, res, manager);
    return true;
  }
  if (method === 'PUT') {
    await handleSetActive(req, res, manager);
    return true;
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

async function dispatchProvidersCollection(method, req, res, manager) {
  if (method === 'GET') {
    handleListProviders(req, res, manager);
    return true;
  }
  if (method === 'POST') {
    await handleAddProvider(req, res, manager);
    return true;
  }
  sendJson(res, 405, { error: 'method not allowed' });
  return true;
}

async function dispatchProviderItem(method, subPath, req, res, manager) {
  // subPath is /<id> or /<id>/test
  if (!subPath.startsWith('/') || subPath.length <= 1) {
    return false;
  }
  const rest = subPath.slice(1);
  const slash = rest.indexOf('/');
  if (slash === -1) {
    const id = rest;
    if (method === 'PUT') {
      await handleUpdateProvider(req, res, manager, id);
      return true;
    }
    if (method === 'DELETE') {
      handleDeleteProvider(req, res, manager, id);
      return true;
    }
    if (method === 'GET') {
      const cfg = manager.getProvider(id, { reveal: false });
      if (!cfg) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      sendJson(res, 200, { id, ...cfg });
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  }
  const id = rest.slice(0, slash);
  const tail = rest.slice(slash);
  if (tail === '/test' && method === 'POST') {
    await handleTestProvider(req, res, manager, id);
    return true;
  }
  sendJson(res, 404, { error: 'unknown subpath: ' + subPath });
  return true;
}

// V43: top-level dispatch. Kept small by delegating to the
// per-subpath helpers above. subPath is the path after /api/config.
async function dispatchConfigRoute(method, subPath, req, res) {
  const manager = (ConfigApi._managerFactory || makeManager)();
  if (subPath === '/schema') {
    return dispatchSchema(method, req, res);
  }
  if (subPath === '/active') {
    return dispatchActive(method, req, res, manager);
  }
  if (subPath === '/providers') {
    return dispatchProvidersCollection(method, req, res, manager);
  }
  // /providers/<id>[/test] -- the only remaining shape
  if (subPath.startsWith('/')) {
    return dispatchProviderItem(method, subPath, req, res, manager);
  }
  return false; // not a config route
}

const ConfigApi = {
  dispatchConfigRoute,
  // V43: tests can inject a stub manager factory so the handlers
  // operate on tmp dirs without touching the real ~/.darwin.
  _managerFactory: null,
  setManagerFactory(fn) {
    ConfigApi._managerFactory = fn;
  },
  resetManagerFactory() {
    ConfigApi._managerFactory = null;
  },
  // Exposed for unit tests that want to drive handlers directly.
  _internals: {
    handleGetSchema,
    handleListProviders,
    handleAddProvider,
    handleUpdateProvider,
    handleDeleteProvider,
    handleTestProvider,
    handleGetActive,
    handleSetActive,
    makeManager,
  },
};

export { ConfigApi, dispatchConfigRoute };
export default ConfigApi;
