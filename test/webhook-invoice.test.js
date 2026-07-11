/**
 * Test de integración del webhook de facturas: monta el router real sobre
 * Express con los servicios de UISP/WhatsApp simulados, y verifica el flujo
 * completo — autenticación, validación del token de pago e idempotencia.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('./setup-env');
const express = require('express');
const config = require('../src/config');
const svc = require('../src/services/uisp-api');
const wa = require('../src/services/whatsapp');

// La capa B (verificación de eventos) se prueba a fondo en webhook-auth.test.js;
// aquí se apaga para que el mock no tenga que simular /webhook-events
config.app.webhookVerifyEvents = 'off';

const GOOD_UUID = '550e8400-e29b-41d4-a716-446655440000';
const SECRET = process.env.WEBHOOK_SECRET;

// --- Mock de UISP: PDF con el uuid, payment-token del invoice consultado, cliente con teléfono ---
let uispDown = false;
let lastPdfInvoiceId = null;
svc.client = {
  get: async (url) => {
    if (uispDown) {
      const e = new Error('500');
      e.response = { status: 500, data: {} };
      throw e;
    }
    const pdfMatch = url.match(/\/invoices\/(\d+)\/pdf/);
    if (pdfMatch) {
      lastPdfInvoiceId = Number(pdfMatch[1]);
      return { data: Buffer.from(`pdf ${GOOD_UUID} fin`) };
    }
    if (url.startsWith('/payment-tokens/')) {
      return { data: { token: GOOD_UUID, clientId: 10, invoiceId: lastPdfInvoiceId } };
    }
    if (url.startsWith('/clients/')) {
      return { data: { contacts: [{ phone: '5219981234567', isBilling: true }] } };
    }
    throw new Error('URL inesperada: ' + url);
  },
};

// --- Mock de WhatsApp: cuenta envíos ---
let whatsappsSent = 0;
wa.client = {
  post: async () => {
    whatsappsSent++;
    return { data: { messages: [{ id: 'wamid.test' }] } };
  },
};

const webhookRouter = require('../src/routes/webhook');

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

function invoicePayload(id) {
  return {
    uuid: GOOD_UUID,
    changeType: 'insert',
    entity: 'invoice',
    entityId: String(id),
    eventName: 'invoice.add',
    extraData: {
      entity: {
        id,
        clientId: 10,
        number: 'N' + id,
        total: 300,
        clientFirstName: 'Test',
        dueDate: '2026-07-12',
        items: [{ label: 'Internet' }],
      },
    },
  };
}

async function postInvoice(id, { token = SECRET } = {}) {
  const qs = token ? `?token=${token}` : '';
  const res = await fetch(`${baseUrl}/webhook/uisp${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(invoicePayload(id)),
  });
  return { status: res.status, body: await res.json() };
}

test('rechaza el webhook sin token con 401', async () => {
  const r = await postInvoice(1000, { token: null });
  assert.equal(r.status, 401);
});

test('el primer webhook de una factura envía WhatsApp', async () => {
  const r = await postInvoice(1000);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.whatsappSent, true);
  assert.equal(r.body.data.phone, '5219***'); // PII enmascarada en la respuesta
  assert.equal(whatsappsSent, 1);
});

test('el webhook duplicado (plugin o reintento) se descarta sin enviar', async () => {
  const r1 = await postInvoice(1000);
  assert.equal(r1.body.message, 'Duplicado ignorado');
  const r2 = await postInvoice(1000);
  assert.equal(r2.body.message, 'Duplicado ignorado');
  assert.equal(whatsappsSent, 1); // sigue en 1
});

test('una factura distinta sí se envía', async () => {
  const r = await postInvoice(1001);
  assert.equal(r.body.data.whatsappSent, true);
  assert.equal(whatsappsSent, 2);
});

test('un fallo de UISP no marca la factura: el reintento posterior envía', async () => {
  uispDown = true;
  const fail = await postInvoice(1002);
  assert.equal(fail.status, 500);

  uispDown = false;
  const retry = await postInvoice(1002);
  assert.equal(retry.body.data.whatsappSent, true);
  assert.equal(whatsappsSent, 3);
});

test('eventos de otra entidad se ignoran con 200', async () => {
  const res = await fetch(`${baseUrl}/webhook/uisp?token=${SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid: GOOD_UUID, entity: 'payment', entityId: '5' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.message, 'Webhook ignorado');
});

test('payload inválido responde 400', async () => {
  const res = await fetch(`${baseUrl}/webhook/uisp?token=${SECRET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hola: 'mundo' }),
  });
  assert.equal(res.status, 400);
});

test('los errores no exponen detalles internos', async () => {
  uispDown = true;
  const r = await postInvoice(1003);
  uispDown = false;
  assert.equal(r.status, 500);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes('500 '), 'no debe incluir mensajes de axios');
  assert.ok(!text.includes('uisp.test'), 'no debe incluir URLs internas');
});
