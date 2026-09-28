import { createHash, randomUUID } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { escapeHtml } from './telegram.mjs';
import { publicUrl } from './ai.mjs';

const MAX_FILES = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RECAP_FIELDS = ['doneMeans', 'builderHelp', 'bonNeeds', 'firstTwoWeeks', 'assumptionsDependencies'];
const LABELS = ['Done means', 'I can help by', 'You would need to', 'First two weeks', 'Assumptions and dependencies'];
const SUPPORTED = new Set(['.txt', '.md', '.pdf', '.jpg', '.jpeg', '.png']);

function extension(name) {
  return String(name).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
}

function mimeFor(name) {
  return ({ '.txt': 'text/plain', '.md': 'text/markdown', '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' })[extension(name)];
}

function newState(now) {
  return {
    id: randomUUID().replaceAll('-', '').slice(0, 10),
    stage: 'awaiting_project',
    project: { name: '', description: '' },
    sources: [],
    questions: [],
    recap: null,
    recapHistory: [],
    corrections: [],
    approved: null,
    approvalHistory: [],
    reviewingApproved: false,
    direction: null,
    directionInputHash: null,
    pendingNew: false,
    metrics: { selectedAt: null, firstResultAt: null, finalAnswerAt: null, recapAt: null, approvalAt: null },
    createdAt: now,
  };
}

function safeName(name) {
  return String(name || 'unnamed file').replace(/[\r\n<>]/g, ' ').slice(0, 120);
}

function short(text, limit = 500) {
  const value = String(text || '').trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function recapHash(recap) {
  const values = Object.fromEntries(RECAP_FIELDS.map((field) => [field, recap[field]]));
  values.sources = recap.sources || [];
  return createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 14);
}

function publicSources(direction) {
  return (direction?.sources || []).filter(({ url }) => publicUrl(url))
    .slice(0, 8).map(({ title, url, supports, checkedAt }) => ({ title: short(title || 'Primary source', 100), url: publicUrl(url), supports: short(supports, 250), checkedAt: checkedAt || direction.checkedAt }));
}

function approvedVersions(state) {
  const history = [...(state.approvalHistory || [])];
  if (state.approved && !history.some(({ recap }) => recap.version === state.approved.recap.version)) history.push(state.approved);
  return history.sort((a, b) => a.recap.version - b.recap.version);
}

function savedButtons(state) {
  const rows = [[{ text: 'Show saved recap', callback_data: `saved:${state.id}` },
    { text: 'Review saved direction', callback_data: `review:${state.id}` }]];
  if (approvedVersions(state).length > 1) rows.push([{ text: 'Earlier approvals', callback_data: `history:${state.id}` }]);
  return rows;
}

function directionInputHash(state) {
  return createHash('sha256').update(JSON.stringify({
    verificationPolicyVersion: 2,
    project: state.project,
    sources: state.sources.filter(({ status }) => status === 'read').map(({ name, facts, summary }) => ({ name, facts, summary })),
    questions: state.questions,
    corrections: state.corrections,
  })).digest('hex');
}

function recapText(state) {
  const recap = state.recap;
  const parts = [`<b>${escapeHtml(state.project.name)} · Recap — version ${recap.version}</b>`];
  RECAP_FIELDS.forEach((field, index) => parts.push(`<b>${LABELS[index]}</b>\n${escapeHtml(recap[field])}`));
  if (recap.sources?.length) {
    parts.push(`<b>Sources for this route</b>\n${recap.sources.slice(0, 3).map(({ title, url }) => `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`).join('\n')}`);
    if (recap.sources.length > 3) parts.push('Send /sources to see all supporting sources.');
  }
  parts.push('Does this match your goal and approach? Approve this recap, or tell me what to change.');
  return parts.join('\n\n');
}

function recapButtons(state) {
  const { version, hash } = state.recap;
  return [[
    { text: 'Approve this recap', callback_data: `approve:${state.id}:${version}:${hash}` },
    { text: 'Make a change', callback_data: `change:${state.id}:${version}` },
  ]];
}

function intakeButtons(state) {
  return [[
    { text: 'Files ready', callback_data: `files_ready:${state.id}` },
    { text: 'No files', callback_data: `no_files:${state.id}` },
  ]];
}

function blockedButtons(state, index) {
  return [[
    { text: 'Retry reading', callback_data: `retry_file:${state.id}:${index}` },
    { text: 'Remove this file', callback_data: `remove_file:${state.id}:${index}` },
  ]];
}

