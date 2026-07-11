# 🔍 Análisis de Código — Seguridad, Escalabilidad y Eficiencia

**Fecha:** 2026-07-09
**Alcance:** `src/` completo, configuración, dependencias y estructura del proyecto.
**Nota:** Este documento contiene únicamente observaciones y soluciones propuestas; no se aplicó ningún cambio de código.

---

## 1. 🚨 Vulnerabilidades de Seguridad

### 1.1 CRÍTICO — Webhooks sin autenticación

**Archivos:** `src/routes/webhook.js:7`, `src/routes/uisp-messaging.js:29`

Los endpoints `POST /webhook/uisp` y `POST /uisp-messaging/client-message` aceptan cualquier petición sin verificar su origen. Cualquiera que descubra la URL puede:

- **Enviar mensajes de WhatsApp a números arbitrarios.** En `/uisp-messaging/client-message` el teléfono se toma directamente del payload (`clientData.contacts[].phone`), así que un atacante controla el destinatario **y** el contenido del mensaje (`extraData.message`). Esto permite spam/phishing usando tu número de WhatsApp Business, con riesgo de bloqueo de la cuenta por Meta y costo por conversación.
- **Forzar consultas a tu UISP** (descarga de PDFs, consulta de clientes) con IDs arbitrarios, exfiltrando indirectamente si un ID de factura/cliente existe.

**Solución propuesta:**
1. Definir un secreto compartido en `.env` (ej. `WEBHOOK_SECRET`) y exigirlo en cada webhook, ya sea como header (`X-Webhook-Secret`) o como query param en la URL registrada en UISP (UISP no firma webhooks nativamente, pero sí permite URLs con token: `https://tu-servidor/webhook/uisp?token=...`).
2. Complementar con **allowlist de IP** (solo la IP del servidor UISP) a nivel de reverse proxy (nginx) o middleware.
3. **Verificar el evento contra la propia API de UISP** (confirmado en la documentación oficial, ver sección 5): el payload de cada webhook incluye un `uuid` de evento y existe `GET /webhook-events/{uuid}`. Al recibir un webhook, consultar ese endpoint y comparar `entity`, `entityId` y `changeType`; si UISP no conoce el `uuid`, el webhook es falsificado y se descarta. *Caveat:* los eventos generados por el plugin de facturas recurrentes son sintéticos y su `uuid` no existirá en UISP — esos deben autenticarse con el secreto compartido (o el plugin puede añadirlo a la URL que dispara).
4. Middleware ejemplo:

```js
function verifyWebhookSecret(req, res, next) {
  const token = req.headers['x-webhook-secret'] || req.query.token;
  if (!token || !crypto.timingSafeEqual(
    Buffer.from(token), Buffer.from(config.app.webhookSecret))) {
    return res.status(401).json({ success: false, message: 'No autorizado' });
  }
  next();
}
```

### 1.2 ALTO — Token de acceso registrado en logs

**Archivo:** `src/services/whatsapp.js:9`

```js
console.log(`  Access Token: ${config.whatsapp.accessToken.substring(0, 30)}...`);
```

Se imprimen los primeros 30 caracteres del token de WhatsApp en cada arranque. Los logs suelen terminar en sistemas de terceros (PM2, journald, agregadores) y 30 caracteres reducen drásticamente el espacio de búsqueda del token.

**Solución:** eliminar el log del token por completo, o limitarse a `configurado: sí/no`. Lo mismo aplica al bloque `DEBUG WhatsApp Config` completo: debe existir solo detrás de `NODE_ENV !== 'production'`.

### 1.3 ALTO — Fuga de detalles internos en respuestas de error

**Archivos:** `src/index.js:23`, `src/routes/webhook.js:117,126`, `src/routes/uisp-messaging.js:197`

Se devuelve `error.message` (y por transición, mensajes de axios que incluyen URLs internas, códigos de estado de UISP/Meta, etc.) al cliente HTTP. Un atacante obtiene información de la infraestructura interna con solo provocar errores.

