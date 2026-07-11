const express = require('express');
const router = express.Router();
const uispApiService = require('../services/uisp-api');
const whatsappService = require('../services/whatsapp');
const config = require('../config');
const { verifyWebhookSecret, verifyWebhookEvent } = require('../middleware/webhook-auth');
const { maskPhone } = require('../utils/mask');
const { cleanTextForWhatsApp } = require('../utils/clean-text');

/**
 * POST /uisp-messaging/client-message
 * Recibe eventos de mensajes de cliente desde UISP
 * Envía el mensaje por WhatsApp usando una plantilla
 */
router.post('/client-message', verifyWebhookSecret, verifyWebhookEvent, async (req, res) => {
  const startTime = Date.now();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`[${new Date().toISOString()}] Evento client.message recibido de UISP`);

  try {
    const payload = req.body;

    // Validar que es un evento de mensaje
    const eventName = payload.eventName || '';
    const changeType = payload.changeType || '';

    if (eventName !== 'client.message' && changeType !== 'message') {
      console.log(`⚠️  Ignorando evento que no es client.message: ${eventName || changeType}`);
      return res.status(200).json({
        success: true,
        message: 'Evento ignorado - no es un evento de mensaje de cliente',
      });
    }

    // Extraer datos
    const mailingId = payload.extraData?.mailingId;
    const messageContent = payload.extraData?.message;
    const clientData = payload.extraData?.entity;
    const clientId = payload.entityId || clientData?.id;

    // Validar datos mínimos
    if (!clientId) {
      console.error('❌ No se encontró ID de cliente en el payload');
      return res.status(400).json({
        success: false,
        error: 'ID de cliente no encontrado',
      });
    }

    if (!messageContent) {
      console.warn(`⚠️  No hay contenido de mensaje para cliente ${clientId}`);
      return res.status(200).json({
        success: true,
        message: 'Sin contenido de mensaje',
        clientId,
      });
    }

    console.log(`📨 Evento de mensaje para cliente ${clientId}`);
    console.log(`   Mailing ID: ${mailingId}`);
    console.log(`   Contenido: ${messageContent.length} caracteres`);

    // Extraer número de teléfono (prefiere contacto de facturación, luego phone/mobile)
    let phoneNumber = uispApiService.extractPhoneNumber(clientData);

    // Si aún no hay teléfono, obtener desde UISP
    if (!phoneNumber) {
      try {
        const client = await uispApiService.getClientById(clientId);
        phoneNumber = uispApiService.extractPhoneNumber(client);
      } catch (error) {
        console.warn(`⚠️  No se pudo obtener datos del cliente ${clientId}: ${error.message}`);
      }
    }

    if (!phoneNumber) {
      console.warn(`⚠️  No se encontró número de teléfono para cliente ${clientId}`);
      return res.status(200).json({
        success: true,
        message: 'No hay número de teléfono disponible',
        clientId,
        mailingId,
      });
    }

    console.log(`📱 Enviando mensaje a WhatsApp: ${maskPhone(phoneNumber)}`);

    // Obtener configuración de plantilla desde config
    // IMPORTANTE: Verificar que config está disponible
    if (!config || !config.uisp || !config.uisp.messagingTemplate) {
      console.error('❌ Configuración no disponible');
      return res.status(500).json({
        success: false,
        error: 'Configuración de servidor no disponible',
        clientId,
        mailingId,
      });
    }

    const templateName = config.uisp.messagingTemplate.name;
    const languageCode = config.uisp.messagingTemplate.language;

    if (!templateName) {
      console.error('❌ UISP_MESSAGING_TEMPLATE_NAME no configurado en .env');
      return res.status(200).json({
        success: false,
        error: 'Plantilla WhatsApp no configurada',
        clientId,
        mailingId,
      });
    }

    console.log(`   Plantilla: ${templateName}`);
    console.log(`   Idioma: ${languageCode}`);

    // Limpiar el mensaje
    const cleanedMessage = cleanTextForWhatsApp(messageContent);

    if (messageContent !== cleanedMessage) {
      console.log(`   ✓ Mensaje limpiado de caracteres no permitidos (${messageContent.length} -> ${cleanedMessage.length} caracteres)`);
    }

    // Construir componentes de la plantilla
    const components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: cleanedMessage },
        ],
      },
    ];

    // Enviar mensaje por WhatsApp
    const whatsappResponse = await whatsappService.sendTemplateMessage(
      phoneNumber,
      templateName,
      languageCode,
      components
    );

    const duration = Date.now() - startTime;

    console.log(`✓ Mensaje enviado en ${duration}ms`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    return res.status(200).json({
      success: true,
      message: 'Mensaje enviado por WhatsApp',
      clientId,
      mailingId,
      phoneNumber: maskPhone(phoneNumber),
      template: templateName,
      messageLength: messageContent.length,
      whatsappMessageId: whatsappResponse.messages?.[0]?.id || null,
      duration: `${duration}ms`,
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Error procesando client.message (${duration}ms):`, error.message);
    console.error('Stack:', error.stack);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // 200 deliberado: los errores internos no deben provocar reintentos de UISP
    return res.status(200).json({
      success: false,
      error: 'Error interno procesando el mensaje',
      duration: `${duration}ms`,
    });
  }
});

/**
 * GET /uisp-messaging/status
 * Verificar estado del servicio de mensajería
 */
router.get('/status', (req, res) => {
  try {
    // Verificar que config está disponible
    if (!config) {
      return res.status(500).json({
        status: 'error',
        message: 'Configuración no disponible',
      });
    }

    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'UISP Messaging Integration',
      endpoints: {
        clientMessage: 'POST /uisp-messaging/client-message (webhook)',
        status: 'GET /uisp-messaging/status',
      },
      whatsappConfigured: !!config.whatsapp?.accessToken,
      uispConfigured: !!config.uisp?.apiKey,
      messagingTemplateConfigured: !!config.uisp?.messagingTemplate?.name,
    });
  } catch (error) {
    console.error('❌ Error en status endpoint:', error.message);
    res.status(500).json({
      status: 'error',
      message: 'Error interno',
    });
  }
});

module.exports = router;
