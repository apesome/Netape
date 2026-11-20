import assert from 'node:assert/strict';
import test from 'node:test';
import { directoryAfterCd, commandFromPrompt } from '../src/terminalCwd.ts';

test('cd supports absolute, relative, parent, home, previous, and spaces', () => {
  const cases = [
    ['cd /opt/logs/', '/opt/logs'], ['cd logs', '/srv/app/logs'],
    ['cd ../data', '/srv/data'], ['cd ../../..', '/'],
    ['cd', '/home/user'], ['cd ~', '/home/user'], ['cd ~/work', '/home/user/work'],
    ['cd -', '/var/log'], ['cd "log files"', '/srv/app/log files'],
    ["cd '/opt/log files'", '/opt/log files'], ['cd /opt/log\\ files', '/opt/log files'],
    ['cd -- /tmp', '/tmp'],
  ];
  for (const [command, expected] of cases) {
    assert.equal(directoryAfterCd(command, '/srv/app', '/home/user', '/var/log'), expected, command);
  }
});

test('unknown expressions and compound commands are not guessed', () => {
  for (const command of ['cd $HOME', 'cd "$(pwd)"', 'cd /tmp && false', 'echo cd /tmp', 'cd ~other', 'cd a b', 'cd "unterminated', 'cd *']) {
    assert.equal(directoryAfterCd(command, '/srv/app', '/home/user'), null, command);
  }
  assert.equal(directoryAfterCd('cd relative', '', ''), null);
});

test('completed command is read from the displayed prompt', () => {
  assert.equal(commandFromPrompt('[user@host app]$ cd /opt/completed/'), 'cd /opt/completed/');
  assert.equal(commandFromPrompt('root@host:/srv# cd ..'), 'cd ..');
  assert.equal(commandFromPrompt('arbitrary output'), null);
});
