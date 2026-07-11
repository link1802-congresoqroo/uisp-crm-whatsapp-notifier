# 📱 UISP WhatsApp Notifier

**Sistema automatizado de notificaciones de facturas por WhatsApp integrando UISP y WhatsApp Business API**

Un servicio backend que se integra con UISP para capturar eventos de facturación y enviar notificaciones automáticas a través de WhatsApp Business API.

---

## 🎯 Descripción General

UISP WhatsApp Notifier automatiza el proceso de notificación a clientes cuando se genera una nueva factura. El sistema:

- Recibe webhooks de UISP cuando se crean nuevas facturas
- Obtiene información completa de la factura y el cliente desde UISP
- Extrae el link de pago directo del PDF de la factura
- Envía notificaciones personalizadas por WhatsApp con plantillas predefinidas
- Mantiene un registro de todas las comunicaciones

El sistema tiene **dos componentes, ambos necesarios** para una operación completa:

1. **El notifier** (este servidor Node.js) — recibe los webhooks y envía los WhatsApps.
2. **El [plugin de facturas recurrentes](./plugin/README.md)** (se instala en UISP) — UISP 3.x tiene un bug por el que las facturas generadas automáticamente por planes recurrentes **no disparan el webhook nativo**; sin el plugin, solo las facturas manuales se notifican. Ver [Plugin de Facturas Recurrentes](#-plugin-de-facturas-recurrentes-requerido).

### Flujo de Funcionamiento

```
UISP (Evento de factura)
         ↓
    Webhook POST (?token=SECRETO)
         ↓
Tu Servidor (Express)
         ↓
Autentica el webhook (secreto + verificación opcional del evento en UISP)
         ↓
Consulta datos de factura y cliente
         ↓
Extrae URL de pago del PDF y la valida contra la API (payment-tokens)
         ↓
Envía notificación por WhatsApp (al contacto de facturación)
         ↓
Cliente recibe mensaje con link de pago
```

---

## ✨ Características

- ✅ **Integración con UISP**: Consumo de API de UISP (CRM v1.0) para obtener datos de facturas y clientes
- ✅ **WhatsApp Business API**: Envío de mensajes a través de la API oficial de WhatsApp
- ✅ **Plantillas de Mensaje**: Soporte para plantillas personalizadas en español
- ✅ **Autenticación de Webhooks**: Secreto compartido (`?token=`) con comparación a prueba de timing attacks, más verificación opcional del evento contra la API de UISP
- ✅ **Extracción de URLs validada**: El UUID de pago extraído del PDF se valida contra `GET /payment-tokens/{token}` para garantizar que corresponde a la factura, con cache por factura para no re-descargar el PDF en reintentos
- ✅ **Contacto de facturación**: El teléfono se toma preferentemente del contacto marcado como `isBilling` en UISP
- ✅ **Idempotencia**: La misma factura no se notifica dos veces aunque llegue por el webhook nativo, por el plugin de recurrentes o por reintentos (registro en memoria con TTL de 6h)
- ✅ **Validación de Configuración**: Validación completa de variables de entorno al arrancar
- ✅ **Logging Detallado**: Registros claros con emojis para debugging
- ✅ **Health Checks**: Endpoints para monitoreo del sistema (validación de API key vía `GET /version`)
- ✅ **Manejo de Errores**: Sistema robusto de gestión de errores

---

## 📋 Requisitos Previos

### Tecnología
- **Node.js** ≥ 16.0.0
- **npm** ≥ 8.0.0
- Conexión HTTP requerida (para webhooks)

### Cuentas y Credenciales Necesarias

1. **UISP Account**
   - Acceso a cuenta UISP con permisos de API
   - Token/API Key de UISP

2. **WhatsApp Business Account**
   - Cuenta de WhatsApp Business verificada
   - Access Token de la API
   - Phone Number ID (ID del número de WhatsApp)
   - Plantillas de mensaje aprovadas

3. **Servidor**
   - Servidor VPS o en la nube con IP pública
   - URL HTTPS (para webhooks de UISP)
   - Puerto disponible (por defecto 3000)

4. **Plugin de Facturas Recurrentes** (se instala en UISP)
   - Requerido para que las facturas recurrentes se notifiquen — ver [su documentación](./plugin/src/README.md)

---

## 🚀 Instalación

### 1. Clonar el Repositorio

```bash
git clone https://github.com/link1802-congresoqroo/uisp-whatsapp-notifier.git
cd uisp-whatsapp-notifier
```

### 2. Instalar Dependencias

```bash
npm install
```

### 3. Configurar Variables de Entorno

Crear archivo `.env` en la raíz del proyecto (copiar desde `.env.example`):

```bash
cp .env.example .env
```

Editar `.env` con tus credenciales:

```env
# ==========================================
# SERVIDOR
# ==========================================
PORT=3000
IP=localhost
NODE_ENV=production
APP_URL=http://localhost:3000

# ==========================================
# SEGURIDAD DE WEBHOOKS
# ==========================================
# Secreto compartido (obligatorio en producción). Generar con: openssl rand -hex 32
# Debe agregarse como ?token=VALOR en la URL del webhook en UISP y en el plugin.
WEBHOOK_SECRET=
# Verificación de eventos contra la API de UISP: off | log (default) | enforce
WEBHOOK_VERIFY_EVENTS=log

# ==========================================
# UISP Configuration
# ==========================================
UISP_URL=https://localhost.com.mx
UISP_API_KEY=
# El prefijo de la API del CRM está congelado en v1.0 aunque la app UISP sea 3.0.x
UISP_BASE_URL=https://localhost.com.mx/crm/api/v1.0

# ==========================================
# WhatsApp Configuration
# ==========================================
WHATSAPP_API_VERSION=v21.0
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_TEMPLATE_NAME=
WHATSAPP_LANGUAGE_CODE=
UISP_MESSAGING_TEMPLATE_NAME=
UISP_MESSAGING_TEMPLATE_LANGUAGE=

# Teléfono del administrador para alertas operativas por WhatsApp (opcional)
ADMIN_PHONE=
```

### 4. Iniciar el Servidor

**Desarrollo:**
```bash
npm run dev
```

**Producción:**
```bash
npm start
```

El servidor estará disponible en `http://localhost:3000`

---

## 📚 Endpoints

### Health Check
```bash
GET /
```
Verifica que el servidor esté funcionando.

**Respuesta:**
```json
{
  "status": "OK",
  "message": "UISP WhatsApp Notifier"
}
```

### Webhook Health
```bash
GET /webhook/health
```
Estado de la conexión con UISP (valida la API key contra `GET /version`). Público, sin token.

**Respuesta:**
```json
{
  "success": true,
  "status": "healthy",
  "services": { "uisp": "connected" }
}
```

### Webhook UISP (Facturas)
```bash
POST /webhook/uisp?token=WEBHOOK_SECRET
```
Recibe eventos `invoice.add` desde UISP. **Endpoint principal del sistema.** 🔒 Requiere el secreto.

**Body esperado** (formato nativo del webhook de UISP):
```json
{
  "uuid": "2c6984d7-03ae-4e48-a212-7b99378837a2",
  "changeType": "insert",
  "entity": "invoice",
  "entityId": "1000",
  "eventName": "invoice.add",
  "extraData": {
    "entity": {
      "id": 1000,
      "clientId": 10,
      "number": "00099",
      "total": 300,
      "clientFirstName": "Nombre",
      "dueDate": "2026-07-12",
      "items": [{ "label": "Servicio de Internet" }]
    }
  }
}
```

### Webhook de Mensajes
```bash
POST /uisp-messaging/client-message?token=WEBHOOK_SECRET
```
Recibe eventos `client.message` desde UISP y reenvía el contenido por WhatsApp. 🔒 Requiere el secreto. Necesita su propio terminal en UISP con el evento `client.message` suscrito.

### Alertas Operativas
```bash
POST /webhook/alert?token=WEBHOOK_SECRET
```
Recibe alertas de sistemas internos (ej. el plugin de facturas recurrentes tras 5 corridas fallidas) y las reenvía por WhatsApp al administrador. 🔒 Requiere el secreto.

**Body:** `{ "source": "nombre-del-emisor", "message": "descripción del problema" }`

Requiere `ADMIN_PHONE` y `UISP_MESSAGING_TEMPLATE_NAME` en el `.env`; sin ellos la alerta solo se registra en logs. Responde siempre 200 (best-effort, el emisor no debe reintentar).

### Estado de Mensajería
```bash
GET /uisp-messaging/status
```
Estado del sistema de mensajería. Público, sin token.

### Test del Sistema
```bash
POST /webhook/test?token=WEBHOOK_SECRET
```
Ejecuta el flujo de factura con datos fijos de prueba (factura `123`, cliente `2`). 🔒 Requiere el secreto. **Solo disponible fuera de producción** (`NODE_ENV` ≠ `production`; en producción responde 404).

> ⚠️ Este endpoint ejecuta el flujo **real**: consulta UISP y, si el cliente de prueba existe y tiene teléfono, **envía un WhatsApp de verdad**. Úsalo solo con IDs de un cliente de prueba controlado.

---

## ⚙️ Configuración de UISP

### Crear Webhook en UISP

1. Accede a tu cuenta UISP
2. Ir a **System → Webhooks** → nuevo terminal (endpoint)
3. Configurar:
   - **URL:** `https://tu-dominio.com:3000/webhook/uisp?token=TU_WEBHOOK_SECRET`
   - **Cualquier evento:** NO
   - **Tipos de eventos Webhook:** `invoice.add`
   - **Use delivery window:** NO (activarlo retrasaría las notificaciones)

### Autenticación de Webhooks

Los endpoints `POST /webhook/uisp`, `POST /webhook/test` y `POST /uisp-messaging/client-message`
exigen un secreto compartido. UISP no soporta firmas ni headers personalizados en webhooks,
por lo que el secreto viaja como query param `?token=...` en la URL registrada
(en pruebas manuales también se acepta el header `X-Webhook-Secret`).

**Despliegue sin perder eventos** (en este orden — el código anterior ignora el query param):

1. Generar el secreto en el servidor: `openssl rand -hex 32`
2. Agregar `?token=SECRETO` a la URL del terminal en UISP (**System → Webhooks**)
   y al campo *Webhook URL destino* del plugin de facturas recurrentes.
3. Agregar `WEBHOOK_SECRET=SECRETO` al `.env` y reiniciar el servicio.

Verificación adicional (`WEBHOOK_VERIFY_EVENTS`): con `log` (default) cada evento se
contrasta contra `GET /webhook-events/{uuid}` de UISP y las anomalías solo se registran;
con `enforce` se rechazan. **No usar `enforce` con el plugin de facturas recurrentes
activo**: sus eventos son sintéticos y UISP no los reconoce.

### 🔔 Plugin de Facturas Recurrentes (requerido)

UISP 3.x **no dispara el webhook nativo `invoice.add` para facturas recurrentes** (el proceso corre como consumer asíncrono fuera del ciclo que encola webhooks). Como en un ISP la mayoría de las facturas son recurrentes, **sin el plugin el sistema solo notificaría las facturas manuales**.

Instalación resumida (detalle completo en [`plugin/src/README.md`](./plugin/src/README.md)):

1. Crear en UISP una API Key de **solo lectura en Facturas** (*Sistema → Usuarios API*).
2. Subir [`plugin/uisp-recurring-invoice-webhook.zip`](./plugin/uisp-recurring-invoice-webhook.zip) en *Sistema → Plugins*.
3. Configurar: URL de UISP, la API Key, la **Webhook URL destino** (`http://tu-servidor:3000/webhook/uisp`), el **Secreto del webhook** (mismo valor que `WEBHOOK_SECRET`) y la **URL de alertas** (`http://tu-servidor:3000/webhook/alert`).
4. Activar. El plugin corre cada minuto; su panel de estado se ve en la pantalla del plugin en UISP.

El plugin envía el mismo payload que el webhook nativo, autenticado con `X-Webhook-Secret`, y ante 5 corridas consecutivas con error alerta al administrador por WhatsApp (vía `POST /webhook/alert` + `ADMIN_PHONE`). Los duplicados entre el webhook nativo y el plugin los absorbe la idempotencia por `invoiceId` del notifier.

### Plantillas de WhatsApp

La plantilla recomendada debe incluir:

```
BODY (Cuerpo)
├─ Hola {{1}},
├─
├─ Tu factura #{{2}} por {{3}} está lista para pagar.
├─
├─ 📅 Fecha de vencimiento: {{4}}
├─ 📝 Concepto: {{5}}
├─
└─ Haz clic en el botón de abajo para realizar el pago.

BUTTON (Boton)
├─ Botón 1 (URL DINÁMICA)
├─ Tipo: URL
├─ Texto: "Pagar Ahora"
└─ URL: "https://localhost.com.mx/crm/online-payment/pay/{{1}}"

```

**Parámetros:**
```
┌─────────┬───────────────────┬─────────────────────┬──────────────┐
│ Variable│ Qué es            │ Ejemplo             │ Max Caract.  │
├─────────┼───────────────────┼─────────────────────┼──────────────┤
│  {{1}}  │ Nombre cliente    │ Juan García         │ 60           │
│  {{2}}  │ Factura #         │ INV-2024-001        │ 20           │
│  {{3}}  │ Monto/Moneda      │ MXN $1,500.00       │ 30           │
│  {{4}}  │ Fecha vencimiento │ 15 de febrero 2024  │ 30           │
│  {{5}}  │ Concepto          │ Servicio Internet   │ 100          │
└─────────┴───────────────────┴─────────────────────┴──────────────┘
Boton
┌─────────┬───────────────────┬──────────────────────────────────────┬──────────────┐
│ Variable│ Qué es            │ Ejemplo                              │ Max Caract.  │
├─────────┼───────────────────┼──────────────────────────────────────┼──────────────┤
│  {{1}}  │ UUID de Factura   │ 30477914-6990-42d5-aeb9-af8ef0724d73 │ 36           │
└─────────┴───────────────────┴──────────────────────────────────────┴──────────────┘
```
---

## 🧪 Testing

### Tests Automatizados

La suite (`test/`, usando el runner nativo `node:test`, sin dependencias extra) cubre
autenticación de webhooks, validación de tokens de pago, idempotencia, enmascarado de
PII y utilidades:

```bash
npm test
```

CI (GitHub Actions, `.github/workflows/ci.yml`) corre en cada push/PR: la suite en
Node 20 y 22, lint del plugin PHP, verificación de que el zip del plugin corresponde
a `plugin/src/`, y `npm audit` informativo.

### Prueba Manual con CURL

**Health Check:**
```bash
curl http://localhost:3000/
curl http://localhost:3000/webhook/health
```

**Webhook UISP (simulado)** — guarda el JSON del "Body esperado" (sección Endpoints) en `payload.json`:
```bash
curl -X POST "http://localhost:3000/webhook/uisp?token=TU_WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  --data-binary @payload.json
```

En Windows (cmd) usa `curl.exe` con la misma sintaxis. En pruebas manuales puedes mandar el
secreto como header en lugar del query param: `-H "X-Webhook-Secret: TU_WEBHOOK_SECRET"`.

**Verificar la autenticación** (debe responder `401 No autorizado`):
```bash
curl -X POST http://localhost:3000/webhook/uisp \
  -H "Content-Type: application/json" \
  --data-binary @payload.json
```

> Tip: para una prueba sin envío real de WhatsApp, usa en el payload un `id` de factura
> inexistente (ej. `999999`) — el flujo fallará de forma controlada al no encontrar el PDF.

---

## 📊 Estructura del Proyecto

```
uisp-whatsapp-notifier/
├── src/
│   ├── index.js                    # Punto de entrada
│   ├── config.js                   # Configuración centralizada
│   ├── middleware/
│   │   └── webhook-auth.js         # Autenticación de webhooks (secreto + verificación de eventos)
│   ├── routes/
│   │   ├── webhook.js              # Rutas de webhooks
│   │   └── uisp-messaging.js       # Rutas de mensajería UISP
│   └── services/
│       ├── uisp-api.js             # Cliente de API UISP
│       └── whatsapp.js             # Cliente de WhatsApp API
├── plugin/                         # Plugin UISP (REQUERIDO): webhook para facturas recurrentes
├── ANALISIS.md                     # Análisis de seguridad, escalabilidad y eficiencia
├── .env.example                    # Archivo de ejemplo de configuración
├── .gitignore
├── package.json                    # Dependencias del proyecto
├── package-lock.json               # Versiones exactas de dependencias
└── README.md                       # Este archivo
```

### Archivos Principales

**`src/config.js`**
- Centraliza toda la configuración
- Valida variables de entorno (en producción exige las credenciales y `WEBHOOK_SECRET`)
- Gestiona defaults

**`src/middleware/webhook-auth.js`**
- Verifica el secreto compartido de los webhooks (`?token=` o header `X-Webhook-Secret`)
- Verificación opcional del evento contra `GET /webhook-events/{uuid}` (`WEBHOOK_VERIFY_EVENTS`)

**`src/services/uisp-api.js`**
- Interacción con API de UISP (header `X-Auth-App-Key`, prefijo `/crm/api/v1.0`)
- Obtención de facturas y clientes; teléfono del contacto de facturación (`isBilling`)
- Extracción de URLs de pago desde PDFs, validada contra `GET /payment-tokens/{token}` y con cache por factura

**`src/services/whatsapp.js`**
- Envío de mensajes por WhatsApp
- Gestión de plantillas
- Manejo de errores de WhatsApp

**`src/routes/webhook.js`**
- Endpoints principales del sistema
- Procesamiento de eventos de UISP
- Health checks

---

## 🐛 Troubleshooting

### Error: "UISP_API_KEY not configured"

**Solución:** Verifica que el archivo `.env` existe y tiene la variable `UISP_API_KEY` configurada.

```bash
cat .env | grep UISP_API_KEY
```

### Error: "Token de UISP inválido o expirado"

**Solución:** Valida tu token en la consola de UISP. Si expira, genera uno nuevo.

### Error: 401 "No autorizado" en los webhooks

**Solución:** La URL registrada en UISP (y en el plugin) no incluye el `?token=` o el valor
no coincide con `WEBHOOK_SECRET` del `.env`. Verifica ambos lados y que no haya espacios
o caracteres cortados al copiar el secreto.

### Error: "No se encontró UUID en el PDF"

**Solución:** Verifica que:
- La factura está completa en UISP
- El token tiene permisos para descargar PDFs
- El PDF se descarga correctamente

```bash
# Ver logs de descarga en consola
npm run dev
```

### Error: "Ningún UUID del PDF corresponde a la factura"

El sistema encontró UUIDs en el PDF pero UISP no reconoció ninguno como token de pago de
esa factura (validación vía `GET /payment-tokens/{token}`). Suele indicar que el PDF es de
otra factura o que el pago en línea está deshabilitado para ella. Revisa la factura en UISP
y prueba `PATCH /invoices/{id}/regenerate-pdf` si el PDF parece corrupto.

### WhatsApp No Envía Mensajes

**Verifica:**
1. Token de acceso válido: `curl "https://graph.facebook.com/me?access_token=YOUR_TOKEN"`
2. Número de teléfono registrado y verificado
3. Plantilla aprovada por Meta
4. Formato correcto del número (con código de país)

### Las facturas manuales se notifican pero las recurrentes NO

**Causa:** el plugin de facturas recurrentes no está instalado, está desactivado, o su API Key
quedó inválida (p. ej. tras rotarla). Revisa el panel del plugin en *Sistema → Plugins* — su
log muestra el resultado de cada corrida. Ver [`plugin/src/README.md`](./plugin/src/README.md).

### No Recibe Webhooks de UISP

**Solución:**
1. Verifica que la URL es HTTPS
2. Comprueba que el servidor es accesible públicamente
3. Revisa los logs en UISP
4. Usa `ngrok` para testing local:
   ```bash
   ngrok http 3000
   ```

---

## 📝 Logs y Monitoreo

El sistema usa logging detallado con emojis para fácil identificación:

```
✓ Operación exitosa
❌ Error crítico
⚠️ Advertencia
📊 Información
🚀 Inicio del sistema
📱 Acción relacionada con WhatsApp
```

**Ejemplo de salida:**
```
🚀 Iniciando UISP WhatsApp Notifier...
📊 Ambiente: production
🔌 Puerto: 3000
✓ UISP API Service inicializado
📍 Escuchando en: http://localhost:3000
✅ Sistema listo para recibir webhooks
```

---

## 🚢 Deployment

### Con PM2 (Recomendado)

```bash
# Instalar PM2 globalmente
npm install -g pm2

# Crear archivo ecosystem.config.js
cat > ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'uisp-whatsapp-notifier',
    script: './src/index.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production'
    }
  }]
};
EOF

# Iniciar con PM2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### Con Docker

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

EXPOSE 3000

CMD ["npm", "start"]
```

**Construir y ejecutar:**
```bash
docker build -t uisp-whatsapp-notifier .
docker run -d --env-file .env -p 3000:3000 uisp-whatsapp-notifier
```

### En Servidor Linux

```bash
# 1. Clonar repositorio
git clone https://github.com/tu-usuario/uisp-whatsapp-notifier.git
cd uisp-whatsapp-notifier

# 2. Instalar dependencias
npm install

# 3. Configurar .env
nano .env

# 4. Iniciar con PM2
pm2 start npm --name "uisp-whatsapp" -- start
pm2 save
```

---

## 🔐 Seguridad

El análisis completo de seguridad, con hallazgos y soluciones priorizadas, está en
[`ANALISIS.md`](./ANALISIS.md).

### Implementado

1. ✅ **Autenticación de Webhooks** — secreto compartido obligatorio en producción
   (`WEBHOOK_SECRET`) más verificación opcional de eventos contra la API de UISP
   (`WEBHOOK_VERIFY_EVENTS`). Ver *Configuración de UISP → Autenticación de Webhooks*.
2. ✅ **Protección de Variables de Entorno** — `.env` está en `.gitignore`; usa
   `.env.example` sin valores reales. Si una credencial se expone (chat, logs,
   capturas), rótala de inmediato en UISP/Meta.
3. ✅ **Validación del token de pago** — el UUID extraído del PDF se contrasta con
   la API antes de enviarse al cliente.
4. ✅ **Logs Seguros** — el arranque no imprime credenciales; los teléfonos se
   enmascaran (`5219***`) en logs y respuestas; no se loguea el contenido de
   mensajes de clientes, solo su longitud.
5. ✅ **Errores genéricos** — las respuestas HTTP no exponen detalles internos;
   el detalle completo queda en los logs del servidor.
6. ✅ **Rate Limiting + helmet** — máximo 60 peticiones/minuto por IP en
   `/webhook` y `/uisp-messaging` (headers estándar `RateLimit-*`), headers de
   seguridad de helmet, y body JSON limitado a 100kb.
7. ✅ **`/webhook/test` deshabilitado en producción** — solo existe con
   `NODE_ENV` distinto de `production`.

### Pendiente

1. **HTTPS** — si el notifier se expone fuera de la LAN, usar TLS y activar
   "Verificar certificado SSL" en el terminal de UISP
2. **Rotación periódica de credenciales** y `npm audit` regular

---

## 📄 Licencia

Este proyecto está bajo la licencia MIT. Ver archivo LICENSE para más detalles.

---

## 🔗 Enlaces Útiles

- [Documentación de UISP CRM API v1.0 (Apiary)](https://unmscrm.docs.apiary.io/)
- [Guía oficial: UISP CRM API Usage](https://help.uisp.com/hc/en-us/articles/22590956856087-UISP-CRM-API-Usage)
- [WhatsApp Business API Docs](https://developers.facebook.com/docs/whatsapp/cloud-api)
- [Node.js Best Practices](https://nodejs.org/en/docs/)
- [Express.js Guide](https://expressjs.com/)

---

## 🎉 Agradecimientos

- Meta por WhatsApp Business API
- UISP por su excelente plataforma de CRM
- Comunidad Node.js

---

**Última actualización:** Julio 2026
**Versión:** 1.1.0
