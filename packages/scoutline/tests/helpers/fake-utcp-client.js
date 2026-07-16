/**
 * Test helper: FakeUtcpClient — deterministic UTCP double for offline tests.
 *
 * Records callTool({name, args}) calls in order and returns configured results
 * or throws configured errors. close() is counted.
 */
export class FakeUtcpClient {
  constructor(options = {}) {
    /** @type {Array<{name:string,args:Record<string,unknown>}>} */
    this.callToolCalls = [];
    /** @type {Array<Tool>} */
    this.discoveredTools = options.discoveredTools || [];
    /** @type {Record<string, unknown> | ((name: string, args: Record<string, unknown>) => unknown)} */
    this.resultsByName = options.resultsByName || {};
    /** @type {Record<string, Error> | ((name: string, args: Record<string, unknown>) => Error)} */
    this.errorsByName = options.errorsByName || {};
    this.closeCount = 0;
    this.registerManualCalls = 0;
  }

  setDiscoveredTools(tools) {
    this.discoveredTools = Array.isArray(tools) ? tools.slice() : [];
  }

  registerManual(_template) {
    this.registerManualCalls += 1;
    return Promise.resolve({ success: true, errors: [] });
  }

  getTools() {
    return Promise.resolve(this.discoveredTools.slice());
  }

  callTool(name, args) {
    this.callToolCalls.push({ name, args });
    const err =
      typeof this.errorsByName === "function"
        ? this.errorsByName(name, args)
        : this.errorsByName[name];
    if (err) {
      return Promise.reject(err);
    }
    const result =
      typeof this.resultsByName === "function"
        ? this.resultsByName(name, args)
        : this.resultsByName[name];
    return Promise.resolve(result);
  }

  close() {
    this.closeCount += 1;
    return Promise.resolve();
  }
}
