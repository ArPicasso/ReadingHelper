// Test double for `sdk/api`: records Bot API calls instead of making them.

const calls = [];
const files = new Map();
let messageId = 1000;
let failNext = null;

export class BotApiError extends Error {
  constructor(code, description, method, parameters) {
    super(`${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.method = method;
    this.parameters = parameters ?? {};
  }
}

function handle(method, params) {
  calls.push({ method, params });

  if (failNext && failNext.method === method) {
    const { code, description } = failNext;
    failNext = null;
    throw new BotApiError(code, description, method, {});
  }

  switch (method) {
    case 'sendMessage':
    case 'sendDocument':
    case 'sendPhoto':
      return {
        message_id: messageId++,
        chat: { id: params.chat_id },
        text: params.text ?? params.caption ?? '',
      };
    case 'editMessageText':
    case 'answerCallbackQuery':
    case 'sendChatAction':
    case 'setMyCommands':
      return true;
    case 'getMe':
      return { id: 777, is_bot: true, username: 'reading_helper_bot' };
    case 'getFileContent': {
      const id = typeof params === 'string' ? params : params?.file_id;
      if (!files.has(id)) throw new BotApiError(400, 'Bad Request: file not found', method, {});
      return files.get(id);
    }
    default:
      return {};
  }
}

export const api = new Proxy({}, {
  get(_target, method) {
    if (method === 'then') return undefined; // never look like a promise
    return async (params) => handle(String(method), params);
  },
});

export function __reset() {
  calls.length = 0;
  files.clear();
  messageId = 1000;
  failNext = null;
}

export const __calls = calls;
export const __setFileContent = (fileId, bytes) => files.set(fileId, bytes);
export const __failNext = (method, code = 400, description = 'Bad Request') => {
  failNext = { method, code, description };
};
/** Text of every message sent, in order — what the user would have seen. */
export const __texts = () => calls
  .filter((c) => c.method === 'sendMessage')
  .map((c) => c.params.text);
export const __lastCall = (method) => [...calls].reverse().find((c) => c.method === method) ?? null;

export default api;
