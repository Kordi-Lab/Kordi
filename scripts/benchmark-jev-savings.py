#!/usr/bin/env python3
"""Paired synthetic PiP/Digest run, with checkpointed metrics and local Keychain auth."""
import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live',action='store_true')
    parser.add_argument('--remote-session', type=Path, help='Private task-owned SSH helper metadata')
    args=parser.parse_args()
    if not args.live: parser.error('--live is required')
    root=Path(__file__).resolve().parent.parent
    target_dir=root/'.build'/'jev-savings'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target_dir.mkdir(parents=True)
    result=subprocess.run(['cargo','build','-p','kordi-cloud-agent-runner','--example','benchmark_jev_savings'],cwd=root)
    if result.returncode:return result.returncode
    metadata=subprocess.run(['cargo','metadata','--no-deps','--format-version','1'],cwd=root,capture_output=True,text=True)
    if metadata.returncode:raise RuntimeError('Cargo metadata unavailable')
    binary=Path(json.loads(metadata.stdout)['target_directory'])/'debug/examples/benchmark_jev_savings'
    with urllib.request.urlopen('https://ai-gateway.vercel.sh/v1/models',timeout=20) as response:
        catalog=json.load(response)
    pricing={m['id']:m.get('pricing',{}) for m in catalog['data'] if m['id'] in ['openai/gpt-5.6-luna','typesafe-ai/jev']}
    spec=importlib.util.spec_from_file_location('keychain_launcher',root/'scripts/test-jev-routing-keychain.py')
    helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    env=os.environ.copy();env['AI_GATEWAY_API_KEY']=helper.read_test_key();env['KORDI_JEV_PROVIDER']='vercel';env['KORDI_JEV_MODEL']='typesafe-ai/jev'
    if args.remote_session:
        session=json.loads(args.remote_session.read_text())
        env['KORDI_BENCH_PROVIDER_HELPER']=session['helper']
    records=[]
    def checkpoint(code=None):
        data={'recordedAt':datetime.now(timezone.utc).isoformat(),'syntheticOnly':True,'pricingSource':'https://ai-gateway.vercel.sh/v1/models','pricing':pricing,'exitCode':code,'records':records}
        temporary=target_dir/'results.json.tmp';temporary.write_text(json.dumps(data,indent=2)+'\n');temporary.replace(target_dir/'results.json')
    checkpoint()
    child=subprocess.Popen([str(binary),'--live'],cwd=root,env=env,stdout=subprocess.PIPE,text=True);del env
    try:
        for line in child.stdout:
            value=json.loads(line);records.append(value);checkpoint()
            if value['type']=='arm':
                print(json.dumps({k:value[k] for k in ['case','arm','elapsedMs','qualityCheckPassed','error']} | {'modelCalls':value['generation']['calls']}),flush=True)
            else:print(json.dumps(value),flush=True)
        code=child.wait()
    except KeyboardInterrupt:
        child.terminate();code=child.wait()
    checkpoint(code)
    print('Saved benchmark:',target_dir.relative_to(root)/'results.json',flush=True)
    return code

if __name__=='__main__':
    raise SystemExit(main())
