import pathlib
import sys
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from feasibility.energy import summarize_power


class EnergyTest(unittest.TestCase):
    def test_integrates_watts_over_time_without_affecting_the_gate(self):
        result = summarize_power([
            {"timestamp": 0.0, "watts": 10.0},
            {"timestamp": 2.0, "watts": 14.0},
            {"timestamp": 5.0, "watts": 8.0},
        ])

        self.assertTrue(result["available"])
        self.assertEqual(result["durationSeconds"], 5.0)
        self.assertEqual(result["joules"], 57.0)
        self.assertEqual(result["averageWatts"], 11.4)

    def test_unavailable_samples_are_reported_not_raised(self):
        self.assertEqual(
            summarize_power([], error="Energy Meter counter unavailable"),
            {"available": False, "error": "Energy Meter counter unavailable"},
        )


if __name__ == "__main__":
    unittest.main()
