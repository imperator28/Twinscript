def summarize_power(
    samples: list[dict[str, float]],
    *,
    error: str | None = None,
) -> dict[str, object]:
    if len(samples) < 2:
        return {"available": False, "error": error or "insufficient power samples"}

    ordered = sorted(samples, key=lambda row: row["timestamp"])
    joules = 0.0
    for first, second in zip(ordered, ordered[1:]):
        seconds = max(0.0, second["timestamp"] - first["timestamp"])
        joules += seconds * (first["watts"] + second["watts"]) / 2
    duration = max(0.0, ordered[-1]["timestamp"] - ordered[0]["timestamp"])
    return {
        "available": True,
        "durationSeconds": round(duration, 3),
        "joules": round(joules, 3),
        "averageWatts": round(joules / duration, 3) if duration else 0.0,
    }
