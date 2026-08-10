import json
from pathlib import Path


APPROVED_MODELS = {"whisper-small", "hy-mt2-1.8b"}
REQUIRED_FIELDS = {"repo", "revision", "task", "weight_format"}


def load_model_sources(path: Path) -> dict[str, dict[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    models = data.get("models")
    if not isinstance(models, dict) or set(models) != APPROVED_MODELS:
        raise ValueError("model_sources.json must define exactly the approved models")

    for model_id, row in models.items():
        if not isinstance(row, dict):
            raise ValueError(f"{model_id} must be an object")
        missing = REQUIRED_FIELDS - row.keys()
        if missing:
            raise ValueError(f"{model_id} missing {sorted(missing)}")
        if any(not isinstance(row[field], str) or not row[field] for field in REQUIRED_FIELDS):
            raise ValueError(f"{model_id} fields must be non-empty strings")

    return models
