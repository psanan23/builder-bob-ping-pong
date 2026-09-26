import assert from 'node:assert/strict';
import test from 'node:test';

import { AlignmentBot } from './bot.mjs';
import { MemoryStore } from './store.mjs';

const CHAT = 42;
const CLOCK = '2026-09-26T06:00:00.000Z';

function fakeTelegram(files = {}) {
  return {
    sent: [],
    answered: [],
    async send(chatId, message, buttons) {
      this.sent.push({ chatId, message, buttons });
    },
    async answerCallback(id) {
      this.answered.push(id);
    },
    async getFile(fileId) {
      if (!(fileId in files)) throw new Error('Telegram file is unavailable');
      return Buffer.from(files[fileId]);
    },
  };
}

function fakeAI({ questions = [], readable = true } = {}) {
  return {
    calls: { inspect: [], ask: [], answers: [], recap: [], discussion: [] },
    async inspectFile(file) {
      this.calls.inspect.push(file);
      return readable
        ? { readable: true, facts: ['The balcony is sheltered.'], summary: 'Sheltered balcony' }
        : { readable: false, reason: 'The image is too blurred to read' };
    },
    async askQuestions(context) {
      this.calls.ask.push(structuredClone(context));
      return questions;
    },
    async parseAnswers(context, reply) {
      this.calls.answers.push({ context: structuredClone(context), reply });
      const answers = [...reply.matchAll(/(?:^|\n)(\d+)\.\s*([^\n]+)/g)]
        .map((match) => ({ index: Number(match[1]), answer: match[2] }));
      return { answers, followup: 'Please include a question number.' };
    },
    async makeRecap(context) {
      this.calls.recap.push(structuredClone(context));
      const correction = context.corrections.length > 0;
      return {
        doneMeans: 'A comfortable balcony reading corner is ready to use.',
        builderHelp: 'I can organize the later action plan and compare options.',
        bonNeeds: 'You choose the layout because it is your space; allow about 30 minutes.',
        firstTwoWeeks: correction
          ? 'Week 1: check what you own. Week 2: set up the corner with existing items.'
          : 'Week 1: measure the space. Week 2: shop for a chair and set it up.',
        assumptionsDependencies: 'Assumes the balcony is safe; check building rules before setup.',
      };
    },
    async handleDiscussion(context, reply) {
      this.calls.discussion.push({ context: structuredClone(context), reply });
      if (reply.includes('?')) return { kind: 'question', reply: 'The plan assumes the balcony can hold a chair.' };
      return {
        kind: 'correction',
        patch: { firstTwoWeeks: 'Use the existing chair.' },
        changedNote: 'The plan now reuses what you own.',
      };
    },
  };
}

function harness(options = {}) {
  const store = options.store ?? new MemoryStore();
  const telegram = options.telegram ?? fakeTelegram(options.files);
  const ai = options.ai ?? fakeAI(options);
  const bot = new AlignmentBot({ store, telegram, ai, clock: () => CLOCK });
  let nextUpdateId = 1;
  return {
    store, telegram, ai, bot,
    async message(text, extra = {}) {
      await bot.handleUpdate({ update_id: nextUpdateId++, message: { chat: { id: CHAT }, text, ...extra } });
    },
    async callback(data) {
      await bot.handleUpdate({
        update_id: nextUpdateId++,
        callback_query: { id: `callback-${nextUpdateId}`, data, message: { chat: { id: CHAT } } },
      });
    },
    async state() {
      return (await store.load(CHAT)).state;
    },
    last() {
      return telegram.sent.at(-1);
    },
  };
}

const questions = [
  { question: 'What should be ready?', why: 'This sets the finish line.' },
  { question: 'Can you reuse a chair?', why: 'This decides whether shopping is needed.' },
];

