"""The agent lookup runs on every call. A column that is not in the database yet must not stop calls."""

import types

import pytest

import app.grok_conversation as gc

U = "11111111-1111-1111-1111-111111111111"


class Rest:
    """Raises for any select that names a column the 'database' does not have."""
    rows: list = []
    missing_provider = False
    fail_with: Exception | None = None
    selects: list = []

    def __init__(self, *a, **k):
        pass

    async def select(self, table, *, select, filters, limit=None, order=None):
        Rest.selects.append(select)
        if Rest.fail_with:
            raise Rest.fail_with
        if Rest.missing_provider and "provider" in select:
            raise RuntimeError('select user_agents failed: HTTP 400 {"message":"column user_agents.provider does not exist"}')
        return [{k: v for k, v in r.items() if k in select} for r in Rest.rows]

    async def aclose(self):
        pass


@pytest.fixture(autouse=True)
def _rest(monkeypatch):
    monkeypatch.setattr(gc, "_Rest", Rest)
    Rest.rows, Rest.missing_provider, Rest.fail_with, Rest.selects = [], False, None, []


def settings():
    return types.SimpleNamespace(supabase_url="https://x.supabase.co", supabase_service_role_key="srv", mock_mode=False)


async def test_a_missing_provider_column_does_not_stop_calls_and_means_grok():
    Rest.missing_provider = True
    Rest.rows = [{"voice_id": "eve", "active": True, "provider": "grok"}]
    link = await gc.fetch_agent_link(settings(), U, "s")
    assert (link.provider, link.voice_id) == ("grok", "eve")
    assert Rest.selects == ["voice_id,active,provider", "voice_id,active"]


async def test_a_missing_provider_column_with_no_agent_row_is_standard_gpt_live():
    Rest.missing_provider = True
    assert await gc.fetch_agent_link(settings(), U, "s") is None


async def test_with_the_column_present_the_provider_is_read_normally():
    Rest.rows = [{"voice_id": "ws__mine", "active": True, "provider": "inworld"}]
    link = await gc.fetch_agent_link(settings(), U, "s")
    assert (link.provider, link.voice_id) == ("inworld", "ws__mine")
    assert Rest.selects == ["voice_id,active,provider"]


async def test_any_other_failure_still_ends_the_call_instead_of_becoming_gpt_live():
    Rest.fail_with = RuntimeError("select user_agents failed: HTTP 503 upstream")
    with pytest.raises(RuntimeError, match="call not connected"):
        await gc.fetch_agent_link(settings(), U, "s")
    Rest.fail_with = RuntimeError("select user_agents failed: HTTP 400 something unrelated")
    with pytest.raises(RuntimeError, match="call not connected"):
        await gc.fetch_agent_link(settings(), U, "s")
