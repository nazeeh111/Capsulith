# SPDX-License-Identifier: GPL-2.0-only
"""Rebuild only these known official-source controls on Apple Silicon macOS.

This script never loads a caller-supplied binary. It compiles the pinned sources
beside itself into a new output directory, and compares both complete dylibs.
"""
from pathlib import Path
import argparse,ctypes,hashlib,json,platform,subprocess
HERE=Path(__file__).resolve().parent

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output',type=Path,help='new directory; existing paths are rejected')
    args=parser.parse_args()
    if platform.system()!='Darwin' or platform.machine()!='arm64':
        parser.error('native fixture rebuilding requires Apple Silicon macOS and clang')
    manifest=json.loads((HERE/'manifest.json').read_text())
    for filename in ('xxhash.c','xxhash.h','LICENSE'):
        raw=(HERE/filename).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=manifest['files'][filename]['sha256']:
            parser.error(f'{filename} differs from the pinned official-source hash')
    output=args.output.resolve();output.mkdir(parents=True,exist_ok=False)
    libs={};builds=[]
    for opt in ('o2','o1'):
        target=output/f'libxxhash-{opt}.dylib'
        command=['clang','-arch','arm64','-'+opt.upper(),'-dynamiclib',str(HERE/'xxhash.c'),'-o',str(target)]
        subprocess.run(command,check=True)
        lib=ctypes.CDLL(str(target));fn=lib.XXH32
        fn.argtypes=[ctypes.c_void_p,ctypes.c_size_t,ctypes.c_uint];fn.restype=ctypes.c_uint
        libs[opt]=(lib,fn)
        builds.append({'optimization':opt,'command':command,'artifactSHA256':hashlib.sha256(target.read_bytes()).hexdigest(),'artifactBytes':target.stat().st_size})
    oracle=json.loads((HERE/'oracle.json').read_text())
    vectors={v['id']:bytes.fromhex(v['inputHex']) for v in oracle['vectors']}
    calls=0
    for case in oracle['cases']:
        raw=vectors[case['vector']];offset=case['nativePointerModulo16']
        owner=ctypes.create_string_buffer(len(raw)+32);base=(ctypes.addressof(owner)+15)&~15;pointer=base+offset
        if raw:ctypes.memmove(pointer,raw,len(raw))
        for opt,(_,fn) in libs.items():
            value=int(fn(pointer,len(raw),case['seedU32']));calls+=1
            if value!=case['returnU32']:
                raise AssertionError((opt,case,value))
    receipt={'status':'verified rebuilt complete official-source dylibs against committed oracle','cases':len(oracle['cases']),'nativeCalls':calls,'builds':builds,'compiler':subprocess.check_output(['clang','--version'],text=True),'sourceTag':'v0.8.3','sourceModified':False,'limit':'Artifact bytes may differ across compiler/linker versions. Matching results on this corpus do not prove universal equality.'}
    (output/'native-rebuild-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))

if __name__=='__main__':main()
