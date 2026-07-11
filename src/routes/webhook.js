const express = require('express');
const config = require('../config');
const uispApiService = require('../services/uisp-api');
const whatsappService = require('../services/whatsapp');
const { verifyWebhookSecret, verifyWebhookEvent } = require('../middleware/webhook-auth');
const { maskPhone } = require('../utils/mask');
const { cleanTextForWhatsApp } = require('../utils/clean-text');
const { RecentKeys } = require('../utils/recent-keys');

const router = express.Router();

// Idempotencia por invoiceId: la misma factura puede llegar por el webhook
// nativo de UISP, por el plugin de recurrentes (~1 min después) o por
// reintentos — al cliente solo debe llegarle UNA notificación.
// Se marca únicamente tras un desenlace terminal exitoso, para que los
// fallos (PDF, WhatsApp) sí puedan reintentarse.
const processedInvoices = new RecentKeys({ ttlMs: 6 * 60 * 60 * 1000, maxSize: 1000 });

/**
 * Procesar un evento invoice.add: obtener URL de pago, teléfono del cliente
 * y enviar la notificación por WhatsApp. Separado de la capa HTTP para que
 * /webhook/test (y pruebas futuras) puedan invocarlo directamente.
 */
async function handleInvoiceWebhook(req, res) {
  try {
    console.log('\n====== WEBHOOK RECIBIDO ======');
    const data = req.body;

    if (!data || !data.entity || !data.entityId) {
      console.warn('⚠️ Webhook inválido');
      return res.status(400).json({ success: false, message: 'Webhook inválido' });
    }

    if (data.entity !== 'invoice') {
      console.log(`ℹ️ Webhook de otra entidad: ${data.entity}, ignorando`);
      return res.status(200).json({ success: true, message: 'Webhook ignorado' });
    }

    const invoiceData = data.extraData?.entity;
    if (!invoiceData || !invoiceData.id) {
      console.warn('⚠️ Datos de factura incompletos');
      return res.status(400).json({ success: false, message: 'Datos incompletos' });
    }

    const invoiceId = invoiceData.id;
    const clientId = invoiceData.clientId;
    const invoiceNumber = invoiceData.number;
    const total = invoiceData.total || invoiceData.amountToPay || 0;
    const clientName = invoiceData.clientFirstName || 'Cliente';
    const dueDate = invoiceData.dueDate || 'No especificada';

    console.log(`✓ Factura detectada: ID=${invoiceId}, Número=${invoiceNumber}, Total=${total}`);

    // ===== IDEMPOTENCIA =====
    if (processedInvoices.has(invoiceId)) {
      console.log(`ℹ️ Factura ${invoiceId} ya notificada recientemente, ignorando duplicado`);
      return res.status(200).json({
        success: true,
        message: 'Duplicado ignorado',
        data: { invoiceId, invoiceNumber, whatsappSent: false, reason: 'Ya procesada recientemente' }
      });
    }

    // ===== OBTENER URL DE PAGO DESDE UISP =====
    console.log(`📊 Obteniendo URL de pago de UISP para factura ${invoiceId}`);
    const paymentUrl = await uispApiService.getInvoicePaymentUrl(invoiceId);

    if (!paymentUrl) {
      console.error('❌ No se pudo obtener URL de pago');
      return res.status(500).json({ success: false, message: 'Error obteniendo URL' });
    }

    console.log(`✓ URL de pago obtenida: ${paymentUrl}`);

    // ===== OBTENER TELÉFONO DEL CLIENTE =====
    console.log(`📊 Obteniendo datos del cliente ${clientId}`);
    const client = await uispApiService.getClient(clientId);

    // Prefiere el contacto de facturación (isBilling) y cae a phone/mobile directos
    const phone = uispApiService.extractPhoneNumber(client);

    if (phone) {
      console.log(`✓ Teléfono obtenido: ${maskPhone(phone)}`);
    } else {
      console.warn('⚠️ No hay contactos con teléfono disponibles');
    }

    if (!phone) {
      console.warn('⚠️ Sin teléfono, no se envía WhatsApp');
      processedInvoices.add(invoiceId);
      return res.status(200).json({
        success: true,
        message: 'Procesado sin teléfono',
        data: {
          invoiceId,
          invoiceNumber,
          paymentUrl,
          whatsappSent: false,
          reason: 'Sin teléfono de cliente'
        }
      });
    }

    // ===== EXTRAER CONCEPTO DE ITEMS =====
    const items = invoiceData.items || [];
    const concept = items.length > 0 ? items[0].label : 'Factura de servicios';

    // ===== ENVIAR PLANTILLA DE WHATSAPP =====
    console.log('📱 Enviando notificación de factura por WhatsApp...');

    const formattedData = {
      clientName: clientName,
      invoiceNumber: invoiceNumber,
      amount: total,
      currency: 'MXN',
      dueDate: dueDate,
      description: concept,
      paymentLink: paymentUrl,
      paymentMethod: 'UISP'
    };

    try {
      await whatsappService.sendInvoiceNotification(phone, formattedData);

      processedInvoices.add(invoiceId);
      console.log('✓ Plantilla enviada correctamente');
      console.log('=============================\n');

      return res.status(200).json({
        success: true,
        message: 'Procesado correctamente',
        data: {
          invoiceId,
          invoiceNumber,
          paymentUrl,
          whatsappSent: true,
          phone: maskPhone(phone)
        }
      });

    } catch (error) {
      console.error('❌ Error enviando WhatsApp:', error.message);
      return res.status(500).json({
        success: false,
        message: 'Error enviando WhatsApp'
      });
    }

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    return res.status(500).json({
      success: false,
      message: 'Error interno procesando webhook'
    });
  }
}

