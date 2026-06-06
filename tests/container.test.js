/**
 * Container (DI) unit tests — TDD red→green for PR 4.
 *
 * Coverage targets:
 * - register / get / has / clear / size
 * - factory is lazy (not invoked on register)
 * - factory called once + cached (singleton per container)
 * - same name re-register throws
 * - get of unknown name throws with available names list
 * - child container inherits parent registrations
 * - child override does not affect parent
 * - boundary: null factory / non-function factory / non-string name
 * - boundary: circular dep surfaces as Error (factory's responsibility)
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Container } from '../core/container.js';

describe('Container basics', () => {
  let c;

  beforeEach(() => {
    c = new Container();
  });

  test('register + get returns factory result', () => {
    c.register('foo', () => 42);
    assert.equal(c.get('foo'), 42);
  });

  test('factory is lazy: not invoked on register', () => {
    let called = 0;
    c.register('lazy', () => {
      called++;
      return 'x';
    });
    assert.equal(called, 0, 'factory must not run on register');
    c.get('lazy');
    assert.equal(called, 1, 'factory runs on first get');
  });

  test('factory result is cached: get twice → factory called once', () => {
    let called = 0;
    c.register('singleton', () => {
      called++;
      return { id: called };
    });
    const a = c.get('singleton');
    const b = c.get('singleton');
    assert.equal(called, 1);
    assert.equal(a, b, 'same instance returned');
  });

  test('has returns true for registered, false for unknown', () => {
    c.register('present', () => 1);
    assert.equal(c.has('present'), true);
    assert.equal(c.has('absent'), false);
  });

  test('size returns registration count', () => {
    assert.equal(c.size(), 0);
    c.register('a', () => 1);
    c.register('b', () => 2);
    assert.equal(c.size(), 2);
  });

  test('clear removes all registrations', () => {
    c.register('a', () => 1);
    c.register('b', () => 2);
    c.clear();
    assert.equal(c.size(), 0);
    assert.equal(c.has('a'), false);
  });
});

describe('Container error handling', () => {
  let c;

  beforeEach(() => {
    c = new Container();
  });

  test('register duplicate name throws', () => {
    c.register('dup', () => 1);
    assert.throws(() => c.register('dup', () => 2), /already registered.*dup/);
  });

  test('get of unknown name throws with available list', () => {
    c.register('alpha', () => 1);
    c.register('beta', () => 2);
    assert.throws(() => c.get('gamma'), /gamma.*available.*alpha.*beta/);
  });

  test('get of unknown name on empty container lists none', () => {
    assert.throws(() => c.get('missing'), /missing.*available.*none/);
  });

  test('register with non-string name throws', () => {
    assert.throws(() => c.register(null, () => 1), /name must be non-empty string/);
    assert.throws(() => c.register('', () => 1), /name must be non-empty string/);
    assert.throws(() => c.register(42, () => 1), /name must be non-empty string/);
  });

  test('register with non-function factory throws', () => {
    assert.throws(() => c.register('x', null), /factory must be function/);
    assert.throws(() => c.register('x', 'not-fn'), /factory must be function/);
    assert.throws(() => c.register('x', 42), /factory must be function/);
  });

  test('factory that throws surfaces error to caller', () => {
    c.register('boom', () => {
      throw new Error('factory exploded');
    });
    assert.throws(() => c.get('boom'), /factory exploded/);
  });
});

describe('Container child containers', () => {
  test('child inherits parent registrations', () => {
    const parent = new Container();
    parent.register('shared', () => 'from-parent');
    const child = parent.createChild();
    assert.equal(child.get('shared'), 'from-parent');
    assert.equal(child.has('shared'), true);
  });

  test('child can register its own without affecting parent', () => {
    const parent = new Container();
    parent.register('shared', () => 'parent-val');
    const child = parent.createChild();
    child.register('only-child', () => 'child-val');
    assert.equal(parent.has('only-child'), false, 'parent must not see child-only');
    assert.equal(child.has('only-child'), true);
  });

  test('child override of parent name wins locally (no parent mutation)', () => {
    const parent = new Container();
    parent.register('cfg', () => 'parent-cfg');
    const child = parent.createChild();
    child.register('cfg', () => 'child-cfg');
    assert.equal(child.get('cfg'), 'child-cfg');
    assert.equal(parent.get('cfg'), 'parent-cfg', 'parent unchanged');
  });

  test('child.size includes parent registrations (logical view)', () => {
    const parent = new Container();
    parent.register('a', () => 1);
    parent.register('b', () => 2);
    const child = parent.createChild();
    child.register('c', () => 3);
    assert.equal(child.size(), 3, 'child size = parent 2 + child 1');
    assert.equal(parent.size(), 2, 'parent size unchanged');
  });

  test('child get of unknown still throws with merged available list', () => {
    const parent = new Container();
    parent.register('p1', () => 1);
    const child = parent.createChild();
    child.register('c1', () => 2);
    assert.throws(() => child.get('nope'), /nope.*available.*p1.*c1/);
  });

  test('child container is a Container instance', () => {
    const parent = new Container();
    const child = parent.createChild();
    assert.ok(child instanceof Container);
  });

  test('factory invoked in child context still works', () => {
    const parent = new Container();
    let counter = 0;
    parent.register('counter', () => ++counter);
    const child = parent.createChild();
    assert.equal(child.get('counter'), 1);
    assert.equal(parent.get('counter'), 1, 'same factory, parent also cached it');
  });
});
