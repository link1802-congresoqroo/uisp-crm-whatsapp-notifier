require('dotenv').config();

const config = {
  app: {
    nodeEnv: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3000,
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    // Secreto compartido para autenticar webhooks entrantes (query param ?token=...)
    webhookSecret: process.env.WEBHOOK_SECRET,
    // Verificación de eventos contra GET /webhook-events/{uuid}: off | log | enforce
    webhookVerifyEvents: (process.env.WEBHOOK_VERIFY_EVENTS || 'log').toLowerCase(),
    // Teléfono del administrador para alertas operativas por WhatsApp (opcional)
    adminPhone: process.env.ADMIN_PHONE,
  },

  uisp: {
    apiKey: process.env.UISP_API_KEY,
    baseUrl: process.env.UISP_BASE_URL,
    uispUrl: process.env.UISP_URL,
    invoiceTemplate: {
      name: process.env.WHATSAPP_TEMPLATE_NAME || 'invoice_checkout_link',
      language: process.env.WHATSAPP_LANGUAGE_CODE || 'es_MX',
    },
    messagingTemplate: {
      name: process.env.UISP_MESSAGING_TEMPLATE_NAME,
      language: process.env.UISP_MESSAGING_TEMPLATE_LANGUAGE || 'es',
    },
  },

  whatsapp: {
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    templateName: process.env.WHATSAPP_TEMPLATE_NAME || 'invoice_checkout_link',
    languageCode: process.env.WHATSAPP_LANGUAGE_CODE || 'es_MX',
  },
};

function validateConfig() {
  const errors = [];

  if (!config.uisp.apiKey) {
    errors.push('❌ UISP_API_KEY not configured in .env');
  }

  if (!config.uisp.baseUrl) {
    errors.push('❌ UISP_BASE_URL not configured in .env');
  }

  if (!config.uisp.uispUrl) {
    errors.push('❌ UISP_URL not configured in .env');
  }

  if (!config.whatsapp.phoneNumberId) {
    errors.push('❌ WHATSAPP_PHONE_NUMBER_ID not configured in .env');
  }

  if (!config.whatsapp.accessToken) {
    errors.push('❌ WHATSAPP_ACCESS_TOKEN not configured in .env');
  }

  if (!config.app.webhookSecret) {
    errors.push('❌ WEBHOOK_SECRET not configured in .env (generate one with: openssl rand -hex 32)');
  }

  if (!['off', 'log', 'enforce'].includes(config.app.webhookVerifyEvents)) {
    errors.push(`❌ WEBHOOK_VERIFY_EVENTS must be off, log or enforce (got: ${config.app.webhookVerifyEvents})`);
  }

  if (!config.uisp.messagingTemplate.name) {
    console.warn('⚠️  UISP_MESSAGING_TEMPLATE_NAME not configured - messaging feature will not work');
  }

  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach(err => console.error(err));
    if (config.app.nodeEnv === 'production') {
      throw new Error('Critical configuration missing');
    }
  }

  console.log('✓ Configuración cargada y validada');
  return true;
}

validateConfig();

module.exports = config;
