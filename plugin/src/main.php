<?php

declare(strict_types=1);

// Corridas consecutivas fallidas antes de disparar la alerta
const ALERT_THRESHOLD = 5;

// ============================================================
// Recurring Invoice Webhook Plugin — v1.3.0
// Dispara un webhook nativo de UISP cuando se genera una
// factura a través del proceso de facturación recurrente.
// Sin dependencias externas — usa cURL nativo de PHP.
// ============================================================

// --- Configuración del usuario (data/config.json, generado por UISP) ---
$dataDir     = getenv('PLUGIN_DATA_DIR') ?: __DIR__ . '/data';
$configFile  = $dataDir . '/config.json';
$config      = file_exists($configFile) ? json_decode(file_get_contents($configFile), true) : [];

$ucrmUrl       = rtrim($config['ucrmUrl'] ?? '', '/');
$apiKey        = $config['apiKey'] ?? '';
$webhookUrl    = rtrim($config['webhookUrl'] ?? '', '/');
$webhookSecret = trim($config['webhookSecret'] ?? '');
$alertUrl      = rtrim($config['alertUrl'] ?? '', '/');
$timezone      = $config['timezone'] ?? 'America/Cancun';

// Zona horaria inválida emitiría warning y dejaría UTC; validar antes de aplicar
if (!in_array($timezone, timezone_identifiers_list(), true)) {
    $timezone = 'America/Cancun';
}
date_default_timezone_set($timezone);

// --- ucrm.json (auto-generado por UISP junto al plugin) ---
// Provee ucrmLocalUrl: URL local para la API sin problemas de certificado,
// lo que permite mantener la verificación TLS activa en las llamadas.
$ucrmJsonFile = __DIR__ . '/ucrm.json';
$ucrmJson     = file_exists($ucrmJsonFile) ? json_decode(file_get_contents($ucrmJsonFile), true) : [];
$apiBaseUrl   = rtrim((string) ($ucrmJson['ucrmLocalUrl'] ?? ''), '/') ?: $ucrmUrl;

$lastRunFile = $dataDir . '/last_run.txt';
$statsFile   = $dataDir . '/stats.json';
// data/plugin.log es el archivo que UISP muestra en la pantalla del plugin
$pluginLog   = $dataDir . '/plugin.log';

$runTime = date('Y-m-d H:i:s');

// --- Validaciones ---
if (empty($apiBaseUrl)) {
    echo logLine("❌ ERROR: Campo 'ucrmUrl' no configurado y ucrm.json no disponible.");
    exit(1);
}
if (empty($apiKey)) {
    echo logLine("❌ ERROR: Campo 'apiKey' no configurado.");
    exit(1);
}
if (empty($webhookUrl)) {
    echo logLine("❌ ERROR: Campo 'webhookUrl' no configurado.");
    exit(1);
}

// --- Crear directorio de datos si no existe ---
if (!is_dir($dataDir)) {
    mkdir($dataDir, 0755, true);
}

// --- Cargar estadísticas acumuladas ---
$defaultStats = ['month' => date('Y-m'), 'totalRuns' => 0, 'totalWebhooksSent' => 0, 'totalErrors' => 0, 'consecutiveErrors' => 0, 'alertSent' => false, 'lastInvoice' => null, 'lastError' => null];
$stats = file_exists($statsFile)
    ? json_decode(file_get_contents($statsFile), true)
    : $defaultStats;

// --- Reset automático al inicio de cada mes (conserva el estado de alertas) ---
if (($stats['month'] ?? '') !== date('Y-m')) {
    $consecutive = $stats['consecutiveErrors'] ?? 0;
    $alertSent   = $stats['alertSent'] ?? false;
    $stats = $defaultStats;
    $stats['consecutiveErrors'] = $consecutive;
    $stats['alertSent'] = $alertSent;
}

$stats['totalRuns']++;
$stats['consecutiveErrors'] = $stats['consecutiveErrors'] ?? 0;
$stats['alertSent'] = $stats['alertSent'] ?? false;

