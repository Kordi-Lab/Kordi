"""Collect conservative WebRTC notices from a verified pinned source checkout."""
import argparse
import time
import ast,base64,concurrent.futures,hashlib,json,urllib.request,urllib.error
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',required=True)
parser.add_argument('--cache',required=True)
parser.add_argument('--output',required=True)
args=parser.parse_args()
root=Path(args.source);cache=Path(args.cache);cache.mkdir(parents=True,exist_ok=True)
expected_inputs={'DEPS': '8f7895f3614c31e317e3298f040d7217220fc711655f3fbb0f5379333da08e3f', 'tools_webrtc/libs/generate_licenses.py': 'e6b5c94a8138e62c9d16beec64741d3e081ccc1ced59e983b818cef6a96a916e'}
for name,expected in expected_inputs.items():
 if hashlib.sha256((root/name).read_bytes()).hexdigest()!=expected:raise ValueError('Review changed WebRTC source inputs first')
module=ast.parse((root/'DEPS').read_text());variables={};deps={}
def value(n):
 if isinstance(n,ast.Constant):return n.value
 if isinstance(n,(ast.List,ast.Tuple)):return [value(x) for x in n.elts]
 if isinstance(n,ast.Dict):return {value(k):value(v) for k,v in zip(n.keys,n.values)}
 if isinstance(n,ast.BinOp) and isinstance(n.op,ast.Add):return value(n.left)+value(n.right)
 if isinstance(n,ast.Call) and isinstance(n.func,ast.Name) and n.func.id=='Var':return variables[value(n.args[0])]
 raise ValueError(ast.dump(n))
for n in module.body:
 if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name):
  if n.targets[0].id=='vars':variables=value(n.value)
  if n.targets[0].id=='deps':deps=value(n.value)
links={}
for path,entry in deps.items():
 url=entry if isinstance(entry,str) else entry.get('url')
 if url and '@' in url:links[path.removeprefix('src/')]=url.rsplit('@',1)
mod=ast.parse((root/'tools_webrtc/libs/generate_licenses.py').read_text());mapping=next(ast.literal_eval(n.value) for n in mod.body if isinstance(n,ast.Assign) and isinstance(n.targets[0],ast.Name) and n.targets[0].id=='LIB_TO_LICENSES_DICT')
# The pinned base64 target now uses Abseil; its obsolete third_party path is gone.
mapping['base64']=['LICENSE']
skip={'android_sdk','android_toolchain','auto','errorprone','guava','ijar','kotlin_stdlib','jni_zero','android_deps','androidx','ow2_asm','jdk','ffmpeg','openh264','protobuf','protobuf-javascript'}
def fetch(path,optional=False):
 local=root/path
 if local.is_file():data=local.read_bytes();url='https://github.com/webrtc-sdk/webrtc/blob/39d2180660d43d2e1630e564e3afe1c1fb72746e/'+path
 else:
  prefixes=[k for k in links if path==k or path.startswith(k+'/')]
  if not prefixes:
   if optional:return None
   raise ValueError('No pinned source for '+path)
  prefix=max(prefixes,key=len)
  repo,rev=links[prefix];rel=path[len(prefix)+1:]
  if repo.startswith('https://github.com/'):
   url='https://raw.githubusercontent.com/'+repo.removeprefix('https://github.com/').removesuffix('.git')+'/'+rev+'/'+rel
  else:url=repo+'/+/'+rev+'/'+rel+'?format=TEXT'
  cached=cache/hashlib.sha256(url.encode()).hexdigest()
  if cached.exists():data=cached.read_bytes()
  else:
   try:
    for attempt in range(6):
     try:
      with urllib.request.urlopen(url,timeout=50) as r:data=r.read()
      break
     except urllib.error.HTTPError as error:
      if error.code not in {429,502,503} or attempt==5:raise
      time.sleep(3 * (attempt+1))
    time.sleep(0.3)
    if 'format=TEXT' in url:data=base64.b64decode(data)
    cached.write_bytes(data)
   except urllib.error.HTTPError as e:
    if optional and e.code==404:return None
    raise
 return {'file':path,'source':url,'sha256':hashlib.sha256(data).hexdigest(),'text':data.decode()}
def component(item):
 name,paths=item
 notices=[fetch(p) for p in paths]
 if paths:
  parent=Path(paths[0]).parent
  for extra in ['PATENTS','NOTICE','COPYING','LICENSE','LICENSE.TXT','README.ijg','LICENSE-BSD-3-Clause','LICENSE-IJG','LICENSE-ZLIB']:
   path=str(parent/extra)
   if path in paths:continue
   n=fetch(path,True)
   if n:notices.append(n)
 return {'name':name,'notices':notices}
selected=[(k,v) for k,v in mapping.items() if k not in skip and v]
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:rows=list(pool.map(component,selected))
Path(args.output).write_text(json.dumps({'revision':'39d2180660d43d2e1630e564e3afe1c1fb72746e','components':rows,'excluded':sorted(skip)},indent=2)+'\n')
print('Collected',len(rows),'WebRTC component notice sets')
