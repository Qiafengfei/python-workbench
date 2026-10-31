import unittest

from execution import statement_at


TENSOR_SOURCE = """import torch
import torch.nn as nn
from torch.nn.functional import cross_entropy
import numpy as np

torch.manual_seed(7)

logits = torch.tensor([[0.0,0.0],
                        [0.0,1.0],
                        [1.0,0.0],
                        [1.0,1.0],
                        [0.5,0.5],
                        [0.22,0.8]],dtype = torch.float32)
"""


class StatementTests(unittest.TestCase):
    def test_tensor_continuation_selects_whole_assignment(self):
        for line in range(8, 14):
            with self.subTest(line=line):
                result = statement_at(TENSOR_SOURCE, line)
                self.assertEqual((result["start_line"], result["end_line"]), (8, 13))
                self.assertTrue(result["source"].startswith("logits = torch.tensor("))
                self.assertTrue(result["source"].endswith("dtype = torch.float32)"))
                self.assertEqual(result["mode"], "selection")

    def test_import_simple_expression_and_blank_stay_local(self):
        for line, expected in ((1, "import torch"), (6, "torch.manual_seed(7)"), (7, "")):
            result = statement_at(TENSOR_SOURCE, line)
            self.assertEqual(result["source"], expected)
            self.assertEqual(result["mode"], "line")

    def test_compound_and_decorators_include_required_context(self):
        source = "x = 0\nfor i in range(2):\n    x += i\nprint(x)\n"
        result = statement_at(source, 3)
        self.assertEqual(result["source"], "for i in range(2):\n    x += i")
        self.assertEqual(result["mode"], "selection")
        result = statement_at("@decorator\ndef f():\n    return 1\n", 1)
        self.assertEqual((result["start_line"], result["end_line"]), (1, 3))

    def test_incomplete_later_code_does_not_break_completed_statement(self):
        result = statement_at("values = [1,\n          2]\nunfinished = (\n", 2)
        self.assertEqual(result["source"], "values = [1,\n          2]")
        self.assertEqual(result["mode"], "selection")
        result = statement_at("values = [1,\n          2", 2)
        self.assertEqual(result["start_line"], 1)
        self.assertEqual(result["mode"], "line")

    def test_string_brackets_backslash_and_validation(self):
        result = statement_at("text = '''[\n)\n]'''\nprint(text)\n", 2)
        self.assertEqual((result["start_line"], result["end_line"]), (1, 3))
        result = statement_at("value = 1 + \\\n    2\n", 2)
        self.assertEqual(result["start_line"], 1)
        for line in (0, -1, 100, True):
            with self.assertRaises(ValueError):
                statement_at("x=1", line)

    def test_incomplete_later_statement_keeps_compound_context(self):
        samples = [
            ("if True:\n    x = 1\n\nunfinished = [", 2, "if True:\n    x = 1"),
            ("@staticmethod\ndef f():\n    return 1\n\nunfinished = [", 1, "@staticmethod\ndef f():\n    return 1"),
            ("if True:\n    x = 1\nelse:\n    x = 2\nunfinished = [", 4, "if True:\n    x = 1\nelse:\n    x = 2"),
        ]
        for source, line, expected in samples:
            with self.subTest(source=source):
                result = statement_at(source, line)
                self.assertEqual(result["source"], expected)
                self.assertEqual(result["mode"], "selection")
        # Do not run a truncated prefix of an unfinished block.
        source = "if True:\n    x = 1\n    unfinished = ["
        result = statement_at(source, 2)
        self.assertEqual(result["source"], source)
        self.assertEqual(result["mode"], "line")


if __name__ == "__main__":
    unittest.main()
