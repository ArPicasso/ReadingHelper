// Test double for the platform SDK's main entry point.

export { db } from './db.js';
export { api, BotApiError } from './api.js';
export { fetch } from './fetch.js';

export class InputFile {
  constructor(bytes, name, opts = {}) {
    this.bytes = bytes;
    this.name = name;
    this.type = opts.type ?? null;
  }
}

export class EndpointError extends Error {
  constructor(description, parameters) {
    super(description);
    if (typeof description !== 'string') throw new TypeError('description must be a string');
    if (parameters != null && typeof parameters !== 'object') throw new TypeError('parameters must be an object');
    this.description = description;
    this.parameters = parameters ?? {};
    this.type = 'ENDPOINT_ERROR';
  }
}

export class FormData {
  constructor() { this.entries = []; }
  append(name, value) { this.entries.push([name, value]); }
}
