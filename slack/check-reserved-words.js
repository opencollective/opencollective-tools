/**
 * This script checks for reserved words in members usernames/descriptions.
 */

require('../env');

const { Command } = require('commander');
const { App } = require('@slack/bolt');
const { flatten, get } = require('lodash');
const { SLACK_BOT_ID } = require('./_constants');
const { formatUserName } = require('./_lib');

if (!process.env.SLACK_BOT_TOKEN) {
  throw new Error('Missing environment variable: SLACK_BOT_TOKEN');
} else if (!process.env.SLACK_SIGNING_SECRET) {
  throw new Error('Missing environment variable: SLACK_SIGNING_SECRET');
}

const reservedWords = ['osc', 'admin', 'ocf'];

const getSlackApp = () => {
  return new App({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    token: process.env.SLACK_BOT_TOKEN,
  });
};

const getProgram = (argv) => {
  const program = new Command();
  program.exitOverride();
  program.showSuggestionAfterError();
  program.option('--channel <channel>', 'Only analyze the given channels (comma-separated list)');
  program.option('--kick', 'Kick invalid members from channels');
  program.parse(argv);
  return program;
};

const SPECIAL_MEMBERS = [
  // ==== Apps ====
  SLACK_BOT_ID, // This script!
  'U014VS2FCH5', // Sentry
  'U028MQC0TSR', // OCF team survey
];

const IGNORED_USERS = ['UALJD3D7T'];

const INTERNAL_GROUPS = [
  'S020U3J559D', // OC Inc
  'S026UGK3U9F', // OCF
  'S0523QBN65R', // OCEU
  'S0524AJ7KAP', // OSC
  'S0523QPE4NP', // OCNZ
];

const MEMBER_TEXT_FIELDS = [
  // 'name',
  'profile.first_name',
  'profile.last_name',
  'profile.display_name_normalized',
  'profile.real_name_normalized',
  'profile.title',
  'profile.status_text',
];

const checkMember = async (slackApp, member, adminMembers) => {
  // Ignore special members
  if (
    member['deleted'] ||
    member['is_admin'] ||
    SPECIAL_MEMBERS.includes(member.id) ||
    IGNORED_USERS.includes(member.id) ||
    adminMembers?.includes(member.id)
  ) {
    return;
  }

  const result = { reservedWords: [], values: {} };
  for (const field of MEMBER_TEXT_FIELDS) {
    const value = get(member, field);
    if (value) {
      const lowercaseValue = value.toLowerCase();
      const reservedWordsFound = reservedWords.filter((word) => lowercaseValue.includes(word));
      if (reservedWordsFound.length > 0) {
        result.reservedWords.push(...reservedWordsFound);
        result.values[field] = value;
      }
    }
  }

  // Display result
  if (result.reservedWords.length > 0) {
    const reservedWordsStr = result.reservedWords.join(', ');
    const fieldsStr = JSON.stringify(result.values);
    const memberLastUpdateDate = new Date(member.updated * 1000).toLocaleDateString();
    const userName = formatUserName(member);
    console.log(
      `> User ${userName}(${memberLastUpdateDate}) has reserved words "${reservedWordsStr}" in fields "${fieldsStr}"`,
    );

    // Use the search API to get all messages from user
    const { messages, files } = await slackApp.client.search.all({
      query: `from:${member.name}`,
      sort: 'timestamp',
      sort_dir: 'desc',
      token: process.env.SLACK_USER_TOKEN,
      count: 1000,
    });

    const allItems = [...messages.matches, ...files.matches];
    if (allItems.length > 0) {
      console.log(`    Found ${messages.matches.length} messages and ${files.matches.length} files`);
      for (const item of allItems.slice(0, 5)) {
        const itemText = item.url_private ? `File [${item.name}](${item.private_url})` : `"${item.text}"`;
        console.log(`    - #${item.channel?.name || 'unknown channel'}: ${itemText}`);
      }
    }

    console.log('\n');
  }
};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const slackApp = getSlackApp();

  // Get a list of all user groups
  const { usergroups } = await slackApp.client.usergroups.list({ include_users: true });
  const adminGroups = usergroups.filter((g) => INTERNAL_GROUPS.includes(g.id));
  const adminMembers = flatten(adminGroups.map((g) => g.users));

  // List all users (with pagination)
  let cursor;
  do {
    const response = await slackApp.client.users.list({ cursor, limit: 1000 });
    cursor = response['response_metadata']['next_cursor'];
    for (const member of response.members) {
      await checkMember(slackApp, member, adminMembers);
    }
  } while (cursor);
}

main();
