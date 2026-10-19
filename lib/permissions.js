import { nowIso, parseDurationMinutes, randomCode } from './util.js';

export const SCOPES = {
  app_control: {
    label: '软件控制',
    detail: '启动、切换、关闭本机软件，枚举窗口',
    minutes: 30,
  },
  screen: {
    label: '屏幕读取',
    detail: '截取屏幕画面',
    minutes: 15,
  },
  input: {
    label: '模拟输入',
    detail: '模拟鼠标/键盘操作',
    minutes: 10,
  },
  filesystem: {
    label: '文件读写',
    detail: '读写工作区之外的本地文件',
    minutes: 30,
  },
  shell: {
    label: '命令执行',
    detail: '在本机执行命令',
    minutes: 10,
  },
  qzone: {
    label: 'QQ空间',
    detail: '发表QQ空间说说',
    minutes: 30,
  },
  broadcast: {
    label: '批量发送',
    detail: '向多个好友/群批量发送消息',
    minutes: 10,
  },
};

export class PermissionBroker {
  constructor({ grants, sendApproval, onChange, logger, approvalTimeoutSec = 300 }) {
    this.grants = new Map(Object.entries(grants ?? {}));
    this.requests = new Map();
    this.sendApproval = sendApproval;
    this.onChange = onChange ?? (() => {});
    this.logger = logger ?? (() => {});
    this.approvalTimeoutSec = approvalTimeoutSec;
  }

  snapshotGrants() {
    return Object.fromEntries([...this.grants.entries()]);
  }

  _prune() {
    const now = Date.now();
    for (const [scope, grant] of this.grants) {
      if (!grant || grant.expiresAt <= now) this.grants.delete(scope);
    }
    for (const [code, request] of this.requests) {
      if (request.expiresAt <= now && request.status === 'pending') request.status = 'expired';
      if (request.expiresAt + 600000 <= now) this.requests.delete(code);
    }
  }

  isGranted(scope) {
    this._prune();
    const grant = this.grants.get(scope);
    return Boolean(grant && grant.expiresAt > Date.now());
  }

  require(scope, reason) {
    if (!SCOPES[scope]) throw new Error(`未知权限作用域: ${scope}`);
    if (this.isGranted(scope)) return this.grants.get(scope);
    const error = new Error(
      `需要用户授权「${SCOPES[scope].label}」(${scope}) 才能继续：${reason}。`
      + `请先调用 qq_permission_request(scope="${scope}", reason="...")，用户在QQ里回复“同意 <授权码>”后重试。`,
    );
    error.code = 'QQ_PERMISSION_REQUIRED';
    throw error;
  }

  list() {
    this._prune();
    const now = Date.now();
    return [...this.grants.entries()].map(([scope, grant]) => ({
      scope,
      label: SCOPES[scope]?.label ?? scope,
      remainingSeconds: Math.max(0, Math.round((grant.expiresAt - now) / 1000)),
      expiresAt: new Date(grant.expiresAt).toISOString(),
      grantedAt: grant.grantedAt,
      grantedBy: grant.grantedBy,
      reason: grant.reason,
    }));
  }

  pending() {
    this._prune();
    return [...this.requests.values()]
      .filter((request) => request.status === 'pending')
      .map((request) => ({
        code: request.code,
        scope: request.scope,
        label: SCOPES[request.scope]?.label ?? request.scope,
        reason: request.reason,
        minutes: request.minutes,
        expiresAt: new Date(request.expiresAt).toISOString(),
      }));
  }

  revoke(scope) {
    const existed = this.grants.delete(scope);
    if (existed) this.onChange(this.snapshotGrants());
    return existed;
  }

