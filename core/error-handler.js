/**
 * ErrorHandler: framework-wide error normalization + capture.
 *
 * v2 rule: every cross-module boundary wraps with ErrorHandler (ANTI-PATTERNS D-3).
 * Entry shape: { ok, error, context, timestamp, cause, chain, value } — stable contract.
 * value = success payload (consumers read result.value directly; failures have value=undefined)
 */

const stamp = () => Date.now();

function norm(err) {
  if (err instanceof Error) {
    return { message: err.message, name: err.name, stack: err.stack, raw: err };
  }
  if (err === null || err === undefined) {
    return { message: 'unknown (null/undefined)', name: 'UnknownError', stack: '', raw: err };
  }
  if (typeof err === 'string') {
    return { message: err, name: 'StringError', stack: '', raw: err };
  }
  if (typeof err === 'object') {
    const message = err.message || JSON.stringify(err);
    return { message, name: err.name || 'ObjectError', stack: err.stack || '', raw: err };
  }
  return { message: String(err), name: 'UnknownError', stack: '', raw: err };
}

function entry({ ok, err, context, cause, chain, value }) {
  return { ok, error: err, context: context || {}, timestamp: stamp(), cause, chain, value };
}

function buildEntry(err, context) {
  const e = norm(err);
  let cause = null;
  const chain = [];
  if (err && typeof err === 'object' && err.cause) {
    cause = norm(err.cause);
    chain.push(e.message, cause.message);
    if (err.cause.cause) {
      chain.push(norm(err.cause.cause).message);
    }
  }
  return entry({
    ok: false,
    err: e,
    context,
    cause,
    chain: chain.length ? chain.join(' → ') : null,
    value: undefined,
  });
}

function okEntry(value, context) {
  return entry({ ok: true, err: null, context, cause: null, chain: null, value });
}

function failEntry(err, context) {
  // Last-resort safety: even our own normalization must not throw out.
  const message = `ErrorHandler internal failure: ${err?.message || err}`;
  const error = { message, name: 'InternalError', stack: '', raw: err };
  return entry({ ok: false, err: error, context, cause: null, chain: null, value: undefined });
}

export class ErrorHandler {
  /** Normalize an error into a structured entry. NEVER throws. No-args → ok:true no-op. */
  static handle(err, context) {
    try {
      if (err === undefined && context === undefined) {
        return okEntry(null, {});
      }
      return buildEntry(err, context);
    } catch (internalErr) {
      return failEntry(internalErr, context);
    }
  }

  /** Wrap a sync fn. Returns a fn that catches throws → structured entry. NEVER throws. */
  static wrap(fn) {
    if (typeof fn !== 'function') {
      return () => okEntry(undefined, {});
    }
    return (...args) => {
      try {
        return okEntry(fn(...args), {});
      } catch (err) {
        return buildEntry(err, {});
      }
    };
  }

  /** Wrap an async fn. Promise always resolves to structured entry — never rejects. */
  static wrapAsync(fn, context) {
    if (typeof fn !== 'function') {
      return async () => okEntry(undefined, context);
    }
    return async (...args) => {
      try {
        return okEntry(await fn(...args), context);
      } catch (err) {
        return buildEntry(err, context || {});
      }
    };
  }
}
