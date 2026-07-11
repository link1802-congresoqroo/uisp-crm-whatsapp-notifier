const { test } = require('node:test');
const assert = require('node:assert/strict');

const { maskPhone } = require('../src/utils/mask');
const { RecentKeys } = require('../src/utils/recent-keys');

test('maskPhone enmascara dejando solo 4 dígitos visibles', () => {
  assert.equal(maskPhone('5219981234567'), '5219***');
  assert.equal(maskPhone(5219981234567), '5219***');
});

test('maskPhone tolera valores vacíos', () => {
  assert.equal(maskPhone(null), '(sin teléfono)');
  assert.equal(maskPhone(''), '(sin teléfono)');
  assert.equal(maskPhone(undefined), '(sin teléfono)');
});

test('RecentKeys recuerda claves dentro del TTL', () => {
  const rk = new RecentKeys({ ttlMs: 60_000, maxSize: 10 });
  rk.add(1000);
  assert.equal(rk.has(1000), true);
  assert.equal(rk.has(9999), false);
});

test('RecentKeys expira claves al vencer el TTL', async () => {
  const rk = new RecentKeys({ ttlMs: 50, maxSize: 10 });
  rk.add('a');
  assert.equal(rk.has('a'), true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(rk.has('a'), false);
});

test('RecentKeys expulsa la clave más antigua al llenarse', () => {
  const rk = new RecentKeys({ ttlMs: 60_000, maxSize: 2 });
  rk.add('x');
  rk.add('y');
  rk.add('z'); // maxSize 2: 'x' debe salir
  assert.equal(rk.has('x'), false);
  assert.equal(rk.has('y'), true);
  assert.equal(rk.has('z'), true);
});
