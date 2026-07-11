# 🔔 Plugin: Recurring Invoice Webhook

**Componente requerido** del sistema [UISP WhatsApp Notifier](../README.md): compensa el bug de UISP 3.x donde las facturas recurrentes no disparan el webhook nativo `invoice.add`. Sin este plugin instalado en UISP, **las facturas generadas automáticamente por planes recurrentes nunca se notifican por WhatsApp** — solo las manuales.

| Recurso | Ubicación |
|---|---|
| 📖 Documentación completa (instalación, configuración, logs, changelog) | [`src/README.md`](./src/README.md) |
| 📦 ZIP instalable en UISP | [`uisp-recurring-invoice-webhook.zip`](./uisp-recurring-invoice-webhook.zip) |
| 💻 Código fuente | [`src/`](./src/) (el ZIP se genera desde aquí; el CI verifica que estén sincronizados) |
| 🔍 Análisis de seguridad y confiabilidad | [`../ANALISIS-PLUGIN.md`](../ANALISIS-PLUGIN.md) |

**Instalación exprés:** crear API Key de solo lectura en Facturas → subir el ZIP en *Sistema → Plugins* → configurar URL de UISP, API Key, URL del webhook del notifier, el secreto compartido (`WEBHOOK_SECRET`) y la URL de alertas → activar. Detalle paso a paso en [`src/README.md`](./src/README.md).
