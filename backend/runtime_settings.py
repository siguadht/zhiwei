# [v1.0.13][R1] Model apply acknowledgements, readiness state and idempotent wake signals.
"""
runtime_settings.py — [v0.44] 设置面板下发的**运行时设置**（Harness 层的唯一权威）

摆放位置：backend/runtime_settings.py（与 config.py 同包）

── 为什么单独一个模块 ──
config.py 是「装机常量」：进程起来就定死（frozen dataclass）。设置面板要的是
「运行中可改、重启后还在」——两种生命周期硬塞一起会互相打架。于是：

    CONFIG.approval_timeout_s  ← 改成了 property，转发到本模块（config.py [v0.44]）
    engine._new_agent(...)     ← 先问本模块要模型绑定，问不到再落回 CONFIG.deepseek_*
    server.py /settings        ← HTTP 入口，收到就 apply() + 落盘

── 三条硬规矩（README §2.3 / §3.2 / §3.3）──
 1. 全局覆盖个性：apply() 里只要检测到 main_model 变了 → 清空全部 per-Agent 绑定；
    approval_timeout_s 变了 → 清空全部群级超时。前端也做同样的清空，但**这里是兜底
    权威**——哪怕来包的是个老版本前端，规矩也立得住。
 2. 审批超时按「群级 > 全局」解析，群从 contextvar 里拿（engine._loop 进场即登记，
    propose 都发生在 _loop 的后代任务里，contextvar 自动继承——gate.py 一行不用改）。
 3. 「永不超时」在权威状态中就是 None；只有展示层需要时才使用远期日期。
    前端下发 null / 0 都归一到 None，Gate 不创建自动 timeout 任务。

── Key 的去向 ──
两种模式，看机器上有没有 `.env`（由 config.py 的 python-dotenv 读进来）：

 · **`.env` 模式（发布/开源推荐）**：设了 `KNOWE_MODEL_API_KEY` 之后，本机所有模型绑定
   的密钥都从环境变量取，**settings.json 里一份明文都不留**（启动时顺手把历史遗留的
   明文抹掉）。此模式下在设置界面里粘的 key 只活到下次重启——`.env` 才是权威。
   可用 `KNOWE_MODEL_PROVIDER` / `KNOWE_MODEL_BASE_URL` 把这把 key 的作用范围收窄到某个厂商；
   不写就是"这台机器一把 key 管全部绑定"。收窄到一个绑定都不命中时，视为这把 key 与本机
   无关——不封口、照旧落盘，绝不静默抹掉用户已有的 key。`DEEPSEEK_API_KEY` 是老部署的兼容位，同样生效。

 · **无 `.env` 模式（历史行为，一字未改）**：key 随设置落在 CONFIG.data_dir/settings.json
   （0600 权限），与 DEEPSEEK_API_KEY 环境变量同一台机器、同一信任边界；不出本机。
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import stat
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Iterator, Mapping

from knowe_core.provider_identity import http_status_error_message, provider_target
from .i18n_backend import msg

log = logging.getLogger("knowe.settings")


class SettingsApplyConflict(ValueError):
    """The tested binding is no longer the binding being applied."""

#: 「永不超时」的实际秒数：100 年。够所有实际用途当作永不；又是普通 float，
#: gate 里任何 `asyncio.wait_for(..., timeout=...)` / `now + timeout` 的算术都装得下。
NEVER_TIMEOUT_S: float = 3_153_600_000.0

#: 出厂默认：审批等待没有自动墙钟截止，由用户或外部取消显式落定。
DEFAULT_APPROVAL_TIMEOUT_S: float | None = None

# ═══════════════════════════════════════════════════════════════
# 当前项目 contextvar（engine._loop 进场登记；propose 在其后代任务里自动继承）
# ═══════════════════════════════════════════════════════════════

_current_project: ContextVar[str | None] = ContextVar("knowe_current_project", default=None)


def set_current_project(project_id: str | None) -> object:
    """登记当前任务树属于哪个项目。返回 token，可用于 reset。"""
    return _current_project.set(project_id)


def reset_current_project(token: object) -> None:
    try:
        _current_project.reset(token)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 — token 跨任务失效时静默（兜底路径）
        pass


@contextmanager
def project_context(project_id: str | None) -> Iterator[None]:
    """with 版：`with project_context(pid): ...`（Engine.__init__ 造 Gate 时用）。"""
    token = _current_project.set(project_id)
    try:
        yield
    finally:
        try:
            _current_project.reset(token)
        except Exception:  # noqa: BLE001
            pass


# ═══════════════════════════════════════════════════════════════
# 状态 + 持久化
# ═══════════════════════════════════════════════════════════════

def _default_state() -> dict[str, Any]:
    return {
        # [v1.0.13 R1] Persisted revision and per-install HMAC salt.  The salt never
        # leaves this module; clients receive only opaque ``sha256:<digest>`` values.
        "settings_revision": 0,
        "fingerprint_salt": secrets.token_hex(32),
        "active_model_fingerprint": None,
        "user_name": "",                    # 空 = 前端还没下发过，取用方自兜底「用户」
        "language": "zh",                   # [v1.0.21.3] 主要语言：'zh' | 'en'（界面 + 提示词语言）
        "main_model": None,                 # {provider, model, api_key, base_url, transport}
        "aux_model": None,                  # 同上（前端已把「跟随主模型便宜档」派生好再发）
        # [v1.0.39.3] 多模型预存切换：全部清单 + 主/辅池（池 = model_profiles 的下标列表，有序）
        "model_profiles": [],               # [ {provider, model, api_key, base_url, transport}, ... ]
        "main_pool": [],                    # 主池：model_profiles 下标，按序路由
        "aux_pool": [],                     # 辅池：model_profiles 下标，按序路由
        "agent_models": {},                 # {"<project_id>::<agent_id>": binding}
        "approval_timeout_s": DEFAULT_APPROVAL_TIMEOUT_S,   # None = 永不
        "group_approval_timeouts": {},      # {project_id: seconds | None}
    }


_state: dict[str, Any] = _default_state()
_loaded = False
_model_waiters: set[asyncio.Event] = set()


def _settings_path() -> Path | None:
    """settings.json 的落点：CONFIG.data_dir 下。纯内存模式（data_dir 空）→ 不落盘。"""
    from .config import CONFIG  # 局部 import：config.property → 本模块，避免环
    raw = (CONFIG.data_dir or "").strip()
    if not raw:
        return None
    return Path(raw).expanduser() / "settings.json"


def _ensure_loaded() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True
    path = _settings_path()
    if path is None or not path.exists():
        # 全新安装（还没落过盘）也要认 .env，否则首启时环境变量里的 key 白费。
        _seal_from_env(_state)
        return
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            base = _default_state()
            base.update({k: raw[k] for k in base.keys() & raw.keys()})
            if not str(base.get("fingerprint_salt") or "").strip():
                base["fingerprint_salt"] = secrets.token_hex(32)
            try:
                base["settings_revision"] = max(0, int(base.get("settings_revision") or 0))
            except (TypeError, ValueError):
                base["settings_revision"] = 0
            _state.update(base)
            # Upgrade compatibility: a pre-v1.0.13 persisted main binding was already
            # effective in production, so activate it once during migration.  A truly
            # new install starts without a binding and still requires test→apply.
            if raw.get("main_model") and "active_model_fingerprint" not in raw:
                _state["active_model_fingerprint"] = binding_fingerprint(raw.get("main_model"))
            # [v1.0.39.3] 旧数据迁移：只有单组 main/aux、无 model_profiles → 封装成清单一组 + 池首条。
            # 老用户不丢配置，且新池路由从这组开始。
            if not raw.get("model_profiles"):
                migrated = _migrate_legacy_bindings(_state.get("main_model"), _state.get("aux_model"))
                if migrated is not None:
                    _state["model_profiles"] = migrated["model_profiles"]
                    _state["main_pool"] = migrated["main_pool"]
                    _state["aux_pool"] = migrated["aux_pool"]
            log.info(msg("runtime_settings.py.001"), path)
            # [.env 密钥层] 有 env key 就以 env 为准。
            #   判据不能只看"有没有改动过绑定"——盘上那串和 .env 里那串往往就是同一把，
            #   这时值没变、可明文照样得抹掉。所以直接查读进来的那份原始 JSON。
            _seal_from_env(_state)
            if _SEALED and any((b.get("api_key") or "").strip() for b in _walk_bindings(raw)):
                _persist()
    except Exception as exc:  # noqa: BLE001 — settings.json 坏了不该拖死后端
        log.warning(msg("runtime_settings.py.002"), exc)


def _persist(candidate: Mapping[str, Any] | None = None) -> None:
    """Atomically persist a candidate state; write failures are part of apply's result."""
    path = _settings_path()
    if path is None:
        return
    value = _state if candidate is None else candidate
    if _SEALED:
        value = _without_secrets(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    # Key 在里面——收紧到 0600（Windows 上 chmod 是尽力而为，本来也是单用户目录）。
    try:
        os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass
    tmp.replace(path)


# ═══════════════════════════════════════════════════════════════
# .env 密钥层（v1.0.43 发布改造）
# ═══════════════════════════════════════════════════════════════

# 老部署用的是 DEEPSEEK_API_KEY，留着当兼容位；新装用 KNOWE_MODEL_API_KEY。
ENV_SECRET_KEYS = ("KNOWE_MODEL_API_KEY", "DEEPSEEK_API_KEY")
ENV_SCOPE_KEYS = (("KNOWE_MODEL_PROVIDER", "provider"), ("KNOWE_MODEL_BASE_URL", "base_url"))

# 本机是否由 .env 供密钥。决定 _persist 要不要把 api_key 抹掉再写盘。
_SEALED = False


def _env_secret() -> str:
    for name in ENV_SECRET_KEYS:
        value = (os.environ.get(name) or "").strip()
        if value:
            return value
    return ""


def _env_scope() -> dict[str, str]:
    """环境变量声明的凭据作用域；一个都没声明 = 这把 key 管这台机器上的全部绑定。"""
    out: dict[str, str] = {}
    for name, field in ENV_SCOPE_KEYS:
        value = (os.environ.get(name) or "").strip()
        if value:
            out[field] = value
    return out


def _in_env_scope(binding: Mapping[str, Any], scope: Mapping[str, str]) -> bool:
    for field, value in scope.items():
        raw = str(binding.get(field) or "").strip()
        same = raw.rstrip("/") == value.rstrip("/") if field == "base_url" else raw.lower() == value.lower()
        if not same:
            return False
    return True


def _walk_bindings(state: Mapping[str, Any]):
    """把状态里每一个带 api_key 的绑定逐个交出来（交出的就是原对象，就地可改）。"""
    for field in ("main_model", "aux_model"):
        binding = state.get(field)
        if isinstance(binding, dict):
            yield binding
    for binding in state.get("model_profiles") or []:
        if isinstance(binding, dict):
            yield binding
    for binding in (state.get("agent_models") or {}).values():
        if isinstance(binding, dict):
            yield binding


def _seal_from_env(state: dict[str, Any]) -> bool:
    """用 .env 的 key 灌进作用域内的绑定。返回是否改动过。

    `_SEALED` 只在**至少有一个绑定真的拿到了 env 的 key** 时才置真——意思是"这台机器的
    密钥由 .env 供"，从此不再往盘上写任何明文。若用户拿 provider/base_url 把作用域收窄到
    一个绑定都不命中，那就当作这把 key 跟本机无关：保持老行为，绝不静默抹掉别人已有的 key。
    """
    global _SEALED
    secret = _env_secret()
    if not secret:
        return False
    scope = _env_scope()
    changed = False
    for binding in _walk_bindings(state):
        if not _in_env_scope(binding, scope):
            continue
        _SEALED = True
        if binding.get("api_key") != secret:
            binding["api_key"] = secret
            changed = True
    return changed


def _without_secrets(state: Mapping[str, Any]) -> dict[str, Any]:
    """落盘专用副本：所有 api_key 清空，别的字段一律不动。"""
    clone = json.loads(json.dumps(state, ensure_ascii=False))
    for binding in _walk_bindings(clone):
        if binding.get("api_key"):
            binding["api_key"] = ""
    return clone


# ═══════════════════════════════════════════════════════════════
# 归一化小工具
# ═══════════════════════════════════════════════════════════════

def _norm_binding(raw: Any) -> dict[str, str] | None:
    """校验并收窄一份模型绑定；缺 provider/model 即视为无效。"""
    if not isinstance(raw, dict):
        return None
    provider = str(raw.get("provider") or "").strip()
    model = str(raw.get("model") or "").strip()
    if not provider or not model:
        return None
    return {
        "provider": provider,
        "model": model,
        "api_key": str(raw.get("api_key") or ""),
        "base_url": str(raw.get("base_url") or "").rstrip("/"),
        "transport": str(raw.get("transport") or "openai_chat"),
    }


def _norm_profiles(raw: Any) -> list[dict[str, str]]:
    """[v1.0.39.3] 归一化整组模型清单：逐项 _norm_binding，剔除无效项。"""
    if not isinstance(raw, list):
        return []
    profiles: list[dict[str, str]] = []
    seen: set[tuple[str, str, str, str]] = set()
    slot: dict[tuple[str, str, str, str], int] = {}
    for item in raw:
        binding = _norm_binding(item)
        if binding is None:
            continue
        # 去重：同 provider/base_url/transport/model 只保留首次出现的（保序）。
        key = (
            binding["provider"].strip().casefold(),
            binding["base_url"].strip().rstrip("/").casefold(),
            binding["transport"].strip().casefold(),
            binding["model"].strip(),
        )
        if key in seen:
            # 渲染层每次重输 key 会往清单尾部追加一份同作用域的行，旧行只留空 api_key。
            # 只保首行等于永远保住那条空的——用户新输的凭据当场被丢掉，界面显示"已填"而后端为空。
            # 同一作用域内凭据本就属于同一个厂商，后出现的非空 key 才是用户这次的意图。
            first = profiles[slot[key]]
            if binding["api_key"]:
                first["api_key"] = binding["api_key"]
            continue
        seen.add(key)
        slot[key] = len(profiles)
        profiles.append(binding)
    return profiles


def _norm_pool(raw: Any, profile_count: int) -> list[int]:
    """[v1.0.39.3] 归一化主/辅池：只保留合法下标、去重、保序。"""
    if not isinstance(raw, list):
        return []
    pool: list[int] = []
    seen: set[int] = set()
    for item in raw:
        try:
            idx = int(item)
        except (TypeError, ValueError):
            continue
        if idx < 0 or idx >= profile_count:
            continue
        if idx in seen:
            continue
        seen.add(idx)
        pool.append(idx)
    return pool


def _migrate_legacy_bindings(
    main_model: Any,
    aux_model: Any,
) -> dict[str, Any] | None:
    """[v1.0.39.3] 把旧单组 main/aux 迁移成 model_profiles + 主/辅池。

    返回 {model_profiles, main_pool, aux_pool}；无任何有效绑定时返回 None。
    老用户只有 main_model → 清单一组、main_pool=[0]、aux_pool 看有无显式 aux。
    """
    main = _norm_binding(main_model)
    aux = _norm_binding(aux_model)
    if main is None and aux is None:
        return None
    profiles: list[dict[str, str]] = []
    main_pool: list[int] = []
    aux_pool: list[int] = []
    if main is not None:
        profiles.append(main)
        main_pool.append(0)
    if aux is not None:
        aux_idx = len(profiles)
        profiles.append(aux)
        aux_pool.append(aux_idx)
        # 旧语义：aux 可能跟随 main 派生（同 scope 借 key）；若不显式 aux，则空池由
        # aux_effective() 运行时按 main 派生便宜档兜底（语义不变）。
    else:
        aux_pool = []
    return {"model_profiles": profiles, "main_pool": main_pool, "aux_pool": aux_pool}


def _binding_for_apply(raw: Any, previous: Any) -> dict[str, str] | None:
    """Normalize a binding; blank preserves a key only inside the same credential scope."""
    binding = _norm_binding(raw)
    if binding is None:
        return None
    prior = _norm_binding(previous)
    clear_requested = isinstance(raw, dict) and any(
        raw.get(key) is True for key in ("clear_api_key", "api_key_clear", "clearApiKey")
    )
    if clear_requested:
        # Explicit deletion wins even if a buggy/old caller also supplied a credential value.
        binding["api_key"] = ""
        return binding
    if (
        not binding["api_key"]
        and prior is not None
        and _same_credential_scope(binding, prior)
    ):
        binding["api_key"] = prior["api_key"]
    return binding


def _credential_scope(raw: Any) -> tuple[str, str, str] | None:
    binding = _norm_binding(raw)
    if binding is None:
        return None
    return (
        binding["provider"].strip().casefold(),
        binding["base_url"].strip().rstrip("/").casefold(),
        binding["transport"].strip().casefold(),
    )


def _same_credential_scope(left: Any, right: Any) -> bool:
    left_scope = _credential_scope(left)
    return left_scope is not None and left_scope == _credential_scope(right)


def _matching_previous(raw: Any, *candidates: Any) -> Any:
    """Return the first predecessor whose credential scope matches ``raw`` exactly."""
    for candidate in candidates:
        if _same_credential_scope(raw, candidate):
            return candidate
    return None


def _fold_explicit_key(payload: dict[str, Any], field: str, pool_key: str, candidate: dict[str, Any]) -> None:
    """把界面显式提交的新 key 折回清单里池首那一条，再重派生 main/aux。

    渲染层只持有 has_api_key，保存包里的 model_profiles 各项 key 恒空；而池模式下
    main_model 是从清单首成员派生的（见 apply() 那段），于是「模型与提供方」里重输的 key
    会被清单里的空值顶掉——用户反复保存也填不回去。只有本次真带了非空 key（或明确带
    clear 标记）才动清单，空串本身仍按「保留现有凭据」处理。
    """
    raw = payload.get(field)
    explicit = _norm_binding(raw)
    if explicit is None:
        return
    clear_requested = isinstance(raw, dict) and any(
        raw.get(key) is True for key in ("clear_api_key", "api_key_clear", "clearApiKey")
    )
    if not explicit["api_key"] and not clear_requested:
        return
    profiles = candidate.get("model_profiles") or []
    idx: int | None = None
    for member in candidate.get(pool_key) or []:
        try:
            pos = int(member)
        except (TypeError, ValueError):
            continue
        if 0 <= pos < len(profiles):
            idx = pos
            break
    if idx is None or not _same_credential_scope(explicit, profiles[idx]):
        return
    profiles[idx]["api_key"] = "" if clear_requested else explicit["api_key"]
    candidate[field] = dict(profiles[idx])


def binding_for_test(target: str, raw: Any) -> dict[str, str] | None:
    """Fill a redacted renderer test binding from persisted credentials when safe.

    GET /settings exposes only ``has_api_key``.  A subsequent connection test therefore sends
    an empty key; the backend may borrow its persisted value only when provider, base URL and
    transport still match.  A newly typed key always wins and is never copied back to the client.
    """

    _ensure_loaded()
    binding = _norm_binding(raw)
    if binding is None:
        return binding
    clear_requested = isinstance(raw, dict) and any(
        raw.get(key) is True for key in ("clear_api_key", "api_key_clear", "clearApiKey")
    )
    if clear_requested:
        binding["api_key"] = ""
        return binding
    if binding["api_key"]:
        return binding
    prior: Any
    if str(target).strip().lower() == "aux":
        # Prefer an explicit/effective aux credential, then the persisted main credential for a
        # renderer-derived cheap-tier binding.  Scope matching prevents cross-provider reuse.
        prior = _matching_previous(raw, _state.get("aux_model"), _state.get("main_model"))
    else:
        prior = _matching_previous(raw, _state.get("main_model"))
    if prior is not None:
        previous = _norm_binding(prior)
        if previous is not None:
            binding["api_key"] = previous["api_key"]
    return binding


def _binding_complete(binding: dict[str, str] | None) -> bool:
    return bool(
        binding
        and binding.get("provider")
        and binding.get("model")
        and binding.get("api_key")
        and binding.get("base_url")
    )


def binding_fingerprint(raw: Any) -> str | None:
    """Return an opaque, stable per-install HMAC fingerprint for one binding.

    The covered fields are the exact apply/test transaction boundary requested by the
    first-run gate.  The API key is HMACed as part of the whole canonical message and is
    never returned or logged.
    """

    _ensure_loaded()
    binding = _norm_binding(raw)
    if binding is None:
        return None
    canonical = "|".join((
        binding["provider"].strip().casefold(),
        binding["model"].strip(),
        binding["base_url"].strip().rstrip("/").casefold(),
        binding["transport"].strip().casefold(),
        binding["api_key"],
    )).encode("utf-8")
    salt = str(_state.get("fingerprint_salt") or "").encode("utf-8")
    digest = hmac.new(salt, canonical, hashlib.sha256).hexdigest()
    return f"sha256:{digest}"


def public_binding(raw: Any) -> dict[str, Any] | None:
    """Return a redacted binding suitable for local HTTP acknowledgements."""

    binding = _norm_binding(raw)
    if binding is None:
        return None
    return {
        "provider": binding["provider"],
        "model": binding["model"],
        "transport": binding["transport"],
        "base_url": binding["base_url"],
        "has_api_key": bool(binding["api_key"]),
    }


def _zinnia_usable(raw: Any) -> bool:
    binding = _norm_binding(raw)
    return bool(
        _binding_complete(binding)
        and binding is not None
        and binding.get("transport", "openai_chat") in {"openai_chat", "codex_responses", "anthropic_messages"}
    )


def zinnia_binding_status() -> tuple[bool, str, dict[str, str] | None]:
    """Resolve the same persisted binding precedence used by Zinnia."""

    _ensure_loaded()
    agents = _state.get("agent_models") or {}
    own = agents.get("__platform__::zinnia") if isinstance(agents, dict) else None
    main = own or _state.get("main_model")
    if _zinnia_usable(main):
        return True, "agent" if own else "main", dict(main)
    aux = _state.get("aux_model")
    if main and _zinnia_usable(aux):
        return True, "aux", dict(aux)
    return False, "incompatible" if main else "missing", dict(main) if isinstance(main, dict) else None


def model_ready_for(project_id: str, agent_id: str) -> bool:
    """Runtime readiness barrier predicate for one Agent turn.

    A binding is usable when complete: provider/model/base_url/api_key all present
    (per-Agent override first, then global main).  The old test→apply fingerprint
    ceremony was removed — saving a complete binding is the user's explicit
    confirmation, so no fingerprint handshake is required.
    """

    if project_id == "__platform__" and agent_id == "zinnia":
        return zinnia_binding_status()[0]
    _ensure_loaded()
    agents = _state.get("agent_models") or {}
    own = agents.get(f"{project_id}::{agent_id}") if isinstance(agents, dict) else None
    if own is not None:
        return _binding_complete(_norm_binding(own))
    main = _state.get("main_model")
    return bool(_binding_complete(_norm_binding(main)))


def _signal_model_waiters() -> None:
    # apply() runs on the server event-loop thread.  Avoid depending on asyncio.Event's
    # private ``_loop`` attribute; a vanished/cancelled waiter must never abort apply.
    for waiter in tuple(_model_waiters):
        try:
            waiter.set()
        except Exception:  # noqa: BLE001 — defensive wake-up path
            pass


async def wait_for_model_ready(
    project_id: str,
    agent_id: str,
    *,
    timeout: float | None = None,
) -> bool:
    """Wait for an apply transaction to make an Agent binding usable."""

    if model_ready_for(project_id, agent_id):
        return True
    waiter = asyncio.Event()
    _model_waiters.add(waiter)
    try:
        # Close the check/register race before awaiting.
        if model_ready_for(project_id, agent_id):
            return True
        while not model_ready_for(project_id, agent_id):
            waiter.clear()
            if timeout is None:
                await waiter.wait()
            else:
                try:
                    await asyncio.wait_for(waiter.wait(), timeout=timeout)
                except asyncio.TimeoutError:
                    return model_ready_for(project_id, agent_id)
        return True
    finally:
        _model_waiters.discard(waiter)


def _norm_timeout(raw: Any) -> float | None:
    """秒数归一：None / 0 / 负数 / 超过 NEVER → None（永不）；其余 → float。"""
    if raw is None:
        return None
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return DEFAULT_APPROVAL_TIMEOUT_S
    if v <= 0 or v >= NEVER_TIMEOUT_S:
        return None
    return v


def core_base_url(base: str) -> str:
    """
    [v0.44.3 场景2 修复] 目录口径 → knowe_core 口径的**唯一**换算点（片段保护版）
    （engine._core_base_url 与下面 test_binding 的 Agent 路径探测都走这里）。

    目录/测试/aux/知知用行业标准口径：base = 端点前缀（自带版本段，如 …/v1、…/paas/v4、
    …/v1beta/openai），请求层只追加 `/chat/completions`。所以任何厂商的**正确端点**永远是
    `{目录 base}/chat/completions`——知知就是这么打的（zinnia.py），全厂商通用、已验证可用。

    历史病根：knowe_core 的 ProviderClient 曾在 else 分支自补 `/v1/chat/completions`，对
    不以 /v1 结尾的厂商拼出 …/v4/v1/chat/completions 而 404（项目经理/Worker 走 core，知知不走
    core，所以只有他俩挂）。ProviderClient 的根源已同步修正（只追 /chat/completions、尊重
    base 版本段，见 knowe_core/provider_client）。

    这里再加一道**与 core 内部拼接实现解耦**的保护：把 base 换算成
    `{目录 base}/chat/completions#`。交给 core 后，无论 core 往后追加什么（新实现的
    /chat/completions、或历史上的 /v1/chat/completions），都落进 URL fragment；HTTP 层
    按 RFC 3986 §3.5 不发 fragment，实际请求恰好命中 `{目录 base}/chat/completions`——与
    知知/aux/目录**完全同址**。这样即便 core 侧回退到旧拼接口径，Agent 也照样打对地址。

    空 base 透传空串（保留下游对空 base 的兜底）；已是片段保护形态则幂等返回。
    """
    b = (base or "").rstrip("/")
    if not b or b.endswith("#"):          # 空串透传；已片段保护则幂等
        return b
    endpoint = b if b.endswith("/chat/completions") else f"{b}/chat/completions"
    return f"{endpoint}#"


# ═══════════════════════════════════════════════════════════════
# 对外：apply / 查询
# ═══════════════════════════════════════════════════════════════

def _revision_payload(state: Mapping[str, Any] | None = None) -> dict[str, Any]:
    source = _state if state is None else state
    return {
        key: value
        for key, value in source.items()
        if key not in {"settings_revision", "fingerprint_salt"}
    }

def apply(payload: dict[str, Any], *, canonical_pid: Any = None) -> dict[str, Any]:
    """
    整包应用前端下发的设置（POST /settings 的处理核心）。

    优先级规矩（README §3.2 / §3.3）在两层落实：
      · **解析层**（真正的 Harness 保证）：effective_approval_timeout / model_binding_for
        永远按「个性化 > 全局 > 出厂」裁决——不管状态是怎么进来的。
      · **应用层**：前端的 saveMainModel / setApprovalTimeout 已经在发包前把对应的
        个性化表清空（全局覆盖个性），所以**完整包直接照单全收**；只有当包里
        全局值变了、却**没带**对应的个性化表（老客户端 / 手写请求）时，才在这里
        兜底清空——决不能因为「开机对账」这类正常同步吃掉用户的群级/Agent 级设置。

    canonical_pid：server 传进来的「项目 id 归一函数」（临时 id → 权威 id），
    群级超时与 per-Agent 键都过一遍，防止前端拿着握手前的临时 id 存出孤儿键。

    返回：应用后的生效摘要（回给前端做确认展示）。
    """
    _ensure_loaded()

    expected_revision = payload.get("expected_revision")
    if expected_revision not in (None, ""):
        try:
            expected_value = int(expected_revision)
        except (TypeError, ValueError) as exc:
            raise SettingsApplyConflict(msg("runtime_settings.py.003")) from exc
        current_revision = int(_state.get("settings_revision") or 0)
        if expected_value != current_revision:
            raise SettingsApplyConflict(
                msg("runtime_settings.py.004", expected_value=expected_value, current_revision=current_revision)
            )

    candidate = json.loads(json.dumps(_state, ensure_ascii=False))
    candidate_main = _binding_for_apply(payload.get("main_model"), candidate.get("main_model"))

    before = json.dumps(_revision_payload(candidate), ensure_ascii=False, sort_keys=True)

    norm = canonical_pid if callable(canonical_pid) else (lambda pid: pid)

    # ── 1. 主模型 / 辅助模型（[v1.0.39.3] 多模型预存：收整组清单 + 主/辅池，派生 main/aux）──
    # 收整组 profile（向前兼容：老包不带 model_profiles → 保持单组 main/aux 走原逻辑）。
    profiles_raw = payload.get("model_profiles")
    if isinstance(profiles_raw, list):
        # 前端只持有 has_api_key（GET /settings 从不回吐真 key），所以清单一到位 key 全是空的。
        # 直接 _norm_profiles 会把后端存的凭据一并抹掉——任何一次「改个无关开关」都能把模型打残。
        # 这里逐项走 _binding_for_apply：同凭据作用域（provider+base_url+transport）且没带
        # clear 标记的，把旧 key 续上；换了作用域才真的当成新绑定。
        previous_profiles = candidate.get("model_profiles") or []
        candidate["model_profiles"] = _norm_profiles([
            _binding_for_apply(item, _matching_previous(item, *previous_profiles)) or item
            for item in profiles_raw
        ])
        # 收主/辅池（下标列表，有序）；不提供池时用默认：主 = 清单第一条，辅 = 空。
        candidate["main_pool"] = _norm_pool(payload.get("main_pool"), len(candidate["model_profiles"]))
        candidate["aux_pool"] = _norm_pool(payload.get("aux_pool"), len(candidate["model_profiles"]))
        # 派生 main/aux = 各自池首成员（从 candidate 读，因为 apply 末尾才 _state.update）。
        main_member = _first_in_pool(candidate.get("model_profiles") or [], candidate.get("main_pool") or [])
        aux_member = _first_in_pool(candidate.get("model_profiles") or [], candidate.get("aux_pool") or [])
        candidate["main_model"] = dict(main_member) if main_member else None
        candidate["aux_model"] = dict(aux_member) if aux_member else None
        _fold_explicit_key(payload, "main_model", "main_pool", candidate)
        _fold_explicit_key(payload, "aux_model", "aux_pool", candidate)
    else:
        # 老包：只有单组 main/aux（无 model_profiles）→ 保持原逻辑，同时迁移成池，
        # 保证「存了多组模型之后切到旧包」也能正确落成清单一组。
        migrated = _migrate_legacy_bindings(
            _binding_for_apply(payload.get("main_model"), candidate.get("main_model")),
            _binding_for_apply(payload.get("aux_model"), _matching_previous(
                payload.get("aux_model"), candidate.get("aux_model"), candidate.get("main_model"))),
        )
        if migrated is not None:
            candidate["model_profiles"] = migrated["model_profiles"]
            candidate["main_pool"] = migrated["main_pool"]
            candidate["aux_pool"] = migrated["aux_pool"]

    new_main = candidate_main
    old_main = candidate.get("main_model")
    main_changed = bool(new_main) and new_main != old_main

    # [v1.0.39.3] 池模式已派生 main_model，无需再走原单组赋值；老包仍保留原覆盖逻辑。
    if not isinstance(profiles_raw, list):
        candidate["main_model"] = new_main if new_main else old_main
        # A derived auxiliary binding and a newly introduced per-Agent override may intentionally
        # omit the secret after GET /settings.  When there is no binding-specific predecessor, the
        # newly resolved main binding is the only safe fallback, and _binding_for_apply still requires
        # an exact provider/base_url/transport scope match before borrowing its key.
        aux_raw = payload.get("aux_model")
        aux_previous = _matching_previous(aux_raw, candidate.get("aux_model"), new_main)
        aux = _binding_for_apply(aux_raw, aux_previous)
        if aux is not None or "aux_model" in payload:
            candidate["aux_model"] = aux

    # ── 2. per-Agent 绑定 ──
    incoming_agents = payload.get("agent_models")
    if isinstance(incoming_agents, dict):
        # 完整包：前端已按「全局覆盖个性」把表清好了——照单全收（含空表）。
        cleaned: dict[str, dict[str, str]] = {}
        previous_agents = candidate.get("agent_models") or {}
        for key, raw in incoming_agents.items():
            raw_key = str(key)
            if "::" not in raw_key:
                continue
            pid, _, aid = raw_key.partition("::")
            canonical_key = f"{norm(pid)}::{aid}"
            previous = None
            if isinstance(previous_agents, dict):
                previous = previous_agents.get(canonical_key, previous_agents.get(raw_key))
            b = _binding_for_apply(raw, _matching_previous(raw, previous, new_main))
            if b is not None:
                cleaned[canonical_key] = b
        candidate["agent_models"] = cleaned
    elif main_changed:
        # 兜底：包里换了主模型却没带个性化表 → 按规矩清空，别让旧表压过新全局。
        candidate["agent_models"] = {}
        log.info(msg("runtime_settings.py.005"))

    # ── 3. 审批超时 ──
    timeout_changed = False
    if "approval_timeout_s" in payload:
        new_timeout = _norm_timeout(payload.get("approval_timeout_s"))
        timeout_changed = new_timeout != candidate.get("approval_timeout_s")
        candidate["approval_timeout_s"] = new_timeout
    incoming_groups = payload.get("group_approval_timeouts")
    if isinstance(incoming_groups, dict):
        # 完整包照单全收（前端改全局时已把群表清空后随包发来）。
        candidate["group_approval_timeouts"] = {
            str(norm(pid)): _norm_timeout(v) for pid, v in incoming_groups.items()
        }
    elif timeout_changed:
        candidate["group_approval_timeouts"] = {}
        log.info(msg("runtime_settings.py.006"),
                 msg("runtime_settings.py.007") if candidate["approval_timeout_s"] is None
                 else f"{candidate['approval_timeout_s']:g}s")

    # ── 4. 称呼 ──
    if "user_name" in payload:
        candidate["user_name"] = str(payload.get("user_name") or "").strip()

    # ── 4.1 主要语言 [v1.0.21.3] ──
    if "language" in payload:
        lang = str(payload.get("language") or "zh").strip().lower()
        candidate["language"] = lang if lang in ("zh", "en") else "zh"

    # v1.0.19.5: 保存完整绑定即视为用户确认（指纹闸门废除）。指纹仅作诊断记录，
    # 与「测试→应用」仪式完全解耦——用户填好 key 确认保存的那一刻，Agent 即可用。
    if candidate.get("main_model"):
        candidate["active_model_fingerprint"] = (
            binding_fingerprint(candidate.get("main_model")) or None
        )
    after = json.dumps(_revision_payload(candidate), ensure_ascii=False, sort_keys=True)
    if after != before:
        candidate["settings_revision"] = int(candidate.get("settings_revision") or 0) + 1
    # Publish only after the exact candidate is durably replaced on disk.
    _persist(candidate)
    _state.clear()
    _state.update(candidate)
    _signal_model_waiters()
    return snapshot()


def snapshot() -> dict[str, Any]:
    """当前生效设置的进程内完整快照；HTTP 边界必须改用 api_snapshot()."""
    _ensure_loaded()
    return json.loads(json.dumps(_state, ensure_ascii=False))


# Diagnostic/audit exports cross a different trust boundary from the localhost
# settings editor.  Keep one recursive scrubber here so evidence bundles never
# accidentally serialize credentials while ordinary non-secret values remain exact.
_SECRET_FIELD_NAMES = frozenset({
    "api_key",
    "authorization",
    "auth_token",
    "access_token",
    "refresh_token",
    "bearer_token",
    "token",
    "cookie",
    "cookies",
    "password",
    "passwd",
    "client_secret",
    "secret",
    "secret_key",
    "private_key",
    "fingerprint_salt",
})
_REDACTED_PLACEHOLDER = "[REDACTED]"


def _normalise_secret_field_name(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(".", "_").replace(" ", "_")


def _is_secret_field_name(value: Any) -> bool:
    name = _normalise_secret_field_name(value)
    if name in _SECRET_FIELD_NAMES:
        return True
    return any(
        name.endswith(suffix)
        for suffix in (
            "_api_key",
            "_authorization",
            "_auth_token",
            "_access_token",
            "_refresh_token",
            "_bearer_token",
            "_cookie",
            "_password",
            "_client_secret",
            "_secret_key",
            "_private_key",
            "_fingerprint_salt",
        )
    )


def _secret_is_unset(value: Any) -> bool:
    return value is None or value == "" or value == b""


def redact_secrets(value: Any, *, field_name: Any = None) -> Any:
    """Return a deep copy with credential-bearing fields replaced exactly once.

    Empty credentials stay empty so diagnostics can still distinguish an unset key
    from a configured-but-redacted key.  This function deliberately filters only
    structured credential fields; it never rewrites ordinary natural-language text.
    """

    if field_name is not None and _is_secret_field_name(field_name):
        return value if _secret_is_unset(value) else _REDACTED_PLACEHOLDER
    if isinstance(value, Mapping):
        return {key: redact_secrets(item, field_name=key) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_secrets(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_secrets(item) for item in value)
    return value


def redacted_snapshot() -> dict[str, Any]:
    """Credential-safe settings projection for diagnostics and audit artifacts."""

    value = redact_secrets(snapshot())
    return dict(value) if isinstance(value, Mapping) else {}


def settings_revision() -> int:
    _ensure_loaded()
    return max(0, int(_state.get("settings_revision") or 0))


def model_apply_ack(*, welcome_state: str = "unknown") -> dict[str, Any]:
    """Redacted ModelApplyAckV1 shared by GET and POST /settings."""

    _ensure_loaded()
    compatible, source, _binding = zinnia_binding_status()
    main = _state.get("main_model")
    current = binding_fingerprint(main)
    # v1.0.19.5: 保存即确认——当前配置的指纹就是已激活指纹，无需事务比对。
    acknowledged = current
    return {
        "settings_revision": settings_revision(),
        "applied_fingerprint": acknowledged,
        "effective": {"main_model": public_binding(main)},
        "zinnia_compatible": compatible,
        "zinnia_binding_source": source,
        "welcome_state": welcome_state,
    }


def api_snapshot(*, welcome_state: str = "unknown") -> dict[str, Any]:
    """Public settings snapshot plus readiness ack; never serialize credential values."""

    value = snapshot()
    # The per-install HMAC salt is process-private key material.  The renderer
    # needs only the opaque applied fingerprint returned by model_apply_ack().
    value.pop("fingerprint_salt", None)
    value.pop("active_model_fingerprint", None)
    value["main_model"] = public_binding(value.get("main_model"))
    value["aux_model"] = public_binding(value.get("aux_model"))
    # [v1.0.39.3] 漏网的一条：多模型清单是后加的，上面两行只压了 main/aux，
    # model_profiles 里的真 key 曾整串发给渲染层。前端 bindingFromBackend 只认
    # has_api_key、从不回抄 api_key（settings.ts:246），所以这里脱敏不影响任何往返。
    # 保留逐位对齐——main_pool/aux_pool 是按这份清单的下标路由的。
    raw_profiles = value.get("model_profiles")
    value["model_profiles"] = [
        public_binding(item) or {"has_api_key": False}
        for item in (raw_profiles if isinstance(raw_profiles, list) else [])
    ]
    raw_agents = value.get("agent_models")
    value["agent_models"] = {
        str(key): public
        for key, raw in (raw_agents.items() if isinstance(raw_agents, dict) else [])
        if (public := public_binding(raw)) is not None
    }
    value.update(model_apply_ack(welcome_state=welcome_state))
    return value


def user_name(default: str | None = None) -> str:
    """全局对用户的称呼（README §2.1：改名后所有上下文同步）。"""
    _ensure_loaded()
    return str(_state.get("user_name") or "").strip() or (default if default is not None else msg("runtime_settings.py.017"))


def language(default: str = "zh") -> str:
    """当前主要语言（'zh' | 'en'）。PromptResolver / 前端对账都读这里。"""
    _ensure_loaded()
    lang = str(_state.get("language") or "").strip().lower()
    return lang if lang in ("zh", "en") else default


def set_approval_timeout_compat(value: Any) -> float | None:
    """Set the process-local global timeout for legacy callers and tests.

    Before runtime settings became the authority, callers occasionally used
    ``object.__setattr__(CONFIG, "approval_timeout_s", value)``.  The compatibility
    property setter delegates here so that those callers update the same authoritative
    in-memory state instead of shadowing it on the frozen Config instance.  This path is
    intentionally non-persistent; durable settings still go through :func:`apply`.
    """

    _ensure_loaded()
    normalized = _norm_timeout(value)
    _state["approval_timeout_s"] = normalized
    _state["group_approval_timeouts"] = {}
    return None if normalized is None else float(normalized)


def effective_approval_timeout(project_id: str | None = None) -> float | None:
    """
    审批卡超时的**最终裁决**（CONFIG.approval_timeout_s property 的真身）：

        群级覆盖（project_id 或 contextvar 里的当前项目） > 全局值 > 出厂永不
        None 表示 Gate 直接等待显式 resolution，不创建自动超时。

    gate.py 每次读 CONFIG.approval_timeout_s 都会走到这里——群在哪儿来？
    engine._loop 进场时把项目 id 登进 contextvar，propose 全部发生在 _loop 的
    后代任务里，asyncio 的上下文继承把 id 一路带过去。
    """
    _ensure_loaded()
    pid = project_id if project_id is not None else _current_project.get()
    if pid:
        groups = _state.get("group_approval_timeouts") or {}
        if pid in groups:
            v = groups[pid]
            return None if v is None else float(v)
    v = _state.get("approval_timeout_s", DEFAULT_APPROVAL_TIMEOUT_S)
    return None if v is None else float(v)


def _first_in_pool(profiles: list[dict[str, str]], pool: list[int]) -> dict[str, str] | None:
    """[v1.0.39.3] 纯函数：从候选 profiles + 有序下标池取第一个合法绑定。"""
    for idx in pool:
        try:
            idx = int(idx)
        except (TypeError, ValueError):
            continue
        if 0 <= idx < len(profiles):
            return dict(profiles[idx])
    return None


def _pool_candidates(pool_key: str) -> list[dict[str, str]]:
    """[v1.0.39.3] 返回指定池（main_pool/aux_pool）的全部合法候选绑定列表（保序）。

    供运行时「配额用尽切下一个候选」用——从池里按序拿到所有可切换的绑定。
    """
    profiles = _state.get("model_profiles") or []
    pool = _state.get(pool_key) or []
    out: list[dict[str, str]] = []
    for idx in pool:
        try:
            idx = int(idx)
        except (TypeError, ValueError):
            continue
        if 0 <= idx < len(profiles):
            out.append(dict(profiles[idx]))
    return out


def _first_profile_in_pool(pool_key: str) -> dict[str, str] | None:
    """[v1.0.39.3] 从指定池（main_pool/aux_pool）取第一个合法候选绑定。

    池可能为空、下标可能越界（前端删了行但池没重排）→ 逐个校验，返回第一个字典。
    """
    profiles = _state.get("model_profiles") or []
    pool = _state.get(pool_key) or []
    return _first_in_pool(profiles, pool)


def model_binding_for(project_id: str, agent_id: str) -> dict[str, str] | None:
    """
    某个 Agent 的生效模型绑定：个性化（"pid::aid"）> 全局主模型 > None。
    None = 用户没在设置面板配过 → 调用方（engine._new_agent）落回 CONFIG.deepseek_*。
    [v1.0.39.3] 全局主模型 = main_pool 首成员（多模型路由池）。
    """
    _ensure_loaded()
    agents = _state.get("agent_models") or {}
    own = agents.get(f"{project_id}::{agent_id}")
    if own:
        return dict(own)
    main = _first_profile_in_pool("main_pool")
    return dict(main) if main else None


#: 各厂商便宜档（backend 兜底副本——正常情况下前端把派生辅助绑定发过来了；
#: 只有「前端只发了 main、没发 aux」的旧包才会用到这张表）。
_CHEAP_TIER: dict[str, str] = {
    "openrouter": "deepseek/deepseek-v4-flash",
    "deepseek": "deepseek-v4-flash",
    "zai": "glm-4.5-flash",
    "kimi-coding": "kimi-k2.5",
    "kimi-coding-cn": "kimi-k2.5",
    "alibaba": "qwen3.5-plus",
    "minimax": "MiniMax-M2",
    "minimax-cn": "MiniMax-M2",
    "stepfun": "step-3.5-flash",
    "tencent-tokenhub": "hy3-preview",
    "xai": "grok-4.20-0309-non-reasoning",
    "anthropic": "claude-haiku-4-5-20251001",
    "openai-api": "gpt-5.4-nano",
    "gemini": "gemini-3.6-flash",
    "nvidia": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
    "huggingface": "XiaomiMiMo/MiMo-V2-Flash",
    "novita": "deepseek/deepseek-v3-0324",
    "arcee": "trinity-mini",
    "gmi": "google/gemini-3.1-flash-lite-preview",
    "copilot": "gpt-4o-mini",
    "opencode-zen": "gpt-5-nano",
}


def aux_effective() -> dict[str, str] | None:
    """
    辅助模型（摘要/翻译/知识蒸馏）的生效绑定：
        显式 aux > 由主模型派生（同厂商同 Key，模型换便宜档）> None（落回 CONFIG）。
    [v1.0.39.3] 显式 aux = aux_pool 首成员；主模型 = main_pool 首成员。
    """
    _ensure_loaded()
    aux = _first_profile_in_pool("aux_pool")
    if aux:
        return dict(aux)
    main = _first_profile_in_pool("main_pool")
    if not main:
        return None
    derived = dict(main)
    # [customAPI] custom 等非官方 provider 不在 _CHEAP_TIER → 回退主模型名 = 完整跟随语义
    # （有意为之：自定义端点无便宜档，唯一合理语义是复用主模型配置，非漏网）。
    derived["model"] = _CHEAP_TIER.get(main.get("provider", ""), main.get("model", ""))
    return derived





# ═══════════════════════════════════════════════════════════════
# 连接测试（POST /settings/test 的真身 —— 真发请求，禁 mock）
# ═══════════════════════════════════════════════════════════════

_TEST_TIMEOUT_S = 15


def _probe_once(url: str, headers: dict[str, str], body: dict[str, Any],
                ) -> tuple[int | None, str | None, int | None]:
    """
    [v0.44.3] 发一次最小探测。返回 (HTTP 状态码, 网络层错误串, 延迟 ms)。
    2xx → (200, None, ms)；HTTP 错误 → (code, None, ms)；连不上/超时 → (None, 原因, None)。
    """
    # [v0.44.3 对账] 自报家门的 UA：urllib 默认的 `Python-urllib/*` 会被 Cloudflare 的
    #   Browser Integrity Check（error 1010）直接拒掉——hermes 上游为同一原因专门设了
    #   自定义 UA（models.py `_HERMES_USER_AGENT` 的注释）。OpenRouter 等前置了
    #   Cloudflare 的厂商若拦下默认 UA，测试会误报「连不上」，而 Agent 实际调用
    #   （httpx，另一个 UA）却是通的——测试不许这样冤枉一条好链路。
    headers = {**headers}
    headers.setdefault("User-Agent", "Zhiwei/1.0.43 (settings-test)")
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST",
    )
    started = time.monotonic()
    try:
        # [v1.0.35][macOS] python.org framework 的 ssl 默认 CA 路径（etc/openssl/cert.pem）
        # 在 PyInstaller 打包后为空 → urllib 默认上下文拿不到任何根 CA，把所有证书链都判成
        # 「self signed certificate」而误报连不上；而 Agent 实际路径（httpx）显式用 certifi
        # 所以正常。这里对齐：显式用 certifi 的 CA bundle 建 SSL 上下文。
        import certifi
        import ssl
        _opener = urllib.request.build_opener(
            urllib.request.HTTPSHandler(
                context=ssl.create_default_context(cafile=certifi.where())
            )
        )
        with _opener.open(req, timeout=_TEST_TIMEOUT_S) as resp:
            resp.read(512)   # 只要能读到响应体开头就算通；内容不重要
            return (200, None, int((time.monotonic() - started) * 1000))
    except urllib.error.HTTPError as exc:
        return (exc.code, None, int((time.monotonic() - started) * 1000))
    except urllib.error.URLError as exc:
        return (None, str(getattr(exc, "reason", exc)), None)
    except TimeoutError:
        return (None, msg("runtime_settings.py.008", _TEST_TIMEOUT_S=_TEST_TIMEOUT_S), None)
    except Exception as exc:  # noqa: BLE001 — 测试端点不许把异常抛回 HTTP 层
        return (None, msg("runtime_settings.py.009", exc=exc), None)


def _test_binding_impl(binding: dict[str, Any]) -> dict[str, Any]:
    """
    对一份绑定真发**最小请求**（max_tokens=1），验证接入点 + Key + 模型三件事。
    同步阻塞实现（urllib）——server 用 asyncio.to_thread 包着调。

    [v0.44.3 场景2] 还会**再探一条 Agent 实际路径**（所有 transport 都探）：
    knowe_core 的 ProviderClient 按 OpenAI 兼容方式使用 Bearer，并尊重 base 自带的版本段，
    最终请求 ``{base}/chat/completions``。标准探测与 Agent 路径不一定使用同一协议
    （例如 Anthropic messages），所以两条都要核对：前者验证 Key/模型/厂商，后者验证
    引擎真正会打的路径；后者 404/405 → 如实报不兼容。

    返回 {"ok": bool, "message": str, "latency_ms": int | None}。
    """
    b = _norm_binding(binding)
    if b is None:
        return {"ok": False, "message": msg("event.test.binding.impl.01"), "latency_ms": None}
    base = b["base_url"]
    target = provider_target(b["provider"], base, b["model"])
    if not base:
        return {
            "ok": False,
            "message": msg("runtime_settings.py.010", target=target),
            "latency_ms": None,
        }

    transport = b["transport"]
    if transport == "anthropic_messages":
        url = f"{base}/v1/messages"
        headers = {
            "Content-Type": "application/json",
            "x-api-key": b["api_key"],
            "anthropic-version": "2023-06-01",
        }
        body = {
            "model": b["model"],
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }
    else:
        # openai_chat 与 codex_responses 都能吃 /chat/completions 的最小探测
        # （OpenAI / xAI 两家 codex_responses 厂商的 chat/completions 端点都在）。
        url = f"{base}/chat/completions"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {b['api_key']}",
        }
        body = {
            "model": b["model"],
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}],
        }

    code, neterr, latency = _probe_once(url, headers, body)
    if neterr is not None:
        return {
            "ok": False,
            "message": msg("runtime_settings.py.011", target=target, neterr=neterr),
            "latency_ms": None,
        }
    if code != 200:
        # 与真实 Agent/知知共用同一套绑定感知文案；切换厂商后测试结果也会明确标出
        # 当前 provider + model，不再出现“测的是 Z.AI、提示却写 DeepSeek”的歧义。
        err_msg = http_status_error_message(
            int(code or 0),
            provider=b["provider"],
            base_url=base,
            model=b["model"],
        )
        return {"ok": False, "message": err_msg, "latency_ms": latency}

    # ── [v0.44.3 场景2 · 对账补强] 标准地址通了 → 再探 Agent 实际会打的那条路 ──
    #   引擎侧：base 经 core_base_url 片段保护后交给 ProviderClient，实际命中的地址是
    #   {base}/chat/completions（fragment 被 HTTP 丢弃，见 core_base_url）。这里就探这条
    #   **真实地址**（去掉 fragment 即得），不分绑定的 transport 都探：
    #     · openai_chat / codex_responses：它 == 上面的标准地址 → 下面 `!=` 判空自动
    #       跳过，不重复探；
    #     · anthropic_messages：标准地址是 /v1/messages，Agent 却按 OpenAI 兼容打
    #       {base}/chat/completions —— api.anthropic.com 有官方兼容层（探测通过，不误伤），
    #       MiniMax 的 …/anthropic 没有这条路径（探出 404，如实报）。
    #   老实现「测试绿、聊天 404」的根：探的是 core 曾经乱补 /v1 之后的假地址，非真实地址。
    agent_url = core_base_url(base).split("#", 1)[0]
    agent_headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {b['api_key']}",
    }
    agent_body = {
        "model": b["model"],
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "ping"}],
    }
    if agent_url != url:
        a_code, a_neterr, _ = _probe_once(agent_url, agent_headers, agent_body)
        if a_neterr is None and a_code in (404, 405):
            # 标准地址活着、Agent 地址却没有这个路径 → 该厂商与引擎的调用方式不兼容。
            # 网络层错误（a_neterr）不在此列：标准探测已证明网络与鉴权都通，
            # 偶发抖动不该把整个测试打红。
            return {
                "ok": False,
                "message": (
                    msg("runtime_settings.py.012", target=target) +
                    msg("runtime_settings.py.013", agent_url=agent_url, a_code=a_code) +
                    msg("runtime_settings.py.014") +
                    msg("runtime_settings.py.015")
                ),
                "latency_ms": latency,
            }

    return {"ok": True, "message": msg("runtime_settings.py.016", target=target), "latency_ms": latency}


