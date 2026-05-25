/**
 * Bridge legacy Vercel Node handlers (req, res) to Next.js App Router
 * Route Handlers (Web Request / Response).
 *
 * Root `/api/*.js` cannot coexist with `app/api/**` on Vercel — both try
 * to create `.vercel/output/functions/api` and the build fails with
 * EEXIST. Legacy handlers live under `lib/legacy-handlers/` and are
 * mounted from app/api route.js wrappers.
 */

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readRequestBody(request, { raw } = {}) {
  const text = await request.text();
  if (raw) return text;
  if (!text) return {};
  return tryParseJson(text);
}

function buildQuery(url) {
  const query = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return query;
}

function createMockResponse() {
  let statusCode = 200;
  const headers = {};
  let body = null;

  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    setHeader(key, value) {
      headers[key] = value;
      return res;
    },
    json(obj) {
      body = JSON.stringify(obj);
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      return res;
    },
    end(data) {
      body = data ?? '';
      return res;
    },
  };

  return {
    res,
    toWebResponse() {
      return new Response(body, { status: statusCode, headers });
    },
  };
}

function createMockRequest(request, body) {
  const url = new URL(request.url);
  const req = {
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    query: buildQuery(url),
    body,
    on(event, handler) {
      if (event === 'end' && typeof handler === 'function') {
        setImmediate(handler);
      }
    },
  };
  return req;
}

/**
 * @param {Function} legacyHandler - module.exports from lib/legacy-handlers/*
 * @param {{ methods?: string[], rawBody?: boolean }} [options]
 */
function toNextHandler(legacyHandler, options = {}) {
  const methods = options.methods || ['POST'];
  const rawBody = Boolean(options.rawBody);

  async function handle(request) {
    const body = await readRequestBody(request, { raw: rawBody });
    const req = createMockRequest(request, body);
    const { res, toWebResponse } = createMockResponse();
    await legacyHandler(req, res);
    return toWebResponse();
  }

  /** @type {Record<string, unknown>} */
  const routeExports = {
    dynamic: 'force-dynamic',
    runtime: 'nodejs',
  };

  for (const method of methods) {
    routeExports[method] = handle;
  }

  return routeExports;
}

module.exports = { toNextHandler };
