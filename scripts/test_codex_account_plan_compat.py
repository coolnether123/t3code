import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from codex_account_plan_compat import translate_reply

class PlanCompatibilityTests(unittest.TestCase):
    def test_new_plan_and_routing_fields(self):
        pending = {2}
        payload = {"id": 2, "result": {"account": {"type": "chatgpt", "email": "redacted@example.com", "planType": "promax"}, "requiresOpenaiAuth": True, "workspaceRouting": {"chatgptAccountId": "synthetic-account-id", "backendOrigin": "https://chatgpt.com/backend-api", "accountRoutingOverride": None}}}
        decoded = json.loads(translate_reply(json.dumps(payload).encode(), pending))
        self.assertEqual(decoded["result"]["account"]["planType"], "unknown")
        self.assertEqual(decoded["result"]["workspaceRouting"], payload["result"]["workspaceRouting"])
        self.assertEqual(pending, set())
    def test_known_plan_is_preserved(self):
        self.assertEqual(json.loads(translate_reply(b'{"id":1,"result":{"account":{"planType":"pro"}}}', {1}))["result"]["account"]["planType"], "pro")
    def test_unrelated_tool_content_is_unchanged(self):
        line = b'{"id":5,"result":{"planType":"client-specific-plan"}}\n'
        self.assertEqual(translate_reply(line, {1}), line)
    def test_rate_limit_notification(self):
        decoded = json.loads(translate_reply(b'{"method":"account/rateLimits/updated","params":{"rateLimits":{"planType":"future-plan"}}}', set()))
        self.assertEqual(decoded["params"]["rateLimits"]["planType"], "unknown")
    def test_non_string_stays_invalid(self):
        self.assertEqual(json.loads(translate_reply(b'{"id":1,"result":{"account":{"planType":123}}}', {1}))["result"]["account"]["planType"], 123)
    def test_non_json_passes_through(self):
        self.assertEqual(translate_reply(b'non-json\n', set()), b'non-json\n')

if __name__ == '__main__':
    unittest.main()
