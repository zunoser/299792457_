import json
import tempfile
import unittest
from pathlib import Path

from scripts.build_dashboard import build_dashboard, load_archive


class DashboardTest(unittest.TestCase):
    def test_loads_post_and_reply_in_tokyo_time(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "2026" / "08"
            root.mkdir(parents=True)
            samples = [
                ("1", "Wed Aug 26 23:30:00 +0000 2026", None, False, False),
                ("2", "Thu Aug 27 01:00:00 +0000 2026", "friend", False, False),
                ("3", "Thu Aug 27 02:00:00 +0000 2026", None, True, False),
                ("4", "Thu Aug 27 03:00:00 +0000 2026", None, False, True),
            ]
            for post_id, created_at, reply_to, is_quote, is_repost in samples:
                payload = {
                    "tweet": {
                        "restId": post_id,
                        "legacy": {
                            "createdAt": created_at,
                            "fullText": "sample",
                            "inReplyToScreenName": reply_to,
                            "isQuoteStatus": is_quote,
                        },
                    }
                }
                if is_repost:
                    payload["retweeted"] = {}
                (root / f"{post_id}.json").write_text(json.dumps(payload))

            frame = load_archive(Path(directory))

        self.assertEqual(frame["kind"].tolist(), ["投稿", "返信", "引用", "リポスト"])
        self.assertEqual(frame["hour"].tolist(), [8, 10, 11, 12])
        self.assertEqual(frame["weekday"].tolist(), ["木", "木", "木", "木"])

    def test_dashboard_is_deterministic(self):
        frame = load_archive()
        first = build_dashboard(frame)
        second = build_dashboard(frame)

        self.assertEqual(first, second)
        self.assertIn("活動タイムライン", first)
        self.assertIn("activity-chart", first)


if __name__ == "__main__":
    unittest.main()
