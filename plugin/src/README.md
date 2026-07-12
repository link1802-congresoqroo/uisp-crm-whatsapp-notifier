# 🔔 Recurring Invoice Webhook — Plugin UISP/UCRM

Plugin que resuelve el bug de UISP 3.x donde las facturas generadas automáticamente por planes recurrentes **no disparan el webhook nativo** (`invoice.add`).

> **Parte del sistema [UISP WhatsApp Notifier](https://github.com/link1802-congresoqroo/uisp-crm-whatsapp-notifier)** — este plugin es un **componente requerido** de la instalación: sin él, el notifier solo recibe webhooks de facturas manuales y las facturas recurrentes (la mayoría en un ISP) **nunca se notifican por WhatsApp**. Ver la guía completa de instalación del sistema en el [README principal](../../README.md).

---

## ¿Por qué existe este plugin?

En UISP, el proceso de facturación recurrente (`crm:recurringInvoices:generate`) corre como un consumer asíncrono de RabbitMQ. Al ejecutarse fuera del ciclo HTTP normal de Symfony, el event dispatcher que normalmente encola los webhooks **nunca se invoca**. El resultado: las facturas manuales sí disparan el webhook, las recurrentes no.

Este plugin compensa ese comportamiento consultando la API de UISP cada minuto, detectando facturas recurrentes nuevas y disparando el mismo payload que usaría el webhook nativo.

---

## ✨ Características

- ✅ Sin dependencias externas — usa **cURL nativo de PHP**
- ✅ Payload **idéntico al webhook nativo** de UISP (`invoice.add`)
- ✅ Autenticación con el notifier vía header `X-Webhook-Secret`
- ✅ Sin pérdida de facturas: la ventana solo avanza tras corridas exitosas, con paginación (hasta 1000 facturas por corrida)
- ✅ Ventana retrasada de 60s (sin `sleep`, corridas de milisegundos) y deduplicación con `last_run.txt`
- ✅ **Alertas por WhatsApp** al administrador tras 5 corridas consecutivas con error, con aviso de recuperación
- ✅ Verificación TLS activa (usa `ucrmLocalUrl` del `ucrm.json` auto-generado por UISP)
- ✅ Compatible con **UISP 3.x / UCRM 3.x** — se ejecuta cada **1 minuto** automáticamente

---

## 📦 Instalación

### 1. Descargar el ZIP

Descarga [`plugin/uisp-recurring-invoice-webhook.zip`](../uisp-recurring-invoice-webhook.zip) del repositorio (se genera desde `plugin/src/`; el CI verifica que ambos estén sincronizados).

### 2. Crear una API Key en UISP

```
Sistema → Usuarios API → Agregar
```

Asigna permiso de **lectura en Facturas** y copia la key generada.

### 3. Subir el plugin a UISP

```
Sistema → Plugins → Subir plugin → seleccionar el ZIP → Guardar
```

### 4. Configurar el plugin

Completa los campos en la pantalla de configuración:

| Campo | Requerido | Descripción | Ejemplo |
|---|---|---|---|
| **URL base de UISP** | Sí | IP o dominio de tu servidor (si existe `ucrm.json`, se prefiere su `ucrmLocalUrl`) | `http://192.168.1.1` |
| **API Key de UISP** | Sí | Key creada en el paso 2 — recuerda actualizarla aquí si la rotas | `aB3xZ9...` |
| **Webhook URL destino** | Sí | Endpoint del notifier que recibirá el evento | `http://192.168.1.19:3000/webhook/uisp` |
| **Secreto del webhook** | Recomendado | Mismo valor que `WEBHOOK_SECRET` del notifier; se envía como header `X-Webhook-Secret` | `a1b2c3...` |
| **URL de alertas** | Opcional | Endpoint de alertas del notifier; requiere `ADMIN_PHONE` configurado allá | `http://192.168.1.19:3000/webhook/alert` |
| **Zona horaria** | Opcional | Para las fechas del panel de estado | `America/Cancun` |

### 5. Activar el plugin

Haz clic en **Activar**. El plugin comenzará a ejecutarse cada minuto.

---

## 📨 Payload enviado

El plugin envía un `POST` con `Content-Type: application/json` con el siguiente formato — idéntico al webhook nativo de UISP:

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "changeType": "insert",
  "entity": "invoice",
  "entityId": "1000",
  "eventName": "invoice.add",
  "extraData": {
    "entity": {
      "id": 1000,
      "clientId": 10,
      "number": "00099",
      "createdDate": "2026-02-24T15:00:03-0500",
      "dueDate": "2026-03-01T15:00:03-0500",
      "items": [ "..." ],
      "subtotal": 300.0,
      "total": 300.0,
      "amountPaid": 0,
      "currencyCode": "MXN",
      "status": 1
    },
    "entityBeforeEdit": null
  }
}
```

> El campo `extraData.entity` contiene el objeto completo de la factura tal como lo devuelve `GET /api/v1.0/invoices/{id}`.

---

## 📋 Criterio de detección de facturas recurrentes

Una factura se considera recurrente si cumple **alguna** de estas condiciones:

1. Tiene el flag `isAutomated: true`
2. Contiene al menos un ítem con `serviceId` (ítem de tipo servicio)

Se excluyen los **borradores** (`status: 0`).

> **Nota verificada (CRM 4.5.33):** el campo `isAutomated` **no existe** en la API v1.0, así que en la práctica el criterio activo es el de `serviceId`. Esto implica que una factura *manual* con ítem de servicio también dispara este webhook además del nativo — el duplicado lo absorbe la **idempotencia por `invoiceId` del notifier**, que descarta el segundo evento.

---

## 🪵 Logs

Los logs del plugin se pueden ver en:

```
Sistema → Plugins → Recurring Invoice Webhook → Log
```

Cada corrida escribe un panel de estado con el resultado, estadísticas del mes, la última factura enviada y el último error:

```
🕐 Última ejecución : 2026-07-11 10:32:00
▶  Resultado        : ✅ 1 webhook(s) enviado(s) exitosamente.

