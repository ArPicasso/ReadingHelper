// Test double for `sdk/fetch`. The bot makes no outbound HTTP calls, so any use
// here is a mistake worth failing loudly on.

export async function fetch() {
  throw new Error('sdk fetch is not stubbed: the bot is not expected to make HTTP calls');
}
fetch.body = {
  json: (v) => ({ kind: 'json', value: v }),
  form: (v) => ({ kind: 'form', value: v }),
  text: (v) => ({ kind: 'text', value: v }),
};
export default fetch;
