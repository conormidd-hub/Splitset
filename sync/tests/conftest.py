import json
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def fixture_json():
    def load(name: str):
        with (FIXTURES / name).open(encoding="utf-8") as f:
            return json.load(f)
    return load