test('inspects supplied files before one question batch, retains partial answers, and saves the exact revised recap', async () => {
  const h = harness({ questions, files: { notes: 'The balcony is sheltered.' } });
  await h.message('/start');
  await h.message('Make a balcony reading corner\nUse our existing space.');
  await h.message('', { document: { file_id: 'notes', file_name: 'balcony-notes.txt', file_size: 26 } });
  const projectId = (await h.state()).id;

  await h.callback(`files_ready:${projectId}`);
  assert.equal(h.ai.calls.inspect.length, 1);
  assert.equal(h.ai.calls.ask.length, 1);
  assert.equal(h.ai.calls.ask[0].sources[0].facts[0], 'The balcony is sheltered.');
  assert.equal((await h.state()).sources[0].status, 'read');
  assert.match(h.telegram.sent.at(-2).message, /Read: balcony-notes\.txt/);
  assert.match(h.last().message, /1\. What should be ready\?/);
  assert.match(h.last().message, /2\. Can you reuse a chair\?/);

  await h.message('1. A comfortable place to read.');
  assert.equal((await h.state()).questions[0].answer, 'A comfortable place to read.');
  assert.equal((await h.state()).questions[1].answer, '');
  assert.doesNotMatch(h.last().message, /1\. What should be ready\?/);
  assert.match(h.last().message, /2\. Can you reuse a chair\?/);
  assert.equal(h.ai.calls.recap.length, 0);

  await h.message('2. Yes, use our existing chair.');
  const first = (await h.state()).recap;
  assert.equal(first.version, 1);
  assert.match(h.last().message, /direction only/);
  assert.match(h.telegram.sent.at(-2).message, /Recap — version 1/);
  assert.match(h.telegram.sent.at(-2).message, /Done means/);
  assert.match(h.telegram.sent.at(-2).message, /First two weeks/);

  await h.message('Why does the plan include shopping?');
  assert.equal((await h.state()).recap.version, 1);
  assert.match(h.telegram.sent.at(-2).message, /assumes the balcony/);

  await h.message('Please use the chair we own; remove shopping.');
  const second = (await h.state()).recap;
  assert.equal(second.version, 2);
  assert.equal((await h.state()).recapHistory.length, 2);
  assert.match((await h.state()).recapHistory[0].firstTwoWeeks, /shop for a chair/);
  assert.equal((await h.state()).corrections.length, 1);
  assert.match(h.last().message, /Recap — version 2/);
  assert.match(h.last().message, /Use the existing chair/);

  await h.callback(`approve:${projectId}:${first.version}:${first.hash}`);
  assert.equal((await h.state()).approved, null);
  assert.match(h.telegram.sent.at(-2).message, /older recap/);
  assert.match(h.last().message, /Recap — version 2/);

  const approvedMessage = h.last().message;
  await h.callback(`approve:${projectId}:${second.version}:${second.hash}`);
  const saved = await h.state();
  assert.equal(saved.stage, 'approved');
  assert.deepEqual(saved.approved.recap, second);
  assert.equal(saved.approved.message, approvedMessage);
  assert.match(h.last().message, /Direction saved — version 2/);

  const returningTelegram = fakeTelegram();
  const returningAI = fakeAI({ questions });
  const returningBot = new AlignmentBot({ store: h.store, telegram: returningTelegram, ai: returningAI, clock: () => CLOCK });
  await returningBot.handleUpdate({ update_id: 1000, message: { chat: { id: CHAT }, text: '/saved' } });
  assert.equal(returningTelegram.sent[0].message, approvedMessage);
  assert.equal(returningAI.calls.recap.length, 0);
});

test('an explicit No files choice reports empty coverage before asking questions', async () => {
  const h = harness({ questions: [questions[0]] });
  await h.message('Make a balcony reading corner');
  const id = (await h.state()).id;
  await h.callback(`no_files:${id}`);
  assert.deepEqual((await h.state()).sources, []);
  assert.match(h.telegram.sent.at(-2).message, /No files supplied/);
  assert.match(h.last().message, /A few questions/);
  assert.equal(h.ai.calls.ask[0].sources.length, 0);
});

