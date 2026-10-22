/**
 * [v1.0.13][R1] settings.ts — durable local settings plus acknowledged model apply state.
 *
 * Model testing and model application are separate transactions.  The first-run gate may
 * enter only when the opaque fingerprint returned by /settings/test is exactly the one
 * acknowledged by /settings.  Ordinary settings remain debounced; model activation has an
 * explicit Promise, validates HTTP/JSON boundaries and reconciles after backend reconnect.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { featureEnabled } from '../shared/featureFlags';
import { runtimeHttpBase } from '../shared/runtimeEndpoints';
import { runtimeFetch } from '../shared/runtimeFetch';
import { cheapTierOf, migrateModelName, providerOf, isCustomProvider } from './modelCatalog';
import i18n, { normalizeLanguage } from '../i18n'; // [v1.0.21.3] 语言校验（i18n 不依赖 settings，无环）
import { DEFAULT_AVATAR_DATA_URL } from './defaultAvatar'; // [v1.0.23.5] 首次安装默认头像


export interface ModelBinding {
  provider: string;
  model: string;
  /** Transient user input. It is never returned by GET /settings or persisted in localStorage. */
  apiKey: string;
  /** Backend/public acknowledgement that a credential exists without exposing its value. */
  hasApiKey?: boolean;
  /** [v1.0.39.3] 展示用掩码（仅前端，不持久化/不发后端）：sk-abc****xyz。不含真实 key。 */
  apiKeyMask?: string;
  /** Explicit user intent; an empty apiKey alone always means "preserve the current key". */
  clearApiKey?: boolean;
  /** [v1.0.36] 自定义端点接入点（provider='custom' 时用户填；固定提供商为空、从目录取）。 */
  baseUrl?: string;
  sealed: boolean;
}

export const APPROVAL_TIMEOUT_OPTIONS: { value: number; label: string }[] = [
  { value: 5, label: 'settings.06' },
  { value: 10, label: 'settings.02' },
  { value: 30, label: 'settings.04' },
  { value: 60, label: 'settings.01' },
  { value: 180, label: 'settings.03' },
  { value: 300, label: 'settings.05' },
  { value: 0, label: 'global.search.08' },
];

export function agentBindingKey(projectId: string, agentId: string): string {
  return `${projectId}::${agentId}`;
}

export type ModelApplyState = 'idle' | 'pending' | 'applied' | 'failed' | 'stale';

export interface ModelApplyResult {
  ok: boolean;
  restartRequired: boolean;
  settingsRevision: number;
  appliedFingerprint: string | null;
  zinniaCompatible: boolean;
  zinniaBindingSource: string;
  welcomeState: string;
  message: string;
}

export interface SettingsState {
  userName: string;
  avatarDataUrl: string | null;
  mainModel: ModelBinding | null;
  auxModel: ModelBinding | null;
  agentModels: Record<string, ModelBinding>;
  // [v1.0.39.3] 多模型预存：清单 + 主/辅池
  modelProfiles: ModelBinding[];
  mainPoolIdxs: number[];
  auxPoolIdxs: number[];
  // [v1.0.39.3] 运行时连接状态（瞬态，不持久化）：key = `${provider}|${model}`。
  //   'ok' = 连接正常；'fail' = 连接有问题；'testing' = 测试中；缺省 = 未测。
  connState: Record<string, 'ok' | 'fail' | 'testing'>;
  // [v1.0.39.3] 全量连接测试的防并发标记与请求序号（瞬态，不持久化）。
  testingAll: boolean;
  connTestRunId: number;
  notifyDesktop: boolean;
  closeToTray: boolean;
  approvalTimeoutS: number;
  groupApprovalTimeouts: Record<string, number>;
  appearance: 'light' | 'dark';
  fontScale: 'small' | 'large';
  language: string; // [v1.0.21.3] 主要语言 'zh' | 'en'（界面 + 提示词语言）

  // Backend acknowledgement state is intentionally transient (not localStorage truth).
  modelApplyState: ModelApplyState;
  modelApplyError: string | null;
  settingsRevision: number;
  appliedFingerprint: string | null;
  zinniaCompatible: boolean;
  zinniaBindingSource: string;
  welcomeState: string;
  settingsConflict: string | null;
  restartRequired: boolean;

  setUserName: (name: string) => void;
  setAvatar: (dataUrl: string | null) => void;
  saveMainModel: (b: Omit<ModelBinding, 'sealed'>) => void;
  editMainModel: () => void;
  saveAuxModel: (b: Omit<ModelBinding, 'sealed'>) => void;
  editAuxModel: () => void;
  clearAuxModel: () => void;
  saveAgentModel: (projectId: string, agentId: string, b: Omit<ModelBinding, 'sealed'>) => void;
  editAgentModel: (projectId: string, agentId: string) => void;
  clearAgentModel: (projectId: string, agentId: string) => void;
  // [v1.0.39.3] 多模型预存：清单 + 主/辅池的操作
  addModelProfile: (b: Omit<ModelBinding, 'sealed'>) => void;
  updateModelProfile: (idx: number, b: Omit<ModelBinding, 'sealed'>) => void;
  removeModelProfile: (idx: number) => void;
  moveModelProfile: (idx: number, dir: -1 | 1) => void;
  toggleProfilePool: (idx: number, which: 'main' | 'aux') => void;
  setConnState: (key: string, state: 'ok' | 'fail' | 'testing') => void;
  clearConnState: () => void;
  testAllConnections: () => Promise<void>;
  setNotifyDesktop: (on: boolean) => void;
  setCloseToTray: (on: boolean) => void;
  setApprovalTimeout: (s: number) => void;
  setGroupApprovalTimeout: (projectId: string, s: number) => void;
  setAppearance: (m: 'light' | 'dark') => void;
  setFontScale: (f: 'small' | 'large') => void;
  setLanguage: (lang: string) => void; // [v1.0.21.3] 仅本地 state；持久化走 pushToBackend
  markModelBindingStale: () => void;
  clearRestartRequired: () => void;
  applyModelBinding: (expectedFingerprint?: string) => Promise<ModelApplyResult>;
  reconcileFromBackend: () => Promise<ModelApplyResult>;
  pushToBackend: () => Promise<ModelApplyResult>;
}

