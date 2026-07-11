# 🔍 Análisis del Plugin — Recurring Invoice Webhook

**Fecha:** 2026-07-10
**Alcance:** `plugin/uisp-recurring-invoice-webhook.zip` (`main.php`, `manifest.json`), contrastado con la [documentación oficial de UCRM-plugins](https://github.com/Ubiquiti-App/UCRM-plugins) (estructura de archivos, `ucrm.json`, convenciones de ejecución y logging).
**Nota:** Solo observaciones y soluciones propuestas; no se modificó el plugin.

---

## 1. 🚨 Seguridad

### 1.1 ALTO — Verificación TLS deshabilitada en ambas llamadas cURL

**Ubicación:** `main.php:93` y `main.php:161` (`CURLOPT_SSL_VERIFYPEER => false`)

Tanto la consulta a la API de UISP como el POST del webhook aceptan cualquier certificado. Si `ucrmUrl` es HTTPS (como en una instalación típica con dominio público), un atacante en posición de red podría interceptar la llamada y **capturar la API key** que viaja en el header, además de inyectar respuestas falsas.

**Solución (la que da la propia documentación oficial):** UCRM genera automáticamente el archivo **`ucrm.json`** junto al plugin, que incluye `ucrmLocalUrl` — una URL local para llamar a la API "evitando problemas de certificado" sin desactivar la verificación. El plugin debería:

```php
$ucrmJson = json_decode(file_get_contents(__DIR__ . '/ucrm.json'), true);
$apiUrl   = $ucrmJson['ucrmLocalUrl'] ?? $ucrmUrl; // fallback al config manual
```

y eliminar `CURLOPT_SSL_VERIFYPEER => false` (o hacerlo configurable con default seguro). Para el POST del webhook (HTTP en LAN) el flag es inocuo hoy, pero quedará armado el día que el notifier pase a HTTPS.

### 1.2 MEDIO — API key manual cuando UCRM provee una gestionada

**Ubicación:** `manifest.json` (campo `apiKey`), `main.php:20`

La doc oficial indica que `ucrm.json` incluye **`pluginAppKey`**: "an App key automatically generated for the plugin, which can be used to access UCRM API". Usarla eliminaría el campo manual y el modo de fallo que ya vivimos: **al rotar la App Key hay que acordarse de actualizar el plugin**, y si se olvida, el polling falla silenciosamente (facturas recurrentes sin notificar).

**Matiz de mínimo privilegio:** `pluginAppKey` tiene permisos de **escritura**, mientras que la key manual actual es de solo lectura sobre Facturas — estrictamente, la configuración manual es *menos* privilegio. Decisión recomendada: mantener la key manual de solo lectura, pero **detectar el 401/403 y hacerlo gritar** (ver 3.2), o migrar a `pluginAppKey` si se prefiere cero mantenimiento.

### 1.3 MEDIO — El webhook sale sin autenticación propia

**Ubicación:** `main.php:158-169`

El plugin depende de que el usuario pegue `?token=...` en el campo `webhookUrl`. Funciona (ya validado), pero es fácil de omitir y el token queda a la vista en la config.

**Solución:** agregar un campo de configuración `webhookSecret` en `manifest.json` y enviarlo como header — el middleware del notifier **ya lo acepta**:

```php
CURLOPT_HTTPHEADER => [
    'Content-Type: application/json',
    'X-Webhook-Secret: ' . $webhookSecret,
    'User-Agent: UISP-Plugin/recurring-invoice-webhook',
],
```

---

## 2. 📉 Bugs de confiabilidad (los más importantes del análisis)

### 2.1 CRÍTICO — Pérdida de facturas si una corrida falla

**Ubicación:** `main.php:77`

`last_run.txt` se actualiza con `time()` **antes** de consultar la API. Si la consulta falla (UISP caído, key rotada, timeout), el plugin hace `exit(1)` — pero la ventana ya avanzó: **las facturas de ese minuto no se reintentan nunca** y los clientes no reciben su notificación, sin que nadie lo note.

**Solución:** mover la escritura de `last_run.txt` al final, solo tras procesar con éxito. El costo es que un fallo produzca reintentos (posibles duplicados), lo cual se resuelve en pareja con la **idempotencia por `invoiceId` en el notifier** (sección 2.2 del `ANALISIS.md` principal — esta es la razón más concreta para implementarla).

### 2.2 ALTO — Sin paginación: máximo 50 facturas por corrida

**Ubicación:** `main.php:84-88` (`'limit' => 50`)

El día de facturación masiva (típicamente el 1° del mes), UISP genera todas las facturas recurrentes en pocos minutos. Si en una ventana caen más de 50, **las excedentes se pierden silenciosamente** — y como el filtro por fecha es de granularidad día, la consulta trae las facturas de todo el día, no solo las de la ventana, agotando el límite aún más rápido.

**Solución:** paginar con `offset` hasta que la API devuelva menos de `limit` resultados, y pedir orden explícito (`order=createdDate&direction=DESC` — el endpoint `/invoices` lo soporta según la doc de la API).

### 2.3 MEDIO — El heurístico de "recurrente" puede duplicar notificaciones

**Ubicación:** `main.php:118-132`

Una factura cuenta como recurrente si `isAutomated` **o si algún item tiene `serviceId`**. Pero una factura **manual** con un item de servicio también cumple la segunda condición — y esa factura **ya disparó el webhook nativo** de UISP. Resultado: el cliente recibe **dos WhatsApps** por la misma factura.

**Solución:** si `isAutomated` está presente y es confiable en tu versión de UISP, usar solo ese flag. Verificarlo es un curl: crear una factura manual con servicio y revisar el JSON. Si no es confiable, de nuevo: idempotencia por `invoiceId` en el notifier resuelve ambos lados.

**✅ VERIFICADO (2026-07-10, CRM 4.5.33):** `GET /invoices?limit=10` contra el servidor en producción — **el campo `isAutomated` no existe** en ninguna factura (tampoco aparece en la documentación oficial de la API v1.0). Conclusiones:

1. El check `!empty($invoice['isAutomated'])` del plugin **nunca se activa**: el filtro depende al 100% del heurístico de `serviceId`, y el riesgo de notificación duplicada (webhook nativo + plugin) en facturas manuales con servicio **es real**.
2. Se mantiene el check en el código como future-proofing inofensivo (si un upgrade agrega el campo, empieza a funcionar; mientras no exista, no altera el comportamiento).
3. **La única defensa robusta es la idempotencia por `invoiceId` en el notifier** (sección 2.2 del `ANALISIS.md` principal): descarta el segundo webhook del mismo `invoiceId` sin importar su origen (nativo, plugin, o reintento).

### 2.4 MEDIO — No filtra borradores ni proformas

El query trae facturas en cualquier estado. Si UISP está configurado para generar las recurrentes **como borrador** (`draft`), el plugin notificaría facturas sin aprobar (número `null`, PDF posiblemente inexistente). **Solución:** filtrar `status` (excluir `0` = Draft) o pedir `statuses[]` en el query, y saltar proformas si no aplican.

### 2.5 BAJO — Frontera de ventana inclusiva en ambos extremos

El filtro acepta `createdTs >= lastRun` y `<= now`, y la siguiente corrida empieza en `lastRun = now`: una factura creada exactamente en el segundo límite entra en ambas ventanas (duplicado raro pero posible). **Solución:** hacer un extremo exclusivo (`> lastRun`).

---

## 3. ⚙️ Eficiencia y buenas prácticas

### 3.1 El `sleep(30)` quema la mitad de cada ventana de ejecución

**Ubicación:** `main.php:54`

Con `executionPeriod: 1` (cada minuto), dormir 30s en cada corrida deja al proceso vivo la mitad del tiempo (la doc confirma que `.ucrm-plugin-running` evita corridas concurrentes, así que no hay solapamiento — pero sí desperdicio). **Solución sin dormir:** procesar con retraso deliberado — consultar la ventana `[lastRun-60s, now-60s]`. Las facturas siempre tienen ≥60s de antigüedad al procesarse (el mismo margen que hoy da el sleep), la corrida termina en milisegundos y la notificación llega igual de rápido en la práctica.

### 3.2 Los errores solo se ven si alguien abre la pantalla del plugin

Los fallos van a `stats.json`/`plugin.log`, pero nada avisa. Combinado con 2.1, un 401 por key rotada puede pasar semanas sin detectarse. **Solución mínima:** ante N errores consecutivos (p. ej. 5), mandar un POST al propio notifier a un endpoint de alerta (o directamente el mensaje de error como webhook), para que el equipo lo vea por WhatsApp/logs centralizados. Guardar `consecutiveErrors` en `stats.json`.

### 3.3 Código muerto y detalles menores

- **`main.php:27-28`:** se asigna `$pluginLog` dos veces — la primera línea es código muerto (y la ubicación final `data/plugin.log` es la correcta según la doc, que la muestra en la UI del plugin; el comentario de la línea 26 dice lo contrario y está desactualizado).
- **`stats['totalRuns']`** se incrementa pero nunca se muestra en `printStatus`, y el reset mensual lo borra igual que a los contadores "acumulados" — decidir si es mensual (renombrar) o acumulado (no resetear).
- **`manifest.json → information.url`** apunta al repo genérico de Ubiquiti; debería apuntar al repo propio (procedencia clara del código que corre en el servidor).
- **`json_decode` sin validar:** si la API devuelve un error JSON (objeto, no lista), `array_filter` itera valores no-array y el callback tipado (`array $invoice`) lanza `TypeError` con `strict_types`. Validar `is_array($invoices) && array_is_list($invoices)` antes de filtrar.
- **Zona horaria como texto libre:** `date_default_timezone_set()` con un valor inválido emite warning y sigue en UTC; validar contra `timezone_identifiers_list()` o usar el tipo `choice` en el manifest.

### 3.4 El código fuente del plugin no está versionado

En el repo solo vive el `.zip`. Un cambio al plugin no tiene diff revisable ni historia. **Solución:** versionar `plugin/src/` (`main.php`, `manifest.json`, `README.md`) y generar el zip como artefacto (el SDK oficial de UCRM incluye un *pack script* justo para esto); el zip puede seguir commiteado para instalación directa, pero generado desde el fuente.

---

## 4. ✅ Lo que el plugin hace bien

- `declare(strict_types=1)` y sin dependencias externas (cURL nativo), como recomienda el ecosistema de plugins.
- Payload **idéntico al webhook nativo** (`uuid` v4 correcto vía `random_bytes`, `changeType`/`entity`/`eventName` consistentes) — por eso el notifier lo procesa sin ramas especiales.
- Usa `data/` para estado persistente (sobrevive actualizaciones del plugin, según la doc oficial) y `data/plugin.log` para el panel de UISP.
- Timeouts explícitos en ambas llamadas cURL (15s/10s) — mejor que el propio notifier antes del análisis.
- Ventana de deduplicación simple y legible; estadísticas visibles para el operador en la UI.

---

## 5. 📋 Priorización sugerida

| # | Acción | Impacto | Esfuerzo | Estado |
|---|--------|---------|----------|--------|
| 1 | Mover `last_run.txt` al final de la corrida (2.1) + idempotencia por `invoiceId` en el notifier | Crítico | Bajo | ✅ Plugin v1.2.0 + idempotencia por `invoiceId` en el notifier |
| 2 | Paginación en la consulta de facturas (2.2) | Alto | Bajo | ✅ Plugin v1.2.0 (hasta 1000/corrida) |
| 3 | Quitar `CURLOPT_SSL_VERIFYPEER => false` usando `ucrmLocalUrl` de `ucrm.json` (1.1) | Alto | Bajo | ✅ Plugin v1.2.0 |
| 4 | Header `X-Webhook-Secret` desde config (1.3) | Medio | Trivial | ✅ Plugin v1.2.0 (campo nuevo en manifest) |
| 5 | Filtro de borradores/proformas y revisión del heurístico `isAutomated` (2.3, 2.4) | Medio | Bajo | 🔶 Borradores filtrados; **verificado: `isAutomated` no existe en CRM 4.5.33** → la solución al duplicado es idempotencia en el notifier |
| 6 | Reemplazar `sleep(30)` por ventana retrasada (3.1) | Medio | Bajo | ✅ Plugin v1.3.0 (corridas de ~40ms) |
| 7 | Alerta ante errores consecutivos (3.2) | Medio | Medio | ✅ Plugin v1.3.0 + endpoint /webhook/alert en el notifier (WhatsApp a ADMIN_PHONE, alerta única al 5° fallo y aviso de recuperación) |
| 8 | Versionar el fuente del plugin en `plugin/src/` (3.4) | Medio | Trivial | ✅ Fuente versionado; el zip se genera desde `plugin/src/` |
| 9 | Limpiezas menores (3.3) | Bajo | Trivial | ✅ Plugin v1.2.0 |

**Verificación de v1.2.0:** probado contra un mock de la API de UISP — paginación (53 facturas en 2 páginas), filtro de borradores y de ventana, header `X-Webhook-Secret` en los 51 webhooks resultantes, `last_run.txt` avanzando solo en corridas exitosas (fallo de API HTTP 500 → ventana preservada), y preferencia de `ucrmLocalUrl` sobre el `ucrmUrl` manual.
