/**
 * Registro en memoria de claves recientes con TTL y tamaño máximo.
 * Usado para idempotencia: recordar qué facturas ya se notificaron y
 * descartar webhooks duplicados (nativo + plugin, o reintentos).
 *
 * Limitación conocida: al ser memoria de proceso, un reinicio olvida el
 * registro. Aceptable para la ventana de duplicados real (~1 minuto entre
 * webhook nativo y plugin); para múltiples instancias se necesitaría Redis.
 */
class RecentKeys {
  constructor({ ttlMs, maxSize }) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
    this.entries = new Map(); // clave -> timestamp de expiración
  }

  has(key) {
    const expiresAt = this.entries.get(key);
    if (expiresAt === undefined) return false;
    if (Date.now() > expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  add(key) {
    if (this.entries.size >= this.maxSize) {
      // El Map conserva orden de inserción: eliminar la entrada más antigua
      this.entries.delete(this.entries.keys().next().value);
    }
    this.entries.set(key, Date.now() + this.ttlMs);
  }
}

module.exports = { RecentKeys };
