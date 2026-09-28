import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyDirection, askQuestions, publicUrl, makeRecap, validateRecap } from './ai.mjs';

const url = 'https://authority.example.gov/requirements';
function direction(overrides = {}) {
  return { outcome: 'Application submitted.', sequence: ['Obtain prerequisite.', 'Submit application.'],
    prerequisites: [{ fact: 'Prerequisite required.', status: 'confirmed', sourceUrls: [url] }],
    applicationAppointment: { exists: 'yes', detail: 'Apply after prerequisite.', sourceUrls: [url] },
    ownership: [{ work: 'Verify and prepare.', owner: 'Builder Bob', reason: 'Available work.' }],
    uncertainties: [], sources: [{ title: 'Official requirements', url, supports: 'Prerequisite comes first.' }], ...overrides };
}
function structured(value) { return { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }; }
async function withResponses(responses, run) {
  const oldFetch = globalThis.fetch; const oldKey = process.env.OPENAI_API_KEY; const requests = [];
  process.env.OPENAI_API_KEY = 'test-placeholder';
  globalThis.fetch = async (_, options) => {
    requests.push(JSON.parse(options.body));
    assert.ok(responses.length, 'Unexpected API request');
    const next = responses.shift();
    return { ok: !next._httpStatus, status: next._httpStatus || 200, json: async () => next };
  };
  try { await run(requests); assert.equal(responses.length, 0); }
  finally { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey; }
}
const lookupPlan = { needsLookup: true, reason: 'A public prerequisite changes the route.', publicQuestions: ['Official application prerequisites in Singapore for children'], officialDomains: ['authority.example.gov'] };
const research = { status: 'completed', output: [
  { type: 'web_search_call', action: { sources: [{ url, title: 'Official requirements' }] } },
  { type: 'message', content: [{ type: 'output_text', text: 'The official authority requires the prerequisite before applying.', annotations: [{ type: 'url_citation', url, title: 'Official requirements' }] }] },
] };

test('material lookup is bounded and receives only generalized questions, never raw files', async () => {
  await withResponses([structured(lookupPlan), research, structured(direction())], async (requests) => {
    const result = await verifyDirection({ project: { name: 'Private project' }, sources: [{ name: 'private-file.txt', facts: ['Private Person, account 123456789'] }] });
    const web = requests[1];
    assert.equal(web.max_tool_calls, 4); assert.equal(web.tool_choice, 'required');
    assert.deepEqual(web.tools[0].filters.allowed_domains, ['authority.example.gov']);
    assert.deepEqual(web.include, ['web_search_call.action.sources']);
    assert.doesNotMatch(JSON.stringify(web), /Private Person|123456789|private-file/);
    assert.equal(result.lookup.performed, true); assert.equal(result.sources[0].url, url);
    assert.equal(result.prerequisites[0].status, 'confirmed');
  });
});

test('judgement or physical observations use supplied evidence without web lookup', async () => {
  await withResponses([structured({ needsLookup: false, reason: 'Only layout judgement and a physical measurement remain.', publicQuestions: [], officialDomains: [] }),
    structured(direction({ prerequisites: [], sources: [], applicationAppointment: { exists: 'not_applicable', detail: 'No application step.', sourceUrls: [] }, uncertainties: [{ fact: 'Chair fit', impact: 'Changes layout', method: 'Bon measures because physical access is needed.', owner: 'Bon' }] }))], async (requests) => {
    const result = await verifyDirection({ project: { name: 'Reading corner' } });
    assert.equal(requests.length, 2); assert.ok(requests.every((r) => !r.tools));
    assert.equal(result.lookup.performed, false); assert.equal(result.uncertainties[0].owner, 'Bon');
  });
});

test('fabricated source links cannot turn a prerequisite into a checked fact', async () => {
  const falseUrl = 'https://authority.example.gov/invented';
  await withResponses([structured(lookupPlan), research, structured(direction({ prerequisites: [{ fact: 'Invented prerequisite', status: 'confirmed', sourceUrls: [falseUrl] }], sources: [{ title: 'Invented', url: falseUrl, supports: 'Invented rule' }] }))], async () => {
    const result = await verifyDirection({});
    assert.deepEqual(result.sources, []); assert.equal(result.prerequisites[0].status, 'unresolved');
    assert.equal(result.uncertainties.at(-1).owner, 'Builder Bob');
  });
});

test('lookup refuses identifying queries and unsafe authority domains before searching', async () => {
  for (const patch of [{ publicQuestions: ['Check account 123456789'] }, { officialDomains: ['127.0.0.1'] }]) {
    await withResponses([structured({ ...lookupPlan, ...patch })], async (requests) => {
      await assert.rejects(verifyDirection({}), /safer|validated/);
      assert.equal(requests.length, 1);
    });
  }
});

test('a required public lookup that does not call the tool fails visibly', async () => {
  await withResponses([structured(lookupPlan), structured({ message: 'Assumed answer' })], async () => {
    await assert.rejects(verifyDirection({}), /did not run/);
  });
});