// --- Ventana retrasada (reemplaza al antiguo sleep(30)) ---
// Se procesan facturas con al menos 60s de antigüedad: mismo margen contra la
// race condition con GenerateDraftsConsumer (UISP ejecuta el plugin antes de
// que las facturas existan en BD), pero sin bloquear el proceso cada minuto.
// last_run.txt guarda el FIN de la última ventana procesada.
if (file_exists($lastRunFile)) {
    $lastRun = (int) file_get_contents($lastRunFile);
} else {
    $lastRun = time() - 120;
}

$windowEnd = time() - 60;

if ($windowEnd <= $lastRun) {
    saveStats($statsFile, $stats);
    printStatus($stats, $runTime, '✔ Ventana aún sin madurar (facturas de <60s esperan la próxima corrida).', $pluginLog);
    exit(0);
}

// IMPORTANTE: last_run.txt se actualiza AL FINAL, solo tras una corrida
// exitosa. Si se actualizara aquí y la API fallara, las facturas de esta
// ventana se perderían sin reintento.

// --- Rango de fechas para la consulta (granularidad día; el filtro refina) ---
$dateFrom = date('Y-m-d', $lastRun);
$dateTo   = date('Y-m-d', $windowEnd + 86400);

// --- Consultar facturas con paginación ---
// El día de facturación masiva pueden generarse más de 50 facturas por
// ventana; sin paginación las excedentes se perderían silenciosamente.
$invoices  = [];
$pageSize  = 50;
$offset    = 0;
$maxPages  = 20; // tope de seguridad: 1000 facturas por corrida

for ($page = 0; $page < $maxPages; $page++) {
    $url = $apiBaseUrl . '/api/v1.0/invoices?' . http_build_query([
        'createdDateFrom' => $dateFrom,
        'createdDateTo'   => $dateTo,
        'limit'           => $pageSize,
        'offset'          => $offset,
    ]);

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'X-Auth-App-Key: ' . $apiKey,
        ],
    ]);

    $body     = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr || $httpCode >= 400) {
        // last_run.txt NO se actualizó: la próxima corrida reintenta esta ventana
        failRun($stats, $statsFile, $pluginLog, $runTime, "Error consultando API UISP — HTTP {$httpCode} {$curlErr}", $alertUrl, $webhookSecret);
    }

    $pageData = json_decode($body, true);

    if (!is_array($pageData)) {
        failRun($stats, $statsFile, $pluginLog, $runTime, 'Respuesta inesperada de la API UISP (no es una lista de facturas)', $alertUrl, $webhookSecret);
    }

    $invoices = array_merge($invoices, $pageData);

    if (count($pageData) < $pageSize) {
        break;
    }
    $offset += $pageSize;
}

// --- Filtrar facturas recurrentes en ventana de tiempo exacta ---
// Ventana (lastRun, windowEnd]: extremo inferior exclusivo para que una
// factura creada exactamente en el límite no entre en dos corridas.
$recurringInvoices = array_filter($invoices, function ($invoice) use ($lastRun, $windowEnd): bool {
    if (!is_array($invoice)) {
        return false;
    }
    $createdTs = strtotime($invoice['createdDate'] ?? '');
    if ($createdTs === false || $createdTs <= $lastRun || $createdTs > $windowEnd) {
        return false;
    }
    // Los borradores no deben notificarse (sin número aprobado ni link de pago)
    if (($invoice['status'] ?? null) === 0) {
        return false;
    }
    if (!empty($invoice['isAutomated'])) {
        return true;
    }
    foreach ($invoice['items'] ?? [] as $item) {
        if (isset($item['serviceId'])) {
            return true;
        }
    }
    return false;
});

if (empty($recurringInvoices)) {
    file_put_contents($lastRunFile, (string) $windowEnd);
    recoverIfAlerted($stats, $alertUrl, $webhookSecret);
    saveStats($statsFile, $stats);
    printStatus($stats, $runTime, "✔ Sin facturas nuevas en esta ventana.", $pluginLog);
    exit(0);
}