**Solución:** responder con mensajes genéricos (`{ error: 'Error interno' }`) y registrar el detalle solo en el log del servidor. En el error handler global de `index.js`:

```js
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});
```

### 1.4 MEDIO — Exposición de PII (teléfonos) en logs y respuestas

**Archivo:** `src/routes/uisp-messaging.js:115,182`

`webhook.js` sí enmascara el teléfono en la respuesta (`phone.substring(0, 4) + '***'`), pero `uisp-messaging.js` devuelve `phoneNumber` completo en el JSON de respuesta y lo imprime completo en logs, junto con el contenido del mensaje del cliente.

**Solución:** aplicar el mismo enmascarado en ambas rutas y centralizarlo en una utilidad `maskPhone(phone)`. Evitar loggear el contenido de mensajes de clientes (o truncar/anonimizar).

### 1.5 MEDIO — Sin rate limiting ni límite de tamaño de payload

**Archivo:** `src/index.js:9`

No hay ninguna protección contra ráfagas de peticiones. Cada webhook dispara trabajo costoso (descarga de PDF desde UISP + llamada a Meta con costo por mensaje), por lo que es un vector de **amplificación de costos** además de DoS.

**Solución:**

```js
const rateLimit = require('express-rate-limit');
app.use(express.json({ limit: '100kb' }));
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 60 }));
app.use('/uisp-messaging', rateLimit({ windowMs: 60_000, max: 60 }));
```

Complementar con `helmet` para headers de seguridad estándar.

### 1.6 MEDIO — Endpoint `/webhook/test` habilitado en producción

**Archivo:** `src/routes/webhook.js:148`

El endpoint de prueba ejecuta el flujo real (consulta UISP con `invoiceId=123`, `clientId=2` y **envía un WhatsApp real** si ese cliente existe). Además usa introspección frágil de `router.stack` para invocar el handler.

**Solución:** deshabilitarlo fuera de desarrollo:

```js
if (config.app.nodeEnv !== 'production') {
  router.post('/test', ...);
}
```

Y refactorizar: extraer la lógica del webhook a una función `processInvoiceWebhook(payload)` que tanto la ruta real como la de test invoquen directamente, eliminando los mocks de `req`/`res`.

### 1.7 MEDIO — Falta `.gitignore`

No existe `.gitignore` en el repositorio. El riesgo inmediato es que un `git add .` accidental suba `.env` (con `UISP_API_KEY` y `WHATSAPP_ACCESS_TOKEN`) y `node_modules/`.

**Solución:** crear `.gitignore` con al menos:

```
node_modules/
.env
*.log
```

Si `.env` llegó a subirse en algún momento, **rotar ambas credenciales**.

### 1.8 BAJO — Dependencias potencialmente desactualizadas

**Archivo:** `package.json`

`axios ^1.6.0` y `express ^4.18.2` tienen versiones con CVEs conocidos en sus rangos (axios: SSRF/credential leak en versiones < 1.8.x; express dependencias transitivas). El `^` permite versiones parcheadas, pero sin `package-lock.json` en el repo no hay garantía de qué se instala.

**Solución:** commitear `package-lock.json`, correr `npm audit` periódicamente y fijar axios ≥ 1.8 y express 4.21+. Considerar Dependabot/Renovate en GitHub.

---

## 2. 📈 Escalabilidad

### 2.1 Procesamiento síncrono dentro del webhook (el problema #1 de escala)

**Archivo:** `src/routes/webhook.js:7-129`

El handler hace, en serie y antes de responder: descarga del PDF (hasta 10s de timeout) → consulta del cliente → envío a Meta. Consecuencias:

- UISP tiene timeout para webhooks; si el flujo tarda, UISP **reintenta** y el cliente recibe el mensaje duplicado (no hay idempotencia, ver 2.2).
- Bajo carga (facturación recurrente masiva del plugin, que genera N facturas en un minuto), las conexiones se acumulan y el proceso se satura.

