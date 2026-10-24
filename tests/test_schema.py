import sqlite3
import unittest
from pathlib import Path


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        migration = Path(__file__).resolve().parents[1] / "migrations" / "0001_init_schema.sql"
        self.db.executescript(migration.read_text(encoding="utf-8"))
        self.db.execute("INSERT INTO users (id) VALUES (?)", ("author-1",))

    def tearDown(self):
        self.db.close()

    def test_foreign_keys_are_enforced(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO submissions (id, author_id, kind, primary_language) VALUES (?, ?, ?, ?)",
                ("paper-1", "missing", "research", "yo"),
            )

    def test_multilingual_metadata_and_private_by_default(self):
        self.db.execute(
            "INSERT INTO submissions (id, author_id, kind, primary_language) VALUES (?, ?, ?, ?)",
            ("paper-1", "author-1", "research", "yo"),
        )
        self.db.executemany(
            "INSERT INTO submission_metadata (submission_id, language, title) VALUES (?, ?, ?)",
            [("paper-1", "yo", "Iwadi"), ("paper-1", "en", "Study")],
        )
        row = self.db.execute("SELECT visibility, consent_status FROM submissions WHERE id = ?", ("paper-1",)).fetchone()
        self.assertEqual(row, ("private", "pending"))
        self.assertEqual(self.db.execute("SELECT count(*) FROM submission_metadata").fetchone()[0], 2)

    def test_traditional_knowledge_cannot_be_made_public(self):
        self.db.execute(
            "INSERT INTO submissions (id, author_id, kind, primary_language) VALUES (?, ?, ?, ?)",
            ("tk-1", "author-1", "traditional_knowledge", "en"),
        )
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute("UPDATE submissions SET visibility = 'public' WHERE id = 'tk-1'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(
                "INSERT INTO submissions (id, author_id, kind, primary_language, visibility) VALUES (?, ?, ?, ?, ?)",
                ("tk-2", "author-1", "traditional_knowledge", "en", "public"),
            )


if __name__ == "__main__":
    unittest.main()