test('a blocked file pauses questions until the user explicitly removes it', async () => {
  const h = harness({ questions: [questions[0]] });
  await h.message('Make a balcony reading corner');
  await h.message('', { document: { file_id: 'bad', file_name: 'scan.docx', file_size: 4 } });
  const id = (await h.state()).id;
  assert.match(h.last().message, /Unsupported format \.docx/);
  await h.callback(`files_ready:${id}`);
  assert.equal((await h.state()).stage, 'blocked');
  assert.equal(h.ai.calls.ask.length, 0);
  assert.match(h.last().message, /Please replace or remove scan\.docx/);
  await h.callback(`remove_file:${id}:0`);
  assert.equal((await h.state()).sources[0].status, 'removed');
  assert.match(h.last().message, /Removed: scan\.docx/);
  await h.callback(`files_ready:${id}`);
  assert.equal(h.ai.calls.ask.length, 1);
  assert.match(h.telegram.sent.at(-2).message, /No files supplied/);
});

test('rejects a proposed interview longer than five questions', async () => {
  const tooMany = Array.from({ length: 6 }, (_, index) => ({
    question: `Question ${index + 1}?`, why: `Decision ${index + 1}.`,
  }));
  const h = harness({ questions: tooMany });
  await h.message('Make a balcony reading corner');
  await h.callback(`no_files:${(await h.state()).id}`);
  assert.equal((await h.state()).stage, 'inspection_done');
  assert.deepEqual((await h.state()).questions, []);
  assert.match(h.last().message, /short enough question list/);
});

test('a save failure cannot produce a false Direction saved confirmation', async () => {
  class FailingApprovalStore extends MemoryStore {
    async save(chatId, state, expectedRevision) {
      if (state.stage === 'approved') throw new Error('Database unavailable');
      return super.save(chatId, state, expectedRevision);
    }
  }
  const h = harness({ store: new FailingApprovalStore(), questions: [] });
  await h.message('Make a balcony reading corner');
  await h.callback(`no_files:${(await h.state()).id}`);
  const recap = (await h.state()).recap;
  await h.callback(`approve:${(await h.state()).id}:${recap.version}:${recap.hash}`);
  assert.equal((await h.state()).approved, null);
  assert.equal((await h.state()).stage, 'recap');
  assert.match(h.last().message, /couldn’t save/);
  assert.ok(h.telegram.sent.every(({ message }) => !message.includes('Direction saved')));
});

test('new evidence invalidates approval until it is read and a new recap is shown', async () => {
  const h = harness({ questions: [], files: { added: 'The corner also has two storage boxes.' } });
  await h.message('Make a balcony reading corner');
  const id = (await h.state()).id;
  await h.callback(`no_files:${id}`);
  const first = (await h.state()).recap;

  await h.message('', { document: { file_id: 'added', file_name: 'added.txt', file_size: 39 } });
  assert.equal((await h.state()).stage, 'collecting_new_file');
  await h.callback(`approve:${id}:${first.version}:${first.hash}`);
  assert.equal((await h.state()).approved, null);

  await h.callback(`files_ready:${id}`);
  assert.equal((await h.state()).sources[0].status, 'read');
  assert.equal((await h.state()).recap.version, 2);
  assert.equal((await h.state()).stage, 'recap');
});

test('a file beyond the upload limit is visibly recorded as blocked', async () => {
  const h = harness();
  await h.message('Make a balcony reading corner');
  for (let index = 0; index < 7; index++) {
    await h.message('', { document: { file_id: `file-${index}`, file_name: `note-${index}.txt`, file_size: 12 } });
  }
  const state = await h.state();
  assert.equal(state.sources.length, 7);
  assert.equal(state.sources[6].status, 'blocked');
  assert.match(state.sources[6].reason, /up to 6 files/);
  assert.match(h.last().message, /Couldn’t read: note-6\.txt/);
});

test('a clear correction survives even if recap generation repeats the old wording', async () => {
  const ai = fakeAI({ questions: [] });
  ai.makeRecap = async () => ({
    doneMeans: 'The reading corner is ready.',
    builderHelp: 'I can prepare a plan later.',
    bonNeeds: 'You choose the layout because it is your space; allow 30 minutes.',
    firstTwoWeeks: 'Shop for a chair.',
    assumptionsDependencies: 'Check the doorway width.',
  });
  const h = harness({ ai });
  await h.message('Make a balcony reading corner');
  await h.callback(`no_files:${(await h.state()).id}`);
  await h.message('Please use the chair we own; remove shopping.');
  assert.equal((await h.state()).recap.version, 2);
  assert.equal((await h.state()).recap.firstTwoWeeks, 'Use the existing chair.');
  assert.equal((await h.state()).recapHistory[0].firstTwoWeeks, 'Shop for a chair.');
});