────────────── Estadísticas (2026-07) ───────────────
  Corridas del mes   : 4210
  Webhooks enviados  : 187
  Errores acumulados : 0
```

Resultados posibles y su causa:

| Resultado | Significado |
|---|---|
| `✅ N webhook(s) enviado(s)` | Corrida exitosa |
| `✔ Sin facturas nuevas en esta ventana` | Normal — no se generaron facturas |
| `✔ Ventana aún sin madurar` | Normal — las facturas de <60s esperan la próxima corrida |
| `❌ Error consultando API UISP — HTTP 401` | API Key incorrecta o rotada sin actualizar aquí |
| `❌ Error consultando API UISP — HTTP 4xx/5xx` | URL base incorrecta o UISP caído |
| `❌ Ningún webhook entregado — ¿notifier caído?` | El notifier no responde; la ventana se reintenta completa |
| `Errores consecutivos: N — 🚨 alerta enviada` | 5+ fallos seguidos; ya se avisó por WhatsApp al administrador |

Ante fallos, **las facturas no se pierden**: la ventana no avanza y se reintenta cada minuto hasta lograrlo.

---

## 🗂 Estructura del plugin

```
uisp-recurring-invoice-webhook/
├── manifest.json   # Definición del plugin y campos de configuración
├── main.php        # Lógica principal (cURL, sin dependencias externas)
└── README.md       # Este archivo
```

Archivos generados automáticamente en tiempo de ejecución (no incluidos en el ZIP):

```
ucrm.json           # Generado por UISP: ucrmLocalUrl, pluginAppKey (el plugin usa ucrmLocalUrl)
data/
├── config.json     # Valores guardados por el usuario en la UI
├── last_run.txt    # Fin de la última ventana procesada (antiduplicados / reintentos)
├── stats.json      # Estadísticas del mes y estado de alertas
└── plugin.log      # Panel de estado que UISP muestra en la UI
```

El código fuente vive en [`plugin/src/`](.) del repositorio y el ZIP se genera desde ahí.

---

## 🔄 Compatibilidad

| UISP / UCRM | Estado |
|---|---|
| 3.0.x | ✅ Probado |
| 2.x | ✅ Compatible |
| 1.x | ⚠️ No probado |

---

## 📝 Changelog

### v1.3.0

- **Sin `sleep(30)`:** se reemplazó por una **ventana retrasada** — cada corrida procesa facturas con ≥60s de antigüedad (mismo margen contra la race condition con `GenerateDraftsConsumer`), y termina en milisegundos en lugar de bloquear 30s cada minuto.
- **Alertas operativas (campo nuevo `alertUrl`, opcional):** tras **5 corridas consecutivas con error** (API de UISP inaccesible, key inválida, o notifier caído sin entregar ningún webhook), el plugin envía UNA alerta al endpoint `/webhook/alert` del notifier, que la reenvía por WhatsApp al administrador (`ADMIN_PHONE`). Al recuperarse, avisa la recuperación y resetea el contador. El estado se muestra en el panel del plugin (`Errores consecutivos: N — 🚨 alerta enviada`).
- **Fallo total de entrega no avanza la ventana:** si ningún webhook pudo entregarse (notifier caído), la corrida se reintenta completa en el siguiente minuto — la idempotencia del notifier absorbe cualquier repetido.

### v1.2.0

- **Confiabilidad:** `last_run.txt` se actualiza al final de la corrida — si la API de UISP falla, la ventana se conserva y las facturas se reintentan en la siguiente ejecución (antes se perdían sin aviso).
- **Paginación:** la consulta de facturas ya no está limitada a 50 por corrida; pagina hasta 1000 (día de facturación masiva cubierto).
- **Seguridad TLS:** se eliminó `CURLOPT_SSL_VERIFYPEER => false`; el plugin usa `ucrmLocalUrl` del `ucrm.json` auto-generado por UISP cuando existe (sin problemas de certificado), con fallback al campo `ucrmUrl`.
- **Nuevo campo `webhookSecret` (recomendado):** se envía como header `X-Webhook-Secret` al notifier — alternativa más limpia que agregar `?token=` a la URL.
- Los borradores (`status: 0`) ya no disparan webhook.
- Ventana de deduplicación con extremo inferior exclusivo (elimina duplicados en el segundo límite).
- Validación de zona horaria y de la respuesta de la API; limpieza de código muerto.

---

## 📄 Licencia

MIT — libre para usar, modificar y distribuir.
