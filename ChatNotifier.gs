// --- GOOGLE CHAT PRIVATE NOTIFICATIONS (no Google Cloud project required) ---
//
// Each person who wants Chat alerts creates a Chat space containing only themselves,
// adds an incoming webhook to it (Space name > Apps & integrations > Webhooks), and gives
// the webhook URL to the Admin, who records it in the 'Chat_Webhooks' sheet:
//   Email Address | Webhook URL | Status ("Active" to receive messages)
// Messages are then delivered privately to that person. Email remains the primary channel;
// a Chat failure is logged and never interrupts a payment step.

const CHAT_WEBHOOKS_SHEET = 'Chat_Webhooks';
const CHAT_WEBHOOK_PREFIX = 'https://chat.googleapis.com/';

/** One-time setup: creates the Chat_Webhooks sheet with its headers. Run from the Apps Script editor. */
function setupChatWebhooksSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss.getSheetByName(CHAT_WEBHOOKS_SHEET)) return;
  const sheet = ss.insertSheet(CHAT_WEBHOOKS_SHEET);
  sheet.getRange('A1:C1').setValues([['Email Address', 'Webhook URL', 'Status']]).setFontWeight('bold');
  sheet.setFrozenRows(1);
}

/** Returns Map<lowercase email, webhook URL> for all Active rows with a valid Google Chat webhook URL. */
function _getChatWebhookMap() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CHAT_WEBHOOKS_SHEET);
  const map = new Map();
  if (!sheet || sheet.getLastRow() < 2) return map;
  sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach(([email, url, status]) => {
    const cleanUrl = (url || '').toString().trim();
    // Only post to Google Chat webhooks so a mistyped or malicious entry cannot send data elsewhere.
    if (email && status === 'Active' && cleanUrl.startsWith(CHAT_WEBHOOK_PREFIX)) {
      map.set(email.toString().trim().toLowerCase(), cleanUrl);
    }
  });
  return map;
}

/**
 * Sends a private Chat message to each listed person who has an Active webhook.
 * @param {string|string[]} recipients Comma-separated string or array of email addresses.
 * @param {string} title Bold heading of the message.
 * @param {string[]} lines Body lines (plain text; use *bold* for emphasis).
 * @param {string=} linkUrl Optional link appended to the message.
 * @param {string=} linkLabel Label for the link.
 */
function notifyChat(recipients, title, lines, linkUrl, linkLabel) {
  try {
    const emails = (Array.isArray(recipients) ? recipients : recipients.toString().split(','))
      .map(e => e.trim().toLowerCase()).filter(Boolean);
    const webhooks = _getChatWebhookMap();
    let text = `*${title}*\n${lines.join('\n')}`;
    if (linkUrl) text += `\n<${linkUrl}|${linkLabel || 'Open'}>`;

    emails.forEach(email => {
      const url = webhooks.get(email);
      if (!url) return;
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json; charset=UTF-8',
        payload: JSON.stringify({ text: text }),
        muteHttpExceptions: true
      });
      if (response.getResponseCode() !== 200) {
        console.error(`Chat notification to ${email} failed (${response.getResponseCode()}).`);
      }
    });
  } catch (e) {
    console.error(`Chat notification error: ${e.message}`);
  }
}

/** Test helper: sends a sample message to the given registered email. */
function testChatNotification() {
  notifyChat('your.email@dap.edu.ph', 'E-Payment Test', ['This is a test notification from the DAP E-Payment System.']);
}
