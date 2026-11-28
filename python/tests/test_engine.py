"""Checks the Python engine against the web app on its own example leaf.
Run: python -m unittest tests.test_engine -v   (from the BLS_Analyzer_py folder)"""
import os
import unittest

import numpy as np
from PIL import Image

from bls_analyzer import engine

HERE = os.path.dirname(__file__)


class TestMatchesApp(unittest.TestCase):
    def test_example_leaf_bls02(self):
        # Values shown by https://tapishpwr24.github.io/BLS_Image_Analyzer/app/
        rgb = np.asarray(Image.open(os.path.join(HERE, "data", "BLS_02.jpg")).convert("RGB"))
        r = engine.analyze(rgb)
        self.assertEqual((r["width"], r["height"]), (326, 2048))
        self.assertEqual(r["leafPixels"], 667602)
        self.assertEqual(r["healthyPct"], 74.22)
        self.assertEqual(r["chloroticPct"], 0.0)
        self.assertEqual(r["necroticPct"], 25.78)
        self.assertEqual(r["score"], 6)
        self.assertEqual(r["category"], "Moderately Susceptible")
        self.assertEqual(r["qc"], "PASS")

    def test_scale_boundaries(self):
        cases = [(0, 1), (0.5, 1), (0.51, 2), (2, 2), (6, 3), (12, 4), (25, 5), (40, 6), (60, 7), (75, 8), (75.01, 9)]
        for pct, score in cases:
            self.assertEqual(engine.bls_score(pct), score, pct)

    def test_combine_pools_pixels(self):
        a = engine.summarize(100, 90, 0, 10)
        b = engine.summarize(300, 150, 0, 150)
        c = engine.combine([a, b])
        self.assertEqual(c["diseasedPct"], 40.0)
        self.assertEqual(c["sections"], 2)


if __name__ == "__main__":
    unittest.main()
