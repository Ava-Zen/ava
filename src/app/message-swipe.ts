export function messageSwipeKey(message: { role: string; id?: string; timestamp: Date }): string {
  return `${message.role}-${message.id ?? message.timestamp.getTime()}`;
}

/** Horizontal swipe wins once it clearly beats vertical scrolling. */
export function swipeIntent(dx: number, dy: number, slop = 10): 'horizontal' | 'vertical' | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < slop && ay < slop) return null;
  return ax > ay * 1.2 ? 'horizontal' : 'vertical';
}

/** Left is delete (iOS Mail and most lists). Right copies into the composer. */
export function swipeCommitAction(dx: number, threshold = 72): 'delete' | 'edit' | null {
  if (dx <= -threshold) return 'delete';
  if (dx >= threshold) return 'edit';
  return null;
}

export function nextMessageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function isSameMessage(
  msg: { role: string; id?: string; text?: string; timestamp: Date },
  target: { role: string; id?: string; text?: string; timestamp: Date },
): boolean {
  if (msg === target) return true;
  if (msg.id && target.id && msg.id === target.id) return true;
  return msg.role === target.role
    && msg.text === target.text
    && msg.timestamp.getTime() === target.timestamp.getTime();
}

/** True only for the intended bubble. Missing ids must not match each other. */
export function isMessageTarget(
  msg: { id?: string },
  target: { id?: string },
): boolean {
  if (msg === target) return true;
  return !!msg.id && !!target.id && msg.id === target.id;
}

export function rubberbandSwipe(dx: number, limit = 128): number {
  const cap = Math.max(48, limit);
  const sign = Math.sign(dx) || 1;
  const mag = Math.abs(dx);
  if (mag <= cap) return dx;
  return sign * (cap + (mag - cap) * 0.28);
}
