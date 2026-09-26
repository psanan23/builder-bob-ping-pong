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
