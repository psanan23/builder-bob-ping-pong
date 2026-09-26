const TELEGRAM_API = 'https://api.telegram.org';

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export class TelegramClient {
  constructor(token, fetchImpl = fetch) {
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
    this.token = token;
    this.fetch = fetchImpl;
  }

  async call(method, payload) {
    const response = await this.fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw new Error(`Telegram ${method} failed (${response.status}; ${body?.error_code ?? 'unknown'})`);
    }
    return body.result;
  }

  send(chatId, html, buttons) {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  answerCallback(id, text = '') {
    return this.call('answerCallbackQuery', { callback_query_id: id, text: text.slice(0, 180) });
  }

  async getFile(fileId, maxBytes = 10 * 1024 * 1024) {
    const file = await this.call('getFile', { file_id: fileId });
    if (file.file_size && file.file_size > maxBytes) throw new Error('The file is over 10 MB');
    if (!file.file_path) throw new Error('Telegram did not provide a file path');
    const response = await this.fetch(`${TELEGRAM_API}/file/bot${this.token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Telegram download failed (${response.status})`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('The file is over 10 MB');
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new Error('The file is over 10 MB');
    return data;
  }

  setWebhook(url, secret) {
    return this.call('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      max_connections: 4,
    });
  }
}
