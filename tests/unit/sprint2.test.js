// tests/unit/sprint2.test.js — Tests for Sprint 2 (Talk Poller, Confirmation, CRON/TASKS)
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Talk Poller Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('talk-poller', () => {
  let mod;

  it('should load module', async () => {
    mod = await import('../../src/channels/talk-poller.js');
  });

  describe('isBotMentioned', () => {
    it('should detect mention via messageParameters', () => {
      const msg = {
        message: 'Hey {mention-user0}',
        messageParameters: { 'mention-user0': { type: 'user', id: 'laia-fuji', name: 'laia-fuji' } },
      };
      assert.ok(mod.isBotMentioned(msg, 'laia-fuji'));
    });

    it('should not detect mention for another user', () => {
      const msg = {
        message: 'Hey {mention-user0}',
        messageParameters: { 'mention-user0': { type: 'user', id: 'jorid', name: 'jorid' } },
      };
      assert.ok(!mod.isBotMentioned(msg, 'laia-fuji'));
    });

    it('should detect mention via raw text fallback', () => {
      const msg = { message: 'Hey @laia-fuji can you help?', messageParameters: {} };
      assert.ok(mod.isBotMentioned(msg, 'laia-fuji'));
    });

    it('should return false for no mention', () => {
      const msg = { message: 'Hello everyone', messageParameters: {} };
      assert.ok(!mod.isBotMentioned(msg, 'laia-fuji'));
    });

    it('should handle missing messageParameters', () => {
      const msg = { message: '@laia-fuji help' };
      assert.ok(mod.isBotMentioned(msg, 'laia-fuji'));
    });
  });

  describe('routeMessages', () => {
    const botUser = 'laia-fuji';
    const makeMsg = (id, actorId, text, params) => ({
      id, actorId, actorType: 'users', actorDisplayName: actorId,
      message: text, messageParameters: params || {}, systemMessage: '',
    });

    it('should route all human messages in DM', () => {
      const messages = [
        makeMsg(1, 'jorid', 'Hello'),
        makeMsg(2, 'jorid', 'Help me'),
      ];
      const routed = mod.routeMessages(messages, 1, botUser, 'tok123', 'jorid');
      assert.equal(routed.length, 2);
      assert.equal(routed[0].text, 'Hello');
      assert.equal(routed[0].roomToken, 'tok123');
    });

    it('should skip own messages in DM', () => {
      const messages = [
        makeMsg(1, 'laia-fuji', 'My response'),
        makeMsg(2, 'jorid', 'Thanks'),
      ];
      const routed = mod.routeMessages(messages, 1, botUser, 'tok123', 'jorid');
      assert.equal(routed.length, 1);
      assert.equal(routed[0].text, 'Thanks');
    });

    it('should only route @mentioned messages in group', () => {
      const messages = [
        makeMsg(1, 'jorid', 'Hey {mention-user0}', { 'mention-user0': { type: 'user', id: 'laia-fuji' } }),
        makeMsg(2, 'other', 'Random chat'),
      ];
      const routed = mod.routeMessages(messages, 2, botUser, 'grp1', 'General');
      assert.equal(routed.length, 1);
      assert.equal(routed[0].authorId, 'jorid');
    });

    it('should skip system messages', () => {
      const messages = [
        { id: 1, actorType: 'system', actorId: 'system', message: 'User joined', systemMessage: 'user_added', messageParameters: {} },
      ];
      const routed = mod.routeMessages(messages, 1, botUser, 'tok1', 'test');
      assert.equal(routed.length, 0);
    });
  });

  describe('loadPollState / savePollState', () => {
    it('should return default state when no file exists', () => {
      const state = mod.loadPollState();
      assert.ok(state.rooms);
      assert.equal(typeof state.rooms, 'object');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Confirmation Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('confirmation', () => {
  let mod;

  it('should load module', async () => {
    mod = await import('../../src/services/confirmation.js');
  });

  describe('classifyRisk', () => {
    it('should classify read as safe', () => {
      assert.equal(mod.classifyRisk('read', {}), 'safe');
    });

    it('should classify brain_search as safe', () => {
      assert.equal(mod.classifyRisk('brain_search', {}), 'safe');
    });

    it('should classify write as low', () => {
      assert.equal(mod.classifyRisk('write', {}), 'low');
    });

    it('should classify bash as medium by default', () => {
      assert.equal(mod.classifyRisk('bash', { command: 'ls -la' }), 'medium');
    });

    it('should classify rm -rf as high', () => {
      assert.equal(mod.classifyRisk('bash', { command: 'rm -rf /tmp/test' }), 'high');
    });

    it('should classify sudo as high', () => {
      assert.equal(mod.classifyRisk('bash', { command: 'sudo apt update' }), 'high');
    });

    it('should classify docker rm as high', () => {
      assert.equal(mod.classifyRisk('bash', { command: 'docker rm container1' }), 'high');
    });

    it('should classify git push --force as high', () => {
      assert.equal(mod.classifyRisk('bash', { command: 'git push --force origin main' }), 'high');
    });

    it('should classify DELETE api_call as high', () => {
      assert.equal(mod.classifyRisk('api_call', { method: 'DELETE', url: '/resource/1' }), 'high');
    });

    it('should classify GET api_call as medium', () => {
      assert.equal(mod.classifyRisk('api_call', { method: 'GET', url: '/resource' }), 'medium');
    });

    it('should classify unknown tool as medium', () => {
      assert.equal(mod.classifyRisk('unknown_tool', {}), 'medium');
    });

    it('should classify git reset --hard as high', () => {
      assert.equal(mod.classifyRisk('bash', { command: 'git reset --hard HEAD~5' }), 'high');
    });

    it('should classify drop table as high', () => {
      assert.equal(mod.classifyRisk('bash', { command: 'sqlite3 db.sqlite "DROP TABLE users"' }), 'high');
    });
  });

  describe('createConfirmation / resolveConfirmation', () => {
    beforeEach(() => {
      mod.clearPendingConfirmations();
    });

    it('should create pending confirmation', () => {
      const c = mod.createConfirmation({ toolName: 'bash', args: { command: 'rm -rf /' }, risk: 'high' });
      assert.ok(c.id.startsWith('confirm-'));
      assert.ok(c.promise instanceof Promise);
      const pending = mod.getPendingConfirmations();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].toolName, 'bash');
    });

    it('should resolve confirmation as approved', async () => {
      const c = mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      c.resolve(true);
      const result = await c.promise;
      assert.equal(result, true);
      assert.equal(mod.getPendingConfirmations().length, 0);
    });

    it('should resolve confirmation as denied', async () => {
      const c = mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      c.resolve(false);
      const result = await c.promise;
      assert.equal(result, false);
    });

    it('should resolve by ID', async () => {
      const c = mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      assert.ok(mod.resolveConfirmation(c.id, true));
      const result = await c.promise;
      assert.equal(result, true);
    });

    it('should return false for unknown ID', () => {
      assert.ok(!mod.resolveConfirmation('nonexistent', true));
    });
  });

  describe('matchConfirmationResponse', () => {
    beforeEach(() => {
      mod.clearPendingConfirmations();
    });

    it('should return null when no pending confirmations', () => {
      assert.equal(mod.matchConfirmationResponse('sí'), null);
    });

    it('should match "sí" as approved', () => {
      mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      const match = mod.matchConfirmationResponse('sí');
      assert.ok(match);
      assert.equal(match.approved, true);
    });

    it('should match "yes" as approved', () => {
      mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      assert.equal(mod.matchConfirmationResponse('yes').approved, true);
    });

    it('should match "no" as denied', () => {
      mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      assert.equal(mod.matchConfirmationResponse('no').approved, false);
    });

    it('should match "cancel" as denied', () => {
      mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      assert.equal(mod.matchConfirmationResponse('cancel').approved, false);
    });

    it('should match catalan "continua" as approved', () => {
      mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      assert.equal(mod.matchConfirmationResponse('continua').approved, true);
    });

    it('should match catalan "atura" as denied', () => {
      mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      assert.equal(mod.matchConfirmationResponse('atura').approved, false);
    });

    it('should not match unrelated text', () => {
      mod.createConfirmation({ toolName: 'bash', args: {}, risk: 'high' });
      assert.equal(mod.matchConfirmationResponse('what is this about?'), null);
    });
  });

  describe('formatConfirmationMessage', () => {
    it('should format bash command', () => {
      const msg = mod.formatConfirmationMessage('bash', { command: 'rm -rf /tmp' }, 'high');
      assert.ok(msg.includes('🔴'));
      assert.ok(msg.includes('bash'));
      assert.ok(msg.includes('rm -rf /tmp'));
    });

    it('should format api_call', () => {
      const msg = mod.formatConfirmationMessage('api_call', { method: 'DELETE', url: '/api/user/1' }, 'high');
      assert.ok(msg.includes('DELETE'));
      assert.ok(msg.includes('/api/user/1'));
    });

    it('should use yellow emoji for medium risk', () => {
      const msg = mod.formatConfirmationMessage('bash', { command: 'ls' }, 'medium');
      assert.ok(msg.includes('🟡'));
    });

    it('should redact secrets from bash commands', () => {
      const msg = mod.formatConfirmationMessage('bash', {
        command: 'curl -H "Authorization: Bearer sk-abc123xyz" https://api.example.com'
      }, 'high');
      assert.ok(msg.includes('[REDACTED]'));
      assert.ok(!msg.includes('sk-abc123xyz'));
    });

    it('should redact password= from commands', () => {
      const msg = mod.formatConfirmationMessage('bash', {
        command: 'mysql -u root password=super_secret'
      }, 'high');
      assert.ok(msg.includes('[REDACTED]'));
      assert.ok(!msg.includes('super_secret'));
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CRON.md Parser Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('cron-file', () => {
  let mod;

  it('should load module', async () => {
    mod = await import('../../src/channels/cron-file.js');
  });

  describe('parseTomlLite', () => {
    it('should parse string values', () => {
      const result = mod.parseTomlLite('name = "test-job"');
      assert.equal(result.name, 'test-job');
    });

    it('should parse single-quoted strings', () => {
      const result = mod.parseTomlLite("name = 'test'");
      assert.equal(result.name, 'test');
    });

    it('should parse boolean values', () => {
      const result = mod.parseTomlLite('enabled = true\nsilent = false');
      assert.equal(result.enabled, true);
      assert.equal(result.silent, false);
    });

    it('should parse integer values', () => {
      const result = mod.parseTomlLite('timeout = 300');
      assert.equal(result.timeout, 300);
    });

    it('should skip comments', () => {
      const result = mod.parseTomlLite('# comment\nname = "test"');
      assert.equal(result.name, 'test');
      assert.equal(Object.keys(result).length, 1);
    });

    it('should handle inline comments after strings', () => {
      const result = mod.parseTomlLite('prompt = "Do X" # this is a comment');
      assert.equal(result.prompt, 'Do X');
    });

    it('should handle inline comments after booleans', () => {
      const result = mod.parseTomlLite('enabled = true # always on');
      assert.equal(result.enabled, true);
    });

    it('should skip empty lines', () => {
      const result = mod.parseTomlLite('\n\nname = "test"\n\n');
      assert.equal(result.name, 'test');
    });
  });

  describe('isValidCron', () => {
    it('should accept valid cron expressions', () => {
      assert.ok(mod.isValidCron('0 7 * * 1-5'));
      assert.ok(mod.isValidCron('*/15 * * * *'));
      assert.ok(mod.isValidCron('0 0 1 * *'));
      assert.ok(mod.isValidCron('30 22 * * 0'));
    });

    it('should reject invalid cron expressions', () => {
      assert.ok(!mod.isValidCron(''));
      assert.ok(!mod.isValidCron('not a cron'));
      assert.ok(!mod.isValidCron('60 * * * *'));   // minute > 59
      assert.ok(!mod.isValidCron('0 25 * * *'));   // hour > 23
      assert.ok(!mod.isValidCron('* * * *'));       // only 4 fields
    });

    it('should accept star expressions', () => {
      assert.ok(mod.isValidCron('* * * * *'));
    });

    it('should accept range with step', () => {
      assert.ok(mod.isValidCron('1-30/2 * * * *'));
    });

    it('should reject invalid step syntax', () => {
      assert.ok(!mod.isValidCron('abc/2 * * * *'));
    });
  });

  describe('parseCronFile', () => {
    it('should parse a valid CRON.md', () => {
      const content = `# Scheduled Jobs

## Briefing matinal
\`\`\`toml
name = "morning-briefing"
cron = "0 7 * * 1-5"
prompt = "Genera el briefing del matí"
\`\`\`

## Backup check
\`\`\`toml
name = "backup-health"
cron = "0 22 * * *"
command = "restic snapshots --latest 1 --json"
silent_unless_action = true
\`\`\`
`;
      const { jobs, errors } = mod.parseCronFile(content);
      assert.equal(errors.length, 0);
      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].name, 'morning-briefing');
      assert.equal(jobs[0].prompt, 'Genera el briefing del matí');
      assert.equal(jobs[1].name, 'backup-health');
      assert.equal(jobs[1].command, 'restic snapshots --latest 1 --json');
      assert.equal(jobs[1].silent_unless_action, true);
    });

    it('should report missing required fields', () => {
      const content = '```toml\nprompt = "test"\n```';
      const { jobs, errors } = mod.parseCronFile(content);
      assert.equal(jobs.length, 0);
      assert.ok(errors.some(e => e.includes("missing required field 'name'")));
    });

    it('should reject invalid cron expressions', () => {
      const content = '```toml\nname = "bad"\ncron = "invalid"\nprompt = "test"\n```';
      const { jobs, errors } = mod.parseCronFile(content);
      assert.equal(jobs.length, 0);
      assert.ok(errors.some(e => e.includes('invalid cron expression')));
    });

    it('should reject prompt + command together', () => {
      const content = '```toml\nname = "both"\ncron = "* * * * *"\nprompt = "test"\ncommand = "ls"\n```';
      const { jobs, errors } = mod.parseCronFile(content);
      assert.equal(jobs.length, 0);
      assert.ok(errors.some(e => e.includes('mutually exclusive')));
    });

    it('should require prompt or command', () => {
      const content = '```toml\nname = "neither"\ncron = "* * * * *"\n```';
      const { jobs, errors } = mod.parseCronFile(content);
      assert.equal(jobs.length, 0);
      assert.ok(errors.some(e => e.includes("must have 'prompt' or 'command'")));
    });

    it('should handle empty content', () => {
      const { jobs, errors } = mod.parseCronFile('');
      assert.equal(jobs.length, 0);
    });

    it('should handle null content', () => {
      const { jobs, errors } = mod.parseCronFile(null);
      assert.equal(jobs.length, 0);
    });

    it('should default enabled to true', () => {
      const content = '```toml\nname = "test"\ncron = "0 0 * * *"\nprompt = "do it"\n```';
      const { jobs } = mod.parseCronFile(content);
      assert.equal(jobs[0].enabled, true);
    });

    it('should respect enabled = false', () => {
      const content = '```toml\nname = "test"\ncron = "0 0 * * *"\nprompt = "do it"\nenabled = false\n```';
      const { jobs } = mod.parseCronFile(content);
      assert.equal(jobs[0].enabled, false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS.md Parser Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('tasks-file', () => {
  let mod;

  it('should load module', async () => {
    mod = await import('../../src/channels/cron-file.js');
  });

  describe('parseTasksFile', () => {
    it('should parse simple tasks', () => {
      const content = `# Tasks
- [ ] Buy milk
- [x] Send email
- [ ] Review PR`;
      const { tasks } = mod.parseTasksFile(content);
      assert.equal(tasks.length, 3);
      assert.equal(tasks[0].text, 'Buy milk');
      assert.equal(tasks[0].done, false);
      assert.equal(tasks[1].text, 'Send email');
      assert.equal(tasks[1].done, true);
    });

    it('should parse priority markers', () => {
      const content = `- [ ] !! Urgent fix
- [ ] ! Important task
- [ ] Normal task`;
      const { tasks } = mod.parseTasksFile(content);
      assert.equal(tasks[0].priority, 'urgent');
      assert.equal(tasks[1].priority, 'high');
      assert.equal(tasks[2].priority, 'normal');
    });

    it('should handle asterisk bullets', () => {
      const content = '* [ ] Task with asterisk';
      const { tasks } = mod.parseTasksFile(content);
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].text, 'Task with asterisk');
    });

    it('should skip non-task lines', () => {
      const content = `# Header
Some text
- [ ] Real task
- Not a task`;
      const { tasks } = mod.parseTasksFile(content);
      assert.equal(tasks.length, 1);
    });

    it('should handle empty content', () => {
      const { tasks } = mod.parseTasksFile('');
      assert.equal(tasks.length, 0);
    });

    it('should handle uppercase X', () => {
      const content = '- [X] Done task';
      const { tasks } = mod.parseTasksFile(content);
      assert.equal(tasks[0].done, true);
    });

    it('should track line numbers', () => {
      const content = `# Tasks\n\n- [ ] First\n- [ ] Second`;
      const { tasks } = mod.parseTasksFile(content);
      assert.equal(tasks[0].line, 3);
      assert.equal(tasks[1].line, 4);
    });
  });

  describe('getPendingTasks', () => {
    it('should filter out done tasks', () => {
      const tasks = [
        { text: 'Done', done: true, priority: 'normal', line: 1 },
        { text: 'Pending', done: false, priority: 'normal', line: 2 },
      ];
      const pending = mod.getPendingTasks(tasks);
      assert.equal(pending.length, 1);
      assert.equal(pending[0].text, 'Pending');
    });

    it('should sort by priority', () => {
      const tasks = [
        { text: 'Normal', done: false, priority: 'normal', line: 1 },
        { text: 'Urgent', done: false, priority: 'urgent', line: 2 },
        { text: 'High', done: false, priority: 'high', line: 3 },
      ];
      const pending = mod.getPendingTasks(tasks);
      assert.equal(pending[0].text, 'Urgent');
      assert.equal(pending[1].text, 'High');
      assert.equal(pending[2].text, 'Normal');
    });
  });

  describe('formatTasksForPrompt', () => {
    it('should format tasks with priority indicators', () => {
      const tasks = [
        { text: 'Urgent fix', done: false, priority: 'urgent', line: 1 },
        { text: 'Normal task', done: false, priority: 'normal', line: 2 },
      ];
      const formatted = mod.formatTasksForPrompt(tasks);
      assert.ok(formatted.includes('🔴'));
      assert.ok(formatted.includes('Urgent fix'));
      assert.ok(formatted.includes('·'));
      assert.ok(formatted.includes('Normal task'));
    });

    it('should return empty for no pending tasks', () => {
      const tasks = [{ text: 'Done', done: true, priority: 'normal', line: 1 }];
      assert.equal(mod.formatTasksForPrompt(tasks), '');
    });

    it('should respect maxBytes budget', () => {
      const tasks = Array.from({ length: 50 }, (_, i) => ({
        text: `Task number ${i} with extra description text to fill space`,
        done: false, priority: 'normal', line: i + 1,
      }));
      const formatted = mod.formatTasksForPrompt(tasks, 200);
      assert.ok(Buffer.byteLength(formatted) <= 220); // small tolerance for trailing text
    });
  });
});
