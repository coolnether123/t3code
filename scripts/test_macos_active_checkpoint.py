"""Active-update tests use only synthetic databases and private temporary files."""
import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("checkpoint", pathlib.Path(__file__).with_name("macos-active-checkpoint.py"))
checkpoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checkpoint)


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.path = self.root / "statev2.sqlite"
        with sqlite3.connect(self.path) as db:
            for table in checkpoint.TABLES:
                db.execute("CREATE TABLE orchestration_v2_projection_" + table + "(thread_id TEXT,payload_json TEXT)")
        self.put("threads", {"id": "t", "archivedAt": None, "deletedAt": None})
        self.put("provider_threads", {"id": "pt", "appThreadId": "t", "driver": "codex", "status": "active", "providerSessionId": "ps", "nativeThreadRef": {"driver": "codex", "strength": "strong", "nativeId": "n"}})
        self.put("provider_sessions", {"id": "ps", "status": "ready"})
        self.put("provider_turns", {"id": "turn", "runAttemptId": "attempt", "providerThreadId": "pt", "status": "running"})
        self.put("runs", {"id": "r", "threadId": "t", "status": "running", "providerThreadId": "pt", "activeAttemptId": "attempt"})

    def tearDown(self):
        self.temp.cleanup()

    def put(self, table, payload):
        with sqlite3.connect(self.path) as db:
            db.execute("INSERT INTO orchestration_v2_projection_" + table + " VALUES (?,?)", (payload.get("threadId", "t"), json.dumps(payload)))

    def test_completed_receipt_cannot_change_and_pending_approval_cannot_be_answered(self):
        self.put("turn_items", {"id": "confirmed", "threadId": "t", "runId": "r", "type": "dynamic_tool", "status": "completed", "output": "saved-once"})
        before = checkpoint.snapshot(self.path)
        self.put("turn_items", {"id": "new", "threadId": "t", "status": "completed"})
        self.assertEqual(checkpoint.verify(before, self.path)["pending"], 1)
        with sqlite3.connect(self.path) as db:
            db.execute("DELETE FROM orchestration_v2_projection_turn_items WHERE json_extract(payload_json,'$.id')='confirmed'")
        with self.assertRaisesRegex(ValueError, "confirmed"):
            checkpoint.verify(before, self.path)

    def test_active_run_checkpoint_never_contains_original_prompt_and_verifies_once(self):
        before = checkpoint.snapshot(self.path)
        self.assertEqual(before["activeRuns"], 1)
        self.assertEqual(before["held"], 0)
        self.assertEqual(checkpoint.verify(before, self.path)["pending"], 1)
        self.put("runs", {"id": "resume", "threadId": "t", "status": "running", "providerThreadId": "pt", "activeAttemptId": "resume-attempt", "restartContinuationOfRunId": "r"})
        self.put("provider_turns", {"id": "resume-turn", "runAttemptId": "resume-attempt", "providerThreadId": "pt", "status": "running", "startedAt": "2026-11-06T19:47:09.827Z", "nativeTurnRef": {"driver": "codex", "strength": "strong", "nativeId": "accepted-turn"}})
        self.assertEqual(checkpoint.verify(before, self.path)["resumedOnce"], 1)
        verified = checkpoint.verify(before, self.path)
        self.assertTrue(verified["verified"])
        self.assertEqual(verified["resumeReceipts"][0]["nativeTurnId"], "accepted-turn")
        self.put("runs", {"id": "duplicate", "threadId": "t", "status": "running", "restartContinuationOfRunId": "r"})
        with self.assertRaisesRegex(ValueError, "duplicate"):
            checkpoint.verify(before, self.path)

    def test_failed_start_is_not_a_verified_resume_and_cannot_hide_recursive_failures(self):
        before = checkpoint.snapshot(self.path)
        self.put("runs", {"id": "failed-resume", "threadId": "t", "status": "failed", "activeAttemptId": "failed-attempt", "providerThreadId": "pt", "restartContinuationOfRunId": "r"})
        result = checkpoint.verify(before, self.path)
        self.assertFalse(result["verified"])
        self.assertEqual(result["resumedOnce"], 0)
        self.assertEqual(result["failedResumes"], 1)
        self.put("runs", {"id": "recursive-resume", "threadId": "t", "status": "failed", "restartContinuationOfRunId": "failed-resume"})
        result = checkpoint.verify(before, self.path)
        self.assertFalse(result["verified"])
        self.assertEqual(result["resumedOnce"], 0)

    def test_starting_or_unproven_provider_turn_stays_pending(self):
        before = checkpoint.snapshot(self.path)
        self.put("runs", {"id": "resume", "threadId": "t", "status": "running", "activeAttemptId": "resume-attempt", "providerThreadId": "pt", "restartContinuationOfRunId": "r"})
        self.assertFalse(checkpoint.verify(before, self.path)["verified"])
        self.put("provider_turns", {"id": "unproven-turn", "runAttemptId": "resume-attempt", "providerThreadId": "pt", "status": "pending", "startedAt": None, "nativeTurnRef": None})
        self.assertEqual(checkpoint.verify(before, self.path)["resumedOnce"], 0)
        for changes in [
            {"runAttemptId": "different-attempt"},
            {"providerThreadId": "different-thread"},
            {"startedAt": None},
            {"nativeTurnRef": {"driver": "codex", "strength": "weak", "nativeId": "unproven"}},
        ]:
            self.put("provider_turns", {"id": "mismatched-turn", "runAttemptId": "resume-attempt", "providerThreadId": "pt", "status": "running", "startedAt": "now", "nativeTurnRef": {"driver": "codex", "strength": "strong", "nativeId": "native-turn"}, **changes})
            self.assertFalse(checkpoint.verify(before, self.path)["verified"])

    def test_failed_source_cannot_be_counted_as_a_natural_completion(self):
        before = checkpoint.snapshot(self.path)
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.status','failed')")
        result = checkpoint.verify(before, self.path)
        self.assertFalse(result["verified"])
        self.assertEqual(result["finishedNaturally"], 0)
        self.assertEqual(result["failedSources"], 1)

    def test_active_guard_captures_and_refreshes_without_an_idle_wait_or_rewriting_baseline(self):
        spec = importlib.util.spec_from_file_location("guard", pathlib.Path(__file__).with_name("macos-activation-guard.py"))
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        manifest = {"active_checkpoint": True, "database": str(self.path), "baseline_file": str(self.root / "baseline.json"), "_manifest_sha256": "pin", "environment_id": "environment"}
        with patch.object(guard, "check_pins"):
            proof = guard.admit(manifest, capture=True)
            self.assertEqual(proof["state"]["activeRuns"], 1)
            original = pathlib.Path(manifest["baseline_file"]).read_bytes()
            self.put("turn_items", {"id": "late-tool", "threadId": "t", "runId": "r", "type": "dynamic_tool", "status": "running"})
            self.assertEqual(guard.admit(manifest)["state"]["held"], 1)
            self.assertEqual(pathlib.Path(manifest["baseline_file"]).read_bytes(), original)

    def test_pending_approval_uncertain_tool_and_child_are_held_without_replay(self):
        self.put("runtime_requests", {"id": "approval", "threadId": "t", "status": "pending", "kind": "command_execution_approval"})
        self.put("turn_items", {"id": "tool", "threadId": "t", "runId": "r", "type": "dynamic_tool", "status": "running"})
        self.put("subagents", {"id": "child", "threadId": "t", "status": "running", "origin": "provider_native"})
        before = checkpoint.snapshot(self.path)
        self.assertEqual((before["held"], before["pendingApprovals"], before["childAgents"]), (1, 1, 1))
        self.assertIn("pending-request", before["runs"][0]["reasons"])
        self.assertIn("uncertain-tool-result", before["runs"][0]["reasons"])
        self.assertEqual(checkpoint.verify(before, self.path)["held"], 1)

    def test_crash_after_prepare_retains_original_held_sources(self):
        self.put("turn_items", {"id": "tool", "threadId": "t", "runId": "r", "type": "command_execution", "status": "running"})
        state = checkpoint.snapshot(self.path)
        destination = self.root / "runtime" / "update-checkpoint.json"
        checkpoint.write_fence(destination, state)
        checkpoint.write_fence(destination, {"runs": []})
        fence = json.loads(destination.read_text())
        self.assertEqual(fence["heldRunIds"], ["r"])
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_natural_completion_and_recovery_hold_are_not_pending_retries(self):
        before = checkpoint.snapshot(self.path)
        with sqlite3.connect(self.path) as db:
            db.execute("UPDATE orchestration_v2_projection_runs SET payload_json=json_set(payload_json,'$.status','completed')")
        self.assertEqual(checkpoint.verify(before, self.path)["finishedNaturally"], 1)
        self.assertEqual(checkpoint.verify(before, self.path)["pending"], 0)
        self.assertEqual(checkpoint.verify(before, self.path, {"heldRunIds": ["r"]})["held"], 1)

    def test_approval_identity_and_explicit_hold_survive_without_a_fabricated_answer(self):
        request = {"id": "approval", "threadId": "t", "status": "pending", "kind": "command_execution_approval", "nodeId": "node"}
        self.put("runtime_requests", request)
        before = checkpoint.snapshot(self.path)
        with sqlite3.connect(self.path) as db:
            request.update(status="resolved", resolvedAt="now")
            db.execute("UPDATE orchestration_v2_projection_runtime_requests SET payload_json=?", (json.dumps(request),))
        with self.assertRaisesRegex(ValueError, "not explicitly held"):
            checkpoint.verify(before, self.path)
        with sqlite3.connect(self.path) as db:
            request.update(status="expired", responseCapability={"type": "not_resumable", "reason": "Held after update; no answer submitted"})
            db.execute("UPDATE orchestration_v2_projection_runtime_requests SET payload_json=?", (json.dumps(request),))
        self.assertEqual(checkpoint.verify(before, self.path)["held"], 1)


if __name__ == "__main__":
    unittest.main()