function newProjectButtons(state) {
  return [[
    { text: 'Start new project', callback_data: `new_confirm:${state.id}` },
    { text: 'Keep current project', callback_data: `new_cancel:${state.id}` },
  ]];
}

function approvalText(text) {
  return /^(?:i approve (?:this|the) recap|yes,? approve(?: this recap)?|(?:yes,? )?this (?:recap )?matches my (?:goal and )?approach)[.!]?$/i.test(text.trim());
}

// A request to move research or preparation from Bon to Builder Bob changes the
// division of work, even when it is phrased as a question. Keep this narrow so
// ordinary factual questions can still receive a simple answer.
function roleReviewSignal(text) {
  const work = '(?:research|verify|check|confirm|provide|draft|prepare|write|find|compare|organis[ez]e|handle|take care of|do)';
  const owner = '(?:you|builder bob|bob)';
  const request = [
    new RegExp(`\\b${owner}\\s+(?:need to|should|must|have to)\\s+(?:help\\s+me\\s+(?:to\\s+|with\\s+)?|)${work}\\b`, 'i'),
    new RegExp(`\\b${owner}\\s+can\\s+help\\s+me\\s+(?:to\\s+)?${work}\\b`, 'i'),
    new RegExp(`\\b(?:can|could|would)\\s+you\\s+(?:please\\s+)?${work}\\b`, 'i'),
    new RegExp(`\\b(?:i|we)\\s+(?:shouldn't|should not|don't|do not)\\s+have\\s+to\\s+${work}\\b`, 'i'),
  ];
  if (request.some((pattern) => pattern.test(text))) return 'correction';
  if (/\bwhy\s+(?:can(?:['’]?t|not)|cannot)\s+you\s+(?:do|handle|research|verify|check|draft|prepare)\b/i.test(text)) return 'clarification';
  return null;
}

function contextFor(state) {
  const referenceDate = state.metrics.selectedAt
    ? new Date(state.metrics.selectedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' })
    : null;
  return {
    project: state.project,
    referenceDate,
    timezone: 'Asia/Singapore',
    sources: state.sources.filter((source) => source.status === 'read').map(({ name, facts, summary }) => ({ name, facts, summary })),
    questions: state.questions,
    recap: (state.proposedRecap || state.recap) ? Object.fromEntries(RECAP_FIELDS.map((field) => [field, (state.proposedRecap || state.recap)[field]])) : null,
    corrections: state.corrections,
    direction: state.direction || null,
    validationIssues: state.recapValidationIssues || [],
  };
}

export class AlignmentBot {
  constructor({ store, telegram, ai, clock = () => new Date().toISOString() }) {
    this.store = store;
    this.telegram = telegram;
    this.ai = ai;
    this.clock = clock;
  }

  async handleUpdate(update) {
    if (!Number.isSafeInteger(update?.update_id)) return;
    if (!(await this.store.claimUpdate(update.update_id))) return;
    const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
    if (!chatId) {
      await this.store.completeUpdate(update.update_id);
      return;
    }
    const loaded = await this.store.load(chatId);
    const context = { chatId, state: loaded.state ?? newState(this.clock()), revision: loaded.revision };
    try {
      if (!loaded.state) await this.save(context);
      if (update.callback_query) await this.handleCallback(context, update.callback_query);
      else if (update.message) await this.handleMessage(context, update.message);
      await this.store.completeUpdate(update.update_id);
    } catch (error) {
      await this.store.releaseUpdate(update.update_id).catch(() => {});
      await this.telegram.send(chatId, 'I couldn’t finish that step. Your information is still here. Please send /retry.').catch(() => {});
      // Logs contain only the operation and error class, never project text, files, or secrets.
      console.error('Alignment update failed:', error?.name || 'Error');
    }
  }

  async save(context) {
    context.revision = await this.store.save(context.chatId, context.state, context.revision);
  }

  async handleMessage(context, message) {
    const text = String(message.text || message.caption || '').trim();
    if (text === '/new') return this.beginNew(context);
    if (context.state.pendingNew) {
      if (text === 'Start new project') return this.confirmNew(context);
      if (text === 'Keep current project') return this.cancelNew(context);
      return this.newProjectPrompt(context);
    }
    if (text === '/start') return this.start(context);
    if (text === '/retry') return this.retry(context);
    if (/^\/saved(?: \d+)?$/.test(text)) return this.showSaved(context, text.split(' ')[1]);
    if (text === '/review') return this.beginReview(context);
    if (text === '/history') return this.showHistory(context);
    if (text === '/sources') return this.showSources(context);
    if (message.document || message.photo?.length) return this.receiveFile(context, message);
    if (!text) return this.telegram.send(context.chatId, 'Send the project name or a file to continue.');

    const stage = context.state.stage;
    if (stage === 'approved') return this.discuss(context, text);
    if (stage === 'reviewing_saved') {
      if (approvalText(text)) return this.telegram.send(context.chatId,
        'Tell me what you want changed first. I’ll show a revised recap for you to approve.');
      return this.discuss(context, text);
    }
    if (!context.state.project.name) {
      const [name, ...description] = text.split('\n');
      context.state.project.name = short(name, 120);
      context.state.project.description = short(description.join('\n'), 1500);
      context.state.metrics.selectedAt = this.clock();
      context.state.stage = 'collecting';
      await this.save(context);
      return this.telegram.send(context.chatId,
        `<b>Files received</b>\nProject: ${escapeHtml(context.state.project.name)}\nSend any files now, or add a short description. When finished, tap Files ready. If there are no files, tap No files.\n\nI can read TXT, MD, PDF, JPG, and PNG: up to 6 files, 10 MB each, and 20 pages per PDF. Supplied material is processed by the bot’s AI provider.`,
        intakeButtons(context.state));
    }
    if (stage === 'collecting' || stage === 'awaiting_project' || stage === 'collecting_new_file') {
      if (/^files ready$/i.test(text)) return this.finishFiles(context, false);
      if (/^no files$/i.test(text)) return this.finishFiles(context, true);
      context.state.project.description = short([context.state.project.description, text].filter(Boolean).join('\n'), 2500);
      await this.save(context);
      return this.telegram.send(context.chatId, 'Added that to your project notes. Send files if useful, then tap Files ready.', intakeButtons(context.state));
    }
    if (stage === 'questions') return this.receiveAnswers(context, text);
    if (stage === 'recap') {
      if (approvalText(text)) return this.approve(context, context.state.recap.version, context.state.recap.hash);
      return this.discuss(context, text);
    }
    if (stage === 'correction_pending') {
      if (approvalText(text)) return this.telegram.send(context.chatId,
        'I’m holding approval until we resolve who does this work and I show you a revised recap.');
      return this.discuss(context, text);
    }
    if (stage === 'blocked') return this.telegram.send(context.chatId, 'Please replace or remove the file I couldn’t read. Then tap Files ready.');
    return this.telegram.send(context.chatId, 'I’m still working on that step. Send /retry if it seems stuck.');
  }

  async start(context) {
    const state = context.state;
    if (state.stage === 'approved' && !state.reviewingApproved) return this.showSaved(context);
    if (state.stage === 'reviewing_saved') return this.reviewPrompt(context);
    if (!state.project.name) return this.telegram.send(context.chatId,
      'I’m Builder Bob. Send the Notion page name and any files for the task. We’ll agree the goal and approach, then save that direction for a later action plan.\n\nI can read TXT, MD, PDF, JPG, and PNG: up to 6 files, 10 MB each, and 20 pages per PDF. Supplied material is processed by the bot’s AI provider.');
    if (state.stage === 'recap') return this.sendRecap(context, false);
    if (state.stage === 'correction_pending') return this.telegram.send(context.chatId,
      'I’m holding approval while we resolve your question about who does that work. Tell me what you want changed in the recap.');
    if (state.stage === 'questions') return this.sendQuestions(context, true);
    if (state.stage === 'blocked') return this.sendCoverage(context);
    if (['verifying_direction', 'generating_recap', 'ready_for_recap', 'processing_discussion'].includes(state.stage)) return this.telegram.send(context.chatId,
      'Your information is saved. Send /retry to continue checking the direction.');
    return this.telegram.send(context.chatId, `Project: ${escapeHtml(state.project.name)}\nYour information is saved. Send files or tap Files ready to continue.`, intakeButtons(state));
  }

  async beginNew(context) {
    const state = context.state;
    if (state.approved) return this.telegram.send(context.chatId,
      'This chat has an approved direction. I will keep that saved recap intact. Starting another project needs a separate archive flow. Send /saved to see the approved recap.');
    if (!state.project.name) return this.start(context);
    if (!state.pendingNew) {
      state.pendingNew = true;
      await this.save(context);
    }
    return this.newProjectPrompt(context);
  }

  async newProjectPrompt(context) {
    return this.telegram.send(context.chatId,
      `Start a new project? This will replace the current working details for ${escapeHtml(context.state.project.name)} in the bot, including file notes, answers, and recap. Earlier Telegram messages will remain in this chat, but I will not use them for the new project.\n\nTap a button, or reply exactly Start new project or Keep current project.`,
      newProjectButtons(context.state));
  }

  async cancelNew(context) {
    const state = context.state;
    if (!state.pendingNew) return this.telegram.send(context.chatId, 'That choice is no longer current. Send /start to continue.');
    state.pendingNew = false;
    await this.save(context);
    await this.telegram.send(context.chatId, `Keeping ${escapeHtml(state.project.name)}.`);
    return this.start(context);
  }

  async confirmNew(context) {
    const state = context.state;
    if (!state.pendingNew || state.approved) return this.telegram.send(context.chatId, 'That choice is no longer current. Send /start to continue.');
    context.state = newState(this.clock());
    await this.save(context);
    return this.telegram.send(context.chatId,
      'New project started. Send its Notion page name and any useful files. I will inspect the files before asking questions.');
  }

  async receiveFile(context, message) {
    const state = context.state;
    if (state.approved && !state.reviewingApproved) {
      state.approvalHistory = approvedVersions(state);
      state.reviewingApproved = true;
      await this.telegram.send(context.chatId, 'I’ll read this new material and review the direction. Your earlier approved recap remains saved.');
    }
    const document = message.document;
    const photo = message.photo?.at(-1);
    const name = safeName(document?.file_name || `photo-${photo?.file_unique_id || Date.now()}.jpg`);
    const size = document?.file_size ?? photo?.file_size ?? 0;
    const fileId = document?.file_id || photo?.file_id;
    let reason = '';
    if (state.sources.filter((source) => source.status !== 'removed').length >= MAX_FILES) reason = 'This test accepts up to 6 files. Please remove this file from the project.';
    else if (!SUPPORTED.has(extension(name))) reason = `Unsupported format ${extension(name) || '(none)'}. Please send TXT, MD, PDF, JPG, or PNG.`;
    else if (size > MAX_FILE_BYTES) reason = 'The file is over 10 MB.';
    const source = { name, fileId, mime: mimeFor(name), size, status: reason ? 'blocked' : 'pending', reason, facts: [], summary: '' };
    state.sources.push(source);
    state.stage = state.recap ? 'collecting_new_file' : 'collecting';
    await this.save(context);
    if (reason) return this.telegram.send(context.chatId,
      `Couldn’t read: ${escapeHtml(name)} — ${escapeHtml(reason)}\nSend a readable replacement or remove this file before questions.`,
      blockedButtons(state, state.sources.length - 1));
    return this.telegram.send(context.chatId,
      `Received: ${escapeHtml(name)}. I’ll read it when you tap Files ready.`, intakeButtons(state));
  }

  async handleCallback(context, query) {
    await this.telegram.answerCallback(query.id).catch(() => {});
    const [action, projectId, extra, hash] = String(query.data || '').split(':');
    const state = context.state;
    if (projectId !== state.id) return this.telegram.send(context.chatId, 'That control belongs to an older project view. Send /start for the current one.');
    if (action === 'new_cancel') return this.cancelNew(context);
    if (action === 'new_confirm') return this.confirmNew(context);
    if (state.pendingNew) return this.newProjectPrompt(context);
    if (action === 'saved') return this.showSaved(context, extra);
    if (action === 'history') return this.showHistory(context);
    if (action === 'review') return this.beginReview(context);
    if (action === 'files_ready') return this.finishFiles(context, false);
    if (action === 'no_files') return this.finishFiles(context, true);
    if (action === 'retry_file') {
      const source = state.sources[Number(extra)];
      if (!source || source.status !== 'blocked' || !['blocked', 'collecting', 'collecting_new_file'].includes(state.stage)) {
        return this.telegram.send(context.chatId, 'That file control is no longer current. Send /start to continue.');
      }
      source.status = 'pending'; source.reason = '';
      state.stage = state.recap ? 'collecting_new_file' : 'collecting';
      await this.save(context);
      return this.finishFiles(context, false);
    }
    if (action === 'remove_file') {
      const source = state.sources[Number(extra)];
      if (!source || source.status !== 'blocked' || !['blocked', 'collecting', 'collecting_new_file'].includes(state.stage)) {
        return this.telegram.send(context.chatId, 'That file control is no longer current. Send /start to continue.');
      }
      source.status = 'removed'; source.reason = 'Removed from this project at your request';
      await this.save(context);
      await this.telegram.send(context.chatId, `Removed: ${escapeHtml(source.name)}.`, intakeButtons(state));
      return;
    }
    if (action === 'change') {
      if (state.stage !== 'recap' || Number(extra) !== state.recap?.version) return this.outdated(context);
      return this.telegram.send(context.chatId, 'What would you like me to change in this recap? A sentence is enough.');
    }
    if (action === 'approve') return this.approve(context, Number(extra), hash);
  }

  async finishFiles(context, noFiles) {
    const state = context.state;
    if (!state.project.name) return this.telegram.send(context.chatId, 'What is the Notion page called? I’ll keep the files you sent.');
    if (!['collecting', 'collecting_new_file', 'blocked', 'inspecting'].includes(state.stage)) return this.telegram.send(context.chatId, 'That upload choice is from an older message. Send /start to see where we are.');
    if (noFiles && state.sources.some((source) => source.status !== 'removed')) {
      return this.telegram.send(context.chatId, 'You have already sent files. Tap Files ready so I can read them, or remove the files first.');
    }
    state.stage = 'inspecting';
    await this.save(context);
    await this.telegram.send(context.chatId, 'Reading your files now.');
    for (const source of state.sources) {
      if (source.status !== 'pending') continue;
      try {
        const buffer = await this.telegram.getFile(source.fileId, MAX_FILE_BYTES);
        if (extension(source.name) === '.pdf') {
          const pdf = await PDFDocument.load(buffer, { ignoreEncryption: false });
          const pages = pdf.getPageCount();
          if (pages > 20) throw new Error(`The PDF has ${pages} pages; this test accepts at most 20.`);
        }
        const result = await this.ai.inspectFile({ name: source.name, mime: source.mime, buffer });
        if (!result?.readable) throw new Error(result?.reason || 'The content could not be read');
        source.status = 'read';
        source.facts = (result.facts || []).map((item) => short(item, 350)).slice(0, 12);
        source.summary = short(result.summary, 500);
        source.reason = '';
      } catch (error) {
        source.status = 'blocked';
        source.reason = short(error.message || 'The file could not be read', 180);
      }
      await this.save(context);
    }
    if (!state.metrics.firstResultAt) state.metrics.firstResultAt = this.clock();
    if (state.sources.some((source) => source.status === 'blocked')) state.stage = 'blocked';
    else state.stage = 'inspection_done';
    await this.save(context);
    await this.sendCoverage(context);
    if (state.stage === 'blocked') return;
    if (state.recap) return this.buildRecap(context, 'I read the new material and checked the direction again.');
    if (state.questions.length) {
      state.stage = 'questions'; await this.save(context);
      return this.sendQuestions(context, true);
    }
    return this.askQuestions(context);
  }

  async sendCoverage(context) {
    const state = context.state;
    const lines = state.sources.filter((source) => source.status !== 'removed').map((source) => {
      if (source.status === 'read') return `Read: ${escapeHtml(source.name)}${source.summary ? ` — ${escapeHtml(short(source.summary, 180))}` : ''}`;
      return `Couldn’t read: ${escapeHtml(source.name)} — ${escapeHtml(source.reason || 'Reading did not finish')}`;
    });
    await this.telegram.send(context.chatId, `<b>File coverage</b>\n${lines.length ? lines.join('\n') : 'No files supplied.'}`);
    const index = state.sources.findIndex((source) => source.status === 'blocked');
    if (index >= 0) await this.telegram.send(context.chatId,
      `Please replace or remove ${escapeHtml(state.sources[index].name)} before I ask questions.`,
      blockedButtons(state, index));
  }

  async askQuestions(context) {
    const state = context.state;
    state.stage = 'generating_questions'; await this.save(context);
    let proposed;
    try { proposed = await this.ai.askQuestions(contextFor(state)); }
    catch { state.stage = 'inspection_done'; await this.save(context); return this.telegram.send(context.chatId, 'I couldn’t prepare the questions yet. Send /retry to try again.'); }
    if (!Array.isArray(proposed) || proposed.length > 5 || proposed.some((q) => !q.question || !q.why || (q.question.match(/\?/g) || []).length > 1)) {
      state.stage = 'inspection_done'; await this.save(context);
      return this.telegram.send(context.chatId, 'I couldn’t make a short enough question list yet. Send /retry to try again.');
    }
    state.questions = proposed.map(({ question, why }) => ({ question: short(question, 280), why: short(why, 180), answer: '' }));
    if (!state.questions.length) {
      state.metrics.finalAnswerAt = this.clock();
      state.stage = 'ready_for_recap'; await this.save(context);
      return this.buildRecap(context);
    }
    state.stage = 'questions'; await this.save(context);
    return this.sendQuestions(context, false);
  }

  async sendQuestions(context, remainingOnly) {
    const questions = context.state.questions.map((q, index) => ({ ...q, index: index + 1 })).filter((q) => !remainingOnly || !q.answer);
    if (!questions.length) return this.buildRecap(context);
    const lines = questions.map((q) => `${q.index}. ${escapeHtml(q.question)}\nWhy: ${escapeHtml(q.why)}`);
    return this.telegram.send(context.chatId,
      `<b>A few questions</b>\n${lines.join('\n\n')}\n\nShort numbered replies are fine. If you don’t know an answer, say “unsure.”`);
  }

  async receiveAnswers(context, text) {
    const state = context.state;
    let parsed;
    try { parsed = await this.ai.parseAnswers(contextFor(state), text); }
    catch { return this.telegram.send(context.chatId, 'I couldn’t read that reply just now. Please send it again.'); }
    let changed = false;
    for (const item of parsed?.answers || []) {
      const index = Number(item.index) - 1;
      if (index >= 0 && index < state.questions.length && !state.questions[index].answer && String(item.answer || '').trim()) {
        state.questions[index].answer = short(item.answer, 1200);
        changed = true;
      }
    }
    if (!changed) return this.telegram.send(context.chatId, escapeHtml(parsed?.followup || 'Please reply with the question number and your answer.'));
    await this.save(context);
    if (state.questions.some((q) => !q.answer)) return this.sendQuestions(context, true);
    state.metrics.finalAnswerAt = this.clock();
    state.stage = 'ready_for_recap'; await this.save(context);
    return this.buildRecap(context);
  }

  async buildRecap(context, changeNote = '') {
    const state = context.state;
    if (state.sources.some(({ status }) => ['pending', 'blocked'].includes(status))) {
      state.stage = 'blocked'; await this.save(context); return this.sendCoverage(context);
    }
    const inputHash = directionInputHash(state);
    if (!state.direction || state.directionInputHash !== inputHash) {
      state.stage = 'verifying_direction'; await this.save(context);
      await this.telegram.send(context.chatId, 'Checking the prerequisites and facts that could change the route.');
      try {
        const direction = await this.ai.verifyDirection(contextFor(state));
        if (!direction?.outcome || !Array.isArray(direction.sequence) || !direction.sequence.length || !Array.isArray(direction.prerequisites) ||
          !direction.applicationAppointment || !Array.isArray(direction.ownership) || !Array.isArray(direction.uncertainties)) throw new Error('Incomplete direction');
        direction.sources = publicSources(direction);
        state.direction = direction;
        state.directionInputHash = inputHash;
        state.metrics.directionAt = this.clock();
        console.info('Direction check completed:', `lookup=${Boolean(direction.lookup?.performed)}`, `tool=${direction.lookup?.tool || 'none'}`, `sources=${direction.sources.length}`);
        await this.save(context);
      } catch (error) {
        const safeDiagnostic = (value) => /^[a-zA-Z0-9_.:\[\]-]{1,180}$/.test(String(value || '')) ? value : 'unknown';
        state.lastDirectionError = { code: safeDiagnostic(error?.code), operation: safeDiagnostic(error?.operation), at: this.clock() };
        console.error('Direction check failed:', state.lastDirectionError.operation, state.lastDirectionError.code);
        state.stage = 'ready_for_recap'; await this.save(context);
        return this.telegram.send(context.chatId, 'I couldn’t finish the direction check. I’m holding the recap until I can check it. Send /retry to continue.');
      }
    }
    state.stage = 'generating_recap'; await this.save(context);
    let recap;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const draft = await this.ai.makeRecap(contextFor(state));
        const candidate = Object.fromEntries(RECAP_FIELDS.map((field) => [field,
          String(state.patchedFields?.includes(field) ? state.proposedRecap?.[field] || '' : draft?.[field] || '').trim()]));
        candidate.sources = publicSources(state.direction);
        const issues = [];
        if (RECAP_FIELDS.some((field) => !candidate[field])) issues.push('Complete all five recap sections.');
        if (recapText({ ...state, recap: { ...candidate, version: (state.recap?.version || 0) + 1 } }).length > 4000) issues.push('Make the recap fit one Telegram message without losing material caveats.');
        if (state.requiredRoleChange && state.recap && candidate.builderHelp === state.recap.builderHelp && candidate.bonNeeds === state.recap.bonNeeds) issues.push('Reflect the requested change in ownership.');
        if (!issues.length) {
          const review = await this.ai.validateRecap(contextFor(state), candidate);
          if (review?.valid !== true || review?.issues?.length) issues.push(...(review?.issues?.length ? review.issues : ['Check the recap against the verified direction.']));
        }
        if (!issues.length) { recap = candidate; break; }
        state.recapValidationIssues = issues;
        // Generate a complete consistent revision, rather than retaining a stale patch.
        state.proposedRecap = null; state.patchedFields = null;
        await this.save(context);
      } catch {
        state.stage = 'ready_for_recap'; await this.save(context);
        return this.telegram.send(context.chatId, 'I couldn’t finish checking the recap yet. The earlier version cannot be approved. Send /retry to continue.');
      }
    }
    if (!recap) {
      state.stage = 'ready_for_recap'; await this.save(context);
      return this.telegram.send(context.chatId, 'The recap still needs a correction. The earlier recap cannot be approved. Send /retry and I’ll revise it.');
    }
    recap.version = (state.recap?.version || 0) + 1;
    recap.hash = recapHash(recap);
    recap.createdAt = this.clock();
    state.recap = recap;
    state.proposedRecap = null; state.patchedFields = null;
    state.requiredRoleChange = false; state.recapValidationIssues = [];
    state.recapHistory.push(recap);
    state.stage = 'recap';
    state.metrics.recapAt = this.clock();
    await this.save(context);
    if (changeNote) await this.telegram.send(context.chatId, `Changed: ${escapeHtml(changeNote)}`);
    return this.sendRecap(context, recap.version === 1);
  }

  async sendRecap(context, first) {
    const state = context.state;
    const text = recapText(state);
    if (text.length > 4000) throw new Error('Recap exceeds Telegram message limit');
    await this.telegram.send(context.chatId, text, recapButtons(state));
    if (first) await this.telegram.send(context.chatId,
      'This approves the direction only. It does not authorize purchases, bookings, submissions, or messages to other people. The detailed action plan comes later.');
  }

  async discuss(context, text) {
    const state = context.state;
    const wasApproved = state.stage === 'approved';
    const wasReviewing = state.stage === 'reviewing_saved';
    const roleSignal = roleReviewSignal(text);
    const correctionRequired = roleSignal === 'correction' || state.stage === 'correction_pending';
    state.stage = 'processing_discussion';
    state.latestUserText = short(text, 3000);
    await this.save(context);
    let result;
    try { result = await this.ai.handleDiscussion(contextFor(state), text); }
    catch {
      // Hold approval when the message could expose a material error. Preserve all snapshots.
      state.stage = 'correction_pending';
      if (roleSignal) state.requiredRoleChange = true;
      if (state.approved) { state.approvalHistory = approvedVersions(state); state.reviewingApproved = true; }
      await this.save(context);
      return this.telegram.send(context.chatId, 'I couldn’t check that reply just now. Your saved recap is still here; approval of a revision is paused. Send /retry or repeat your change.');
    }
    if (roleSignal === 'clarification' && result.kind !== 'correction') {
      state.stage = 'correction_pending';
      if (state.approved) state.reviewingApproved = true;
      await this.save(context);
      await this.telegram.send(context.chatId, escapeHtml(result.reply || 'I can help with research and preparation later.'));
      return this.telegram.send(context.chatId, 'What should I take over or prepare? I’ll revise the recap before you approve it.');
    }
    if (!correctionRequired && (result.kind === 'question' || result.kind === 'clarification')) {
      state.stage = wasApproved ? 'approved' : wasReviewing ? 'reviewing_saved' : 'recap';
      await this.save(context);
      await this.telegram.send(context.chatId, escapeHtml(result.reply || 'Which part would you like to change?'));
      if (state.stage === 'approved') return;
      if (state.stage === 'reviewing_saved') return this.reviewPrompt(context);
      return this.telegram.send(context.chatId, 'You can still approve the current recap, or tell me what to change.', recapButtons(state));
    }
    if (state.approved) { state.approvalHistory = approvedVersions(state); state.reviewingApproved = true; }
    state.corrections.push({ text: short(text, 3000), at: this.clock() });
    state.requiredRoleChange = Boolean(roleSignal) || Boolean(state.requiredRoleChange);
    // Retain explicit corrections, then validate the complete result against the new evidence.
    state.proposedRecap = { ...state.recap }; state.patchedFields = [];
    for (const field of RECAP_FIELDS) {
      if (typeof result.patch?.[field] === 'string' && result.patch[field].trim()) {
        state.proposedRecap[field] = result.patch[field].trim(); state.patchedFields.push(field);
      }
    }
    state.stage = 'ready_for_recap'; await this.save(context);
    return this.buildRecap(context, short(result.changedNote || result.reply || 'I updated the direction you corrected.', 200));
  }

  async approve(context, version, hash) {
    const state = context.state;
    if (state.stage !== 'recap' || state.recap?.version !== version || state.recap?.hash !== hash) return this.outdated(context);
    const previous = { approved: state.approved, approvalHistory: state.approvalHistory, stage: state.stage, reviewingApproved: state.reviewingApproved, approvalAt: state.metrics.approvalAt };
    const snapshot = structuredClone({ project: state.project, recap: state.recap, direction: state.direction, message: recapText(state), approvedAt: this.clock(), chatId: context.chatId });
    state.approvalHistory = [...approvedVersions(state), snapshot];
    state.approved = snapshot;
    state.stage = 'approved'; state.reviewingApproved = false;
    state.metrics.approvalAt = snapshot.approvedAt;
    try { await this.save(context); }
    catch {
      const { approvalAt, ...fields } = previous;
      Object.assign(state, fields); state.metrics.approvalAt = approvalAt;
      return this.telegram.send(context.chatId, 'I couldn’t save that yet. Please press Approve this recap again.');
    }
    return this.telegram.send(context.chatId,
      `Direction saved — version ${version}. We’ll use this agreed goal and approach for a later action plan. You can send /review or simply tell me what needs changing.`, savedButtons(state));
  }

  async showSaved(context, version) {
    const state = context.state;
    const approved = version ? approvedVersions(state).find(({ recap }) => recap.version === Number(version)) : state.approved;
    if (!approved) return this.telegram.send(context.chatId, 'No approved direction with that version is saved. Send /start to continue.');
    if (state.reviewingApproved) await this.telegram.send(context.chatId, 'This is the earlier approved direction. A revision is under review and needs its own approval.');
    return this.telegram.send(context.chatId, approved.message, savedButtons(state));
  }

  async beginReview(context) {
    const state = context.state;
    if (!state.approved) return this.telegram.send(context.chatId, 'No direction is saved yet. Send /start to review the current recap.');
    if (state.reviewingApproved) return this.start(context);
    state.approvalHistory = approvedVersions(state);
    state.reviewingApproved = true; state.stage = 'reviewing_saved';
    await this.save(context);
    await this.showSaved(context);
    return this.reviewPrompt(context);
  }

  async reviewPrompt(context) {
    return this.telegram.send(context.chatId, 'What would you like to question or change? I’ll keep the earlier approval and show any revised direction for a fresh approval.');
  }

  async showHistory(context) {
    const versions = approvedVersions(context.state);
    if (!versions.length) return this.showSaved(context);
    return this.telegram.send(context.chatId, '<b>Approved directions</b>\n' + versions.map(({ recap, approvedAt }) => `Version ${recap.version} — ${escapeHtml(approvedAt)}`).join('\n'),
      versions.slice(-8).map(({ recap }) => [{ text: `Show version ${recap.version}`, callback_data: `saved:${context.state.id}:${recap.version}` }]));
  }

  async showSources(context) {
    const state = context.state;
    const direction = state.stage === 'approved' ? state.approved?.direction : state.direction;
    const sources = publicSources(direction);
    if (!sources.length) return this.telegram.send(context.chatId, 'No public sources have been saved for this direction. Its supplied evidence and unresolved checks are recorded with the recap.');
    return this.telegram.send(context.chatId, '<b>Sources for this direction</b>\n\n' + sources.map(({ title, url, supports, checkedAt }) =>
      `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>\n${escapeHtml(supports)}${checkedAt ? `\nChecked: ${escapeHtml(checkedAt.slice(0, 10))}` : ''}`).join('\n\n'));
  }

  async outdated(context) {
    if (context.state.stage === 'correction_pending' || context.state.requiredRoleChange) {
      return this.telegram.send(context.chatId,
        'That approval is paused while I update who does the work. Please review the revised recap first.');
    }
    await this.telegram.send(context.chatId, 'That approval is for an older recap. Please review the latest version.');
    if (context.state.stage === 'recap') await this.sendRecap(context, false);
  }

  async retry(context) {
    const stage = context.state.stage;
    if (stage === 'approved') return this.showSaved(context);
    if (stage === 'collecting' || stage === 'collecting_new_file' || stage === 'blocked' || stage === 'inspecting') return this.finishFiles(context, false);
    if (stage === 'inspection_done' || stage === 'generating_questions') return this.askQuestions(context);
    if (['ready_for_recap', 'generating_recap', 'verifying_direction'].includes(stage)) return this.buildRecap(context);
    if (['processing_discussion', 'correction_pending'].includes(stage) && context.state.latestUserText) return this.discuss(context, context.state.latestUserText);
    return this.start(context);
  }
}
