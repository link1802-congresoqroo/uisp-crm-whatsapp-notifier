/**
 * Limpiar texto para parámetros de plantillas de WhatsApp.
 * WhatsApp no permite saltos de línea, tabulaciones ni múltiples espacios
 * en los parámetros de plantilla.
 * @param {string} text - Texto a limpiar
 * @returns {string} Texto limpiado
 */
function cleanTextForWhatsApp(text) {
  if (!text) return '';

  return String(text)
    .replace(/\n/g, ' ')
    .replace(/\r/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

module.exports = { cleanTextForWhatsApp };