test('a requested shift of Embassy research and drafting to Builder Bob revises the recap even when AI calls it a question', async () => {
  const ai = fakeAI({ questions: [] });
  ai.makeRecap = async (context) => {
    const corrections = context.corrections.map(({ text }) => text).join(' ');
    return {
      doneMeans: 'Both Thai passport applications are submitted.',
      builderHelp: /draft an email/i.test(corrections)
        ? 'I can check public requirements and draft an Embassy email in the later action plan.'
        : /provide or verify/i.test(corrections)
          ? 'I can check public Embassy requirements in the later action plan.'
          : 'I can organize the later action plan.',
      bonNeeds: corrections
        ? 'You approve any message before it is sent and attend in person if required, because those steps need your authorization or presence.'
        : 'You verify current Embassy requirements and appointment rules.',
      firstTwoWeeks: 'First check the route, then prepare for the application.',
      assumptionsDependencies: 'Current Embassy rules need checking; no message has been sent.',
    };
  };
  ai.handleDiscussion = async () => ({ kind: 'question', reply: 'I can research later.' });
  const h = harness({ ai });
  await h.message('Thai passports for my daughters');
  const id = (await h.state()).id;
  await h.callback(`no_files:${id}`);
  const first = (await h.state()).recap;

  await h.message('Why cant you do this for me? You need to provide or verify current Embassy requirements and appointment rules.');
  const second = (await h.state()).recap;
  assert.equal(second.version, 2);
  assert.match(second.builderHelp, /check public Embassy requirements/);
  assert.doesNotMatch(second.bonNeeds, /You verify/);
  assert.match(h.last().message, /Recap — version 2/);
  await h.callback(`approve:${id}:${first.version}:${first.hash}`);
  assert.equal((await h.state()).approved, null);

  await h.message('You can help me draft an email to the Embassy so I do not waste time going in person just to ask.');
  const third = (await h.state()).recap;
  assert.equal(third.version, 3);
  assert.match(third.builderHelp, /draft an Embassy email/);
  assert.match(third.bonNeeds, /approve any message/);
  assert.equal((await h.state()).corrections.length, 2);
});

test('a challenge to Bon doing the work pauses old approval until the role is clarified', async () => {
  const ai = fakeAI({ questions: [] });
  ai.handleDiscussion = async () => ({ kind: 'question', reply: 'The recap says you would check the rules.' });
  ai.makeRecap = async (context) => ({
    doneMeans: 'Both applications are submitted.',
    builderHelp: context.corrections.length ? 'I can draft the Embassy inquiry later.' : 'I can organize the later plan.',
    bonNeeds: context.corrections.length ? 'You approve sending because it needs your authorization.' : 'You check the Embassy rules.',
    firstTwoWeeks: 'Check the route first.',
    assumptionsDependencies: 'Embassy response is unresolved.',
  });
  const h = harness({ ai });
  await h.message('Thai passports');
  const id = (await h.state()).id;
  await h.callback(`no_files:${id}`);
  const first = (await h.state()).recap;
  await h.message('Why cant you do this for me?');
  assert.equal((await h.state()).stage, 'correction_pending');
  assert.match(h.last().message, /What should I take over or prepare/);
  await h.callback(`approve:${id}:${first.version}:${first.hash}`);
  assert.equal((await h.state()).approved, null);
  assert.match(h.last().message, /approval is paused/);
  await h.message('I approve this recap');
  assert.equal((await h.state()).approved, null);
  await h.message('Draft the Embassy inquiry for my approval.');
  assert.equal((await h.state()).recap.version, 2);
  assert.equal((await h.state()).stage, 'recap');
});

