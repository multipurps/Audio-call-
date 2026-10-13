import asyncio

from app.config import load_settings
from app import global_config
from app.global_config import call_mode, fetch_global_block, render_section
from app.live import build_live_system_prompt
from app.pipeline import build_system_prompt

ENV = {"ASSISTANT_MOCK_MODE": "true"}


def _settings(**kw):
    import dataclasses

    return dataclasses.replace(load_settings(ENV), **kw)


def test_call_mode_mapping():
    assert call_mode("app", True) == "app"
    assert call_mode("whatsapp", False) == "social"
    assert call_mode("telegram", False) == "social"
    assert call_mode("twilio", False) == "phone"
    assert call_mode(None, False) == "phone"


def test_block_reaches_both_engines_and_is_absent_when_empty():
    block = render_section("Style: warm and brief\n- never say 'certainly'")
    live = build_live_system_prompt(load_settings(ENV), None, None, block)
    luna = build_system_prompt(load_settings(ENV), None, None, block)
    assert "Style: warm and brief" in live and "House guidance" in live
    assert "Style: warm and brief" in luna and "House guidance" in luna
    assert "House guidance" not in build_live_system_prompt(load_settings(ENV), None, None, "")
    assert "House guidance" not in build_system_prompt(load_settings(ENV))


def test_fetch_without_supabase_or_on_failure_returns_empty():
    s = _settings(supabase_url=None, supabase_service_role_key=None)
    assert asyncio.run(fetch_global_block(s, model="luna", mode="phone")) == ""
    global_config._cache.clear()
    s = _settings(supabase_url="http://127.0.0.1:9", supabase_service_role_key="k")
    assert asyncio.run(fetch_global_block(s, model="live", mode="app")) == ""


def test_trainer_token_is_separate_from_user_token():
    import time

    import pytest

    from app.app_call import AppCallTokenError, sign_app_call_token, verify_any_app_call_token

    secret, sid, uid = "s3cret", "call-abc", "admin-1"
    user_tok = sign_app_call_token(secret, session_id=sid, user_id=uid)
    assert verify_any_app_call_token(secret, user_tok, session_id=sid) == (uid, False)

    exp = int(time.time()) + 300
    import hashlib
    import hmac

    sig = hmac.new(secret.encode(), f"trainercall:{sid}:{uid}:{exp}".encode(), hashlib.sha256).hexdigest()
    assert verify_any_app_call_token(secret, f"{exp}.{uid}.{sig}", session_id=sid) == (uid, True)
    with pytest.raises(AppCallTokenError):
        verify_any_app_call_token(secret, f"{exp}.{uid}.{sig}", session_id="call-other")
    with pytest.raises(AppCallTokenError):
        verify_any_app_call_token("wrong", f"{exp}.{uid}.{sig}", session_id=sid)


def test_trainer_registry_and_draft_flag():
    from app.global_config import clear_trainer, mark_trainer, trainer_engine

    assert trainer_engine("call-x") is None
    mark_trainer("call-x", "luna")
    assert trainer_engine("call-x") == "luna"
    mark_trainer("call-x", "anything-else")
    assert trainer_engine("call-x") == "live"
    clear_trainer("call-x")
    assert trainer_engine("call-x") is None
