const axios = require('axios');
const config = require('../config');

/**
 * Servicio para interactuar con API de UISP
 */
class UISSPApiService {
  constructor() {
    if (!config || !config.uisp) {
      console.error('❌ Error: Config de UISP no configurada');
      this.client = null;
      return;
    }

    if (!config.uisp.apiKey) {
      console.warn('⚠️ Advertencia: UISP_API_KEY no está configurado en .env');
    }

    if (!config.uisp.baseUrl) {
      console.error('❌ Error: UISP_BASE_URL no está configurado en .env');
      this.client = null;
      return;
    }

    this.client = axios.create({
      baseURL: config.uisp.baseUrl,
      headers: {
        // Header documentado por UISP CRM API v1.0 (X-Auth-Token era un alias no documentado)
        'X-Auth-App-Key': config.uisp.apiKey || '',
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    // Cache de URLs de pago por invoiceId: evita re-descargar el PDF ante reintentos del webhook
    this.paymentUrlCache = new Map();
    this.paymentUrlCacheLimit = 500;

    console.log('✓ UISP API Service inicializado');
    console.log(`  Base URL: ${config.uisp.baseUrl}`);
  }

  /**
   * Obtener URL de pago de una factura desde UISP
   * Descarga el PDF y busca el UUID en el contenido
   * @param {number} invoiceId - ID de la factura en UISP
   * @returns {Promise<string>} URL de pago de UISP o null
   */
  async getInvoicePaymentUrl(invoiceId) {
    try {
      if (!invoiceId) {
        console.warn('⚠️ invoiceId no proporcionado');
        return null;
      }

      if (!this.client) {
        console.error('❌ UISP API no inicializado correctamente');
        return null;
      }

      if (this.paymentUrlCache.has(invoiceId)) {
        const cachedUrl = this.paymentUrlCache.get(invoiceId);
        console.log(`✓ URL de pago obtenida de cache para factura ${invoiceId}`);
        return cachedUrl;
      }

      console.log(`📊 Obteniendo URL de pago para factura ${invoiceId}`);

      // Descargar PDF como buffer
      console.log(`📥 Descargando PDF de factura ${invoiceId} desde UISP`);
      const response = await this.client.get(`/invoices/${invoiceId}/pdf`, {
        responseType: 'arraybuffer',
      });

      if (!response.data) {
        console.error('❌ No se pudo descargar el PDF');
        return null;
      }

      console.log(`✓ PDF descargado exitosamente (${response.data.length} bytes)`);

      // Convertir buffer a string (muchos PDFs contienen texto legible)
      const pdfContent = response.data.toString('binary');

      // Buscar UUID en el contenido del PDF
      // Patrón: UUID formato estándar (8-4-4-4-12)
      const uuidPattern = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/gi;
      const matches = pdfContent.match(uuidPattern);

      if (!matches || matches.length === 0) {
        console.warn('⚠️ No se encontró UUID en el PDF');
        return null;
      }

      const candidates = [...new Set(matches.map((m) => m.toLowerCase()))];
      console.log(`✓ ${candidates.length} UUID(s) candidato(s) encontrado(s) en PDF`);

      // Validar candidatos contra la API: el token de pago correcto es el que
      // GET /payment-tokens/{token} resuelve con el invoiceId de esta factura
      let uuid = null;
      let validationUnavailable = false;

      for (const candidate of candidates) {
        const tokenData = await this.getPaymentToken(candidate);

        if (tokenData === undefined) {
          validationUnavailable = true;
          continue;
        }

        if (tokenData && Number(tokenData.invoiceId) === Number(invoiceId)) {
          console.log(`✓ Token de pago validado contra API: ${candidate}`);
          uuid = candidate;
          break;
        }
      }

      if (!uuid) {
        if (validationUnavailable) {
          // La API no pudo validar (errores de red/permisos): degradar al
          // comportamiento anterior de tomar el primer candidato
          uuid = candidates[0];
          console.warn(`⚠️ No se pudo validar contra API, usando primer UUID: ${uuid}`);
        } else {
          console.error(`❌ Ningún UUID del PDF corresponde a la factura ${invoiceId}`);
          return null;
        }
      }

      if (!config.uisp.uispUrl) {
        console.error('❌ UISP_URL no configurado — no se puede construir URL de pago');
        return null;
      }

      const paymentUrl = `${config.uisp.uispUrl}/crm/online-payment/pay/${uuid}`;
      console.log(`✓ URL de pago construida: ${paymentUrl}`);

      if (this.paymentUrlCache.size >= this.paymentUrlCacheLimit) {
        this.paymentUrlCache.delete(this.paymentUrlCache.keys().next().value);
      }
      this.paymentUrlCache.set(invoiceId, paymentUrl);

      return paymentUrl;

    } catch (error) {
      const errorData = {
        message: error.message,
      };
      
      if (error.response) {
        errorData.status = error.response.status;
        errorData.data = error.response.data;
      }
      
      console.error('❌ Error obteniendo URL de pago:', errorData);
      return null;
    }
  }

  /**
   * Consultar un token de pago en UISP para validarlo
   * @param {string} token - Token de pago (UUID extraído del PDF)
   * @returns {Promise<Object|null|undefined>} Datos del token ({token, clientId, invoiceId, ...}),
   *   null si el token no existe (404), undefined si la API no pudo responder
   */
  async getPaymentToken(token) {
    try {
      if (!this.client || !token) return undefined;

      const response = await this.client.get(`/payment-tokens/${token}`);
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return null;
      }
      console.warn(`⚠️ No se pudo validar token de pago: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Consultar un evento de webhook en UISP para verificar su autenticidad
   * @param {string} uuid - UUID del evento recibido en el payload del webhook
   * @returns {Promise<Object|null|undefined>} Datos del evento ({uuid, changeType, entity, entityId}),
   *   null si no existe (404), undefined si la API no pudo responder
   */
  async getWebhookEvent(uuid) {
    try {
      if (!this.client || !uuid) return undefined;

      const response = await this.client.get(`/webhook-events/${encodeURIComponent(uuid)}`);
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        return null;
      }
      console.warn(`⚠️ No se pudo consultar evento de webhook: ${error.message}`);
      return undefined;
    }
  }

  /**
   * Obtener detalles completos de una factura
   * @param {number} invoiceId - ID de la factura
   * @returns {Promise<Object>} Datos de la factura
   */
  async getInvoice(invoiceId) {
    try {
      if (!this.client) {
        console.error('❌ UISP API no inicializado');
        return null;
      }

      const response = await this.client.get(`/invoices/${invoiceId}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error obteniendo factura de UISP:', error.message);
      return null;
    }
  }

  /**
   * Obtener cliente completo con teléfono
   * @param {number} clientId - ID del cliente
   * @returns {Promise<Object>} Datos del cliente
   */
  async getClient(clientId) {
    try {
      if (!this.client) {
        console.error('❌ UISP API no inicializado');
        return null;
      }

      const response = await this.client.get(`/clients/${clientId}`);
      return response.data;
    } catch (error) {
      console.error('❌ Error obteniendo cliente de UISP:', error.message);
      return null;
    }
  }

  /**
   * Obtener cliente por ID (alias para getClient)
   * @param {number} clientId - ID del cliente
   * @returns {Promise<Object>} Datos del cliente
   */
  async getClientById(clientId) {
    return this.getClient(clientId);
  }

  /**
   * Extraer número de teléfono de datos del cliente
   * Prefiere el contacto de facturación (isBilling), luego cualquier contacto,
   * luego los campos directos phone/mobile
   * @param {Object} clientData - Datos del cliente
   * @returns {string|null} Número de teléfono o null
   */
  extractPhoneNumber(clientData) {
    if (!clientData) return null;

    // Intentar desde contacts, priorizando el contacto de facturación
    if (clientData.contacts && Array.isArray(clientData.contacts)) {
      const hasPhone = (c) => c.phone && String(c.phone).trim();
      const contactWithPhone =
        clientData.contacts.find((c) => c.isBilling && hasPhone(c)) ||
        clientData.contacts.find(hasPhone);
      if (contactWithPhone?.phone) {
        return String(contactWithPhone.phone).trim();
      }
    }

    // Intentar desde phone directo
    if (clientData.phone && String(clientData.phone).trim()) {
      return String(clientData.phone).trim();
    }

    // Intentar desde mobile
    if (clientData.mobile && String(clientData.mobile).trim()) {
      return String(clientData.mobile).trim();
    }

    return null;
  }

  /**
   * Validar que el token de UISP es válido
   * @returns {Promise<boolean>} true si el token es válido
   */
  async validateToken() {
    try {
      if (!this.client) {
        console.error('❌ UISP API no inicializado');
        return false;
      }

      // GET /version valida la app key con costo mínimo (no consulta clientes)
      await this.client.get('/version');
      console.log('✓ Token de UISP validado correctamente');
      return true;
    } catch (error) {
      console.error('❌ Token de UISP inválido o expirado:', error.message);
      return false;
    }
  }
}

module.exports = new UISSPApiService();
