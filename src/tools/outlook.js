// Outlook MCP tools — registered in Claudia's tool registry
// Exposes all 13 outlook-mcp tools as native Claudia tools

import { defaultRegistry } from './index.js';
import {
  checkAuth, getSchedule, getEmails, searchEmails,
  getUnreadCount, readEmail, findContact, composeDraft,
  replyEmail, forwardEmail, sendDraft, getDraftContent, updateDraft,
} from '../outlook/client.js';

export function registerOutlookTools(config, registry = defaultRegistry) {

  registry.set('outlook_check_auth', {
    description: 'Check if the Outlook MCP session is authenticated.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      try { return { result: await checkAuth() }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_get_schedule', {
    description: 'Get calendar events for today or a specific date.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
      },
      additionalProperties: false,
    },
    async execute({ date }) {
      try { return { result: await getSchedule(date) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_get_emails', {
    description: 'List recent emails from a folder (inbox, sent, drafts, deleted, junk, archive).',
    parameters: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Folder name. Default: inbox' },
        count: { type: 'number', description: 'Max emails to return. Default: 20' },
      },
      additionalProperties: false,
    },
    async execute({ folder, count }) {
      try { return { result: await getEmails(folder, count) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_search_emails', {
    description: 'Search emails by query, sender, subject, or unread status.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text' },
        from: { type: 'string', description: 'Sender name or email' },
        subject: { type: 'string', description: 'Subject contains' },
        unread_only: { type: 'boolean', description: 'Only unread emails' },
        max_results: { type: 'number', description: 'Max results. Default: 20' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try { return { result: await searchEmails(args) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_get_unread_count', {
    description: 'Get the number of unread emails in the inbox.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      try { return { result: await getUnreadCount() }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_read_email', {
    description: 'Read the full content of a specific email by index or subject.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Email index from outlook_get_emails' },
        subject: { type: 'string', description: 'Subject text to match' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try { return { result: await readEmail(args) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_find_contact', {
    description: "Look up a person's email address by name.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: "Person's name to search" },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute({ name }) {
      try { return { result: await findContact(name) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_compose_draft', {
    description: 'Compose email and save as Draft (never sends). Get user confirmation first.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: 'Recipient email(s)' },
        cc: { type: 'array', items: { type: 'string' }, description: 'CC recipients' },
        bcc: { type: 'array', items: { type: 'string' }, description: 'BCC recipients' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body' },
        font_family: { type: 'string', description: 'Font. Default: Calibri' },
        font_size: { type: 'string', description: 'Font size. Default: 11pt' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
    async execute(args) {
      try { return { result: await composeDraft(args) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_reply_email', {
    description: 'Reply to an email (saves as draft). Get user confirmation first.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Email index from outlook_get_emails' },
        body: { type: 'string', description: 'Reply body' },
        reply_all: { type: 'boolean', description: 'Reply All. Default: false' },
      },
      required: ['index', 'body'],
      additionalProperties: false,
    },
    async execute({ index, body, reply_all }) {
      try { return { result: await replyEmail(index, body, reply_all) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_forward_email', {
    description: 'Forward email to someone (saves as draft). Get user confirmation first.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Email index from outlook_get_emails' },
        to: { type: 'array', items: { type: 'string' }, description: 'Forward to email(s)' },
        body: { type: 'string', description: 'Message before forwarded content' },
      },
      required: ['index', 'to'],
      additionalProperties: false,
    },
    async execute({ index, to, body }) {
      try { return { result: await forwardEmail(index, to, body) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_send_draft', {
    description: 'Send an existing draft. SAFETY: confirmed must be true. Always ask user first.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Draft index in Drafts folder' },
        confirmed: { type: 'boolean', description: 'Must be true. Safety gate.' },
      },
      required: ['index', 'confirmed'],
      additionalProperties: false,
    },
    async execute({ index, confirmed }) {
      try { return { result: await sendDraft(index, confirmed) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_get_draft', {
    description: 'Read back a draft from the Drafts folder.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Draft index' },
        subject: { type: 'string', description: 'Subject to match' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try { return { result: await getDraftContent(args) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });

  registry.set('outlook_update_draft', {
    description: 'Modify and re-save an existing draft.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Draft index' },
        subject_match: { type: 'string', description: 'Subject to find draft' },
        to: { type: 'array', items: { type: 'string' }, description: 'New To' },
        cc: { type: 'array', items: { type: 'string' }, description: 'New CC' },
        subject: { type: 'string', description: 'New subject' },
        body: { type: 'string', description: 'New body' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try { return { result: await updateDraft(args) }; }
      catch (e) { return { error: true, message: e.message }; }
    },
  });
}
