'use strict';

class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.failureThreshold = options.failureThreshold || 3;
    this.resetTimeoutMs = options.resetTimeoutMs || 30_000;
    this.state = 'CLOSED';
    this.failureCount = 0;
    this.lastFailureTime = null;
  }

  async call(fn, fallbackFn) {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        console.log(`[cb:${this.name}] HALF_OPEN — probe`);
      } else {
        const err = new Error(`circuit breaker '${this.name}' is OPEN`);
        console.warn(`[cb:${this.name}] OPEN — fast-fail`);
        if (fallbackFn) return fallbackFn(err);
        throw err;
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      if (this.state === 'OPEN' && fallbackFn) return fallbackFn(err);
      throw err;
    }
  }

  _onSuccess() {
    if (this.state !== 'CLOSED') {
      console.log(`[cb:${this.name}] → CLOSED (recovered)`);
    }
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  _onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      console.error(`[cb:${this.name}] → OPEN (failures=${this.failureCount})`);
    }
  }

  getState() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
    };
  }
}

module.exports = { CircuitBreaker };
