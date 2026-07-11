/**
 * Enmascarar un número de teléfono para logs y respuestas HTTP
 * Ejemplo: 5219981234567 -> 5219***
 * @param {string} phone - Número de teléfono
 * @returns {string} Número enmascarado
 */
function maskPhone(phone) {
  if (!phone) return '(sin teléfono)';
  return String(phone).substring(0, 4) + '***';
}

module.exports = { maskPhone };
