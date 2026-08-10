# Windows Local Inference Feasibility

**Gate:** `GO: Whisper NPU and Hy-MT2 local fallback`

## Selected allocation

- Whisper selected device: NPU
- Hy-MT2 selected device: CPU
- Hy-MT2 selected runtime: llama.cpp

## Hardware evidence

- NPU: available — Intel(R) AI Boost
- GPU: unavailable — plugin process exited 3221225477 without diagnostics
- CPU: available — Intel(R) Core(TM) Ultra 7 165H

## Model and runtime findings

- Whisper NPU: supported
- Whisper first inference: 980.3 ms
- Whisper warm inference: 533.2 ms
- Hy-MT2 NPU: unsupported
- Hy-MT2 OpenVINO failure: ValueError: Trying to export a hunyuan_v1_dense model, that is a custom or unsupported architecture, but no custom export configuration was passed as `custom_export_configs`. Please refer to https://huggingface.co/docs/optimum/main/en/exporters/onnx/usage_guides/export_a_model#custom-export-of-transformers-models for an example on how to export custom models. Please open an issue at https://github.com/huggingface/optimum-intel/issues if you would like the model type hunyuan_v1_dense to be supported natively in the OpenVINO export.
- Hy-MT2 CPU/llama.cpp: supported
- Hy-MT2 load: 2,222.7 ms

### whisper-small

- Source: `openai/whisper-small`
- Resolved revision: `973afd24965f72e36ca33b3055d56a652f456b4d`
- OpenVINO exported: `true`

### hy-mt2-1.8b

- Source: `tencent/Hy-MT2-1.8B`
- Resolved revision: `9a341cd1b679d3efd23b46e847b01745a71ed792`
- OpenVINO exported: `false`

### hy-mt2-1.8b GGUF fallback

- Resolved revision: `1cd5208700acedef4ef93019b6cfc148b8522d45`
- Model file: `Hy-MT2-1.8B-Q4_K_M.gguf`
- Model SHA-256: `dc5f44fcf1fa496ee7ad725982c0c8c553a4de00259b53af84c4b89fb0c06699`
- Runtime SHA-256: `e3f35520ca9dcb448fc5471c881dc55059a0e5622b832213745c8e5bb71a560e`

## Bilingual translation probes

- en-zh-tolerance: PASS (2,132.7 ms) — 亚历克斯，在DVT过程中将轴公差控制在±0.2毫米范围内。
- en-zh-voltage: PASS (1,113.6 ms) — 普里亚确认该传感器使用 24 VDC 电压。
- en-zh-mixed: PASS (1,120.0 ms) — 明说DVT结构已经准备就绪，但连接器还需要重新检查。
- zh-en-tolerance: PASS (1,004.4 ms) — Alex, during the DVT stage, keep the shaft tolerance at ±0.2 mm.
- zh-en-voltage: PASS (691.0 ms) — Priya confirmed that the sensor uses 24 VDC.
- zh-en-mixed: PASS (1,096.1 ms) — Ming said the DVT build is ready, but the connector still needs to be reviewed.

## Remaining validation

- The 60-minute simultaneous-residency soak remains a release validation gate.
- OpenVINO GPU is disabled on this machine because isolated plugin discovery exits with an access violation.
- Energy counters were not sampled; energy is diagnostic and does not change the allocation.
