const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { mockRes } = require('./setup-env');
const config = require('../src/config');
const svc = require('../src/services/uisp-api');
const { verifyWebhookSecret, verifyWebhookEvent } = require('../src/middleware/webhook-auth');

const SECRET = process.env.WEBHOOK_SECRET;
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

const error404 = () => {
  const e = new Error('404');
  e.response = { status: 404 };
  return e;
};

function runSecret(req) {
  const res = mockRes();
  let passed = false;
  verifyWebhookSecret({ query: {}, headers: {}, ip: '1.2.3.4', path: '/uisp', ...req }, res, () => { passed = true; });
  return { res, passed };
}

async function runEvent(body) {
  const res = mockRes();
  let passed = false;
  await verifyWebhookEvent({ body, ip: '1.2.3.4' }, res, () => { passed = true; });
  return { res, passed };
}

beforeEach(() => {
  config.app.webhookVerifyEvents = 'log';
});

// ---------- Capa A: secreto compartido ----------

test('rechaza sin token', () => {
  const { res, passed } = runSecret({});
  assert.equal(res.statusCode, 401);
  assert.equal(passed, false);
});

test('rechaza token incorrecto', () => {
  const { res, passed } = runSecret({ query: { token: 'incorrecto' } });
  assert.equal(res.statusCode, 401);
  assert.equal(passed, false);
});

test('rechaza token de longitud distinta sin lanzar excepción', () => {
  const { res } = runSecret({ query: { token: 'x' } });
  assert.equal(res.statusCode, 401);
});

test('acepta token correcto por query param', () => {
  const { passed } = runSecret({ query: { token: SECRET } });
  assert.equal(passed, true);
});

test('acepta token correcto por header X-Webhook-Secret', () => {
  const { passed } = runSecret({ headers: { 'x-webhook-secret': SECRET } });
  assert.equal(passed, true);
});

test('la respuesta 401 no revela detalles', () => {
  const { res } = runSecret({ query: { token: 'malo' } });
  assert.deepEqual(res.body, { success: false, message: 'No autorizado' });
});

// ---------- Capa B: verificación del evento contra UISP ----------

test('modo off no consulta la API y deja pasar', async () => {
  config.app.webhookVerifyEvents = 'off';
  svc.client = { get: async () => { throw new Error('NO DEBE LLAMARSE'); } };
  const { passed } = await runEvent({});
  assert.equal(passed, true);
});

test('evento existente y coincidente pasa', async () => {
  svc.client = { get: async () => ({ data: { uuid: VALID_UUID, entity: 'invoice', entityId: 1000 } }) };
  const { passed } = await runEvent({ uuid: VALID_UUID, entity: 'invoice', entityId: '1000' });
  assert.equal(passed, true);
});

test('modo log deja pasar evento desconocido (caso del plugin)', async () => {
  svc.client = { get: async () => { throw error404(); } };
  const { passed } = await runEvent({ uuid: VALID_UUID, entity: 'invoice', entityId: '1' });
  assert.equal(passed, true);
});

test('modo enforce rechaza evento que UISP no conoce', async () => {
  config.app.webhookVerifyEvents = 'enforce';
  svc.client = { get: async () => { throw error404(); } };
  const { res, passed } = await runEvent({ uuid: VALID_UUID, entity: 'invoice', entityId: '1' });
  assert.equal(res.statusCode, 401);
  assert.equal(passed, false);
});

test('modo enforce rechaza si entity/entityId no coinciden', async () => {
  config.app.webhookVerifyEvents = 'enforce';
  svc.client = { get: async () => ({ data: { uuid: VALID_UUID, entity: 'payment', entityId: 999 } }) };
  const { res, passed } = await runEvent({ uuid: VALID_UUID, entity: 'invoice', entityId: '1000' });
  assert.equal(res.statusCode, 401);
  assert.equal(passed, false);
});

test('modo enforce rechaza uuid malformado SIN consultar la API', async () => {
  // UISP responde 500 (no 404) ante uuids malformados; sin el check de formato,
  // un uuid inválido a propósito activaría el fail-open de "API no disponible"
  config.app.webhookVerifyEvents = 'enforce';
  svc.client = { get: async () => { throw new Error('NO DEBE LLAMARSE'); } };
  const { res, passed } = await runEvent({ uuid: 'prueba-manual-001', entity: 'invoice', entityId: '1' });
  assert.equal(res.statusCode, 401);
  assert.equal(passed, false);
});

test('modo log deja pasar uuid malformado con advertencia', async () => {
  svc.client = { get: async () => { throw new Error('NO DEBE LLAMARSE'); } };
  const { passed } = await runEvent({ uuid: 'no-es-uuid', entity: 'invoice', entityId: '1' });
  assert.equal(passed, true);
});

test('API caída no bloquea el flujo (fail-open) ni siquiera en enforce', async () => {
  config.app.webhookVerifyEvents = 'enforce';
  svc.client = { get: async () => { throw new Error('ECONNREFUSED'); } };
  const { passed } = await runEvent({ uuid: VALID_UUID, entity: 'invoice', entityId: '1000' });
  assert.equal(passed, true);
});