export function effectiveAuxBinding(
  main: ModelBinding | null,
  aux: ModelBinding | null,
): (ModelBinding & { derived: boolean }) | null {
  if (aux && aux.sealed) return { ...aux, derived: false };
  if (main && main.sealed) {
    // [v1.0.36] 自定义端点无便宜档，辅助跟随 = 完整复用主模型配置（含 baseUrl/key/模型）。
    if (isCustomProvider(main.provider)) {
      return { ...main, derived: true };
    }
    const cheap = cheapTierOf(main.provider) || main.model;
    return {
      provider: main.provider,
      model: cheap,
      apiKey: main.apiKey,
      hasApiKey: main.hasApiKey,
      clearApiKey: false,
      sealed: true,
      derived: true,
    };
  }
  return null;
}

export function effectiveAgentBinding(
  s: Pick<SettingsState, 'mainModel' | 'agentModels'>,
  projectId: string,
  agentId: string,
): ModelBinding | null {
  const own = s.agentModels[agentBindingKey(projectId, agentId)];
  if (own && own.sealed) return own;
  return s.mainModel && s.mainModel.sealed ? s.mainModel : null;
}

export function effectiveGroupTimeout(
  s: Pick<SettingsState, 'approvalTimeoutS' | 'groupApprovalTimeouts'>,
  projectId: string,
): number {
  const own = s.groupApprovalTimeouts[projectId];
  return typeof own === 'number' ? own : s.approvalTimeoutS;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function credentialScope(
  providerId: string,
  baseUrl?: string,
  transport?: string,
): string {
  const provider = providerOf(providerId);
  const base = (baseUrl ?? provider?.baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase();
  const wire = (transport ?? provider?.transport ?? 'openai_chat').trim().toLowerCase();
  return `${providerId.trim().toLowerCase()}\u0000${base}\u0000${wire}`;
}

function sameCredentialScope(local: ModelBinding | null | undefined, raw: JsonObject): boolean {
  if (!local) return false;
  return credentialScope(local.provider) === credentialScope(
    stringValue(raw.provider),
    stringValue(raw.base_url),
    stringValue(raw.transport) || 'openai_chat',
  );
}

function bindingWire(b: ModelBinding | null | undefined): JsonObject | null {
  if (!b || !b.sealed || !b.provider || !b.model) return null;
  const provider = providerOf(b.provider);
  const wire: JsonObject = {
    provider: b.provider,
    model: b.model,
    base_url: b.baseUrl ?? provider?.baseUrl ?? '',
    transport: provider?.transport ?? 'openai_chat',
  };
  // A redacted binding deliberately sends no credential field at all.  The backend may preserve
  // its existing key only for the exact provider/base/transport scope.  Newly typed credentials
  // are transient and cross this boundary once, during test/apply.
  if (b.apiKey) wire.api_key = b.apiKey;
  if (b.clearApiKey === true) wire.clear_api_key = true;
  return wire;
}

/** [v1.0.39.3] 序列化整组清单（每个 profile 走 bindingWire；剔除无效项保序）。 */
function bindingWires(profiles: ModelBinding[]): JsonObject[] {
  const out: JsonObject[] = [];
  for (const b of profiles) {
    const wire = bindingWire(b);
    if (wire) out.push(wire);
  }
  return out;
}

function bindingFromBackend(
  value: unknown,
  local?: ModelBinding | null,
): ModelBinding | null {
  const raw = asObject(value);
  if (!raw) return null;
  const provider = stringValue(raw.provider).trim();
  // [v1.0.19.5] 上游目录同步后，旧模型名自动迁移到当前名（如 hy3-preview → hy3）。
  const model = migrateModelName(provider, stringValue(raw.model).trim());
  if (!provider || !model) return null;
  // Old backends may still return api_key. Treat only its presence as metadata and never copy
  // the secret into renderer state. A same-scope local edit may remain transient until POST ack.
  const backendHasKey = raw.has_api_key === true || Boolean(stringValue(raw.api_key));
  const transientKey = sameCredentialScope(local, raw) ? (local?.apiKey ?? '') : '';
  return {
    provider,
    model,
    apiKey: transientKey,
    hasApiKey: backendHasKey,
    clearApiKey: false,
    baseUrl: stringValue(raw.base_url).trim(),
    sealed: true,
  };
}

function bindingSignature(binding: ModelBinding | null): string {
  if (!binding?.sealed) return '';
  return [
    credentialScope(binding.provider),
    binding.model.trim(),
    binding.hasApiKey === true || Boolean(binding.apiKey) ? 'key' : 'no-key',
  ].join('\u0000');
}

function bindingHasCredential(binding: ModelBinding | null | undefined): boolean {
  return Boolean(binding && (binding.hasApiKey === true || binding.apiKey));
}

function acknowledgedBinding(
  binding: ModelBinding | null,
  fallback?: ModelBinding | null,
): ModelBinding | null {
  if (!binding) return null;
  const cleared = binding.clearApiKey === true;
  const inherited = Boolean(
    !cleared
    && fallback
    && credentialScope(binding.provider) === credentialScope(fallback.provider)
    && bindingHasCredential(fallback),
  );
  return {
    ...binding,
    apiKey: '',
    hasApiKey: cleared ? false : (bindingHasCredential(binding) || inherited),
    clearApiKey: false,
  };
}

function persistedBinding(binding: ModelBinding | null): ModelBinding | null {
  if (!binding || !binding.sealed) return null;
  return {
    ...binding,
    apiKey: '',
    // Only a backend acknowledgement is durable metadata.  A newly typed but not-yet-saved
    // secret must never turn into a false "saved key" claim after a renderer reload.
    hasApiKey: binding.hasApiKey === true,
    clearApiKey: false,
  };
}

function persistedBindings(bindings: Record<string, ModelBinding>): Record<string, ModelBinding> {
  return Object.fromEntries(
    Object.entries(bindings).map(([key, binding]) => [key, persistedBinding(binding) as ModelBinding]),
  );
}

/** [v1.0.39.3] API Key 展示掩码：sk-abc****xyz（前4 + **** + 后4），不含真实 key。 */
function maskApiKey(key: string): string {
  const k = (key ?? '').trim();
  if (!k) return '';
  if (k.length <= 8) return '••••••••';
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}

function sealedBinding(
  binding: Omit<ModelBinding, 'sealed'>,
  previous?: ModelBinding | null,
): ModelBinding {
  const clearApiKey = binding.clearApiKey === true;
  const sameScope = Boolean(
    previous
    && credentialScope(previous.provider) === credentialScope(binding.provider),
  );
  // [v1.0.39.3] 保存瞬间捕获展示用掩码（前4+****+后4），不含真实 key；清 key 时置空。
  const apiKeyMask = clearApiKey
    ? undefined
    : binding.apiKey
      ? maskApiKey(binding.apiKey)
      : previous?.apiKeyMask;
  return {
    ...binding,
    apiKey: binding.apiKey || '',
    apiKeyMask,
    hasApiKey: clearApiKey
      ? false
      : (binding.hasApiKey === true || (sameScope && previous?.hasApiKey === true)),
    clearApiKey,
    sealed: true,
  };
}

function acknowledgePersistedSecrets(body: JsonObject): void {
  const current = useSettingsStore.getState();
  const effective = asObject(body.effective);
  const publicMain = bindingFromBackend(effective?.main_model);
  const acknowledgedMain = publicMain ?? acknowledgedBinding(current.mainModel);
  useSettingsStore.setState({
    mainModel: acknowledgedMain,
    // Backend apply permits an explicit auxiliary/Agent binding to reuse the newly persisted main
    // credential only inside the same provider/base/transport scope. Mirror that acknowledgement
    // without ever copying the credential value into renderer state or localStorage.
    auxModel: acknowledgedBinding(current.auxModel, acknowledgedMain),
    agentModels: Object.fromEntries(
      Object.entries(current.agentModels).map(([key, binding]) => [
        key,
        acknowledgedBinding(binding, acknowledgedMain) as ModelBinding,
      ]),
    ),
  });
}

function buildWirePayload(s: SettingsState): JsonObject {
  const agentModels: Record<string, unknown> = {};
  for (const [key, binding] of Object.entries(s.agentModels)) {
    const wire = bindingWire(binding);
    if (wire) agentModels[key] = wire;
  }
  return {
    user_name: s.userName,
    main_model: bindingWire(s.mainModel),
    // [v1.0.36] auxModel=null（跟随态）时发 null，不再把「派生便宜档」发给后端持久化——
    // 否则后端存了派生值，派活/对账都会把它当「显式设置」用，辅助模型就冻结在旧主模型的便宜档。
    // 后端 aux_effective 在 aux_model 为空时按主模型运行时派生（_CHEAP_TIER / custom 完整跟随）。
    aux_model: bindingWire(s.auxModel),
    agent_models: agentModels,
    // [v1.0.39.3] 多模型预存：整组清单 + 主/辅池下标（有序 = 自动路由顺序）。
    // 后端收 group 后派生 main_model/aux_model；老字段保留用于向后兼容。
    model_profiles: bindingWires(s.modelProfiles),
    main_pool: s.mainPoolIdxs,
    aux_pool: s.auxPoolIdxs,
    approval_timeout_s: s.approvalTimeoutS,
    group_approval_timeouts: { ...s.groupApprovalTimeouts },
    language: normalizeLanguage(s.language), // [v1.0.21.3]
  };
}

function errorMessage(body: JsonObject | null, status: number): string {
  const direct = body ? stringValue(body.message || body.error || body.detail).trim() : '';
  return direct || i18n.t('settings.view.applyFailed', { status });
}

function parseApplyResult(
  body: JsonObject,
  status: number,
  restartFallback = false,
): ModelApplyResult {
  const ok = body.ok === true;
  const restartRequired = typeof body.restart_required === 'boolean'
    ? body.restart_required
    : restartFallback;
  return {
    ok,
    restartRequired,
    settingsRevision: Math.max(0, Math.trunc(numberValue(body.settings_revision))),
    appliedFingerprint: stringValue(body.applied_fingerprint).trim() || null,
    zinniaCompatible: body.zinnia_compatible === true,
    zinniaBindingSource: stringValue(body.zinnia_binding_source).trim() || 'unknown',
    welcomeState: stringValue(body.welcome_state).trim() || 'unknown',
    message: ok
      ? (restartRequired
        ? i18n.t('settings.17')
        : i18n.t('settings.16'))
      : errorMessage(body, status),
  };
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let postQueue: Promise<void> = Promise.resolve();

function cancelScheduledPush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = null;
}

function schedulePush(): void {
  cancelScheduledPush();
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void postCurrentSettings(undefined, true);
  }, 400);
}