**Solución:** patrón *acknowledge-then-process*:

1. Validar el payload mínimamente y responder `200` de inmediato.
2. Encolar el trabajo. Para el tamaño actual del proyecto basta una cola en memoria con concurrencia limitada (`p-queue`); para crecer con garantía de entrega, **BullMQ + Redis** (reintentos con backoff, persistencia, dashboard).

```js
router.post('/uisp', (req, res) => {
  if (!isValidInvoiceEvent(req.body)) return res.status(400).json(...);
  res.status(200).json({ success: true, message: 'Encolado' });
  queue.add(() => processInvoiceWebhook(req.body));
});
```

### 2.2 Sin idempotencia / deduplicación

El payload de UISP incluye `uuid` de evento, pero no se usa. Ante reintentos de UISP (o el plugin de facturas recurrentes re-disparando), el cliente recibe WhatsApps duplicados — cada uno con costo y molestia.

**Solución:** guardar los `uuid` procesados (Set en memoria con TTL como mínimo; Redis `SET NX EX` para múltiples instancias) y descartar duplicados antes de procesar.

**✅ IMPLEMENTADO (v1.1.0):** idempotencia por **`invoiceId`** (más robusta que por `uuid` de evento: cubre también el duplicado webhook-nativo-vs-plugin, que llega con uuids distintos). Registro en memoria con TTL de 6h y tope de 1000 entradas (`utils/recent-keys.js`); la factura se marca solo tras un desenlace terminal exitoso, así los fallos de PDF/WhatsApp siguen siendo reintentables. Verificado con test de integración: 6 webhooks → 3 envíos (duplicados y reintentos post-éxito descartados; reintento post-fallo permitido).

### 2.3 Extracción del link de pago escaneando el PDF binario

**Archivo:** `src/services/uisp-api.js:44-114`

Descargar el PDF completo y buscar el **primer UUID** con regex es el paso más costoso (memoria + red + CPU) y el más frágil del sistema:

- El primer UUID del binario puede no ser el token de pago (los PDFs contienen UUIDs internos de fuentes/metadatos).
- Un cambio en cómo UISP genera el PDF (compresión de streams) rompería la extracción silenciosamente.

**Solución (actualizada tras revisar la documentación oficial de la API v1.0, ver sección 5):** la API **no** expone el token de pago de una factura — `InvoiceReadOnly` no incluye ningún campo `uuid`/token y `GET /payment-tokens/{token}` requiere conocer el token de antemano (no admite búsqueda por `invoiceId`). Por lo tanto la extracción desde el PDF es un workaround entendible. Mejoras posibles sin cambiar de estrategia:

- **Validar el UUID extraído contra la API (✅ VERIFICADO empíricamente el 2026-07-09):** en lugar de confiar ciegamente en el primer match, iterar sobre *todos* los UUIDs encontrados en el PDF y llamar `GET /payment-tokens/{candidato}`; el correcto es el que responde 200 con `invoiceId` igual al de la factura. Se probó contra el servidor en producción (CRM 4.5.33) con un token real **en formato con guiones** (el mismo que aparece en el PDF y en el link de pago) y respondió:

  ```json
  {"token":"550e8400-...","clientId":10,"invoiceId":1000,"quoteId":null,"amount":null}
  ```

  Es decir: el endpoint acepta el formato con guiones directamente, devuelve el `invoiceId` para contrastar con el del webhook, e incluso el `clientId` para doble verificación. Nótese que `amount` puede venir `null` y existe el campo `quoteId` (no documentado en el Blueprint) — la comparación debe hacerse contra `invoiceId`.
- **Cachear el resultado por `invoiceId`** para no re-descargar el PDF ante reintentos.

### 2.4 Sin timeout en el cliente de WhatsApp

**Archivo:** `src/services/whatsapp.js:13-19`

