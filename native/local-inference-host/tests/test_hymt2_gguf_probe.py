import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from feasibility.hymt2_gguf_probe import hymt2_payload, probe_server, render_json


class HyMt2GgufProbeTest(unittest.TestCase):
    def test_payload_uses_the_documented_user_only_prompt(self):
        payload = hymt2_payload("Hold ±0.2 mm.", "Chinese")

        self.assertEqual(payload["temperature"], 0)
        self.assertEqual(payload["max_tokens"], 256)
        self.assertEqual(payload["messages"], [{
            "role": "user",
            "content": (
                "Translate the following text into Chinese. Note that you should only "
                "output the translated result without any additional explanation: "
                "Hold ±0.2 mm."
            ),
        }])

    def test_probe_records_llamacpp_cpu_evidence(self):
        class FakeServer:
            def chat(self, _payload):
                return {
                    "choices": [{"message": {"content": "保持 ±0.2 mm。"}}],
                    "usage": {"completion_tokens": 5},
                }

        result = probe_server(FakeServer(), "Hold ±0 mm.", "Chinese")

        self.assertTrue(result["passed"])
        self.assertEqual(result["runtime"], "llama.cpp")
        self.assertEqual(result["requestedDevice"], "CPU")
        self.assertEqual(result["actualDevice"], "CPU")
        self.assertEqual(result["completionTokens"], 5)

    def test_report_is_safe_for_the_default_windows_console(self):
        output = render_json({"text": "已确认"})

        self.assertTrue(output.isascii())
        self.assertIn("\\u5df2", output)


if __name__ == "__main__":
    unittest.main()
