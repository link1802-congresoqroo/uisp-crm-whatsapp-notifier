/**
 * Variables de entorno de prueba. Debe requerirse ANTES que cualquier
 * módulo de src/, porque config.js valida al cargarse y los servicios
 * son singletons que se construyen con esta configuración.
 */
process.env.NODE_ENV = 'test';
process.env.UISP_API_KEY = 'test-key';
process.env.UISP_BASE_URL = 'https://uisp.test/crm/api/v1.0';
process.env.UISP_URL = 'https://uisp.test';
process.env.WHATSAPP_PHONE_NUMBER_ID = '1';
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
process.env.WHATSAPP_TEMPLATE_NAME = 'invoice_checkout_link';
process.env.WHATSAPP_LANGUAGE_CODE = 'es_MX';
process.env.WEBHOOK_SECRET = 'secreto-de-prueba';
process.env.WEBHOOK_VERIFY_EVENTS = 'log';
process.env.UISP_MESSAGING_TEMPLATE_NAME = 'plantilla_prueba';
process.env.UISP_MESSAGING_TEMPLATE_LANGUAGE = 'es';
process.env.ADMIN_PHONE = '5219990000000';

// Silenciar los logs de la app durante los tests. Además de limpiar la salida,
// evita un bug del runner de Node 20 donde el volumen de stdout del proceso
// hijo corrompe el canal serializado de resultados y tumba el archivo entero
// con "Unable to deserialize cloned data" aunque todos los tests pasen.
// Para depurar con logs visibles: TEST_VERBOSE=1 npm test
if (!process.env.TEST_VERBOSE) {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}

/** Respuesta simulada de Express para probar middlewares y handlers. */
function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (data) => { res.body = data; return data; };
  return res;
}

module.exports = { mockRes };
