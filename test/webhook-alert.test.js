/**
 * Tests del endpoint de alertas operativas POST /webhook/alert.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('./setup-env');
const express = require('express');
const config = require('../src/config');
const wa = require('../src/services/whatsapp');

config.app.webhookVerifyEvents = 'off';

let lastWhatsAppPayload = null;
let whatsappFails = false;
wa.client = {
  post: async (url, payload) => {
    if (whatsappFails) throw new Error('Meta caído');
    lastWhatsAppPayload = payload;
    return { data: { messages: [{ id: 'wamid.alert' }] } };
  },
};

const webhookRouter = require('../src/routes/webhook');
const SECRET = process.env.WEBHOOK_SECRET;

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/webhook', webhookRouter);
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

after(() => server.close());

async function postAlert(body, { token = SECRET } = {}) {
  const qs = token ? `?token=${token}` : '';
  const res = await fetch(`${baseUrl}/webhook/alert${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('exige el secreto del webhook', async () => {
  const r = await postAlert({ source: 'x', message: 'y' }, { token: null });
  assert.equal(r.status, 401);
});

test('envía la alerta por WhatsApp al administrador', async () => {
  const r = await postAlert({ source: 'plugin-prueba', message: 'Fallo detectado\ncon salto de línea' });
  assert.equal(r.status, 200);
  assert.equal(r.body.delivered, true);
  assert.equal(lastWhatsAppPayload.to, process.env.ADMIN_PHONE);
  const text = lastWhatsAppPayload.template.components[0].parameters[0].text;
  assert.equal(text, '[plugin-prueba] Fallo detectado con salto de línea'); // limpiado para WhatsApp
});

test('trunca fuentes y mensajes excesivamente largos', async () => {
  const r = await postAlert({ source: 'S'.repeat(200), message: 'M'.repeat(2000) });
  assert.equal(r.body.delivered, true);
  const text = lastWhatsAppPayload.template.components[0].parameters[0].text;
  assert.ok(text.length <= 2 + 60 + 1 + 500 + 1, `demasiado largo: ${text.length}`);
});

test('responde 200 con delivered=false si WhatsApp falla (best-effort, sin reintentos)', async () => {
  whatsappFails = true;
  const r = await postAlert({ source: 'x', message: 'y' });
  whatsappFails = false;
  assert.equal(r.status, 200);
  assert.equal(r.body.delivered, false);
});

test('sin ADMIN_PHONE la alerta queda solo en logs, con 200', async () => {
  const original = config.app.adminPhone;
  config.app.adminPhone = undefined;
  const r = await postAlert({ source: 'x', message: 'y' });
  config.app.adminPhone = original;
  assert.equal(r.status, 200);
  assert.equal(r.body.delivered, false);
});

test('tolera body vacío', async () => {
  const r = await postAlert({});
  assert.equal(r.status, 200);
});
