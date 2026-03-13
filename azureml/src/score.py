import json
from typing import Any, Dict


def init() -> None:
    return None


def _clamp(value: float, min_value: float, max_value: float) -> float:
    return max(min_value, min(max_value, value))


def _round_float(value: float, digits: int = 6) -> float:
    return round(float(value), digits)


def _pick_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    for key in ("configAtual", "config", "input", "data"):
        value = payload.get(key)
        if isinstance(value, dict):
            return value
    return payload if isinstance(payload, dict) else {}


def _safe_float(config: Dict[str, Any], key: str, default: float) -> float:
    try:
        return float(config.get(key, default))
    except (TypeError, ValueError):
        return float(default)


def run(raw_data: Any) -> Dict[str, Any]:
    if isinstance(raw_data, (bytes, bytearray)):
        raw_data = raw_data.decode("utf-8")

    if isinstance(raw_data, str):
        try:
            payload = json.loads(raw_data)
        except json.JSONDecodeError:
            payload = {}
    elif isinstance(raw_data, dict):
        payload = raw_data
    else:
        payload = {}

    config = _pick_config(payload)
    edge_threshold = _safe_float(config, "edgeThreshold", 90)
    morphology_size = _safe_float(config, "morphologySize", 5)
    contrast_boost = _safe_float(config, "contrastBoost", 1.3)
    min_area = _safe_float(config, "minArea", 15)
    min_quality_score = _safe_float(config, "minQualityScore", 35)
    simplification = _safe_float(config, "simplification", 0.00001)

    confidence = 0.82
    if edge_threshold < 55 or edge_threshold > 150:
        confidence -= 0.08
    if min_area < 4 or min_area > 220:
        confidence -= 0.07
    if contrast_boost < 1.0 or contrast_boost > 2.2:
        confidence -= 0.05

    recommended_edge = _clamp(edge_threshold, 55, 135)
    recommended_morphology = _clamp(round(morphology_size), 3, 9)
    recommended_contrast = _clamp(contrast_boost, 1.1, 1.9)
    recommended_area = _clamp(min_area, 8, 120)
    recommended_simplification = _clamp(simplification, 0.000003, 0.00008)

    quality_hint = min_quality_score / 100.0
    confidence = _clamp((confidence * 0.75) + (quality_hint * 0.25), 0.45, 0.94)

    return {
        "provider": "azure-ml",
        "modelVersion": "demo-v1",
        "qualidadePredita": _round_float(confidence, 4),
        "edgeThresholdRecomendado": int(round(recommended_edge)),
        "morphologySizeRecomendado": int(round(recommended_morphology)),
        "contrastBoostRecomendado": _round_float(recommended_contrast, 3),
        "minAreaRecomendado": _round_float(recommended_area, 3),
        "simplificationRecomendado": _round_float(recommended_simplification, 6),
        "segmentMaskUrl": None,
        "observacoes": [
            "online endpoint ativo",
            "deployment placeholder pronto para substituicao por modelo treinado"
        ]
    }
