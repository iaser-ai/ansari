// Prints the SDK identity the build stamps into the card document (`data-sdk-*` on the body), as JSON.
// The application installs one exact public SAGA release from the npm registry, so the identity is that pinned stack
// version; the registry integrity of every SAGA package is recorded in the lockfile and is not repeated here.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export function sdkIdentity() {
  return {kind: 'registry', version: manifest.dependencies['@saga-a2ui/react-mcp-stack'], source: 'none', stackSha256: 'none', setSha256: 'none'};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(sdkIdentity()));
