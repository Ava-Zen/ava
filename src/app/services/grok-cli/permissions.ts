import { AgentQuestion, AgentRequestEvent, AgentRequestOption } from './types';

export function permissionOptions(request: Pick<AgentRequestEvent, 'options' | 'questions'>): AgentRequestOption[] {
  const nested = request.questions?.[0]?.options;
  if (nested?.length) return nested;
  return request.options || [];
}

export function isCommandPermission(request: Pick<AgentRequestEvent, 'method' | 'options' | 'questions'>): boolean {
  const method = request.method || '';
  if (method === 'session/request_permission') return true;
  if (
    method === 'x.ai/folder_trust/request' ||
    method === 'x.ai/ask_user_question' ||
    method === 'x.ai/exit_plan_mode'
  ) {
    return false;
  }
  return permissionOptions(request).some(option =>
    /allow[-_ ]?(once|always)|reject[-_ ]?(once|always)/i.test(option.optionId),
  );
}

export function isAllowAllOption(option: AgentRequestOption): boolean {
  return /allow[-_ ]?always|allow all|yolo/i.test(`${option.optionId} ${option.name}`);
}

export function allowOptionId(request: Pick<AgentRequestEvent, 'options' | 'questions'>): string | null {
  const options = permissionOptions(request);
  const match = (pattern: RegExp) =>
    options.find(option => pattern.test(option.optionId) || pattern.test(option.name));
  return (
    match(/allow[-_ ]?always|allow all|yolo/i)?.optionId ||
    match(/^(allow|approve|yes|trust|run)$/i)?.optionId ||
    match(/allow[-_ ]?once|\ballow\b/i)?.optionId ||
    options[0]?.optionId ||
    null
  );
}

export function permissionOptionLabel(option: AgentRequestOption): string {
  if (isAllowAllOption(option)) return 'Allow all';
  if (/allow[-_ ]?once/i.test(`${option.optionId} ${option.name}`)) return 'Allow';
  return option.name;
}

export function hasAllowAllOption(request: Pick<AgentRequestEvent, 'options' | 'questions'>): boolean {
  return permissionOptions(request).some(isAllowAllOption);
}

export function questionsOf(request: Pick<AgentRequestEvent, 'questions'>): AgentQuestion[] {
  return request.questions || [];
}