// --- Disparar webhook por cada factura ---
$webhookHeaders = [
    'Content-Type: application/json',
    'User-Agent: UISP-Plugin/recurring-invoice-webhook',
];
// El notifier acepta el secreto como header X-Webhook-Secret (alternativa
// más limpia que pegarlo como ?token= en la URL)
if ($webhookSecret !== '') {
    $webhookHeaders[] = 'X-Webhook-Secret: ' . $webhookSecret;
}

$sent   = 0;
$errors = 0;

foreach ($recurringInvoices as $invoice) {

    $payload = json_encode([
        'uuid'       => generateUuid(),
        'changeType' => 'insert',
        'entity'     => 'invoice',
        'entityId'   => (string) $invoice['id'],
        'eventName'  => 'invoice.add',
        'extraData'  => [
            'entity'           => $invoice,
            'entityBeforeEdit' => null,
        ],
    ]);

    $ch = curl_init($webhookUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_HTTPHEADER     => $webhookHeaders,
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr || $httpCode >= 400) {
        $errors++;
        $stats['totalErrors']++;
        $stats['lastError'] = [
            'time' => $runTime,
            'msg'  => "Webhook invoice #{$invoice['number']} — HTTP {$httpCode} {$curlErr}",
        ];
    } else {
        $sent++;
        $stats['totalWebhooksSent']++;
        $stats['lastInvoice'] = [
            'time'     => $runTime,
            'id'       => $invoice['id'],
            'number'   => $invoice['number'] ?? '?',
            'clientId' => $invoice['clientId'] ?? '?',
            'total'    => $invoice['total'] ?? '?',
            'currency' => $invoice['currencyCode'] ?? '',
        ];
    }
}

if ($sent === 0 && $errors > 0) {
    // Fallo total (notifier caído): NO avanzar la ventana — la próxima corrida
    // reintenta todas las facturas (la idempotencia del notifier absorbe repetidos)
    failRun($stats, $statsFile, $pluginLog, $runTime, "Ningún webhook entregado ({$errors} error(es)) — ¿notifier caído?", $alertUrl, $webhookSecret);
}

// Corrida completada (total o parcial): avanzar la ventana
file_put_contents($lastRunFile, (string) $windowEnd);
recoverIfAlerted($stats, $alertUrl, $webhookSecret);
saveStats($statsFile, $stats);

$summary = $errors === 0
    ? "✅ {$sent} webhook(s) enviado(s) exitosamente."
    : "⚠️  {$sent} enviado(s), {$errors} error(es).";

printStatus($stats, $runTime, $summary, $pluginLog);
exit(0);


// ============================================================
// Helpers
// ============================================================

/**
 * Registrar una corrida fallida: acumula el contador de errores consecutivos,
 * dispara la alerta al llegar al umbral (una sola vez hasta recuperarse),
 * guarda stats y termina el proceso con exit(1).
 */
function failRun(array $stats, string $statsFile, string $pluginLog, string $runTime, string $errMsg, string $alertUrl, string $webhookSecret): void
{
    $stats['totalErrors']++;
    $stats['consecutiveErrors']++;
    $stats['lastError'] = ['time' => $runTime, 'msg' => $errMsg];

    if ($stats['consecutiveErrors'] >= ALERT_THRESHOLD && !$stats['alertSent']) {
        $delivered = sendAlert(
            $alertUrl,
            $webhookSecret,
            "{$stats['consecutiveErrors']} corridas consecutivas fallando. Último error: {$errMsg}"
        );
        if ($delivered) {
            $stats['alertSent'] = true;
        }
    }

    saveStats($statsFile, $stats);
    printStatus($stats, $runTime, "❌ {$errMsg}", $pluginLog);
    exit(1);
}

/**
 * Tras una corrida exitosa: si había una alerta activa, avisar la recuperación
 * y resetear el contador de errores consecutivos.
 */
