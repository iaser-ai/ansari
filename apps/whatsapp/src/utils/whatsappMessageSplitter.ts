export const WHATSAPP_MAX_MESSAGE_LENGTH = 4_096;
export const WHATSAPP_MAX_MESSAGES_PER_ANSWER = 10;

function boundaryBeforeLimit(text: string): number {
  const asCodePoints = (index: number) => [...text.slice(0, index)].length;
  const boundaries: number[] = [];

  for (const match of text.matchAll(/\n\n+/g)) {
    boundaries.push(asCodePoints(match.index! + match[0].length));
  }
  for (const match of text.matchAll(/[.!?؟。！？][ \t]+/g)) {
    boundaries.push(asCodePoints(match.index! + match[0].length));
  }
  for (const match of text.matchAll(/\s+/g)) {
    boundaries.push(asCodePoints(match.index! + match[0].length));
  }

  const limit = [...text].length;
  return boundaries.filter((boundary) => boundary >= limit / 2).sort((a, b) => b - a)[0] ?? limit;
}

function splitMessage(text: string): string[] {
  const remaining = [...text];
  const parts: string[] = [];

  while (remaining.length > WHATSAPP_MAX_MESSAGE_LENGTH) {
    const candidate = remaining.slice(0, WHATSAPP_MAX_MESSAGE_LENGTH).join('');
    const splitAt = boundaryBeforeLimit(candidate);
    parts.push(remaining.splice(0, splitAt).join(''));
  }

  if (remaining.length > 0) parts.push(remaining.join(''));
  return parts;
}

export function prepareWhatsAppMessages(messages: string[]): string[] {
  const parts = messages.filter((message) => message.trim() !== '').flatMap(splitMessage);
  if (parts.length > WHATSAPP_MAX_MESSAGES_PER_ANSWER) {
    throw new Error(`Answer exceeds the ${WHATSAPP_MAX_MESSAGES_PER_ANSWER}-message WhatsApp limit`);
  }
  return parts;
}