function updateBackendAckMetadata(result: ModelApplyResult): void {
  const current = useSettingsStore.getState();
  useSettingsStore.setState({
    settingsRevision: result.settingsRevision,
    appliedFingerprint: result.appliedFingerprint,
    zinniaCompatible: result.zinniaCompatible,
    zinniaBindingSource: result.zinniaBindingSource,
    welcomeState: result.welcomeState,
    restartRequired: result.ok ? result.restartRequired : current.restartRequired,
  });
}

function updateApplyState(result: ModelApplyResult, expectedFingerprint?: string): void {
  const current = useSettingsStore.getState();
  const fingerprintMatches = !expectedFingerprint
    || result.appliedFingerprint === expectedFingerprint;
  const fullyReady = result.ok && fingerprintMatches && result.zinniaCompatible;
  const error = fullyReady
    ? null
    : (!result.ok
      ? result.message
      : (!fingerprintMatches
        ? i18n.t('settings.13')
        : i18n.t('settings.14')));
  useSettingsStore.setState({
    modelApplyState: fullyReady ? 'applied' : (result.ok ? 'stale' : 'failed'),
    modelApplyError: error,
    settingsRevision: result.settingsRevision,
    appliedFingerprint: result.appliedFingerprint,
    zinniaCompatible: result.zinniaCompatible,
    zinniaBindingSource: result.zinniaBindingSource,
    welcomeState: result.welcomeState,
    restartRequired: result.ok ? result.restartRequired : current.restartRequired,
  });
}