test('a failed response to a role challenge keeps approval paused', async () => {
  const ai = fakeAI({ questions: [] });
  ai.handleDiscussion = async () => { throw new Error('AI unavailable'); };
  const h = harness({ ai });
  await h.message('Thai passports');
  const id = (await h.state()).id;
  await h.callback(`no_files:${id}`);
  const first = (await h.state()).recap;

  await h.message('Why cant you do this for me?');
  assert.equal((await h.state()).stage, 'correction_pending');
  await h.callback(`approve:${id}:${first.version}:${first.hash}`);
  assert.equal((await h.state()).approved, null);
});

test('an unchanged AI recap cannot make a requested role change approvable', async () => {
  const ai = fakeAI({ questions: [] });
  ai.handleDiscussion = async () => ({ kind: 'question', reply: 'I can do that later.' });
  ai.makeRecap = async () => ({
    doneMeans: 'Both applications are submitted.',
    builderHelp: 'I can organize the later plan.',
    bonNeeds: 'You verify current Embassy requirements.',
    firstTwoWeeks: 'Check the route first.',
    assumptionsDependencies: 'Embassy response is unresolved.',
  });
  const h = harness({ ai });
  await h.message('Thai passports');
  const id = (await h.state()).id;
  await h.callback(`no_files:${id}`);
  const first = (await h.state()).recap;
  await h.message('You need to verify the Embassy requirements for me.');
  assert.equal((await h.state()).stage, 'ready_for_recap');
  assert.equal((await h.state()).recap.version, 1);
  assert.match(h.last().message, /earlier recap cannot be approved/);
  await h.callback(`approve:${id}:${first.version}:${first.hash}`);
  assert.equal((await h.state()).approved, null);
});

test('an ordinary factual question keeps the current recap approvable', async () => {
  const h = harness({ questions: [] });
  await h.message('Make a balcony reading corner');
  const id = (await h.state()).id;
  await h.callback(`no_files:${id}`);
  const current = (await h.state()).recap;
  await h.message('Why does the plan include shopping?');
  assert.equal((await h.state()).stage, 'recap');
  assert.equal((await h.state()).recap.version, current.version);
  assert.match(h.telegram.sent.at(-2).message, /assumes the balcony/);
  await h.callback(`approve:${id}:${current.version}:${current.hash}`);
  assert.equal((await h.state()).stage, 'approved');
});

test('an ambiguous reply cannot approve; an explicit current-recap statement can', async () => {
  const ai = fakeAI({ questions: [] });
  ai.handleDiscussion = async () => ({ kind: 'clarification', reply: 'Do you want to change anything?' });
  const h = harness({ ai });
  await h.message('Make a balcony reading corner');
  await h.callback(`no_files:${(await h.state()).id}`);
  await h.message('okay');
  assert.equal((await h.state()).approved, null);
  await h.message('I approve this recap');
  assert.equal((await h.state()).stage, 'approved');
});

test('a confirmed new project replaces only unapproved working state and makes old approvals stale', async () => {
  const h = harness({ questions: [], files: { notes: 'The balcony is sheltered.' } });
  await h.message('Make a balcony reading corner');
  await h.message('', { document: { file_id: 'notes', file_name: 'balcony-notes.txt', file_size: 26 } });
  const oldId = (await h.state()).id;
  await h.callback(`files_ready:${oldId}`);
  const oldRecap = (await h.state()).recap;

  await h.message('/new');
  assert.equal((await h.state()).pendingNew, true);
  assert.equal((await h.state()).recap.version, oldRecap.version);
  assert.match(h.last().message, /replace the current working details/);
  assert.match(h.last().message, /Earlier Telegram messages will remain/);
  assert.equal(h.last().buttons[0][0].callback_data, `new_confirm:${oldId}`);

  await h.callback(`approve:${oldId}:${oldRecap.version}:${oldRecap.hash}`);
  assert.equal((await h.state()).approved, null);
  assert.equal((await h.state()).pendingNew, true);
  await h.message('I approve this recap');
  assert.equal((await h.state()).approved, null);

  await h.callback(`new_confirm:${oldId}`);
  const fresh = await h.state();
  assert.notEqual(fresh.id, oldId);
  assert.equal(fresh.stage, 'awaiting_project');
  assert.equal(fresh.project.name, '');
  assert.deepEqual(fresh.sources, []);
  assert.deepEqual(fresh.questions, []);
  assert.deepEqual(fresh.recapHistory, []);
  assert.equal(fresh.recap, null);
  assert.equal(fresh.approved, null);

  await h.callback(`approve:${oldId}:${oldRecap.version}:${oldRecap.hash}`);
  assert.match(h.last().message, /older project view/);
  await h.message('Plan my real project');
  await h.callback(`no_files:${fresh.id}`);
  assert.equal(h.ai.calls.ask.at(-1).project.name, 'Plan my real project');
  assert.deepEqual(h.ai.calls.ask.at(-1).sources, []);
});

