const crypto = require('crypto');
const config = require('../config');
const uispApiService = require('../services/uisp-api');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

/**
 * Capa A: autenticación por secreto compartido.
 * UISP no soporta firmas ni headers personalizados en webhooks, por lo que el
 * secreto viaja como query param en la URL registrada en UISP y en el plugin:
 *   http://servidor:3000/webhook/uisp?token=SECRETO
 * También se acepta el header X-Webhook-Secret para pruebas manuales.
 */
function verifyWebhookSecret(req, res, next) {
  const secret = config.app.webhookSecret;

  if (!secret) {
    if (config.app.nodeEnv === 'production') {
      // validateConfig ya impide arrancar sin secreto en producción; esto es defensa extra
      console.error('❌ Webhook rechazado: WEBHOOK_SECRET no configurado');
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }
    console.warn('⚠️ WEBHOOK_SECRET no configurado — aceptando webhook solo por ser ambiente de desarrollo');
    return next();
  }

  const provided = req.query.token || req.headers['x-webhook-secret'] || '';

  // Comparar hashes de longitud fija: timingSafeEqual exige buffers del mismo
  // tamaño y así no se filtra la longitud del secreto
  if (!provided || !crypto.timingSafeEqual(sha256(provided), sha256(secret))) {
    console.warn(`⚠️ Webhook rechazado: token inválido o ausente (ip: ${req.ip}, ruta: ${req.path})`);
    return res.status(401).json({ success: false, message: 'No autorizado' });
  }

  return next();
}

/**
 * Capa B: verificar que el evento existe en UISP vía GET /webhook-events/{uuid}.
 * Modos (WEBHOOK_VERIFY_EVENTS):
 *   off     - no verificar
 *   log     - verificar y solo registrar advertencias (default)
 *   enforce - rechazar eventos que UISP no reconozca
 * Nota: los eventos del plugin de facturas recurrentes usan uuids sintéticos
 * que no existen en UISP; con "enforce" serían rechazados. Usar "log" mientras
 * el plugin esté activo.
 */
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function verifyWebhookEvent(req, res, next) {
  const mode = config.app.webhookVerifyEvents;
  if (mode === 'off') return next();

  const { uuid, entity, entityId } = req.body || {};

  let problem = null;

  if (!uuid) {
    problem = 'evento sin uuid';
  } else if (!UUID_FORMAT.test(uuid)) {
    // UISP responde 500 (no 404) ante uuids malformados; sin este check, un uuid
    // inválido a propósito activaría el fail-open de "API no disponible"
    problem = `uuid con formato inválido: ${String(uuid).substring(0, 40)}`;
  } else {
    const event = await uispApiService.getWebhookEvent(uuid);

    if (event === undefined) {
      // La API no pudo responder: no bloquear el flujo de notificaciones
      console.warn(`⚠️ Verificación de evento ${uuid} no disponible (error de API), continuando`);
      return next();
    }

    if (event === null) {
      problem = `uuid ${uuid} no existe en UISP`;
    } else if (event.entity !== entity || String(event.entityId) !== String(entityId)) {
      problem = `evento ${uuid} no coincide (UISP: ${event.entity}/${event.entityId}, payload: ${entity}/${entityId})`;
    }
  }

  if (problem) {
    if (mode === 'enforce') {
      console.warn(`❌ Webhook rechazado por verificación de evento: ${problem} (ip: ${req.ip})`);
      return res.status(401).json({ success: false, message: 'No autorizado' });
    }
    console.warn(`⚠️ Verificación de evento (modo log): ${problem} (ip: ${req.ip})`);
  }

  return next();
}

module.exports = { verifyWebhookSecret, verifyWebhookEvent };