async function postCurrentSettingsNow(
  expectedFingerprint?: string,
  silent = false,
): Promise<ModelApplyResult> {
  const state = useSettingsStore.getState();
  const payload = buildWirePayload(state);
  if (expectedFingerprint) payload.expected_fingerprint = expectedFingerprint;
  if (state.settingsRevision > 0) payload.expected_revision = state.settingsRevision;

  try {
    const response = await runtimeFetch(`${runtimeHttpBase()}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = asObject(await response.json().catch(() => null));
    if (!response.ok || !body) {
      const failed: ModelApplyResult = {
        ok: false,
        restartRequired: state.restartRequired,
        settingsRevision: body
          ? Math.max(state.settingsRevision, Math.trunc(numberValue(body.settings_revision)))
          : state.settingsRevision,
        appliedFingerprint: body
          ? (stringValue(body.applied_fingerprint).trim() || state.appliedFingerprint)
          : state.appliedFingerprint,
        zinniaCompatible: false,
        zinniaBindingSource: 'unknown',
        welcomeState: state.welcomeState,
        message: errorMessage(body, response.status),
      };
      if (!silent) updateApplyState(failed, expectedFingerprint);
      return failed;
    }
    const result = parseApplyResult(body, response.status);
    const persisted = result.ok;
    if (persisted) acknowledgePersistedSecrets(body);
    if (expectedFingerprint && result.appliedFingerprint !== expectedFingerprint) {
      result.ok = false;
      result.message = i18n.t('settings.13');
    }
    if (silent) updateBackendAckMetadata(result);
    else updateApplyState(result, expectedFingerprint);
    return result;
  } catch {
    const failed: ModelApplyResult = {
      ok: false,
      restartRequired: state.restartRequired,
      settingsRevision: state.settingsRevision,
      appliedFingerprint: state.appliedFingerprint,
      zinniaCompatible: false,
      zinniaBindingSource: 'unknown',
      welcomeState: state.welcomeState,
      message: i18n.t('settings.12'),
    };
    if (!silent) updateApplyState(failed, expectedFingerprint);
    return failed;
  }
}

function postCurrentSettings(
  expectedFingerprint?: string,
  silent = false,
): Promise<ModelApplyResult> {
  if (!silent) {
    cancelScheduledPush();
    useSettingsStore.setState({ modelApplyState: 'pending', modelApplyError: null });
  }
  // A debounced persistence POST and an explicit test→apply transaction may be
  // initiated in the same tick. Serialize them so the explicit POST reads the
  // revision produced by the ordinary save and cannot be overwritten by it.
  const operation = postQueue.then(
    () => postCurrentSettingsNow(expectedFingerprint, silent),
    () => postCurrentSettingsNow(expectedFingerprint, silent),
  );
  postQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

async function reconcileSettings(): Promise<ModelApplyResult> {
  const state = useSettingsStore.getState();
  try {
    const response = await runtimeFetch(`${runtimeHttpBase()}/settings`, { method: 'GET' });
    const body = asObject(await response.json().catch(() => null));
    if (!response.ok || !body) {
      return {
        ok: false,
        restartRequired: state.restartRequired,
        settingsRevision: state.settingsRevision,
        appliedFingerprint: state.appliedFingerprint,
        zinniaCompatible: false,
        zinniaBindingSource: 'unknown',
        welcomeState: state.welcomeState,
        message: errorMessage(body, response.status),
      };
    }

    const backendMain = bindingFromBackend(body.main_model, state.mainModel);
    const backendAux = bindingFromBackend(body.aux_model, state.auxModel);
    const backendAgentsRaw = asObject(body.agent_models);
    const backendAgents: Record<string, ModelBinding> = {};
    for (const [key, value] of Object.entries(backendAgentsRaw ?? {})) {
      const binding = bindingFromBackend(value, state.agentModels[key]);
      if (binding) backendAgents[key] = binding;
    }
    const revision = Math.max(0, Math.trunc(numberValue(body.settings_revision)));
    const conflict = Boolean(
      state.mainModel?.sealed
      && backendMain
      && bindingSignature(state.mainModel) !== bindingSignature(backendMain),
    );

    if (backendMain) {
      useSettingsStore.setState({
        mainModel: backendMain,
        // [v1.0.36] auxModel 为 null = 用户从未显式设置辅助模型（跟随主模型）。
        // 后端 aux_model 存的是 buildWirePayload 发过去的「派生便宜档」，reconcile 回传会把它
        // 当成「显式设置」污染掉跟随态——null 时保持 null，不覆盖用户意图。
        auxModel: state.auxModel ? backendAux : null,
        agentModels: backendAgents,
        userName: stringValue(body.user_name).trim() || state.userName,
        approvalTimeoutS: numberValue(body.approval_timeout_s, state.approvalTimeoutS),
        groupApprovalTimeouts: Object.fromEntries(
          Object.entries(asObject(body.group_approval_timeouts) ?? {})
            .filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
        ),
        settingsConflict: conflict
          ? i18n.t('settings.08')
          : null,
        language: normalizeLanguage(stringValue(body.language)), // [v1.0.21.3]
      });
    }

    const result = parseApplyResult(
      { ...body, ok: true, settings_revision: revision },
      response.status,
      state.restartRequired,
    );
    updateApplyState(result);

    // First install: local sealed settings exist while the backend has no binding.  Push
    // the snapshot for persistence, but activation remains stale until test→explicit apply.
    if (!backendMain && state.mainModel?.sealed && Boolean(state.mainModel.apiKey)) {
      return postCurrentSettings(undefined, true);
    }
    return result;
  } catch {
    return {
      ok: false,
      restartRequired: state.restartRequired,
      settingsRevision: state.settingsRevision,
      appliedFingerprint: state.appliedFingerprint,
      zinniaCompatible: false,
      zinniaBindingSource: 'unknown',
      welcomeState: state.welcomeState,
      message: i18n.t('settings.11'),
    };
  }
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      userName: i18n.t('settings.15'),
      avatarDataUrl: DEFAULT_AVATAR_DATA_URL, // [v1.0.23.5] 首次安装默认头像（用户当前设置的固化）
      mainModel: null,
      auxModel: null,
      agentModels: {},
      // [v1.0.39.3] 多模型预存：初始清单 + 主/辅池
      modelProfiles: [],
      mainPoolIdxs: [],
      auxPoolIdxs: [],
      connState: {},
      testingAll: false,
      connTestRunId: 0,
      notifyDesktop: true,
      closeToTray: true,
      approvalTimeoutS: 300,
      groupApprovalTimeouts: {},
      appearance: 'light',
      fontScale: 'small',
      language: 'zh',

      modelApplyState: 'idle',
      modelApplyError: null,
      settingsRevision: 0,
      appliedFingerprint: null,
      zinniaCompatible: false,
      zinniaBindingSource: 'unknown',
      welcomeState: 'unknown',
      settingsConflict: null,
      restartRequired: false,

      setUserName(name): void {
        set({ userName: name });
        schedulePush();
      },
      setAvatar(dataUrl): void { set({ avatarDataUrl: dataUrl }); },
      saveMainModel(binding): void {
        const previous = get().mainModel;
        // [v1.0.19.5] 保存前迁移旧模型名（目录同步后旧名在目录里查不到）。
        const migrated = { ...binding, model: migrateModelName(binding.provider, binding.model) };
        set({
          mainModel: sealedBinding(migrated, previous),
          agentModels: {},
          modelApplyState: 'stale',
          modelApplyError: null,
          appliedFingerprint: null,
          zinniaCompatible: false,
          settingsConflict: null,
        });
        schedulePush();
      },
      editMainModel(): void {
        const current = get().mainModel;
        if (current) set({
          mainModel: { ...current, sealed: false },
          modelApplyState: 'stale',
          modelApplyError: null,
          appliedFingerprint: null,
          zinniaCompatible: false,
        });
      },
      saveAuxModel(binding): void {
        // [v1.0.19.5] 保存前迁移旧模型名。
        const migrated = { ...binding, model: migrateModelName(binding.provider, binding.model) };
        set({ auxModel: sealedBinding(migrated, get().auxModel), modelApplyState: 'stale' });
        schedulePush();
      },
      editAuxModel(): void {
        const current = get().auxModel;
        if (current) {
          set({ auxModel: { ...current, sealed: false }, modelApplyState: 'stale' });
          return;
        }
        // [v1.0.36] 未设置 + 跟随态：用跟随值作编辑种子进入编辑态（清除 derived 标记）。
        const eff = effectiveAuxBinding(get().mainModel, null);
        const seed: ModelBinding = eff
          ? { provider: eff.provider, model: eff.model, apiKey: eff.apiKey, hasApiKey: eff.hasApiKey, clearApiKey: false, baseUrl: eff.baseUrl, sealed: false }
          : { provider: '', model: '', apiKey: '', hasApiKey: false, clearApiKey: false, baseUrl: '', sealed: false };
        set({ auxModel: seed, modelApplyState: 'stale' });
      },
      clearAuxModel(): void {
        set({ auxModel: null, modelApplyState: 'stale' });
        schedulePush();
      },
      saveAgentModel(projectId, agentId, binding): void {
        const key = agentBindingKey(projectId, agentId);
        // [v1.0.19.5] 保存前迁移旧模型名。
        const migrated = { ...binding, model: migrateModelName(binding.provider, binding.model) };
        set((current) => ({
          agentModels: {
            ...current.agentModels,
            [key]: sealedBinding(migrated, current.agentModels[key] ?? current.mainModel),
          },
        }));
        schedulePush();
      },
      editAgentModel(projectId, agentId): void {
        const key = agentBindingKey(projectId, agentId);
        set((current) => {
          const base = current.agentModels[key]
            ?? current.mainModel
            ?? {
              provider: '', model: '', apiKey: '', hasApiKey: false, clearApiKey: false, sealed: false,
            };
          return { agentModels: { ...current.agentModels, [key]: { ...base, sealed: false } } };
        });
      },
      clearAgentModel(projectId, agentId): void {
        const key = agentBindingKey(projectId, agentId);
        set((current) => {
          if (!(key in current.agentModels)) return current;
          const next = { ...current.agentModels };
          delete next[key];
          return { agentModels: next };
        });
        schedulePush();
      },
      // ── [v1.0.39.3] 多模型预存：清单 + 主/辅池 ──
      addModelProfile(binding): void {
        const migrated = { ...binding, model: migrateModelName(binding.provider, binding.model) };
        set((current) => {
          const profiles = [...current.modelProfiles, sealedBinding(migrated)];
          const newIdx = profiles.length - 1;
          // [v1.0.39.3] 新加行默认加入主池；若辅池为空（或这是唯一模型），也加入辅池，
          //   保证主/辅池各自至少 1 个，绝无 0 个。
          const mainPool = [...current.mainPoolIdxs, newIdx];
          const auxPool = current.auxPoolIdxs.length === 0 || profiles.length === 1
            ? [...current.auxPoolIdxs, newIdx]
            : current.auxPoolIdxs;
          return {
            modelProfiles: profiles,
            mainPoolIdxs: mainPool,
            auxPoolIdxs: auxPool,
            modelApplyState: 'stale',
            modelApplyError: null,
            appliedFingerprint: null,
          };
        });
        schedulePush();
      },
      updateModelProfile(idx, binding): void {
        const migrated = { ...binding, model: migrateModelName(binding.provider, binding.model) };
        set((current) => {
          if (idx < 0 || idx >= current.modelProfiles.length) return current;
          const profiles = [...current.modelProfiles];
          profiles[idx] = sealedBinding(migrated, current.modelProfiles[idx]);
          return { modelProfiles: profiles, modelApplyState: 'stale', modelApplyError: null, appliedFingerprint: null };
        });
        schedulePush();
      },
      removeModelProfile(idx): void {
        set((current) => {
          if (idx < 0 || idx >= current.modelProfiles.length) return current;
          const profiles = current.modelProfiles.filter((_, i) => i !== idx);
          // 删除后重排池下标 > idx 的项（它们整体左移一位）；直接删掉等于 idx 的引用。
          const remap = (pool: number[]): number[] =>
            pool.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i));
          // [v1.0.39.3] 主/辅池各自至少 1 个：删除后若某池变空，用剩余的最小下标补入。
          //   若清单已删空（profiles.length === 0），则池保持空（没有可补的模型）。
          let mainPool = remap(current.mainPoolIdxs);
          let auxPool = remap(current.auxPoolIdxs);
          if (profiles.length > 0) {
            if (mainPool.length === 0) mainPool = [0];
            if (auxPool.length === 0) auxPool = [0];
          }
          // mainModel/auxModel 保留为派生（= 池首成员），删除后由下次 apply 重算。
          return {
            modelProfiles: profiles,
            mainPoolIdxs: mainPool,
            auxPoolIdxs: auxPool,
            modelApplyState: 'stale',
            modelApplyError: null,
            appliedFingerprint: null,
          };
        });
        schedulePush();
      },
      moveModelProfile(idx, dir): void {
        set((current) => {
          const j = idx + dir;
          if (idx < 0 || idx >= current.modelProfiles.length || j < 0 || j >= current.modelProfiles.length) return current;
          const profiles = [...current.modelProfiles];
          // [v1.0.39.3] 非空断言：idx/j 已在 if 里校验通过（0 <= idx,j < length）
          const a = profiles[idx]!;
          const b = profiles[j]!;
          profiles[idx] = b;
          profiles[j] = a;
          const remap = (pool: number[]): number[] =>
            pool.map((i) => (i === idx ? j : i === j ? idx : i));
          return {
            modelProfiles: profiles,
            mainPoolIdxs: remap(current.mainPoolIdxs),
            auxPoolIdxs: remap(current.auxPoolIdxs),
            modelApplyState: 'stale',
            modelApplyError: null,
            appliedFingerprint: null,
          };
        });
        schedulePush();
      },
      toggleProfilePool(idx, which): void {
        set((current) => {
          const poolKey = which === 'main' ? 'mainPoolIdxs' : 'auxPoolIdxs';
          const pool = current[poolKey];
          const isRemoving = pool.includes(idx);
          // [v1.0.39.3] 不允许把某池关成 0 个：若本次是移除(关掉)且该池只剩这 1 个，则保持不变。
          if (isRemoving && pool.length === 1) return current;
          const next = isRemoving ? pool.filter((i) => i !== idx) : [...pool, idx];
          return {
            [poolKey]: next,
            modelApplyState: 'stale',
            modelApplyError: null,
            appliedFingerprint: null,
          } as Partial<SettingsState>;
        });
        schedulePush();
      },
      setConnState(key, state): void {
        set((current) => ({ connState: { ...current.connState, [key]: state } }));
      },
      clearConnState(): void {
        set({ connState: {} });
      },
      async testAllConnections(): Promise<void> {
        const state = get();
        const profiles = state.modelProfiles;
        if (profiles.length === 0) return;
        // [v1.0.39.3] 防并发抖动：测试中直接忽略新触发；请求序号丢弃过期响应。
        //   快速连点会并发多个请求，后发先回/先发后回互相覆盖 → 同一模型勾/叉乱跳。
        if (get().testingAll) return;
        const runId = (get().connTestRunId || 0) + 1;
        set({ testingAll: true, connTestRunId: runId });
        // 全部置为「测试中」。后端持有全部真实 api_key——前端不回传真 key，故必须由后端代测。
        const testing: Record<string, 'testing'> = {};
        for (const p of profiles) testing[`${p.provider}|${p.model}`] = 'testing';
        set({ connState: testing });
        try {
          const response = await runtimeFetch(`${runtimeHttpBase()}/settings/test-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          });
          const body = asObject(await response.json().catch(() => null));
          // 只接受最新一次请求的结果（序号对不上 = 已有更新一轮在跑，丢弃本轮）。
          if (get().connTestRunId !== runId) return;
          if (!body || !Array.isArray(body.results)) return;
          const next: Record<string, 'ok' | 'fail'> = {};
          for (const r of body.results) {
            const k = `${stringValue(r.provider)}|${stringValue(r.model)}`;
            if (!k || k === '|') continue;
            next[k] = r.ok === true ? 'ok' : 'fail';
          }
          set({ connState: next });
        } catch {
          // 网络/接口失败：不清空 testing 之外的旧值，仅保留当前 testing 态，
          // 避免把「正测着」误标成 ok。前端下次执行会重新拉全量。
        } finally {
          if (get().connTestRunId === runId) set({ testingAll: false });
        }
      },
      setNotifyDesktop(on): void {
        set({ notifyDesktop: on });
        syncDesktopPrefs(get());
      },
      setCloseToTray(on): void {
        set({ closeToTray: on });
        syncDesktopPrefs(get());
      },
      setApprovalTimeout(seconds): void {
        set({ approvalTimeoutS: seconds, groupApprovalTimeouts: {} });
        schedulePush();
      },
      setGroupApprovalTimeout(projectId, seconds): void {
        set((current) => ({
          groupApprovalTimeouts: { ...current.groupApprovalTimeouts, [projectId]: seconds },
        }));
        schedulePush();
      },
      setAppearance(mode): void { set({ appearance: mode }); },
      setFontScale(scale): void { set({ fontScale: scale }); },
      setLanguage(lang): void {
        // [v1.0.21.3] 仅本地 state；持久化由调用方（PrimaryLanguageModule）显式 pushToBackend。
        const normalized = normalizeLanguage(lang);
        set({ language: normalized });
      },
      markModelBindingStale(): void {
        set({
          modelApplyState: 'stale',
          modelApplyError: null,
          appliedFingerprint: null,
          zinniaCompatible: false,
        });
      },
      clearRestartRequired(): void { set({ restartRequired: false }); },
      async applyModelBinding(expectedFingerprint): Promise<ModelApplyResult> {
        if (!featureEnabled('MODEL_READINESS_GATE_V1')) {
          return postCurrentSettings(undefined, false);
        }
        return postCurrentSettings(expectedFingerprint, false);
      },
      async reconcileFromBackend(): Promise<ModelApplyResult> {
        const result = await reconcileSettings();
        syncDesktopPrefs(get());
        return result;
      },
      async pushToBackend(): Promise<ModelApplyResult> {
        const result = await postCurrentSettings(undefined, false);
        syncDesktopPrefs(get());
        return result;
      },
    }),
    {
      name: 'knowe-settings-v1',
      storage: createJSONStorage(() => localStorage),
      version: 3,
      migrate: (persistedState) => {
        const raw = asObject(persistedState);
        if (!raw) return persistedState as SettingsState;
        const redactLegacyBinding = (value: unknown): unknown => {
          const binding = asObject(value);
          if (!binding) return value;
          return {
            ...binding,
            apiKey: '',
            hasApiKey: binding.hasApiKey === true || Boolean(stringValue(binding.apiKey)),
            clearApiKey: false,
          };
        };
        const agents = asObject(raw.agentModels);
        // [v1.0.36 修复] sealed:false = 未确认的编辑草稿，不应持久化生效。
        // 升级时把历史残留的草稿态归一化为 null（跟随），前端显示与测试连接语义对齐。
        const dropDraft = (value: unknown): unknown => {
          const binding = asObject(value);
          if (binding && binding.sealed === false) return null;
          return value;
        };
        return {
          ...raw,
          mainModel: dropDraft(redactLegacyBinding(raw.mainModel)),
          auxModel: dropDraft(redactLegacyBinding(raw.auxModel)),
          agentModels: Object.fromEntries(
            Object.entries(agents ?? {}).map(([key, value]) => [key, dropDraft(redactLegacyBinding(value))]),
          ),
        } as unknown as SettingsState;
      },
      partialize: (state) => ({
        userName: state.userName,
        avatarDataUrl: state.avatarDataUrl,
        mainModel: persistedBinding(state.mainModel),
        auxModel: persistedBinding(state.auxModel),
        agentModels: persistedBindings(state.agentModels),
        // [v1.0.39.3] 多模型预存清单 + 主/辅池（localStorage 持久化，key 脱敏）
        modelProfiles: state.modelProfiles.map((p) => persistedBinding(p)),
        mainPoolIdxs: state.mainPoolIdxs,
        auxPoolIdxs: state.auxPoolIdxs,
        notifyDesktop: state.notifyDesktop,
        closeToTray: state.closeToTray,
        approvalTimeoutS: state.approvalTimeoutS,
        groupApprovalTimeouts: state.groupApprovalTimeouts,
        appearance: state.appearance,
        fontScale: state.fontScale,
        language: normalizeLanguage(state.language), // [v1.0.21.3] localStorage 持久化
      }),
    },
  ),
);

