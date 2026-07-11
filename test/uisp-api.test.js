const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

require('./setup-env');
const svc = require('../src/services/uisp-api');

const GOOD_UUID = '550e8400-e29b-41d4-a716-446655440000';
const BAD_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const FAKE_PDF = Buffer.from(`%PDF basura ${BAD_UUID} más basura ${GOOD_UUID} fin`);

const error404 = () => {
  const e = new Error('Request failed with status code 404');
  e.response = { status: 404 };
  return e;
};

beforeEach(() => {
  svc.paymentUrlCache.clear();
});

// ---------- extractPhoneNumber ----------

test('extractPhoneNumber prefiere el contacto de facturación (isBilling)', () => {
  const client = { contacts: [{ phone: '111' }, { phone: '222', isBilling: true }] };
  assert.equal(svc.extractPhoneNumber(client), '222');
});

test('extractPhoneNumber cae a cualquier contacto si el de facturación no tiene teléfono', () => {
  const client = { contacts: [{ phone: '111' }, { isBilling: true }] };
  assert.equal(svc.extractPhoneNumber(client), '111');
});

test('extractPhoneNumber cae a phone/mobile directos y recorta espacios', () => {
  assert.equal(svc.extractPhoneNumber({ contacts: [], mobile: ' 333 ' }), '333');
  assert.equal(svc.extractPhoneNumber({ phone: '444' }), '444');
});

test('extractPhoneNumber devuelve null sin datos', () => {
  assert.equal(svc.extractPhoneNumber(null), null);
  assert.equal(svc.extractPhoneNumber({}), null);
  assert.equal(svc.extractPhoneNumber({ contacts: [{}] }), null);
});

// ---------- getInvoicePaymentUrl ----------

test('getInvoicePaymentUrl valida candidatos y elige el token correcto (no el primero)', async () => {
  svc.client = {
    get: async (url) => {
      if (url.includes('/pdf')) return { data: FAKE_PDF };
      if (url === `/payment-tokens/${BAD_UUID}`) throw error404();
      if (url === `/payment-tokens/${GOOD_UUID}`) {
        return { data: { token: GOOD_UUID, clientId: 10, invoiceId: 1000 } };
      }
      throw new Error('URL inesperada: ' + url);
    },
  };

  const url = await svc.getInvoicePaymentUrl(1000);
  assert.equal(url, `https://uisp.test/crm/online-payment/pay/${GOOD_UUID}`);
});

test('getInvoicePaymentUrl usa cache en la segunda llamada (no toca la API)', async () => {
  svc.client = {
    get: async (url) => {
      if (url.includes('/pdf')) return { data: FAKE_PDF };
      if (url === `/payment-tokens/${BAD_UUID}`) throw error404();
      return { data: { token: GOOD_UUID, clientId: 10, invoiceId: 1000 } };
    },
  };
  const first = await svc.getInvoicePaymentUrl(1000);

  svc.client = { get: async () => { throw new Error('NO DEBE LLAMARSE'); } };
  const cached = await svc.getInvoicePaymentUrl(1000);
  assert.equal(cached, first);
});

test('getInvoicePaymentUrl devuelve null si ningún candidato corresponde a la factura', async () => {
  svc.client = {
    get: async (url) => {
      if (url.includes('/pdf')) return { data: FAKE_PDF };
      throw error404();
    },
  };
  assert.equal(await svc.getInvoicePaymentUrl(9999), null);
});

test('getInvoicePaymentUrl degrada al primer candidato si la validación no está disponible', async () => {
  svc.client = {
    get: async (url) => {
      if (url.includes('/pdf')) return { data: FAKE_PDF };
      throw new Error('ECONNREFUSED');
    },
  };
  const url = await svc.getInvoicePaymentUrl(1000);
  assert.equal(url, `https://uisp.test/crm/online-payment/pay/${BAD_UUID}`);
});

test('getInvoicePaymentUrl devuelve null si el PDF no tiene UUIDs', async () => {
  svc.client = {
    get: async (url) => {
      if (url.includes('/pdf')) return { data: Buffer.from('%PDF sin uuids') };
      throw new Error('no debería consultar tokens');
    },
  };
  assert.equal(await svc.getInvoicePaymentUrl(777), null);
});

// ---------- getPaymentToken / getWebhookEvent ----------

test('getPaymentToken distingue 404 (null) de API caída (undefined)', async () => {
  svc.client = { get: async () => { throw error404(); } };
  assert.equal(await svc.getPaymentToken('x'), null);

  svc.client = { get: async () => { throw new Error('ETIMEDOUT'); } };
  assert.equal(await svc.getPaymentToken('x'), undefined);
});

test('getWebhookEvent distingue 404 (null) de API caída (undefined)', async () => {
  svc.client = { get: async () => { throw error404(); } };
  assert.equal(await svc.getWebhookEvent('u'), null);

  svc.client = { get: async () => { throw new Error('ETIMEDOUT'); } };
  assert.equal(await svc.getWebhookEvent('u'), undefined);
});