El axios de UISP tiene `timeout: 10000`, pero el de Meta no tiene ninguno. Una degradación de la API de Meta deja peticiones colgadas indefinidamente, acumulando sockets y memoria.

**Solución:** `timeout: 15000` en `axios.create` del servicio de WhatsApp.

### 2.5 Estado y despliegue de una sola instancia

El servicio es *stateless* (bien para escalar horizontalmente), pero faltan piezas operativas:

- **Graceful shutdown:** capturar `SIGTERM`/`SIGINT` y cerrar el servidor con `server.close()` para no cortar webhooks en vuelo durante deploys.
- **Dockerfile** y/o ecosystem de PM2 para despliegue reproducible.
- **Health check real:** `/webhook/health` consulta UISP en cada llamada — si un monitor lo consulta cada 10s, genera carga innecesaria sobre UISP. Cachear el resultado 30-60s.

---

## 3. ⚙️ Eficiencia y Calidad de Código

### 3.1 Lógica duplicada de extracción de teléfono

`webhook.js:54-56` usa solo `client.contacts[0].phone` (falla si el primer contacto no tiene teléfono pero el segundo sí), mientras `uisp-api.js:171` tiene `extractPhoneNumber()` que ya cubre `contacts[] → phone → mobile`. Además `getClientById` es un alias innecesario de `getClient`.

**Solución:** usar `extractPhoneNumber()` en ambas rutas y eliminar el alias.

### 3.2 Sin normalización de teléfonos

WhatsApp exige formato E.164 sin `+`. Si UISP guarda `998-123-4567` o `(998) 123 4567`, el envío falla. **Solución:** normalizar (quitar no-dígitos, anteponer código de país `52` si faltan dígitos) en una utilidad única, idealmente con `libphonenumber-js`.

### 3.3 Logging no estructurado

Todo es `console.log` con emojis y separadores. Para producción es difícil de filtrar, no tiene niveles ni contexto correlacionado.

**Solución:** migrar a **pino** (muy ligero): niveles (`info/warn/error`), JSON estructurado, y un `requestId` por webhook para correlacionar el flujo completo de una factura. `pino-pretty` en desarrollo conserva la legibilidad.

### 3.4 Inconsistencias en códigos de respuesta

`uisp-messaging.js:195` devuelve **200 con `success: false`** en errores (probablemente intencional para que UISP no reintente, pero no está documentado), mientras `webhook.js:114` devuelve 500 en el mismo caso (lo que sí provoca reintentos de UISP sin tener idempotencia — combinación peligrosa con 2.2).

**Solución:** decidir una política única y documentarla: si hay cola con reintentos propios, responder siempre 200 tras validar; los errores se manejan internamente.

### 3.5 Manejo de errores por `null` silencioso

`uisp-api.js` captura errores y devuelve `null` en todos los métodos; el caller luego traduce `null` a mensajes genéricos. Se pierde la causa (¿token expirado? ¿404? ¿timeout?) y en `webhook.js:41-44` un fallo de UISP termina como "Error obteniendo URL" sin distinguir si conviene reintentar.

**Solución:** lanzar errores tipados (`UispAuthError`, `UispNotFoundError`, `UispTimeoutError`) o devolver `{ ok, data, error }`, y decidir reintentos según el tipo.

### 3.6 Sin validación de esquema de payloads

La validación es manual y superficial (`data.entity`, `data.entityId`). **Solución:** definir esquemas con **zod** para ambos webhooks — documenta el contrato, rechaza basura temprano y evita `TypeError` en campos anidados.

### 3.7 Sin pruebas ni CI

No hay tests ni linting. El refactor propuesto en 1.6 (extraer `processInvoiceWebhook` como función pura de la capa HTTP) es precisamente lo que hace el código testeable.

**Solución mínima:** `vitest` o `node:test` + `supertest` para los dos webhooks (casos: payload válido, sin teléfono, entidad ignorada, sin autenticación), ESLint + Prettier, y un workflow de GitHub Actions que corra ambos en cada PR.

---

