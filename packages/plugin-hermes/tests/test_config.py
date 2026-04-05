"""Basic tests for engram_hermes config module."""

from engram_hermes.config import EngramHermesConfig


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