router.post('/uisp', verifyWebhookSecret, verifyWebhookEvent, handleInvoiceWebhook);

/**
 * POST /webhook/alert — alertas operativas de sistemas internos (ej. el plugin
 * de facturas recurrentes tras N corridas fallidas). Reenvía el mensaje por
 * WhatsApp al administrador (ADMIN_PHONE) usando la plantilla de mensajería.
 * Responde 200 siempre: la alerta es best-effort y el emisor no debe reintentar.
 */
router.post('/alert', verifyWebhookSecret, async (req, res) => {
  const source = String(req.body?.source || 'desconocido').substring(0, 60);
  const message = cleanTextForWhatsApp(String(req.body?.message || 'Alerta sin mensaje')).substring(0, 500);

  console.warn(`🚨 ALERTA de ${source}: ${message}`);

  if (!config.app.adminPhone || !config.uisp.messagingTemplate.name) {
    console.warn('⚠️ ADMIN_PHONE o plantilla de mensajería no configurados — alerta solo registrada en logs');
    return res.status(200).json({ success: true, delivered: false, reason: 'Alertas por WhatsApp no configuradas' });
  }

  try {
    await whatsappService.sendTemplateMessage(
      config.app.adminPhone,
      config.uisp.messagingTemplate.name,
      config.uisp.messagingTemplate.language,
      [{ type: 'body', parameters: [{ type: 'text', text: `[${source}] ${message}` }] }]
    );
    return res.status(200).json({ success: true, delivered: true });
  } catch (error) {
    console.error('❌ No se pudo enviar la alerta por WhatsApp:', error.message);
    return res.status(200).json({ success: true, delivered: false, reason: 'Error enviando WhatsApp' });
  }
});

router.get('/health', async (req, res) => {
  try {
    const valid = await uispApiService.validateToken();
    return res.status(200).json({
      success: true,
      status: 'healthy',
      services: { uisp: valid ? 'connected' : 'disconnected' }
    });
  } catch (error) {
    console.error('❌ Error en health check:', error.message);
    return res.status(500).json({
      success: false,
      status: 'unhealthy'
    });
  }
});

// Endpoint de prueba: ejecuta el flujo real (puede enviar un WhatsApp de verdad
// si el cliente de prueba existe), por eso solo se registra fuera de producción
if (config.app.nodeEnv !== 'production') {
  router.post('/test', verifyWebhookSecret, async (req, res) => {
    try {
      console.log('🧪 Test webhook...');

      const testData = {
        uuid: 'test-123',
        changeType: 'insert',
        entity: 'invoice',
        entityId: '123',
        eventName: 'invoice.add',
        extraData: {
          entity: {
            id: 123,
            clientId: 2,
            number: 'TEST-001',
            total: 1000,
            amountToPay: 1000,
            clientFirstName: 'Cliente',
            clientLastName: 'Test',
            dueDate: '2026-02-20',
            items: [{ label: 'Servicio de prueba' }]
          }
        }
      };

      const mockReq = {
        body: testData,
        headers: {},
        query: {}
      };

      let response = null;
      const mockRes = {
        status: function(code) {
          this.statusCode = code;
          return this;
        },
        json: function(data) {
          response = { statusCode: this.statusCode, data };
          return data;
        }
      };

      await handleInvoiceWebhook(mockReq, mockRes);

      return res.status(200).json({
        success: true,
        message: 'Test completado',
        response
      });

    } catch (error) {
      console.error('❌ Error en test:', error);
      return res.status(500).json({
        success: false,
        message: 'Error en test'
      });
    }
  });
}

module.exports = router;
