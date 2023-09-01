require('../env');

const { Command } = require('commander');
const { App } = require('@slack/bolt');
const { difference, partition, flatten } = require('lodash');
const { SLACK_BOT_ID, TEAM_ID } = require('./_constants');
const { formatUserName } = require('./_lib');

if (!process.env.SLACK_BOT_TOKEN) {
  throw new Error('Missing environment variable: SLACK_BOT_TOKEN');
} else if (!process.env.SLACK_SIGNING_SECRET) {
  throw new Error('Missing environment variable: SLACK_SIGNING_SECRET');
}

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

const INTERNAL_GROUPS = [
  'S020U3J559D', // OC Inc
  'S026UGK3U9F', // OCF
  'S0523QBN65R', // OCEU
  'S0524AJ7KAP', // OSC
  'S0523QPE4NP', // OCNZ
];

const userProfileCache = {};

async function main(argv = process.argv) {
  const program = getProgram(argv);
  const options = program.opts();
  const slackApp = getSlackApp();

  // Get a list of all user groups
  const { usergroups } = await slackApp.client.usergroups.list({ include_users: true });
  const adminGroups = usergroups.filter((g) => INTERNAL_GROUPS.includes(g.id));
  const adminMembers = flatten(adminGroups.map((g) => g.users));
  const allowedMembers = [...SPECIAL_MEMBERS, ...adminMembers];

  // List all private channels in the workspace
  let { channels } = await slackApp.client.conversations.list({ types: 'private_channel' });
  if (options.channel) {
    const channelNames = options.channel.split(',');
    channels = channels.filter((c) => channelNames.includes(c.name));
  }

  // Link members with the channel
  await Promise.all(
    channels.map(async (channel) => {
      const { members } = await slackApp.client.conversations.members({ channel: channel.id });
      channel.members = members;
    }),
  );

  // Check members of the channels are not part of the team
  let hasInvalidMembers = false;
  for (const channel of channels) {
    const channelMembers = channel.members;
    const invalidMembers = difference(channelMembers, allowedMembers);

    if (invalidMembers.length > 0) {
      hasInvalidMembers = true;

      // Fetch invalid members' profiles (if not cached)
      let invalidMemberProfiles = await Promise.all(
        invalidMembers.map(async (id) => {
          if (userProfileCache[id]) {
            return userProfileCache[id];
          }
          const { user } = await slackApp.client.users.info({ user: id });
          userProfileCache[id] = user;
          return user;
        }),
      );

      // For shared channels, we cannot check external members
      let externalMemberProfiles;
      if (channel.is_shared) {
        [invalidMemberProfiles, externalMemberProfiles] = partition(
          invalidMemberProfiles,
          (p) => p.team_id === TEAM_ID,
        );
      }

      console.log(
        `#${channel.name} (${channel.id}) has ${invalidMemberProfiles.length} invalid members${
          externalMemberProfiles
            ? ` and ${externalMemberProfiles.length} external members (${externalMemberProfiles
                .map((p) => p.name)
                .join(', ')})`
            : ''
        }`,
      );
      for (const invalidMember of invalidMemberProfiles) {
        process.stdout.write(`  - ${formatUserName(invalidMember)}`); // Using stdout to avoid a newline
        if (!options.kick) {
          process.stdout.write('\n');
        } else {
          // Switch the setting for "People who can remove members from private channels" first
          // See https://opencollective.slack.com/admin/settings#channel_management_restrictions
          try {
            await slackApp.client.conversations.kick({ channel: channel.id, user: invalidMember.id });
            process.stdout.write(' => [KICKED]\n');
          } catch (e) {
            process.stdout.write('=> [ERROR]\n');
            console.error(e);
          }
        }
      }
      process.stdout.write('\n');
    }
  }

  if (!hasInvalidMembers) {
    console.log('✅ No invalid members found');
  }
}

main();