test('no material gaps yields zero questions and generic rules do not embed the passport case', async () => {
  await withResponses([structured({ questions: [] })], async (requests) => {
    assert.deepEqual(await askQuestions({}), []);
    assert.match(requests[0].instructions, /Discover and verify prerequisites/);
    assert.doesNotMatch(requests[0].instructions, /Thai|passport|birth registration|Embassy/);
  });
});

test('recap generation and semantic review use direction and current corrections', async () => {
  const recap = { doneMeans: 'Done', builderHelp: 'Help', bonNeeds: 'Decision', firstTwoWeeks: 'Milestone', assumptionsDependencies: 'Unknown', changedNote: '' };
  await withResponses([structured(recap), structured({ valid: false, issues: ['Wrong sequence'] })], async (requests) => {
    const context = { direction: direction(), corrections: [{ text: 'Complete prerequisite first.' }], validationIssues: ['Wrong sequence'] };
    const draft = await makeRecap(context); const review = await validateRecap(context, draft);
    assert.equal(review.valid, false);
    assert.match(JSON.stringify(requests[1].input), /Complete prerequisite first/);
    assert.match(requests[0].instructions, /context.direction/);
    assert.ok(requests.every((r) => !r.tools));
  });
});

test('public source URLs exclude credentials, local endpoints and active schemes', () => {
  for (const input of ['http://example.com', 'https://user:pass@example.com', 'https://localhost', 'https://172.16.1.2/a', 'https://[::1]/', 'javascript:alert(1)', 'https://example.com:8000']) assert.equal(publicUrl(input), null);
  assert.equal(publicUrl('https://example.gov/a#part'), 'https://example.gov/a');
});

test('a preference correction retains prior checked sources and their original checked date', async () => {
  const previous = { ...direction(), checkedAt: '2026-09-26T00:00:00Z' };
  await withResponses([structured({ needsLookup: false, reason: 'Current official evidence still settles the route.', publicQuestions: [], officialDomains: [] }), structured(direction())], async (requests) => {
    const result = await verifyDirection({ direction: previous, corrections: [{ text: 'Use a shorter summary.' }] });
    assert.equal(result.prerequisites[0].status, 'confirmed');
    assert.equal(result.sources[0].checkedAt, previous.checkedAt);
    assert.ok(requests.every((r) => !r.tools));
  });
});


test('API failures expose only safe stage/status/code/parameter diagnostics', async () => {
  await withResponses([structured(lookupPlan), { _httpStatus: 400, error: { code: 'unsupported_parameter', param: 'max_tool_calls', message: 'Secret private content must not appear' } }], async () => {
    await assert.rejects(verifyDirection({}), (error) => {
      assert.equal(error.operation, 'official_site_lookup');
      assert.equal(error.code, 'http_400:unsupported_parameter:max_tool_calls');
      assert.doesNotMatch(error.message, /Secret private/);
      return true;
    });
  });
});


test('tool rejection uses one compatible lookup and retains only known authority sources', async () => {
  const outside = 'https://unrelated.example.com/guide';
  const returned = structuredClone(research);
  returned.output[0].action.sources.push({ url: outside, title: 'Unrelated blog' });
  await withResponses([structured(lookupPlan), { _httpStatus: 400, error: { type: 'invalid_request_error', param: 'tools' } }, returned,
    structured(direction({ sources: [{ title: 'Official', url, supports: 'Required' }, { title: 'Blog', url: outside, supports: 'Unsupported' }] }))], async (requests) => {
    const result = await verifyDirection({});
    assert.equal(requests[1].tools[0].type, 'web_search');
    assert.deepEqual(requests[2].tools, [{ type: 'web_search_preview' }]);
    assert.equal(requests[2].max_tool_calls, 4);
    assert.equal(requests[2].tool_choice, 'required');
    assert.equal(result.lookup.tool, 'web_search_preview');
    assert.deepEqual(result.sources.map((s) => s.url), [url]);
  });
});

test('authentication failures do not trigger tool fallback', async () => {
  await withResponses([structured(lookupPlan), { _httpStatus: 401, error: { code: 'invalid_api_key', param: null } }], async (requests) => {
    await assert.rejects(verifyDirection({}), (e) => e.code.startsWith('http_401:invalid_api_key'));
    assert.equal(requests.length, 2);
  });
});


test('public authority URLs normalize to safe domain filters without weakening local/credential rejection', async () => {
  await withResponses([structured({ ...lookupPlan, officialDomains: ['https://www.AUTHORITY.example.gov/requirements'] }), research, structured(direction())], async (requests) => {
    const result = await verifyDirection({});
    assert.deepEqual(requests[1].tools[0].filters.allowed_domains, ['authority.example.gov']);
    assert.equal(result.prerequisites[0].status, 'confirmed');
  });
  await withResponses([structured({ ...lookupPlan, officialDomains: ['https://user:pass@authority.example.gov'] })], async () => {
    await assert.rejects(verifyDirection({}), (e) => e.code === 'invalid_authority_domain');
  });
});