function recoverIfAlerted(array &$stats, string $alertUrl, string $webhookSecret): void
{
    if ($stats['alertSent']) {
        sendAlert($alertUrl, $webhookSecret, "Recuperado tras {$stats['consecutiveErrors']} corridas con error.");
    }
    $stats['consecutiveErrors'] = 0;
    $stats['alertSent'] = false;
}

/**
 * Enviar una alerta operativa al notifier (POST /webhook/alert), que la
 * reenvía por WhatsApp al administrador. Best-effort: un fallo aquí solo se
 * registra, nunca interrumpe el flujo del plugin.
 * @return bool true si el notifier aceptó la alerta
 */
function sendAlert(string $alertUrl, string $webhookSecret, string $message): bool
{
    if ($alertUrl === '') {
        return false;
    }

    $ch = curl_init($alertUrl);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode([
            'source'  => 'recurring-invoice-webhook',
            'message' => $message,
        ]),
        CURLOPT_HTTPHEADER     => array_filter([
            'Content-Type: application/json',
            $webhookSecret !== '' ? 'X-Webhook-Secret: ' . $webhookSecret : null,
            'User-Agent: UISP-Plugin/recurring-invoice-webhook',
        ]),
    ]);

    curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlErr  = curl_error($ch);
    curl_close($ch);

    if ($curlErr || $httpCode >= 400) {
        echo logLine("⚠️ No se pudo entregar la alerta — HTTP {$httpCode} {$curlErr}");
        return false;
    }
    return true;
}

function printStatus(array $stats, string $runTime, string $lastResult, string $pluginLog): void
{
    $li = $stats['lastInvoice'] ?? null;
    $le = $stats['lastError'] ?? null;

    $out  = "╔══════════════════════════════════════════════════════╗\n";
    $out .= "║         RECURRING INVOICE WEBHOOK — STATUS           ║\n";
    $out .= "╚══════════════════════════════════════════════════════╝\n";
    $out .= "\n";
    $out .= "🕐 Última ejecución : {$runTime}\n";
    $out .= "▶  Resultado        : {$lastResult}\n";
    $out .= "\n";
    $out .= "────────────── Estadísticas ({$stats['month']}) ───────────────\n";
    $out .= "  Corridas del mes   : {$stats['totalRuns']}\n";
    $out .= "  Webhooks enviados  : {$stats['totalWebhooksSent']}\n";
    $out .= "  Errores acumulados : {$stats['totalErrors']}\n";
    if (($stats['consecutiveErrors'] ?? 0) > 0) {
        $alerted = !empty($stats['alertSent']) ? ' — 🚨 alerta enviada' : '';
        $out .= "  Errores consecutivos: {$stats['consecutiveErrors']}{$alerted}\n";
    }
    $out .= "  (se resetea el 1° de cada mes)\n";
    $out .= "\n";

    if ($li) {
        $out .= "──────────────── Última factura enviada ──────────────\n";
        $out .= "  Fecha     : {$li['time']}\n";
        $out .= "  Factura # : {$li['number']}  (ID: {$li['id']})\n";
        $out .= "  Cliente   : {$li['clientId']}\n";
        $out .= "  Total     : {$li['total']} {$li['currency']}\n";
        $out .= "\n";
    }

    $out .= "─────────────────── Último error ─────────────────────\n";
    if ($le) {
        $out .= "  Fecha  : {$le['time']}\n";
        $out .= "  Detalle: {$le['msg']}\n";
    } else {
        $out .= "  Sin errores registrados ✅\n";
    }
    $out .= "\n";
    $out .= "══════════════════════════════════════════════════════\n";

    // Escribir al archivo plugin.log que UISP muestra en la UI
    file_put_contents($pluginLog, $out);
    echo $out;
}

function saveStats(string $file, array $stats): void
{
    file_put_contents($file, json_encode($stats, JSON_PRETTY_PRINT));
}

function logLine(string $msg): string
{
    return "[" . date('Y-m-d H:i:s') . "] {$msg}\n";
}

function generateUuid(): string
{
    $data    = random_bytes(16);
    $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
    $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}
