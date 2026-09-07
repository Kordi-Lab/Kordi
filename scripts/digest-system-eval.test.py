#!/usr/bin/env python3
"""The evaluator must reject a planted leak and a fabricated deadline."""
import contextlib
import datetime as dt
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import sys
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('digest_eval', Path(__file__).with_name('digest-system-eval.py'))
evaluator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluator)

class DigestEvaluationTests(unittest.TestCase):
    def test_accepts_reference_contract_then_rejects_leak_and_guessed_deadline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = SimpleNamespace(viewer='synthetic-viewer', phase=0, sql=root/'fixture.sql', manifest=root/'manifest.json', response=root/'response.json', output=root/'result.json')
            with contextlib.redirect_stdout(io.StringIO()): evaluator.prepare(args)
            manifest = json.loads(args.manifest.read_text())
            tomorrow = dt.datetime.fromisoformat(manifest['preparedAt']).astimezone(dt.timezone(dt.timedelta(hours=3))).date() + dt.timedelta(days=1)
            response = {'accountId':args.viewer, 'sources':[{'id':s['messageId'],'text':s['text']} for s in manifest['sources']], 'snapshot':{
                'claims':[], 'suggestions':[],
                'commitments':[{'id':'copy-review','title':'Review copy','sourceIds':[evaluator.identity('design-question')],'ownerAccountId':None,'dueAt':None}],
                'calendarCandidates':[{'id':'launch','title':'Launch review','sourceIds':[evaluator.identity('launch-confirm')],'startAt':f'{tomorrow}T14:00:00+03:00'}]}}
            def evaluate():
                args.response.write_text(json.dumps(response))
                with contextlib.redirect_stdout(io.StringIO()): return evaluator.evaluate(args)
            self.assertTrue(evaluate())
            response['snapshot']['claims'] = [{'id':'leak','title':'PRIVACY_CANARY_7B19','sourceIds':[evaluator.identity('private-canary')]}]
            self.assertFalse(evaluate())
            response['snapshot']['claims'] = []
            response['snapshot']['commitments'][0]['dueAt'] = f'{tomorrow}T00:00:00Z'
            self.assertFalse(evaluate())
            response['snapshot'] = None
            with self.assertRaises(SystemExit): evaluate()

if __name__ == '__main__': unittest.main()
