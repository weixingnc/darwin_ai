/**
 * ErrorHandler unit tests — TDD red→green for PR 4.
 * Coverage: handle (sync + cause chain), wrap (sync), wrapAsync (async).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorHandler } from '../core/error-handler.js';

describe('ErrorHandler.handle basics', () => {
  test('handles plain Error with context', () => {
    const entry = ErrorHandler.handle(new Error('boom'), { module: 'foo', action: 'bar' });
    assert.equal(entry.ok, false);
    assert.equal(entry.error.message, 'boom');
    assert.equal(entry.context.module, 'foo');
    assert.equal(entry.context.action, 'bar');
    assert.equal(typeof entry.timestamp, 'number');
    assert.equal(entry.cause, null);
  });

  test('handles undefined/null/string/object err gracefully (no throw)', () => {
    for (const e of [undefined, null, 'just a string', { code: 'E_FOO' }]) {
      assert.doesNotThrow(() => ErrorHandler.handle(e, {}));
      const entry = ErrorHandler.handle(e, {});
      assert.equal(entry.ok, false);
    }
  });

  test('string err surfaces as message', () => {
    const entry = ErrorHandler.handle('just a string', {});
    assert.equal(entry.error.message, 'just a string');
  });

  test('context defaults to {} when omitted', () => {
    assert.deepEqual(ErrorHandler.handle(new Error('x')).context, {});
  });

  test('no-arg handle returns ok:true no-op', () => {
    assert.equal(ErrorHandler.handle().ok, true);
  });
});

describe('ErrorHandler cause chain', () => {
  test('preserves cause on Error', () => {
    const entry = ErrorHandler.handle(new Error('top', { cause: new Error('root') }), {});
    assert.equal(entry.error.message, 'top');
    assert.ok(entry.cause, 'cause must be present');
    assert.equal(entry.cause.message, 'root');
  });

  test('chain flattened into "top → mid → root" string', () => {
    const root = new Error('root-cause');
    const mid = new Error('mid-layer', { cause: root });
    const top = new Error('top-level', { cause: mid });
    const entry = ErrorHandler.handle(top, {});
    assert.equal(typeof entry.chain, 'string');
    assert.match(entry.chain, /top-level.*mid-layer.*root-cause/);
  });

  test('chain is null when no cause', () => {
    assert.equal(ErrorHandler.handle(new Error('lonely'), {}).chain, null);
  });
});

describe('ErrorHandler.wrap (sync)', () => {
  test('success: returns { ok:true, value }', () => {
    const result = ErrorHandler.wrap(() => 42)();
    assert.equal(result.ok, true);
    assert.equal(result.value, 42);
  });

  test('Error throw: catches + returns entry, no rethrow', () => {
    const wrapped = ErrorHandler.wrap(() => {
      throw new Error('sync-boom');
    });
    assert.doesNotThrow(() => wrapped());
    const result = wrapped();
    assert.equal(result.ok, false);
    assert.equal(result.error.message, 'sync-boom');
  });

  test('non-Error throw: catches + returns entry, no rethrow', () => {
    const result = ErrorHandler.wrap(() => {
      throw 'string-throw';
    })();
    assert.equal(result.ok, false);
    assert.equal(result.error.message, 'string-throw');
  });

  test('non-function input: does not throw (no-op pass-through)', () => {
    assert.doesNotThrow(() => ErrorHandler.wrap(null));
    assert.doesNotThrow(() => ErrorHandler.wrap(undefined));
  });
});

describe('ErrorHandler.wrapAsync (async)', () => {
  test('resolve: returns { ok:true, value }', async () => {
    const result = await ErrorHandler.wrapAsync(async () => 'done')();
    assert.equal(result.ok, true);
    assert.equal(result.value, 'done');
  });

  test('Error reject: catches + returns entry, never rejects', async () => {
    const wrapped = ErrorHandler.wrapAsync(async () => {
      throw new Error('async-boom');
    });
    const result = await wrapped();
    assert.equal(result.ok, false);
    assert.equal(result.error.message, 'async-boom');
  });

  test('non-Error reject: catches + returns entry', async () => {
    // eslint-disable-next-line no-throw-literal
    const wrapped = ErrorHandler.wrapAsync(async () => {
      throw { code: 'E_NOPE' };
    });
    const result = await wrapped();
    assert.equal(result.ok, false);
  });

  test('context passes through to entry', async () => {
    const wrapped = ErrorHandler.wrapAsync(
      async () => {
        throw new Error('x');
      },
      { module: 'm', action: 'a' },
    );
    const result = await wrapped();
    assert.equal(result.context.module, 'm');
    assert.equal(result.context.action, 'a');
  });
});

describe('ErrorHandler structural entry', () => {
  test('entry has stable shape: ok/error/context/timestamp/cause/chain/value', () => {
    const entry = ErrorHandler.handle(new Error('x', { cause: new Error('y') }), { k: 'v' });
    assert.deepEqual(Object.keys(entry).sort(), [
      'cause',
      'chain',
      'context',
      'error',
      'ok',
      'timestamp',
      'value',
    ]);
  });

  test('timestamp is a finite number', () => {
    const t = ErrorHandler.handle(new Error('x')).timestamp;
    assert.equal(typeof t, 'number');
    assert.ok(Number.isFinite(t) && t > 0);
  });
});
