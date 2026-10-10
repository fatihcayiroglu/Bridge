#!/usr/bin/env bash
# Integrity/applicability checks only. Does not apply to the working tree or run tests.
set -euo pipefail
handoff_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
(cd "$handoff_dir" && sha256sum --check SHA256SUMS)
python3 - "$handoff_dir" <<'PY'
import hashlib,json,os,subprocess,sys,tempfile
from pathlib import Path
p=Path(sys.argv[1]);root=p.parents[1];m=json.loads((p/'manifest.json').read_text())
patch=p/'semantic-followup.UNVERIFIED.patch'
assert hashlib.sha256(patch.read_bytes()).hexdigest()==m['patch_sha256']
assert hashlib.sha256((root/'scripts/abuse-lab/run.mjs').read_bytes()).hexdigest()==m['protected_file_sha256']
with tempfile.TemporaryDirectory(prefix='bridge-handoff-index-') as temp:
 env={**os.environ,'GIT_INDEX_FILE':temp+'/index'}
 def git(*args):return subprocess.check_output(['git',*args],cwd=root,env=env,text=True).strip()
 git('read-tree',m['source_commit'])
 git('apply','--cached','--check',str(patch));git('apply','--cached',str(patch))
 assert git('diff','--cached','--name-only',m['source_commit'])=='server/tests/semantic-confidentiality-regression.test.ts'
 assert git('write-tree')==m['integration_tree']
print('Artifact hashes and reconstructed integration tree match. Patch remains UNVERIFIED; no tests ran.')
PY