interface DesktopPrefsBridge {
  setNotifyPrefs?: (prefs: { desktop: boolean; closeToTray: boolean }) => void;
}

function syncDesktopPrefs(s: SettingsState): void {
  if (typeof window === 'undefined') return;
  const value = window as unknown as { knowe?: DesktopPrefsBridge };
  value.knowe?.setNotifyPrefs?.({ desktop: s.notifyDesktop, closeToTray: s.closeToTray });
}

export interface TestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
  testedFingerprint?: string;
  zinniaCompatible?: boolean;
}

/**
 * [v1.0.24.1] 测试任意模型绑定（含草稿态：provider/model/apiKey 未封存也可测）。
 * 后端 /settings/test 接受 binding 整体，与 testModelConnection 同一条通道。
 */
export async function testBinding(
  b: { provider: string; model: string; apiKey: string; baseUrl?: string },
  target: 'main' | 'aux' = 'main',
): Promise<TestResult> {
  if (!b.provider || !b.model) {
    return { ok: false, message: i18n.t('settings.07') };
  }
  // [v1.0.36] 自定义端点的 Base URL 格式校验：非空则必须 http(s):// 开头，否则友好提示、不发请求。
  if (isCustomProvider(b.provider) && b.baseUrl && !/^https?:\/\//i.test(b.baseUrl.trim())) {
    return { ok: false, message: i18n.t('model.binding.custom.baseUrlInvalid') };
  }
  const wire: ModelBinding = {
    provider: b.provider,
    model: b.model,
    apiKey: b.apiKey.trim(),
    baseUrl: b.baseUrl?.trim(),
    hasApiKey: Boolean(b.apiKey.trim()),
    clearApiKey: false,
    sealed: true,
  };
  try {
    const response = await runtimeFetch(`${runtimeHttpBase()}/settings/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, binding: bindingWire(wire) }),
    });
    const body = asObject(await response.json().catch(() => null));
    if (!response.ok || !body) {
      return { ok: false, message: errorMessage(body, response.status) };
    }
    const fingerprint = stringValue(body.tested_fingerprint).trim();
    const ok = body.ok === true && (!featureEnabled('MODEL_READINESS_GATE_V1') || Boolean(fingerprint));
    return {
      ok,
      message: ok
        ? (stringValue(body.message).trim() || i18n.t('settings.19'))
        : (stringValue(body.message).trim() || i18n.t('settings.09')),
      latencyMs: typeof body.latency_ms === 'number' ? body.latency_ms : undefined,
      testedFingerprint: fingerprint || undefined,
      zinniaCompatible: body.zinnia_compatible === true,
    };
  } catch {
    return { ok: false, message: i18n.t('settings.10') };
  }
}

export async function testModelConnection(target: 'main' | 'aux'): Promise<TestResult> {
  const state = useSettingsStore.getState();
  const binding = target === 'main'
    ? state.mainModel
    : effectiveAuxBinding(state.mainModel, state.auxModel);
  if (!binding || !binding.sealed) {
    return {
      ok: false,
      message: target === 'main' ? i18n.t('settings.07') : i18n.t('settings.18'),
    };
  }
  return testBinding(binding, target);
}