## 4. 🗂️ Estructura Propuesta (a medida que crezca)

```
src/
├── index.js               # bootstrap (app + server + shutdown)
├── app.js                 # instancia Express (separada para tests)
├── config.js
├── middleware/
│   ├── auth.js            # verificación de secreto de webhook
│   └── rate-limit.js
├── routes/                # solo HTTP: validar, encolar, responder
├── controllers/           # processInvoiceWebhook, processClientMessage
├── services/              # uisp-api, whatsapp
├── queue/                 # p-queue o BullMQ
└── utils/                 # phone.js (normalizar/enmascarar), logger.js
```

---

## 5. 📖 Revisión de la Documentación Oficial de la API (UISP CRM v1.0)

Revisión del documento `uisp_v1_api_documentacion.txt` (API Blueprint de UISP CRM, `HOST: .../crm/api/v1.0`) contrastado con el código actual.

### 5.1 ⚠️ Discrepancia de versión de API — RESUELTA: el prefijo correcto es `v1.0`

La documentación corresponde a **`/crm/api/v1.0`**, pero `.env.example` definía `UISP_BASE_URL=https://.../crm/api/v3.0`.

**Aclaración confirmada:** Ubiquiti congeló deliberadamente el prefijo de la API del CRM en `v1.0` para no romper compatibilidad con integraciones existentes, aunque la aplicación UISP esté en la rama 3.0.x. El desglose es:

