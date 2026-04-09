"""Basic tests for remnic_hermes config module."""

import json

from remnic_hermes.config import EngramHermesConfig, _load_token_from_file


def test_default_config():
    """EngramHermesConfig has sensible defaults."""
    config = EngramHermesConfig()
    assert config.host == "127.0.0.1"
    assert config.port == 4318
    assert config.token == ""
    assert config.timeout == 30.0


def test_custom_config():
    """EngramHermesConfig accepts custom host/port."""
    config = EngramHermesConfig(host="192.168.1.1", port=9999)
    assert config.host == "192.168.1.1"
    assert config.port == 9999


def test_from_hermes_config_empty():
    """from_hermes_config handles empty config dict."""
    config = EngramHermesConfig.from_hermes_config({})
    assert config.host == "127.0.0.1"
    assert config.port == 4318


def test_load_token_prefers_remnic_store(monkeypatch, tmp_path):
    """Fresh Remnic installs read ~/.remnic/tokens.json before legacy fallback."""
    monkeypatch.setenv("HOME", str(tmp_path))
    remnic_dir = tmp_path / ".remnic"
    remnic_dir.mkdir()
    engram_dir = tmp_path / ".engram"
    engram_dir.mkdir()

    (remnic_dir / "tokens.json").write_text(
        json.dumps({"tokens": [{"connector": "hermes", "token": "remnic-token"}]}),
        encoding="utf-8",
    )
    (engram_dir / "tokens.json").write_text(
        json.dumps({"tokens": [{"connector": "hermes", "token": "engram-token"}]}),
        encoding="utf-8",
    )

    assert _load_token_from_file() == "remnic-token"


def test_load_token_falls_back_to_legacy_store(monkeypatch, tmp_path):
    """Legacy token store still works when the Remnic path does not exist yet."""
    monkeypatch.setenv("HOME", str(tmp_path))
    engram_dir = tmp_path / ".engram"
    engram_dir.mkdir()
    (engram_dir / "tokens.json").write_text(
        json.dumps({"tokens": [{"connector": "hermes", "token": "engram-token"}]}),
        encoding="utf-8",
    )

    assert _load_token_from_file() == "engram-token"