test('new-project confirmation survives a restart; keeping the current project preserves its recap', async () => {
  const h = harness({ questions: [] });
  await h.message('Make a balcony reading corner');
  const id = (await h.state()).id;
  await h.callback(`no_files:${id}`);
  const recap = (await h.state()).recap;
  await h.message('/new');

  const returningTelegram = fakeTelegram();
  const returningBot = new AlignmentBot({ store: h.store, telegram: returningTelegram, ai: fakeAI(), clock: () => CLOCK });
  await returningBot.handleUpdate({ update_id: 1001, message: { chat: { id: CHAT }, text: '/start' } });
  assert.match(returningTelegram.sent.at(-1).message, /Start a new project\?/);
  await returningBot.handleUpdate({
    update_id: 1002,
    callback_query: { id: 'keep', data: `new_cancel:${id}`, message: { chat: { id: CHAT } } },
  });
  const kept = await h.state();
  assert.equal(kept.pendingNew, false);
  assert.equal(kept.id, id);
  assert.deepEqual(kept.recap, recap);
  assert.match(returningTelegram.sent.at(-1).message, /Recap — version 1/);
  await h.callback(`approve:${id}:${recap.version}:${recap.hash}`);
  assert.equal((await h.state()).stage, 'approved');
});

test('exact text choices can keep or replace an unapproved project without accepting stale approval', async () => {
  const h = harness({ questions: [] });
  await h.message('Make a balcony reading corner');
  const oldId = (await h.state()).id;
  await h.callback(`no_files:${oldId}`);
  const oldRecap = (await h.state()).recap;

  await h.message('/new');
  assert.match(h.last().message, /reply exactly Start new project or Keep current project/);
  await h.message('Start new project please');
  assert.equal((await h.state()).id, oldId);
  assert.equal((await h.state()).pendingNew, true);
  await h.message('I approve this recap');
  assert.equal((await h.state()).approved, null);

  await h.message('Keep current project');
  const kept = await h.state();
  assert.equal(kept.pendingNew, false);
  assert.equal(kept.id, oldId);
  assert.deepEqual(kept.recap, oldRecap);
  assert.match(h.last().message, /Recap — version 1/);

  await h.message('/new');
  await h.message('Start new project');
  const fresh = await h.state();
  assert.notEqual(fresh.id, oldId);
  assert.equal(fresh.stage, 'awaiting_project');
  assert.equal(fresh.recap, null);
  assert.equal(fresh.approved, null);
  await h.callback(`approve:${oldId}:${oldRecap.version}:${oldRecap.hash}`);
  assert.match(h.last().message, /older project view/);
});

test('an approved direction cannot be replaced through the new-project command', async () => {
  const h = harness({ questions: [] });
  await h.message('Make a balcony reading corner');
  const id = (await h.state()).id;
  await h.callback(`no_files:${id}`);
  const recap = (await h.state()).recap;
  await h.callback(`approve:${id}:${recap.version}:${recap.hash}`);
  const approved = (await h.state()).approved;

  await h.message('/new');
  assert.match(h.last().message, /keep that saved recap intact/);
  assert.equal((await h.state()).pendingNew, false);
  assert.deepEqual((await h.state()).approved, approved);
  await h.message('/saved');
  assert.equal(h.last().message, approved.message);
});
