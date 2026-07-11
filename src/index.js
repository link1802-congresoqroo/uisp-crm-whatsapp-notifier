const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const webhook = require('./routes/webhook');
const uispMessaging = require('./routes/uisp-messaging');

const app = express();

// Middleware
app.use(helmet());
// Los payloads de webhook de UISP son de pocos KB; 100kb da margen de sobra
app.use(express.json({ limit: '100kb' }));

// Rate limiting: cada webhook dispara trabajo costoso (PDF de UISP + mensaje
// pagado a Meta), así que se limita por IP para cortar ráfagas y abuso
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Demasiadas peticiones, intente más tarde' },
});
app.use('/webhook', webhookLimiter);
app.use('/uisp-messaging', webhookLimiter);

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'UISP WhatsApp Notifier' });
});

// Webhook routes
app.use('/webhook', webhook);
app.use('/uisp-messaging', uispMessaging);

// Error handling: el detalle solo va al log del servidor, nunca a la respuesta
app.use((err, req, res, next) => {
  console.error('❌ Error:', err);
  if (res.headersSent) {
    return next(err);
  }
  // Los errores de parseo de body-parser traen status 4xx; el resto es 500
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({
    error: status < 500 ? 'Petición inválida' : 'Error interno del servidor',
  });
});

// Start server
const PORT = config.app.port;
app.listen(PORT, () => {
  console.log(`🚀 Iniciando UISP WhatsApp Notifier...`);
  console.log(`📊 Ambiente: ${config.app.nodeEnv}`);
  console.log(`🔌 Puerto: ${PORT}`);
  console.log(`✓ UISP API Service inicializado`);
  console.log(`📍 Escuchando en: http://localhost:${PORT}`);
  console.log(`📚 Endpoints disponibles:`);
  console.log(`  GET  /                                - Health check`);
  console.log(`  GET  /webhook/health                  - Estado de servicios`);
  console.log(`  POST /webhook/uisp                    - Webhook de UISP (facturas)`);
  if (config.app.nodeEnv !== 'production') {
    console.log(`  POST /webhook/test                    - Prueba del sistema (solo desarrollo)`);
  }
  console.log(`  POST /uisp-messaging/client-message   - Webhook de mensajes`);
  console.log(`  GET  /uisp-messaging/status           - Estado de mensajería`);
  console.log(`✅ Sistema listo para recibir webhooks`);
});