  async request(scope, reason, minutesInput) {
    this._prune();
    if (!SCOPES[scope]) throw new Error(`未知权限作用域: ${scope}，可用: ${Object.keys(SCOPES).join(', ')}`);
    const reasonText = String(reason || '').trim() || '未说明用途';
    if (this.isGranted(scope)) {
      const grant = this.grants.get(scope);
      return {
        status: 'granted',
        scope,
        label: SCOPES[scope].label,
        remainingSeconds: Math.max(0, Math.round((grant.expiresAt - Date.now()) / 1000)),
        message: `「${SCOPES[scope].label}」授权仍然有效，可直接继续。`,
      };
    }
    const minutes = parseDurationMinutes(minutesInput, SCOPES[scope].minutes);
    let code = randomCode(6);
    while (this.requests.has(code)) code = randomCode(6);
    const request = {
      code,
      scope,
      reason: reasonText,
      minutes,
      status: 'pending',
      createdAt: nowIso(),
      expiresAt: Date.now() + this.approvalTimeoutSec * 1000,
    };
    this.requests.set(code, request);

    const text = [
      '【DeepSeek Harness 授权请求】',
      `权限：${SCOPES[scope].label}（${scope}）`,
      `用途：${reasonText}`,
      `时长：${minutes} 分钟`,
      `授权码：${code}`,
      '',
      `同意请回复：同意 ${code}`,
      `拒绝请回复：拒绝 ${code}`,
      `（${Math.round(this.approvalTimeoutSec / 60)} 分钟内有效）`,
    ].join('\n');

    try {
      await this.sendApproval(text);
    } catch (error) {
      request.status = 'send-failed';
      this.logger(`授权请求发送失败: ${error?.message ?? error}`);
      return {
        status: 'unavailable',
        scope,
        label: SCOPES[scope].label,
        code,
        message: `无法把授权请求发到QQ：${error?.message ?? error}。请先在QQ里私聊机器人完成配对（qq_pair），或让用户直接在这里确认。`,
      };
    }

    return {
      status: 'pending',
      scope,
      label: SCOPES[scope].label,
      code,
      minutes,
      message: `授权请求已发到QQ。请让用户回复“同意 ${code}”（或“拒绝 ${code}”）。`,
    };
  }

  async waitFor(code, seconds = 60) {
    const deadline = Date.now() + Math.max(0, Math.min(Number(seconds) || 0, 180)) * 1000;
    while (Date.now() < deadline) {
      this._prune();
      const request = this.requests.get(code);
      if (!request) return { status: 'missing', code };
      if (request.status === 'granted') {
        return {
          status: 'granted',
          scope: request.scope,
          code,
          minutes: request.minutes,
          remainingSeconds: Math.max(0, Math.round(((this.grants.get(request.scope)?.expiresAt ?? Date.now()) - Date.now()) / 1000)),
          message: `用户已授权「${SCOPES[request.scope]?.label ?? request.scope}」，可以继续。`,
        };
      }
      if (request.status === 'denied') return { status: 'denied', scope: request.scope, code, message: '用户拒绝了本次授权。' };
      if (request.status === 'expired') return { status: 'expired', scope: request.scope, code, message: '授权请求已过期。' };
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const request = this.requests.get(code);
    return {
      status: 'pending',
      scope: request?.scope,
      code,
      message: `仍在等待用户确认。请让用户在QQ回复“同意 ${code}”，然后调用 qq_permissions(action="status") 查看。`,
    };
  }

  handleApprovalText(text, uin) {
    const match = String(text || '').trim().match(/^\/?(同意|拒绝|允许|不同意|allow|deny|yes|no)\s*#?\s*(\d{4,8})$/i);
    if (!match) return { handled: false };
    const verb = match[1].toLowerCase();
    const code = match[2];
    const request = this.requests.get(code);
    if (!request) return { handled: true, reply: `授权码 ${code} 不存在或已失效。` };
    if (request.status !== 'pending') return { handled: true, reply: `授权码 ${code} 已经是「${request.status}」状态。` };
    if (request.expiresAt <= Date.now()) {
      request.status = 'expired';
      return { handled: true, reply: `授权码 ${code} 已过期，请重新发起请求。` };
    }
    const approve = ['同意', '允许', 'allow', 'yes'].includes(verb);
    if (approve) {
      request.status = 'granted';
      const expiresAt = Date.now() + request.minutes * 60000;
      this.grants.set(request.scope, {
        expiresAt,
        minutes: request.minutes,
        grantedAt: nowIso(),
        grantedBy: String(uin),
        reason: request.reason,
      });
      this.onChange(this.snapshotGrants());
      return {
        handled: true,
        approved: true,
        request,
        reply: `已授权「${SCOPES[request.scope]?.label ?? request.scope}」${request.minutes} 分钟（到期 ${new Date(expiresAt).toLocaleString('zh-CN', { hour12: false })}）。`,
      };
    }
    request.status = 'denied';
    return { handled: true, approved: false, request, reply: `已拒绝「${SCOPES[request.scope]?.label ?? request.scope}」。` };
  }
}
