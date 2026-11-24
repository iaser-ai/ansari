import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * skills/ansari/SKILL.md, the public Ansari agent skill (#409). It must call the
 * MCP server (mcp.askansari.ai/mcp), which holds the ansari-mcp key, and never
 * apps/api's /api/v2/mcp-complete, which refuses a keyless call once it
 * enforces (#314). A skill is public, so it can never carry a key either.
 * skills/ stays outside the pnpm workspace.
 *
 * The checks are one function so the known-bad case below proves each fails.
 */

const repoRoot = resolve(__dirname, '../../..');
const skillDir = resolve(repoRoot, 'skills/ansari');
const MCP_URL = 'https://mcp.askansari.ai/mcp';

function skillProblems(text: string, dirName: string): string[] {
  const problems: string[] = [];
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return ['no frontmatter'];
  let fm: Record<string, unknown>;
  try {
    fm = parse(match[1]) as Record<string, unknown>;
  } catch {
    return ['frontmatter is not YAML'];
  }
  const body = text.slice(match[0].length);

  // Agent Skills specification (agentskills.io/specification).
  const name = fm.name;
  if (typeof name !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) problems.push('invalid name');
  if (name !== dirName) problems.push('name does not match its directory');
  const description = fm.description;
  if (typeof description !== 'string' || description.trim().length === 0 || description.length > 1024) problems.push('invalid description');
  if (fm.compatibility !== undefined && (typeof fm.compatibility !== 'string' || fm.compatibility.length > 500)) problems.push('invalid compatibility');
  const metadata = fm.metadata;
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Object.values(metadata).some((v) => typeof v !== 'string'))) {
    problems.push('metadata values must be strings');
  }

  // The one host it may reach is the MCP server.
  const runtime = fm.runtime as { network?: { allowed_domains?: unknown } } | undefined;
  if (JSON.stringify(runtime?.network?.allowed_domains) !== JSON.stringify(['mcp.askansari.ai'])) problems.push('allowed_domains is not exactly mcp.askansari.ai');
  if (!body.includes(`curl -sS --max-time 90 -X POST '${MCP_URL}'`)) problems.push('no curl to the MCP endpoint');
  if (!body.includes("-H 'Accept: application/json, text/event-stream'")) problems.push('no Accept header for both response types');
  if (!body.includes('answer_islamic_question')) problems.push('does not name the MCP tool');
  if (/api\.askansari\.ai|mcp-staging\.askansari\.ai/.test(text)) problems.push('names another host');
  // Owner's decision (2026-11-25): askansari.ai only, so no ansari.chat host anywhere (api., mcp. or the site).
  if (/ansari\.chat/.test(text)) problems.push('names an ansari.chat host');
  if (/mcp-complete|\/api\/v2\//.test(text)) problems.push('calls apps/api');

  // No authentication claims, no attribution header the MCP server drops, no credentials.
  if (/no authentication|requires no auth|no api key is needed/i.test(text)) problems.push('claims no authentication');
  if (/x-ansari-client/i.test(text)) problems.push('sends X-Ansari-Client');
  if (/ansari_[a-z]+_(development|staging|production)_|authorization:|bearer /i.test(text)) problems.push('carries a credential');

  // The question goes in through a quoted heredoc only, never into the command.
  if (!body.includes("<<'ANSARI_QUESTION_END' |\nQUESTION GOES HERE\nANSARI_QUESTION_END\n")) problems.push('question is not passed through the quoted heredoc');
  return problems;
}

describe('Ansari agent skill (skills/ansari)', () => {
  const skill = readFileSync(resolve(skillDir, 'SKILL.md'), 'utf8');

  it('is a valid skill that calls only the MCP server, with no credential or no-auth claim', () => {
    expect(skillProblems(skill, 'ansari')).toEqual([]);
  });

  it('the checks fail on the old skill text (api.askansari.ai/api/v2/mcp-complete, no authentication)', () => {
    const old = [
      '---',
      'name: ansari',
      'description: Islamic questions.',
      'metadata:',
      '  version: 3.4',
      '  website: https://ansari.chat',
      'runtime:',
      '  network:',
      '    allowed_domains:',
      '      - api.askansari.ai',
      '---',
      'Answer Islamic questions by calling the Ansari API. The API requires no authentication.',
      "curl -s -X POST 'https://api.askansari.ai/api/v2/mcp-complete' \\",
      "  -H 'X-Ansari-Client: ansari-skill' \\",
      `  -d '{"messages": [{"role": "user", "content": "USER_QUESTION_HERE"}]}'`,
      '',
    ].join('\n');
    expect(skillProblems(old, 'ansari')).toEqual([
      'metadata values must be strings',
      'allowed_domains is not exactly mcp.askansari.ai',
      'no curl to the MCP endpoint',
      'no Accept header for both response types',
      'does not name the MCP tool',
      'names another host',
      'names an ansari.chat host',
      'calls apps/api',
      'claims no authentication',
      'sends X-Ansari-Client',
      'question is not passed through the quoted heredoc',
    ]);
    // Each near-miss is caught on its own.
    expect(skillProblems(skill.replace(/mcp\.askansari\.ai/g, 'mcp.ansari.chat'), 'ansari')).toContain('names an ansari.chat host');
    expect(skillProblems(skill.replace('(https://askansari.ai)', '(https://ansari.chat)'), 'ansari')).toEqual(['names an ansari.chat host']);
    expect(skillProblems(skill + '\nhttps://mcp-staging.askansari.ai/mcp\n', 'ansari')).toEqual(['names another host']);
    expect(skillProblems(skill + '\nPOST /api/v2/mcp-complete\n', 'ansari')).toContain('calls apps/api');
    expect(skillProblems(skill + '\nAuthorization: Bearer x\n', 'ansari')).toContain('carries a credential');
    expect(skillProblems(skill + '\nThe API requires no authentication.\n', 'ansari')).toEqual(['claims no authentication']);
    expect(skillProblems(skill, 'ansari-skill')).toContain('name does not match its directory');
    expect(skillProblems(skill.replace('---\nname: ansari', '---\nname: [ansari'), 'ansari')).toEqual(['frontmatter is not YAML']);
  });

  it('stays outside the pnpm workspace', () => {
    expect(existsSync(resolve(repoRoot, 'skills/package.json'))).toBe(false);
    expect(existsSync(resolve(skillDir, 'package.json'))).toBe(false);
    const workspace = parse(readFileSync(resolve(repoRoot, 'pnpm-workspace.yaml'), 'utf8')) as { packages: string[] };
    expect(workspace.packages.every((p) => !p.startsWith('skills'))).toBe(true);
  });
});
