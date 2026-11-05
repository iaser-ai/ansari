// Prints the SDK identity the build stamps into the card document (`data-sdk-*` on the body), as JSON.
// A public release is identified by its pinned stack version; the registry integrity of every SAGA package is recorded
// in the lockfile and is not repeated here. A private candidate (`0.0.0-candidate.g<commit>`, installed from
// candidates/ until the release is on the registry) is identified by its source commit and the bytes of its tarballs.
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const STACK = '@saga-a2ui/react-mcp-stack';
const CANDIDATE = /^0\.0\.0-candidate\.g([0-9a-f]{12})$/;
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function sdkIdentity() {
  const version = manifest.dependencies[STACK];
  const candidate = CANDIDATE.exec(version);
  if (!candidate) return {kind: 'registry', version, source: 'none', stackSha256: 'none', setSha256: 'none'};
  const directory = new URL(`../candidates/saga-${version}/`, import.meta.url);
  const tarballs = readdirSync(directory).filter(name => name.endsWith('.tgz')).sort();
  const digests = tarballs.map(name => `${name} ${sha256(readFileSync(new URL(name, directory)))}\n`);
  const stack = `saga-a2ui-react-mcp-stack-${version}.tgz`;
  if (!tarballs.includes(stack)) throw new Error(`candidates/saga-${version}/ has no ${stack}.`);
  return {kind: 'candidate', version, source: candidate[1], stackSha256: sha256(readFileSync(new URL(stack, directory))), setSha256: sha256(digests.join(''))};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(sdkIdentity()));
