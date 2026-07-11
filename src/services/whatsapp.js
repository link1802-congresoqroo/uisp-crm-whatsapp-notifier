const axios = require('axios');
const config = require('../config');
const { maskPhone } = require('../utils/mask');

class WhatsAppService {
  constructor() {
    this.client = axios.create({
      baseURL: `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}`,
      headers: {
        Authorization: `Bearer ${config.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('✓ WhatsApp Service inicializado');
    console.log(`  API: ${config.whatsapp.apiVersion} | Phone ID: ${config.whatsapp.phoneNumberId}`);
    console.log(`  Plantilla: ${config.whatsapp.templateName} (${config.whatsapp.languageCode})`);
    console.log(`  Access Token: ${config.whatsapp.accessToken ? 'configurado' : 'NO CONFIGURADO'}`);
  }

  /**
   * Enviar mensaje de plantilla via WhatsApp Business API
   * @param {string} to - Número de teléfono del destinatario (formato internacional sin +)
   * @param {string} templateName - Nombre de la plantilla aprobada
   * @param {string} languageCode - Código de idioma de la plantilla (ej: 'es')
   * @param {Array} components - Componentes de la plantilla (header, body, buttons)
   * @returns {Promise<Object>} Respuesta de la API
   */
  async sendTemplateMessage(to, templateName, languageCode = 'es', components = []) {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'template',
        template: {
          name: templateName,
          language: {
            code: languageCode,
          },
        },
      };

      if (components.length > 0) {
        payload.template.components = components;
      }

      const response = await this.client.post('/messages', payload);

      console.log(`✓ Mensaje de WhatsApp enviado a ${maskPhone(to)}:`, response.data);
      return response.data;
    } catch (error) {
      console.error(`❌ Error al enviar mensaje de WhatsApp a ${maskPhone(to)}:`, (error.response && error.response.data) || error.message);
      throw error;
    }
  }

  /**
   * Extraer UUID de una URL de pago UISP
   * Ejemplo: https://example.com/invoice/pay/550e8400-e29b-41d4-a716-446655440000
   * Retorna: 550e8400-e29b-41d4-a716-446655440000
   * @param {string} url - URL completa de pago
   * @returns {string} UUID extraído
   */
  extractUuidFromUrl(url) {
    if (!url) return null;
    
    // Buscar UUID en formato estándar (8-4-4-4-12)
    const uuidMatch = url.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    
    if (uuidMatch) {
      return uuidMatch[0];
    }
    
    return null;
  }

  /**
   * Enviar notificación de factura usando plantilla
   * ✅ SIMPLIFICADO: Pasa SOLO el UUID como parámetro (extraído de la URL)
   * La plantilla de WhatsApp construye la URL automáticamente
   * @param {string} phoneNumber - Número de teléfono del destinatario
   * @param {Object} formattedData - Datos de la notificación formateados
   * @returns {Promise<Object>} Respuesta de la API
   */
  async sendInvoiceNotification(phoneNumber, formattedData) {
    const { clientName, invoiceNumber, amount, currency, dueDate, description, paymentLink, paymentMethod } = formattedData;

    console.log(`📱 Preparando notificación para ${clientName}`);
    console.log(`   Factura: ${invoiceNumber}`);
    console.log(`   Monto: ${currency} ${amount}`);
    if (paymentLink) {
      console.log(`   Método de pago: ${paymentMethod}`);
    }

    // Construir componentes de la plantilla con variables
    // La plantilla espera parámetros que se reemplazan en {{1}}, {{2}}, etc.
    // ✅ 5 parámetros en el body + parámetro dinámico para el botón URL
    const components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: clientName },                    // {{1}}
          { type: 'text', text: invoiceNumber },                 // {{2}}
          { type: 'text', text: `${currency} ${amount}` },       // {{3}}
          { type: 'text', text: dueDate },                        // {{4}}
          { type: 'text', text: description || 'Servicios de Internet' },  // {{5}}
        ],
      },
    ];

    // ✅ Agregar componente de botón con URL dinámica
    // Meta permite URLs dinámicas en botones usando parámetros separados
    if (paymentLink && paymentMethod === 'Mercado Pago') {
      console.log(`💳 Agregando URL dinámica de Mercado Pago: ${paymentLink}`);
      
      const paymentUrl = `https://mercadopago.com.mx/checkout/v1/redirect?pref_id=${paymentLink}`;
      
      // Componente de botón con URL dinámica
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [
          {
            type: 'text',
            text: paymentLink  // El pref_id se pasa como parámetro dinámico
          }
        ]
      });
      
      console.log(`✓ URL de pago: ${paymentUrl}`);
    } else if (paymentLink && paymentMethod === 'UISP') {
      console.log(`💳 Agregando URL de pago UISP`);
      
      // IMPORTANTE: Extraer SOLO el UUID de la URL completa
      const uuid = this.extractUuidFromUrl(paymentLink);
      
      if (uuid) {
        console.log(`   URL completa: ${paymentLink}`);
        console.log(`   UUID extraído: ${uuid}`);
        
        components.push({
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [
            {
              type: 'text',
              text: uuid  // ✅ Solo se pasa el UUID, no la URL completa
            }
          ]
        });
      } else {
        console.warn(`⚠️  No se pudo extraer UUID de la URL: ${paymentLink}`);
      }
    } else {
      console.log(`⚠️  No hay URL de pago disponible`);
    }

    // Usar languageCode desde config (no hardcodeado)
    return this.sendTemplateMessage(
      phoneNumber,
      config.whatsapp.templateName,
      config.whatsapp.languageCode,
      components
    );
  }

  /**
   * Enviar mensaje de texto simple (solo para pruebas/respuestas, requiere ventana de 24h)
   * @param {string} to - Número de teléfono del destinatario
   * @param {string} text - Texto del mensaje
   * @returns {Promise<Object>} Respuesta de la API
   */
  async sendTextMessage(to, text) {
    try {
      const payload = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: {
          body: text,
        },
      };

      const response = await this.client.post('/messages', payload);
      console.log(`✓ Mensaje de texto de WhatsApp enviado a ${maskPhone(to)}:`, response.data);
      return response.data;
    } catch (error) {
      console.error(`❌ Error al enviar mensaje de texto a ${maskPhone(to)}:`, (error.response && error.response.data) || error.message);
      throw error;
    }
  }
}

module.exports = new WhatsAppService();
