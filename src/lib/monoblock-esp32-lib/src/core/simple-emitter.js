export class SimpleEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, handler) {
    if (typeof handler !== "function") {
      throw new TypeError("handler must be a function");
    }
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._listeners.delete(event);
  }

  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch {
        // Listener isolation is intentional.
      }
    }
  }
}
