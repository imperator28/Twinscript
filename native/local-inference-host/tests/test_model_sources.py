import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from feasibility.model_sources import load_model_sources


class ModelSourcesTest(unittest.TestCase):
    def test_manifest_pins_exactly_whisper_and_hymt2(self):
        sources = load_model_sources(ROOT / "feasibility" / "model_sources.json")

        self.assertEqual(set(sources), {"whisper-small", "hy-mt2-1.8b"})
        self.assertEqual(
            sources["whisper-small"]["task"],
            "automatic-speech-recognition-with-past",
        )
        self.assertEqual(
            sources["hy-mt2-1.8b"]["task"],
            "text-generation-with-past",
        )
        self.assertTrue(all(row["revision"] for row in sources.values()))

    def test_manifest_rejects_unapproved_models(self):
        invalid = ROOT / "tests" / "invalid-model-sources.json"
        invalid.write_text(
            '{"models":{"other":{"repo":"x","revision":"main",'
            '"task":"x","weight_format":"x"}}}',
            encoding="utf-8",
        )
        self.addCleanup(invalid.unlink, missing_ok=True)

        with self.assertRaisesRegex(ValueError, "approved models"):
            load_model_sources(invalid)


if __name__ == "__main__":
    unittest.main()
