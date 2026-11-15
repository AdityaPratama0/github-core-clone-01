import { fail } from './store.ts';

const definitions = [
  ['create_repo', 'Create a repository for the authenticated owner.', { name: 'string', description: 'string', private: 'boolean' }, ['name']],
  ['get_repo', 'Read a repository owned by the authenticated owner.', { owner: 'string', repo: 'string' }, ['owner', 'repo']],
  ['create_issue', 'Open an issue in a repository.', { owner: 'string', repo: 'string', title: 'string', body: 'string' }, ['owner', 'repo', 'title']],
  ['list_issues', 'List issues, optionally filtered by state.', { owner: 'string', repo: 'string', state: 'string' }, ['owner', 'repo']],
  ['create_pull_request', 'Open a pull request between existing branches.', { owner: 'string', repo: 'string', title: 'string', head: 'string', base: 'string', body: 'string' }, ['owner', 'repo', 'title', 'head', 'base']],
  ['merge_pull_request', 'Squash a mergeable pull request into its base branch.', { owner: 'string', repo: 'string', pull_number: 'integer' }, ['owner', 'repo', 'pull_number']],
];
const tools = definitions.map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([name, type]) => [name, { type }])), required, additionalProperties: false } }));
const info = { name: 'standalone-forge', version: '1.0.0' };
export function mcp(f, message) {
  const error = (code, text) => ({ jsonrpc: '2.0', id: message?.id ?? null, error: { code, message: text } });
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return error(-32600, 'Invalid Request');
  const result = body => ({ jsonrpc: '2.0', id: message.id, result: body });
  if (message.id === undefined) return null;
  switch (message.method) {
    case 'initialize': return result({ protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: info });
    case 'server/discover': return result({ supportedVersions: ['2026-07-28', '2025-11-25'], capabilities: { tools: { listChanged: false } }, serverInfo: info, _meta: { 'io.modelcontextprotocol/serverInfo': info } });
    case 'ping': return result({});
    case 'tools/list': return result({ tools });
    case 'tools/call': {
      const { name, arguments: args = {} } = message.params || {}, tool = tools.find(x => x.name === name);
      if (!tool) return error(-32602, 'Unknown tool');
      if (!args || typeof args !== 'object' || tool.inputSchema.required.some(k => args[k] === undefined)) return error(-32602, 'Missing required argument');
      for (const [key, value] of Object.entries(args)) { const type = tool.inputSchema.properties[key]?.type; if (type && (type === 'integer' ? !Number.isInteger(value) : typeof value !== type)) return error(-32602, `Invalid argument ${key}`); }
      try {
        let body; const repo = () => f.repo(args.owner, args.repo);
        if (name === 'create_repo') body = f.repoJson(f.createRepo(args));
        else if (name === 'get_repo') body = f.repoJson(repo());
        else if (name === 'create_issue') body = f.issueJson(f.createIssue(repo(), args));
        else if (name === 'list_issues') body = [...repo().issues.values()].filter(x => args.state === 'all' || x.state === (args.state || 'open')).map(x => f.issueJson(x));
        else if (name === 'create_pull_request') body = f.pullJson(f.createPull(repo(), args));
        else if (name === 'merge_pull_request') body = f.merge(f.pull(repo(), args.pull_number));
        return result({ content: [{ type: 'text', text: JSON.stringify(body) }], structuredContent: Array.isArray(body) ? { issues: body } : body, isError: false });
      } catch (e) { return result({ isError: true, content: [{ type: 'text', text: e.message }] }); }
    }
    default: return error(-32601, 'Method not found');
  }
}
