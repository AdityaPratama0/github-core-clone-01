import { buildSchema, graphql } from '../vendor/graphql.mjs';

const schema = buildSchema(`
  interface Node { id: ID! }
  type User { login: String! }
  type Ref { name: String!, target: Commit }
  type Commit { oid: String! }
  enum IssueState { OPEN CLOSED }
  enum PullRequestState { OPEN CLOSED MERGED }
  enum MergeableState { MERGEABLE CONFLICTING UNKNOWN }
  enum SearchType { ISSUE REPOSITORY USER }
  enum OrderDirection { ASC DESC }
  enum IssueOrderField { CREATED_AT UPDATED_AT COMMENTS }
  enum PullRequestMergeMethod { MERGE SQUASH REBASE }
  input IssueOrder { field: IssueOrderField!, direction: OrderDirection! }
  type PageInfo { hasNextPage: Boolean!, hasPreviousPage: Boolean!, endCursor: String, startCursor: String }
  type IssueEdge { node: Issue!, cursor: String! }
  type IssueConnection { nodes: [Issue!]!, edges: [IssueEdge!]!, totalCount: Int!, pageInfo: PageInfo! }
  type PullRequestEdge { node: PullRequest!, cursor: String! }
  type PullRequestConnection { nodes: [PullRequest!]!, edges: [PullRequestEdge!]!, totalCount: Int!, pageInfo: PageInfo! }
  type PullRequestChangedFile { path: String!, additions: Int!, deletions: Int!, changeType: String! }
  type PullRequestChangedFileConnection { nodes: [PullRequestChangedFile!]!, totalCount: Int!, pageInfo: PageInfo! }
  type IssueComment implements Node { id: ID!, databaseId: Int!, body: String! }
  type IssueCommentEdge { node: IssueComment! }
  type Issue implements Node { id: ID!, databaseId: Int!, number: Int!, title: String!, body: String!, state: IssueState! }
  type PullRequest implements Node { id: ID!, databaseId: Int!, number: Int!, title: String!, body: String!, headRefName: String!, baseRefName: String!, headRefOid: String, baseRefOid: String, mergeable: MergeableState!, state: PullRequestState!, merged: Boolean!, files(first: Int, after: String): PullRequestChangedFileConnection! }
  type Repository implements Node {
    id: ID!, databaseId: Int!, name: String!, nameWithOwner: String!, owner: User!, defaultBranchRef: Ref,
    viewerPermission: String!, hasIssuesEnabled: Boolean!, description: String, isPrivate: Boolean!,
    issue(number: Int!): Issue, issues(first: Int, after: String, states: [IssueState!], orderBy: IssueOrder): IssueConnection!,
    pullRequest(number: Int!): PullRequest, pullRequests(first: Int, after: String, states: [PullRequestState!]): PullRequestConnection!
  }
  input CreateIssueInput { repositoryId: ID!, title: String!, body: String, clientMutationId: String }
  input CloseIssueInput { issueId: ID!, clientMutationId: String }
  input ReopenIssueInput { issueId: ID!, clientMutationId: String }
  input CreatePullRequestInput { repositoryId: ID!, title: String!, headRefName: String!, baseRefName: String!, body: String, draft: Boolean, clientMutationId: String }
  input MergePullRequestInput { pullRequestId: ID!, mergeMethod: PullRequestMergeMethod, commitHeadline: String, commitBody: String, clientMutationId: String }
  input AddCommentInput { subjectId: ID!, body: String!, clientMutationId: String }
  type IssuePayload { issue: Issue!, clientMutationId: String }
  type PullRequestPayload { pullRequest: PullRequest!, clientMutationId: String }
  type AddCommentPayload { commentEdge: IssueCommentEdge!, clientMutationId: String }
  type Query { viewer: User!, repository(owner: String!, name: String!): Repository, node(id: ID!): Node }
  type Mutation {
    createIssue(input: CreateIssueInput!): IssuePayload,
    closeIssue(input: CloseIssueInput!): IssuePayload,
    reopenIssue(input: ReopenIssueInput!): IssuePayload,
    createPullRequest(input: CreatePullRequestInput!): PullRequestPayload,
    mergePullRequest(input: MergePullRequestInput!): PullRequestPayload,
    addComment(input: AddCommentInput!): AddCommentPayload
  }
`);
function connection(items, args = {}) {
  const start = args.after ? Number(Buffer.from(args.after, 'base64').toString().split(':')[1]) + 1 : 0;
  if (!Number.isSafeInteger(start) || start < 0) throw Error('Invalid cursor');
  const count = Math.max(0, Math.min(100, args.first ?? 30)), nodes = items.slice(start, start + count);
  const cursor = i => Buffer.from(`cursor:${i}`).toString('base64');
  return { nodes, edges: nodes.map((node, i) => ({ node, cursor: cursor(start + i) })), totalCount: items.length,
    pageInfo: { hasNextPage: start + nodes.length < items.length, hasPreviousPage: start > 0, startCursor: nodes.length ? cursor(start) : null, endCursor: nodes.length ? cursor(start + nodes.length - 1) : null } };
}
export function createGraphQL(f) {
  const issue = x => x && ({ __typename: 'Issue', id: x.node_id, databaseId: x.id, number: x.number, title: x.title, body: x.body, state: x.state.toUpperCase() });
  const comment = x => ({ __typename: 'IssueComment', id: x.node_id, databaseId: x.id, body: x.body });
  const pull = x => x && ({ __typename: 'PullRequest', id: x.node_id, databaseId: x.id, number: x.number, title: x.title, body: x.body,
    headRefName: x.head.ref, baseRefName: x.base.ref, headRefOid: f.tip(x.repo, x.head.ref), baseRefOid: f.tip(x.repo, x.base.ref),
    mergeable: f.mergeFiles(x).conflicts.length ? 'CONFLICTING' : 'MERGEABLE', state: x.merged ? 'MERGED' : x.state.toUpperCase(), merged: x.merged,
    files: args => connection(f.files(x).map(e => ({ ...e, changeType: e.status.toUpperCase() })), args) });
  const repo = r => r && ({ __typename: 'Repository', id: r.node_id, databaseId: r.id, name: r.name, nameWithOwner: `${f.owner}/${r.name}`,
    owner: { login: f.owner || 'owner' }, defaultBranchRef: f.tip(r) ? { name: r.default_branch, target: { oid: f.tip(r) } } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true, isPrivate: r.private, description: r.description,
    issue: ({ number }) => issue(r.issues.get(number)), pullRequest: ({ number }) => pull(r.pulls.get(number)),
    issues: args => { let xs = [...r.issues.values()]; if (args.states?.length) xs = xs.filter(x => args.states.includes(x.state.toUpperCase())); xs.sort((a, b) => args.orderBy?.direction === 'DESC' ? b.number - a.number : a.number - b.number); return connection(xs.map(issue), args); },
    pullRequests: args => connection([...r.pulls.values()].filter(x => !args.states?.length || args.states.includes(x.merged ? 'MERGED' : x.state.toUpperCase())).map(pull), args) });
  const rawNode = (id, type) => { const n = f.nodes.get(id); if (!n || (type && n.type !== type)) throw Error('Unknown node'); return n.obj; };
  const root = {
    viewer: () => ({ login: f.owner || 'owner' }),
    repository: ({ owner, name }) => { if (!f.repos.has(name) || !f.claim(owner)) return null; return repo(f.repos.get(name)); },
    node: ({ id }) => { const n = f.nodes.get(id); if (!n) return null; return ({ Repository: repo, Issue: issue, PullRequest: pull, IssueComment: comment })[n.type]?.(n.obj) || null; },
    createIssue: ({ input: i }) => ({ issue: issue(f.createIssue(rawNode(i.repositoryId, 'Repository'), i)), clientMutationId: i.clientMutationId }),
    closeIssue: ({ input: i }) => { const x = rawNode(i.issueId, 'Issue'); x.state = 'closed'; return { issue: issue(x), clientMutationId: i.clientMutationId }; },
    reopenIssue: ({ input: i }) => { const x = rawNode(i.issueId, 'Issue'); x.state = 'open'; return { issue: issue(x), clientMutationId: i.clientMutationId }; },
    createPullRequest: ({ input: i }) => ({ pullRequest: pull(f.createPull(rawNode(i.repositoryId, 'Repository'), { ...i, head: i.headRefName, base: i.baseRefName })), clientMutationId: i.clientMutationId }),
    mergePullRequest: ({ input: i }) => { const x = rawNode(i.pullRequestId, 'PullRequest'); f.merge(x, { commit_title: i.commitHeadline }); return { pullRequest: pull(x), clientMutationId: i.clientMutationId }; },
    addComment: ({ input: i }) => { const x = rawNode(i.subjectId); if (!x.comments) throw Error('Node cannot have comments'); return { commentEdge: { node: comment(f.comment(x, i)) }, clientMutationId: i.clientMutationId }; },
  };
  const execute = b => typeof b?.query !== 'string' ? { errors: [{ message: 'query must be a string' }] } : graphql({ schema, source: b.query, variableValues: b.variables, operationName: b.operationName, rootValue: root });
  return async body => { if (!Array.isArray(body)) return execute(body); const results = []; for (const b of body) results.push(await execute(b)); return results; };
}