def test_binding(binding: dict[str, Any]) -> dict[str, Any]:
    """Run the real probe and bind the result to the exact tested configuration."""

    result = _test_binding_impl(binding)
    result["tested_fingerprint"] = binding_fingerprint(binding)
    result["zinnia_compatible"] = _zinnia_usable(binding)
    return result


def test_all_bindings() -> dict[str, Any]:
    """"[v1.0.39.3] 批量连接测试：对当前 model_profiles 全量真发最小请求。

    后端持有全部真实 api_key（前端不回传真 key），故能测所有厂商/模型而不误报。
    返回值按 model_profiles 下标对齐：{"ok": bool, "results": [{"idx", "ok", "message", "latency_ms"}, ...]}。
    """

    _ensure_loaded()
    profiles = _state.get("model_profiles") or []
    results: list[dict[str, Any]] = []
    for idx, raw in enumerate(profiles):
        norm = _norm_binding(raw)
        if norm is None:
            results.append({
                "idx": idx,
                "provider": "",
                "model": "",
                "ok": False,
                "message": msg("event.test.binding.impl.01"),
                "latency_ms": None,
            })
            continue
        r = _test_binding_impl(norm)
        results.append({
            "idx": idx,
            "provider": str(norm.get("provider", "")),
            "model": str(norm.get("model", "")),
            "ok": bool(r.get("ok")),
            "message": str(r.get("message", "")),
            "latency_ms": r.get("latency_ms"),
        })
    return {"ok": True, "results": results}