- **Aplicación UISP:** rama 3.0.x (contenedor global del sistema).
- **Módulo CRM (facturación/clientes):** conocido históricamente como UCRM v3, pero sus rutas HTTP están congeladas en **`/crm/api/v1.0/`**. La documentación oficial interactiva sigue siendo la de Apiary ([unmscrm.docs.apiary.io](https://unmscrm.docs.apiary.io/)).
- **Módulo Network (NMS, antenas/routers):** API independiente bajo **`/nms/api/v2.1/`**, con Swagger auto-alojado en el propio servidor.

**Verificación empírica (2026-07-09, CRM 4.5.33):** `GET /crm/api/v3.0/invoices/{id}/pdf` y `GET /crm/api/v1.0/invoices/{id}/pdf` responden ambos `200` con la misma app key — el router del CRM **ignora el segmento de versión**, por eso la instalación en producción ha funcionado con `v3.0`. Sin embargo, `v1.0` es el único prefijo documentado y garantizado por Ubiquiti (los demás funcionan por accidente de enrutamiento y podrían dejar de hacerlo en un upgrade), así que `.env.example` y README ya fueron corregidos a `v1.0` y se recomienda actualizar igualmente el `.env` del servidor en producción.

### 5.2 ⚠️ Header de autenticación distinto al documentado

La doc indica que **toda** petición debe llevar el header **`X-Auth-App-Key`**, pero `src/services/uisp-api.js:28` envía **`X-Auth-Token`**. Si hoy funciona es porque algunas versiones de UCRM lo aceptan como alias, pero es comportamiento no documentado que puede romperse en un upgrade. Confirmado también en la guía oficial de uso de la API del CRM ([UISP CRM API Usage](https://help.uisp.com/hc/en-us/articles/22590956856087-UISP-CRM-API-Usage)): el header estándar es `X-Auth-App-Key`. **Solución:** cambiar a `X-Auth-App-Key` (una línea).

### 5.3 ✅ Confirmado: no hay forma de obtener el token de pago por API

- `InvoiceReadOnly` (esquema completo de `GET /invoices/{id}`) **no** contiene `uuid` ni token de pago.
- `GET /payment-tokens/{token}` solo permite *validar* un token ya conocido; no hay listado ni filtro por `invoiceId`.

Esto valida el workaround del PDF (sección 2.3) y a la vez habilita la mejora propuesta ahí: usar `GET /payment-tokens/{token}` para **verificar** cada UUID candidato extraído del PDF. **Verificado en producción** (ver detalle y respuesta real en la sección 2.3): el endpoint acepta el token con guiones y devuelve `invoiceId` y `clientId` para contrastar. También quedó confirmado que el servidor corre **CRM 4.5.33** y responde en `/crm/api/v1.0/` con el header `X-Auth-App-Key`, cerrando las dudas de 5.1 y 5.2.

### 5.4 ✅ Mecanismo disponible para autenticar webhooks

La doc no define ninguna firma para webhooks salientes, pero **`GET /webhook-events/{uuid}`** permite confirmar que un evento recibido existe realmente en UISP (devuelve `uuid`, `changeType`, `entity`, `entityId`). Incorporado como medida #3 en la sección 1.1. Ojo con el caveat del plugin de facturas recurrentes (eventos sintéticos).

### 5.5 💡 Selección de contacto: usar el flag `isBilling`

`ClientContact` incluye los booleanos **`isBilling`** ("Contact is used for Billing notifications") e **`isContact`**. El código actual toma `contacts[0].phone` (webhook de facturas) o el primer contacto con teléfono (mensajería). Lo correcto según el modelo de datos es **preferir el contacto con `isBilling: true`** para notificaciones de factura, con fallback al resto:

```js
const contacts = clientData.contacts || [];
const billing = contacts.find((c) => c.isBilling && c.phone?.trim());
const any = contacts.find((c) => c.phone?.trim());
const phone = (billing || any)?.phone || clientData.phone || clientData.mobile || null;
```

### 5.6 💡 Health check más ligero: `GET /version`

`validateToken()` usa `GET /clients?limit=1`, que ejecuta una consulta de clientes completa y exige permiso de lectura sobre Clients. La doc ofrece **`GET /version`** (grupo General), que valida la app key con costo mínimo. Ideal para el health check periódico (sección 2.5).

### 5.7 ℹ️ Otros datos útiles del esquema

- `GET /clients` admite filtro directo por `phone`, `email` y `userIdent` — útil si a futuro se quiere resolver el cliente a partir del número de WhatsApp (mensajes entrantes).
- `ClientReadOnly` expone `accountOutstanding`, `hasOverdueInvoice` y `hasSuspendedService` — suficientes para futuras plantillas de recordatorio de pago sin cálculos propios.
- `PATCH /invoices/{id}/regenerate-pdf` existe; si alguna vez el PDF descargado viene vacío/corrupto, se puede forzar su regeneración antes de reintentar.
- El esquema `WebhookEvent` oficial solo contiene `uuid`, `changeType`, `entity`, `entityId` — el `eventName` y `extraData` que consume el código vienen en el POST del webhook pero no se pueden re-consultar por API; por eso la verificación de 5.4 debe comparar solo los 4 campos base.

---

## 6. ✅ Priorización Recomendada

| # | Acción | Impacto | Esfuerzo |
|---|--------|---------|----------|
| 1 | Autenticación de webhooks (1.1) | Crítico | Bajo |
| 2 | Quitar token de logs + errores genéricos (1.2, 1.3) | Alto | Trivial |
| 3 | `.gitignore` + `package-lock.json` + `npm audit` (1.7, 1.8) | Alto | Trivial |
| 4 | Rate limiting + helmet + límite de body (1.5) | Alto | Bajo |
| 5 | Idempotencia por `uuid` de evento (2.2) | Alto | Bajo |
| 6 | Ack inmediato + cola de procesamiento (2.1) | Alto | Medio |
| 7 | Deshabilitar `/webhook/test` en prod + refactor a controller (1.6) | Medio | Bajo |
| 8 | Timeout en cliente WhatsApp + normalización de teléfonos (2.4, 3.2) | Medio | Bajo |
| 9 | Logger estructurado con requestId (3.3) | Medio | Medio |
| 10 | Reemplazar extracción de UUID desde PDF por API (2.3) | Medio | Medio (requiere verificar API de UISP) |
| 11 | Tests + CI (3.7) | Medio | Medio |
