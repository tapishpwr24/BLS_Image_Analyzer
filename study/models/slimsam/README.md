# SlimSAM leaf finder

Quantized ONNX export of SlimSAM-77 (a compressed Segment Anything model), from
https://huggingface.co/Xenova/slimsam-77-uniform. Licence: Apache-2.0.

- `vision_encoder_quantized.onnx`: runs once per photo (about 2–6 s on a phone)
- `prompt_encoder_mask_decoder_quantized.onnx`: runs for each tap (well under a second)

Bundled with the app so it works offline and doesn't depend on Hugging Face being reachable.
Upstream: Chen et al., "SlimSAM: 0.1% Data Makes Segment Anything Slim" (2023);
Kirillov et al., "Segment Anything" (Meta AI, 2023).
